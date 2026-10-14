import { Trash2 } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import { SessionPane } from "@/v4/SessionPane.js";
import { V4PaneConversationProvider } from "@/v4/V4ConversationContext.js";
import { useSpecDiscussion } from "./useSpecDiscussion.js";
import { documentQuestion, type SpecThread } from "./specThread.js";
import {
  activateNativeDiscussionOwner,
  claimNativeDiscussionOwner,
  nativeDiscussionHandoffSession,
  readNativeDiscussionOwner,
  releaseNativeDiscussionOwner,
  subscribeNativeDiscussionOwner,
  transferNativeDiscussionDraft,
} from "./nativeDiscussionHandoff.js";

export function SpecDiscussionPane({
  thread,
  update,
  updateQuestionDraft,
  workspacePath,
  workspaceIdentity,
  anchorCurrent,
  visible,
  onOpenBrowserUrl,
  onOpenCodeViewer,
  onActivate,
}: {
  thread: SpecThread;
  update: (thread: SpecThread) => void;
  updateQuestionDraft: (threadId: string, question: string, expected?: string) => void;
  workspacePath: string;
  workspaceIdentity?: string;
  anchorCurrent: boolean;
  visible: boolean;
  onOpenBrowserUrl?: (url: string) => void;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  onActivate?: () => void;
}) {
  const question = thread.questionDraft || "";
  const native = useSpecDiscussion(
    thread,
    update,
    workspacePath,
    workspaceIdentity,
    (expected) => updateQuestionDraft(thread.id, "", expected),
    visible,
  );
  const [nativeOwnerSessionId, setNativeOwnerSessionId] = useState<string | null>(null);
  const [handoffError, setHandoffError] = useState("");
  const [unavailable, setUnavailable] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const ownerToken = useRef(Symbol("native-document-discussion-owner")).current;
  const activateRef = useRef(onActivate);
  activateRef.current = onActivate;
  const ownerScopeSessionId = nativeOwnerSessionId || thread.sessionId;
  const ownerScope = useMemo(() => {
    return ownerScopeSessionId
      ? { workspacePath, workspaceIdentity, threadId: thread.id, sessionId: ownerScopeSessionId }
      : null;
  }, [workspacePath, workspaceIdentity, thread.id, ownerScopeSessionId]);
  const currentOwner = useSyncExternalStore(
    (listener) => (ownerScope ? subscribeNativeDiscussionOwner(ownerScope, listener) : () => {}),
    () => (ownerScope ? readNativeDiscussionOwner(ownerScope) : null),
  );
  const ownedElsewhere = currentOwner !== null && currentOwner !== ownerToken;
  useLayoutEffect(
    () => () => {
      if (ownerScope) releaseNativeDiscussionOwner(ownerScope, ownerToken);
    },
    [ownerScope, ownerToken],
  );
  const readySessionId = nativeDiscussionHandoffSession(nativeOwnerSessionId, thread, {
    status: native.configurationReady ? native.projection.status : "preparing",
    snapshotSessionId: native.snapshot?.sessionId ?? null,
    dispatching: native.dispatching,
  });
  // Passive mount runs after displaced native composers flush their rich drafts
  // in passive unmount cleanup. Never seed a new editor during layout cleanup.
  useEffect(() => {
    if (!readySessionId || nativeOwnerSessionId || !ownerScope) return;
    if (!claimNativeDiscussionOwner(ownerScope, ownerToken, () => activateRef.current?.())) return;
    try {
      transferNativeDiscussionDraft(workspacePath, workspaceIdentity, readySessionId, question);
      if (question) updateQuestionDraft(thread.id, "", question);
      if (thread.executionConfig) update({ ...thread, executionConfig: undefined });
      setHandoffError("");
      setNativeOwnerSessionId(readySessionId);
    } catch (cause) {
      releaseNativeDiscussionOwner(ownerScope, ownerToken);
      setHandoffError(String(cause));
    }
  }, [
    readySessionId,
    nativeOwnerSessionId,
    ownerScope,
    ownerToken,
    currentOwner,
    workspacePath,
    workspaceIdentity,
    question,
    thread,
    update,
    updateQuestionDraft,
  ]);
  const scope = useMemo(
    () => ({ workspacePath, ...(workspaceIdentity ? { workspaceIdentity } : {}) }),
    [workspacePath, workspaceIdentity],
  );
  const nativeInteractive =
    !unavailable &&
    !thread.pending &&
    nativeOwnerSessionId === thread.sessionId &&
    currentOwner === ownerToken;
  return (
    <section
      className="flex min-h-0 flex-1 flex-col"
      aria-label="Document discussion"
      onKeyDown={(event) => {
        if (
          event.key === "Escape" &&
          !event.defaultPrevented &&
          !(event.target instanceof Element && event.target.closest('[role="dialog"]'))
        )
          event.stopPropagation();
      }}
    >
      <div className="border-b border-border p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="mb-1 text-ui-xs text-foreground-subtle">
            Selected fragment ·{" "}
            {thread.anchor.start < 0
              ? "location unresolved"
              : anchorCurrent
                ? "current"
                : "changed since selection"}
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Delete discussion"
            title={
              native.removeBlockedReason
                ? `Delete discussion: ${native.removeBlockedReason}`
                : "Delete discussion"
            }
            disabled={ownedElsewhere || !native.canRemove}
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2 />
          </Button>
        </div>
        <blockquote className="max-h-24 overflow-auto border-l-2 border-border pl-2 text-ui-sm">
          {thread.anchor.quote}
        </blockquote>
        {!native.canRemove && !ownedElsewhere ? (
          /* D-04：拒绝原因与 canRemove 同源推导，删除被拒时可见，而不是只有禁用态。 */
          <p role="status" className="mt-1 text-ui-xs text-foreground-subtle">
            {native.removeBlockedReason}
          </p>
        ) : null}
        {confirmDelete ? (
          <div className="mt-2 space-y-2 text-ui-sm" role="alert">
            <p>Delete this discussion and close its native session?</p>
            <Button
              variant="destructive"
              size="sm"
              disabled={!native.canRemove}
              onClick={() => {
                setConfirmDelete(false);
                void native.remove();
              }}
            >
              Delete discussion
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
          </div>
        ) : null}
      </div>
      {thread.pending ? (
        <div className="p-3 text-ui-sm text-foreground-subtle" role="status">
          Checking native command admission.{" "}
          <Button
            variant="ghost"
            size="sm"
            disabled={native.dispatching}
            onClick={() => void native.reconcile()}
          >
            Check status
          </Button>
        </div>
      ) : null}
      {handoffError || native.error ? (
        <p role="alert" className="p-3 text-ui-sm text-destructive">
          {handoffError || native.error}
        </p>
      ) : null}
      {nativeOwnerSessionId ? (
        <div
          className="flex min-h-0 flex-1 flex-col"
          data-native-discussion-owner={nativeOwnerSessionId}
        >
          {unavailable || nativeOwnerSessionId !== thread.sessionId ? (
            <p role="alert" className="p-3 text-ui-sm text-destructive">
              This native discussion is unavailable. Its saved binding is retained.
            </p>
          ) : null}
          <V4PaneConversationProvider scope={scope}>
            <SessionPane
              paneId={`spec-discussion:${thread.id}`}
              sessionId={nativeOwnerSessionId}
              openTrigger="selection"
              selectionSideChat
              isDesktop
              prepareFirstText={(text) => documentQuestion(thread, text, workspacePath)}
              workspacePath={workspacePath}
              workspaceIdentity={workspaceIdentity}
              readOnly={!nativeInteractive}
              focused={false}
              telemetryVisible={visible}
              /* Markdown 讨论宿主：讨论区不可见（文档 tab 切走）时冻结展示推导；
                 订阅与 native 讨论所有权保持原样。 */
              presentationVisible={visible}
              interactionDialogsVisible={visible && nativeInteractive}
              onOpenBrowserUrl={onOpenBrowserUrl}
              onOpenCodeViewer={onOpenCodeViewer}
              onSelectionSideChatUnavailable={() => setUnavailable(true)}
            />
          </V4PaneConversationProvider>
        </div>
      ) : (
        <div className="space-y-2 p-3 text-ui-sm" role="status">
          {ownedElsewhere ? (
            <>
              <p>This discussion is already open in another document tab.</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  if (ownerScope) activateNativeDiscussionOwner(ownerScope);
                }}
              >
                Open existing discussion
              </Button>
            </>
          ) : (
            <p>Preparing the native ZCODE form… No model request is sent.</p>
          )}
          {native.projection.lastError ? (
            <p role="alert" className="text-destructive">
              {String(native.projection.lastError)}
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}
