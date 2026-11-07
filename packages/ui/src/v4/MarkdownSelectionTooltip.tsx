import { SelectionActionMenu } from "@/v4/SelectionActionMenu.js";
import {
  buildSelectionSideChatKey,
  getSelectionSideChatOpenState,
  getSelectionSideChatOpenStateForWorkspace,
  requestSelectionSideChatOpen,
  requestSelectionSideChatOpenForWorkspace,
  subscribeSelectionSideChatRuntime,
} from "@/lib/selectionSideChatRuntime.js";
import { useCallback, useSyncExternalStore, type RefObject } from "react";
import { useTextSelection } from "@/hooks/useTextSelection.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { hasExcludedConversationSelectionEndpoint } from "@/lib/conversationSelectionGuard.js";
import {
  CONVERSATION_SELECTION_MAX_TEXT_LENGTH,
  dispatchConversationSelectionAdd,
  createConversationSelectionReference,
  type MarkdownSelectionTarget,
} from "@/lib/conversationSelectionReference.js";

export function MarkdownSelectionTooltip({
  rootRef,
  sourceKey,
  sourceTitle,
  sourcePath,
  target,
  scopeKey,
  onDiscussFragment,
}: {
  scopeKey: object;
  rootRef: RefObject<HTMLDivElement | null>;
  sourceKey: string;
  sourceTitle: string;
  sourcePath?: string;
  target: MarkdownSelectionTarget;
  onDiscussFragment?: (quote: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const inspect = useCallback(() => {
    const root = rootRef.current;
    const selection = window.getSelection();
    if (!root || !selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
    const range = selection.getRangeAt(0);
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
    const element = (node: Node) => (node instanceof Element ? node : node.parentElement);
    if (
      hasExcludedConversationSelectionEndpoint(
        element(range.startContainer),
        element(range.endContainer),
      )
    )
      return null;
    const text = selection.toString().trim();
    if (!text) return null;
    const rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height) return null;
    return { text, top: rect.top, bottom: rect.bottom, center: rect.left + rect.width / 2 };
  }, [rootRef]);
  const { state, close } = useTextSelection({
    rootRef,
    enabled: true,
    inspect,
    scopeKey,
    observeSelectionChange: true,
  });
  // Side-chat availability (2026-11-07, user report): the preview selection
  // target carries sessionId: null when no main conversation is active. The
  // action used to be disabled unconditionally in that state, but the draft
  // SessionPane registers a workspace opener under its prewarmed session id —
  // an id the preview can never know. So with no explicit session we resolve
  // by workspaceKey instead: the side conversation is created as a child of
  // whatever parent session the workspace's registered opener owns. Without
  // any opener the action stays disabled with its explanatory title; the
  // toolbar itself never hides. With an active session the exact
  // (workspace, sessionId) key is used exactly as before.
  const sideKey = target.sessionId
    ? buildSelectionSideChatKey(target.workspaceKey, target.sessionId)
    : null;
  const sideState = useSyncExternalStore(
    subscribeSelectionSideChatRuntime,
    () =>
      sideKey
        ? getSelectionSideChatOpenState(sideKey)
        : getSelectionSideChatOpenStateForWorkspace(target.workspaceKey),
    () => "unavailable",
  );
  if (!state) return null;
  const createReference = () =>
    createConversationSelectionReference({
      contentType: "markdown",
      sourceKey,
      sourceTitle,
      path: sourcePath,
      text: state.text,
    });
  return (
    <SelectionActionMenu
      center={state.center}
      top={state.top}
      bottom={state.bottom}
      singleLimit={state.text.length > CONVERSATION_SELECTION_MAX_TEXT_LENGTH}
      sideActionDisabled={sideState !== "ready"}
      sideDisabledTitle={
        sideState === "ready"
          ? undefined
          : intl.formatMessage({
              id:
                sideState === "blocked"
                  ? "chat.selections.previewSideBlocked"
                  : "chat.selections.previewSideUnavailable",
            })
      }
      onDiscussFragment={
        onDiscussFragment
          ? () => {
              onDiscussFragment(state.text);
              close();
            }
          : undefined
      }
      // "Add to chat" without an active conversation routes to the workspace
      // draft scope (targetSessionId: null + draftScopeKey); the mounted draft
      // composer subscribes with the same scope key, so the reference lands in
      // the workspace draft composer input — matching composer behavior.
      onAddToCurrentTask={() => {
        dispatchConversationSelectionAdd({
          targetSessionId: target.sessionId,
          draftScopeKey: target.draftScopeKey,
          workspaceKey: target.workspaceKey,
          reference: createReference(),
        });
        close();
      }}
      onAskInSideChat={() => {
        const opened = sideKey
          ? requestSelectionSideChatOpen(sideKey, createReference())
          : requestSelectionSideChatOpenForWorkspace(target.workspaceKey, createReference());
        if (opened) close();
      }}
    />
  );
}
