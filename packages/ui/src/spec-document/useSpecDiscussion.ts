import { useEffect, useState } from "react";
import type {
  CommandAck,
  CommandEnvelope,
  ConversationSnapshot,
} from "@zcode/shared/zcode-protocol-v4";
import { createCommandEnvelope } from "@/v4/commandFactory.js";
import { pendingCommandRegistry } from "@/v4/pendingCommandRegistry.js";
import { useV4Conversation } from "@/v4/V4ConversationContext.js";
import { useConversationProjection } from "@/v4/useConversationProjection.js";
import type { SessionLease } from "@/v4/sessionDataLayer.js";
import {
  claimSpecCommand,
  documentQuestion,
  getSpecThreadStore,
  removeSpecThread,
  specExecutionConfigMatches,
  type SpecThread,
} from "./specThread.js";
import { forgetManagedNativeDiscussion } from "./nativeDiscussionHandoff.js";

export function nativeSessionHasWriters(snapshot: ConversationSnapshot): boolean {
  return (
    snapshot.control.activeWorks.length > 0 ||
    snapshot.control.phase === "prewarming" ||
    snapshot.control.phase === "running" ||
    snapshot.control.stopState === "stopping" ||
    snapshot.queue.items.length > 0 ||
    snapshot.backgroundWorks.some((work) => work.status === "running")
  );
}

/** Observes known sessions; this is a UI guard, not a runtime-wide writer lock. */
export function useSpecWriteGuard(sessionIds: string[]): {
  blocked: boolean;
  phases: Record<string, string>;
} {
  const { layer } = useV4Conversation();
  const [guard, setGuard] = useState<{ blocked: boolean; phases: Record<string, string> }>({
    blocked: true,
    phases: {},
  });
  const ids = [...new Set(sessionIds)].sort().join("\0");
  useEffect(() => {
    const leases = ids ? ids.split("\0").map((id) => layer.acquire(id)) : [];
    const update = () => {
      const phases: Record<string, string> = {};
      const blocked = leases.some(({ sessionId, store }) => {
        const state = store.getState();
        phases[sessionId] =
          state.status === "live" ? state.snapshot?.control.phase || "unknown" : state.status;
        return (
          state.status !== "live" ||
          !state.snapshot ||
          nativeSessionHasWriters(state.snapshot) ||
          state.optimisticCommands.length > 0
        );
      });
      // Read every subscribed session even if an earlier one is busy.
      for (const { sessionId, store } of leases) {
        const state = store.getState();
        phases[sessionId] =
          state.status === "live" ? state.snapshot?.control.phase || "unknown" : state.status;
      }
      setGuard({ blocked, phases });
    };
    const unsubscribers = leases.map(({ store }) => store.subscribe(update));
    update();
    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe());
      leases.forEach((lease) => lease.release());
    };
  }, [layer, ids]);
  return guard;
}

export function useSpecDiscussion(
  thread: SpecThread,
  update: (thread: SpecThread) => void,
  workspacePath: string,
  workspaceIdentity: string | undefined,
  clearQuestionDraft: (expected: string) => void,
  visible = false,
) {
  const { layer, sendCommand } = useV4Conversation();
  const [lease, setLease] = useState<SessionLease | null>(null);
  const [error, setError] = useState("");
  const [dispatching, setDispatching] = useState(false);
  const [parentLease, setParentLease] = useState<SessionLease | null>(null);
  useEffect(() => {
    const parent = layer.acquire(thread.parentSessionId);
    setParentLease(parent);
    return () => parent.release();
  }, [layer, thread.parentSessionId]);
  const parentProjection = useConversationProjection(
    parentLease?.sessionId === thread.parentSessionId ? parentLease : null,
  );
  useEffect(() => {
    if (!thread.sessionId) {
      setLease(null);
      return;
    }
    const next = layer.acquire(thread.sessionId);
    setLease(next);
    return () => next.release();
  }, [layer, thread.sessionId]);
  const projection = useConversationProjection(
    lease?.sessionId === thread.sessionId ? lease : null,
  );
  const snapshot = projection.snapshot?.sessionId === thread.sessionId ? projection.snapshot : null;

  function applyAck(envelope: CommandEnvelope, ack: CommandAck, binding = thread) {
    if (ack.commandId !== envelope.commandId)
      throw new Error("Native acknowledgement belongs to a different command.");
    pendingCommandRegistry.applyAck(envelope, ack);
    if (ack.status !== "accepted" && ack.status !== "duplicate" && ack.status !== "noop") {
      lease?.store.settleCommand(envelope.commandId);
      update({ ...binding, pending: undefined, initialQuestion: undefined });
      throw new Error(ack.reasonCode || `Native command: ${ack.status}`);
    }
    if (envelope.type === "createSession") {
      if (ack.result?.type !== "createSession")
        throw new Error("Native fresh session acknowledgement is incomplete.");
      update({
        ...binding,
        sessionId: ack.result.sessionId,
        discussionStartRowId: binding.discussionStartRowId ?? 1,
        pending: undefined,
      });
    } else if (envelope.type === "deleteSession") {
      const store = getSpecThreadStore(
        `spec-harness-native:v1:${workspaceIdentity?.trim() || workspacePath}`,
        workspaceIdentity?.trim() || workspacePath,
      );
      store.update((current) =>
        removeSpecThread(current, binding.id, binding.sessionId, envelope.commandId),
      );
      if (binding.sessionId)
        forgetManagedNativeDiscussion({
          workspacePath,
          workspaceIdentity,
          threadId: binding.id,
          sessionId: binding.sessionId,
        });
    } else {
      if (
        envelope.type === "sendText" &&
        (ack.status === "accepted" || ack.status === "duplicate")
      ) {
        lease?.store.expectAcceptedInputProjection(envelope.commandId);
        if (binding.submittedQuestionDraft !== undefined)
          clearQuestionDraft(binding.submittedQuestionDraft);
      } else lease?.store.settleCommand(envelope.commandId);
      update({
        ...binding,
        pending: undefined,
        ...(envelope.type === "sendText"
          ? { initialQuestion: undefined, submittedQuestionDraft: undefined }
          : {}),
      });
    }
  }
  async function prepare() {
    if (thread.sessionId || thread.pending || dispatching || error) return;
    const parent = parentProjection.snapshot;
    if (parentProjection.status !== "live" || parent?.sessionId !== thread.parentSessionId) return;
    const { modelSelection, provider, model, thought, mode, planEnabled, followupMode } =
      parent.config;
    if (!provider.trim() || !model.trim()) return;
    const executionConfig = {
      modelSelection,
      provider,
      model,
      thought,
      mode,
      planEnabled,
      followupMode,
    };
    await dispatch(
      createCommandEnvelope({
        type: "createSession",
        sessionId: null,
        payload: {
          workspaceId: workspaceIdentity?.trim() || workspacePath,
          config: executionConfig,
        },
      }),
      { ...thread, executionConfig },
    );
  }
  useEffect(() => {
    if (visible) void prepare();
  }, [visible, thread, dispatching, error, parentProjection.status, parentProjection.snapshot]);
  async function dispatch(envelope: CommandEnvelope, binding = thread) {
    setError("");
    setDispatching(true);
    try {
      // Persist the exact envelope before the first native uplink. Never auto-replay it.
      const store = getSpecThreadStore(
        `spec-harness-native:v1:${workspaceIdentity?.trim() || workspacePath}`,
        workspaceIdentity?.trim() || workspacePath,
      );
      if (!claimSpecCommand(store, thread, binding, envelope)) return;
      pendingCommandRegistry.record(envelope);
      if (envelope.sessionId === thread.sessionId)
        lease?.store.markCommandPending({
          commandId: envelope.commandId,
          type: envelope.type,
          issuedAt: envelope.issuedAt,
        });
      applyAck(envelope, await sendCommand(envelope), binding);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setDispatching(false);
    }
  }
  async function send(question: string) {
    if (thread.pending || dispatching || !question.trim()) return;
    if (thread.sessionId) {
      // This prototype supports idle sends only; no custom queue or guide policy.
      if (
        projection.status !== "live" ||
        !snapshot ||
        snapshot.inputRouting.mode !== "startNow" ||
        nativeSessionHasWriters(snapshot)
      )
        return;
      await dispatch(
        createCommandEnvelope({
          type: "sendText",
          sessionId: thread.sessionId,
          payload: { text: question.trim() },
        }),
        { ...thread, submittedQuestionDraft: question },
      );
    } else {
      const parent = parentProjection.snapshot;
      if (parentProjection.status !== "live" || parent?.sessionId !== thread.parentSessionId) {
        setError("Native execution settings are not available yet. No model request was sent.");
        return;
      }
      // Whitelist execution settings only. No transcript fork, context import or interaction grants.
      const { modelSelection, provider, model, thought, mode, planEnabled, followupMode } =
        parent.config;
      if (!provider.trim() || !model.trim()) {
        setError("Native provider/model is not ready. No model request was sent.");
        return;
      }
      const executionConfig = {
        modelSelection,
        provider,
        model,
        thought,
        mode,
        planEnabled,
        followupMode,
      };
      await dispatch(
        createCommandEnvelope({
          type: "createSession",
          sessionId: null,
          payload: {
            workspaceId: workspaceIdentity?.trim() || workspacePath,
            config: executionConfig,
          },
        }),
        {
          ...thread,
          executionConfig,
          initialQuestion: question.trim(),
          submittedQuestionDraft: question,
        },
      );
    }
  }
  useEffect(() => {
    if (
      thread.initialQuestion &&
      thread.sessionId &&
      !thread.pending &&
      !dispatching &&
      !error &&
      projection.status === "live" &&
      snapshot?.inputRouting.mode === "startNow" &&
      !nativeSessionHasWriters(snapshot)
    ) {
      const expected = thread.executionConfig;
      if (!specExecutionConfigMatches(expected, snapshot.config)) {
        setError(
          "Native session execution settings differ from the requested settings. No model request was sent.",
        );
        return;
      }
      void dispatch(
        createCommandEnvelope({
          type: "sendText",
          sessionId: thread.sessionId,
          payload: { text: documentQuestion(thread, thread.initialQuestion, workspacePath) },
        }),
        {
          ...thread,
          discussionStartRowId:
            thread.discussionStartRowId ?? (snapshot.rows.window.at(-1)?.rowId ?? 0) + 1,
        },
      );
    }
  }, [thread, dispatching, error, projection.status, snapshot, workspacePath]);
  async function reconcile() {
    const envelope = thread.pending;
    if (!envelope || dispatching) return;
    setDispatching(true);
    try {
      const result = await layer.queryCommands({
        commands: [{ sessionId: envelope.sessionId, commandId: envelope.commandId }],
      });
      if (
        result.results[0]?.key.sessionId !== envelope.sessionId ||
        result.results[0]?.key.commandId !== envelope.commandId
      ) {
        throw new Error("Native command query belongs to a different session or command.");
      }
      const ack = result.results[0]?.result;
      if (!ack || ack === "unknown") {
        setError(
          "Native runtime cannot prove admission. The original command is retained; no automatic resend.",
        );
      } else {
        setError("");
        applyAck(envelope, ack);
      }
    } catch (cause) {
      setError(String(cause));
    } finally {
      setDispatching(false);
    }
  }
  async function stop() {
    const executionId = snapshot?.control.activeWorks.find(
      (work) => work.foregroundExecutionId,
    )?.foregroundExecutionId;
    if (!thread.sessionId || !snapshot?.control.canStop || !executionId || thread.pending) return;
    await dispatch(
      createCommandEnvelope({
        type: "stop",
        sessionId: thread.sessionId,
        payload: { expectedForegroundExecutionId: executionId },
      }),
    );
  }
  const configurationReady = Boolean(
    snapshot &&
    (!thread.executionConfig ||
      specExecutionConfigMatches(thread.executionConfig, snapshot.config)),
  );
  const canRemove =
    !thread.pending &&
    !dispatching &&
    (!thread.sessionId ||
      (projection.status === "live" &&
        snapshot &&
        !nativeSessionHasWriters(snapshot) &&
        projection.optimisticCommands.length === 0));
  async function remove() {
    if (!canRemove) return;
    if (thread.sessionId)
      await dispatch(
        createCommandEnvelope({ type: "deleteSession", sessionId: thread.sessionId, payload: {} }),
      );
    else {
      const store = getSpecThreadStore(
        `spec-harness-native:v1:${workspaceIdentity?.trim() || workspacePath}`,
        workspaceIdentity?.trim() || workspacePath,
      );
      store.update((current) => removeSpecThread(current, thread.id, undefined));
    }
  }
  return {
    projection,
    snapshot,
    send,
    stop,
    reconcile,
    prepare,
    remove,
    canRemove,
    configurationReady,
    error,
    dispatching,
  };
}
