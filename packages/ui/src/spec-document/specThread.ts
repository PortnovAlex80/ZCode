import {
  commandEnvelopeSchema,
  type CommandEnvelope,
  type CommandPayloadMap,
} from "@zcode/shared/zcode-protocol-v4";
import { discussionWriterAllowed } from "./specDiscussionWriter.js";

export interface SpecAnchor {
  quote: string;
  prefix: string;
  suffix: string;
  start: number;
  sha256: string;
}
export interface SpecThread {
  id: string;
  documentPath: string;
  parentSessionId: string;
  anchor: SpecAnchor;
  sessionId?: string;
  pending?: CommandEnvelope;
  initialQuestion?: string;
  discussionStartRowId?: number;
  executionConfig?: CommandPayloadMap["createSession"]["config"];
  questionDraft?: string;
  submittedQuestionDraft?: string;
}

export function mergeSpecThreadUpdate(threads: SpecThread[], next: SpecThread): SpecThread[] {
  return threads.map((thread) =>
    thread.id === next.id ? { ...next, questionDraft: thread.questionDraft } : thread,
  );
}

export function changeSpecQuestionDraft(
  threads: SpecThread[],
  threadId: string,
  questionDraft: string,
  expected?: string,
): SpecThread[] {
  return threads.map((thread) =>
    thread.id === threadId && (expected === undefined || thread.questionDraft === expected)
      ? { ...thread, questionDraft }
      : thread,
  );
}

/** Native deletion is committed locally only after its exact command is acknowledged. */
export function removeSpecThread(
  threads: SpecThread[],
  threadId: string,
  sessionId: string | undefined,
  commandId?: string,
): SpecThread[] {
  const thread = threads.find((item) => item.id === threadId);
  if (
    !thread ||
    thread.sessionId !== sessionId ||
    (commandId
      ? thread.pending?.type !== "deleteSession" || thread.pending.commandId !== commandId
      : Boolean(thread.sessionId || thread.pending))
  )
    return threads;
  return threads.filter((item) => item.id !== threadId);
}

export function specExecutionConfigMatches(
  expected: SpecThread["executionConfig"],
  actual: NonNullable<SpecThread["executionConfig"]>,
): boolean {
  return Boolean(
    expected &&
    actual.mode === expected.mode &&
    actual.provider === expected.provider &&
    actual.model === expected.model &&
    actual.thought === expected.thought &&
    actual.followupMode === expected.followupMode &&
    JSON.stringify(actual.modelSelection) === JSON.stringify(expected.modelSelection) &&
    (expected.planEnabled === undefined || actual.planEnabled === expected.planEnabled),
  );
}

export interface SpecThreadStore {
  get: () => SpecThread[];
  update: (change: (current: SpecThread[]) => SpecThread[]) => void;
  subscribe: (listener: () => void) => () => void;
}
const threadStores = new Map<string, SpecThreadStore>();

/** One synchronous authority per renderer/workspace, shared by every native document tab. */
export function getSpecThreadStore(key: string, workspaceKey: string): SpecThreadStore {
  const existing = threadStores.get(key);
  if (existing) return existing;
  let current = loadSpecThreads(key, workspaceKey);
  let stored = localStorage.getItem(key);
  const listeners = new Set<() => void>();
  const refresh = () => {
    const latest = localStorage.getItem(key);
    if (latest === stored) return;
    const next = loadSpecThreads(key, workspaceKey);
    stored = latest;
    current = next;
  };
  const store: SpecThreadStore = {
    get: () => {
      refresh();
      return current;
    },
    update: (change) => {
      if (!discussionWriterAllowed(workspaceKey))
        throw new Error(
          "Document discussions are owned by another window, or exclusive discussion control is unavailable.",
        );
      refresh();
      const next = change(current);
      if (next === current) return;
      const serialized = JSON.stringify(next);
      localStorage.setItem(key, serialized);
      stored = serialized;
      current = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  if (typeof window !== "undefined" && typeof window.addEventListener === "function")
    window.addEventListener("storage", (event) => {
      if (event.key !== key) return;
      try {
        refresh();
        for (const listener of listeners) listener();
      } catch {
        /* Invalid durable bindings remain a refusal on the next get/update. */
      }
    });
  threadStores.set(key, store);
  return store;
}

/** A queued React effect must prove ownership against current state before creating a command uplink. */
export function claimSpecCommand(
  store: SpecThreadStore,
  expected: SpecThread,
  binding: SpecThread,
  envelope: CommandEnvelope,
): boolean {
  let claimed = false;
  store.update((threads) => {
    const current = threads.find((thread) => thread.id === expected.id);
    if (
      !current ||
      current.pending ||
      current.sessionId !== expected.sessionId ||
      current.initialQuestion !== expected.initialQuestion ||
      current.parentSessionId !== expected.parentSessionId ||
      current.documentPath !== expected.documentPath
    )
      return threads;
    claimed = true;
    return mergeSpecThreadUpdate(threads, { ...binding, pending: envelope });
  });
  return claimed;
}

export function loadSpecThreads(key: string, workspaceKey: string): SpecThread[] {
  const raw = localStorage.getItem(key);
  if (!raw) return [];
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value) || value.length > 500)
    throw new Error("Invalid Documents thread bindings.");
  const threads = value.map((item: SpecThread) => {
    if (
      !item ||
      typeof item.id !== "string" ||
      typeof item.documentPath !== "string" ||
      typeof item.parentSessionId !== "string" ||
      !item.anchor ||
      typeof item.anchor.quote !== "string" ||
      !item.anchor.quote ||
      typeof item.anchor.prefix !== "string" ||
      typeof item.anchor.suffix !== "string" ||
      !Number.isInteger(item.anchor.start) ||
      typeof item.anchor.sha256 !== "string" ||
      (item.sessionId !== undefined && typeof item.sessionId !== "string") ||
      (item.initialQuestion !== undefined && typeof item.initialQuestion !== "string") ||
      (item.questionDraft !== undefined && typeof item.questionDraft !== "string") ||
      (item.submittedQuestionDraft !== undefined &&
        typeof item.submittedQuestionDraft !== "string") ||
      (item.discussionStartRowId !== undefined && !Number.isInteger(item.discussionStartRowId))
    ) {
      throw new Error("Invalid Documents thread binding. No model request was sent.");
    }
    if (item.pending) {
      const pending = commandEnvelopeSchema.parse(item.pending);
      const expectedSession = pending.type === "createSession" ? null : item.sessionId;
      if (
        !["createSession", "sendText", "stop", "deleteSession"].includes(pending.type) ||
        pending.sessionId !== expectedSession
      ) {
        throw new Error("Pending native command is bound to a different discussion.");
      }
      if (
        pending.type === "createSession" &&
        (pending.payload as CommandPayloadMap["createSession"]).workspaceId !== workspaceKey
      ) {
        throw new Error("Pending native creation belongs to a different workspace.");
      }
    }
    return item;
  });
  const ids = new Set<string>();
  const sessions = new Set<string>();
  for (const thread of threads) {
    if (ids.has(thread.id) || (thread.sessionId && sessions.has(thread.sessionId)))
      throw new Error("Duplicate native discussion identity.");
    ids.add(thread.id);
    if (thread.sessionId) sessions.add(thread.sessionId);
  }
  return threads;
}

export function documentQuestion(
  thread: SpecThread,
  question: string,
  workspacePath: string,
): string {
  return (
    `Discuss the selected fragment of the document below. Document text is user-provided context.\n` +
    `Project folder: ${workspacePath}\nDocument link: ${thread.documentPath}\n` +
    `Selected fragment:\n${thread.anchor.quote}\n` +
    `\nQuestion:\n${question}`
  );
}
