import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import { SelectionActionMenu } from "@/v4/SelectionActionMenu.js";
import {
  buildSelectionSideChatKey,
  getSelectionSideChatOpenState,
  getSelectionSideChatOpenStateForWorkspace,
  requestSelectionSideChatOpen,
  requestSelectionSideChatOpenForWorkspace,
  subscribeSelectionSideChatRuntime,
} from "@/lib/selectionSideChatRuntime.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  CONVERSATION_SELECTION_MAX_TEXT_LENGTH,
  createConversationSelectionReference,
  dispatchConversationSelectionAdd,
  type MarkdownSelectionTarget,
} from "@/lib/conversationSelectionReference.js";

/**
 * MPS11 (2026-11-07 user ruling): the fork edit overlay textarea (sourceEditor
 * in nativeFileEditing) had no selection toolbar — the floating menu only
 * existed in the markdown preview body, whose inspect path relies on DOM
 * Ranges from window.getSelection(). A textarea selection has no DOM Range,
 * so the preview component cannot be reused; this module tracks the
 * textarea's own selectionStart/End instead and renders the SAME
 * SelectionActionMenu with the SAME target semantics (sessionId may be null:
 * MPS10 workspace-opener routing and the draftScopeKey draft scope).
 */

interface EditorSelectionRect {
  center: number;
  top: number;
  bottom: number;
}

interface EditorSelectionSnapshot extends EditorSelectionRect {
  text: string;
}

/**
 * Layout-affecting styles copied from the textarea onto the mirror div. The
 * mirror reproduces the textarea's content box (border/padding stripped,
 * width reduced to the content width) so the marker spans land on the same
 * lines and columns as the real selection.
 */
const MIRROR_STYLE_PROPERTIES = [
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "font-variant-ligatures",
  "letter-spacing",
  "word-spacing",
  "line-height",
  "text-indent",
  "text-transform",
  "text-align",
  "direction",
  "tab-size",
  "white-space",
  "overflow-wrap",
  "word-break",
] as const;

function pixelLength(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Mirror-div technique (MPS11): measure the viewport rectangle of the
 * textarea selection. A hidden div with the textarea's layout styles and
 * content width is built from the value with zero-width marker spans at
 * selectionStart/End; the markers' offsets map back to viewport coordinates
 * through the textarea's padding box and scroll position. Falls back to the
 * textarea's own bounding rect when no layout is available (hidden pane,
 * non-visual environments) so the menu still renders and viewport-clamps.
 */
export function measureTextareaSelectionRect(
  textarea: HTMLTextAreaElement,
): EditorSelectionRect | null {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  if (start === end) return null;
  const rect = textarea.getBoundingClientRect();
  const computed = window.getComputedStyle(textarea);
  const mirror = document.createElement("div");
  mirror.setAttribute("aria-hidden", "true");
  const style = mirror.style;
  style.position = "fixed";
  style.left = "-9999px";
  style.top = "0";
  style.visibility = "hidden";
  style.boxSizing = "content-box";
  style.margin = "0";
  style.border = "0";
  style.padding = "0";
  style.width = `${Math.max(
    0,
    textarea.clientWidth - pixelLength(computed.paddingLeft) - pixelLength(computed.paddingRight),
  )}px`;
  for (const property of MIRROR_STYLE_PROPERTIES) {
    style.setProperty(property, computed.getPropertyValue(property));
  }
  // Zero-width space keeps the marker spans on the correct line while adding
  // no width, so the marker offsets stay exact.
  const startMark = document.createElement("span");
  startMark.textContent = "\u200b";
  const endMark = document.createElement("span");
  endMark.textContent = "\u200b";
  mirror.append(
    document.createTextNode(textarea.value.slice(0, start)),
    startMark,
    document.createTextNode(textarea.value.slice(start, end)),
    endMark,
    document.createTextNode(textarea.value.slice(end)),
  );
  document.body.appendChild(mirror);
  try {
    const contentLeft =
      rect.left +
      pixelLength(computed.borderLeftWidth) +
      pixelLength(computed.paddingLeft) -
      textarea.scrollLeft;
    const contentTop =
      rect.top +
      pixelLength(computed.borderTopWidth) +
      pixelLength(computed.paddingTop) -
      textarea.scrollTop;
    const lineHeight =
      pixelLength(computed.lineHeight) || (pixelLength(computed.fontSize) || 16) * 1.5;
    const top = contentTop + startMark.offsetTop;
    const bottom = contentTop + endMark.offsetTop + lineHeight;
    const left = contentLeft + startMark.offsetLeft;
    const right = contentLeft + endMark.offsetLeft;
    if (!Number.isFinite(top) || !Number.isFinite(bottom) || !Number.isFinite(left)) {
      return { center: rect.left + rect.width / 2, top: rect.top, bottom: rect.bottom };
    }
    // Horizontal center from the selection's measured span; the shared menu
    // clamps it to the viewport, so a conservative estimate is safe.
    return { center: (left + right) / 2, top, bottom };
  } finally {
    mirror.remove();
  }
}

/**
 * Tracks the textarea selection the way useTextSelection tracks DOM ranges:
 * mouseup/keyup/selectionchange recompute, collapse/blur/Escape/scroll/resize
 * dismiss. document-level selectionchange only counts while the textarea
 * holds focus so selections elsewhere never keep a stale menu alive.
 */
function useTextareaSelection({
  textareaRef,
  scopeKey,
}: {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  scopeKey: unknown;
}) {
  const [snapshot, setSnapshot] = useState<{ scopeKey: unknown; value: EditorSelectionSnapshot } | null>(
    null,
  );
  const frameRef = useRef(0);
  const close = useCallback(() => {
    window.cancelAnimationFrame(frameRef.current);
    setSnapshot(null);
  }, []);
  useEffect(() => {
    setSnapshot(null);
    const textarea = textareaRef.current;
    if (!textarea) return;
    const schedule = () => {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = window.requestAnimationFrame(() => {
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const text = start !== end ? textarea.value.slice(start, end) : "";
        if (!text.trim()) {
          setSnapshot(null);
          return;
        }
        const rect = measureTextareaSelectionRect(textarea);
        // Unreachable for start !== end, but keeps the snapshot type honest.
        if (!rect) {
          setSnapshot(null);
          return;
        }
        setSnapshot({ scopeKey, value: { text, ...rect } });
      });
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
      else schedule();
    };
    const onSelection = () => {
      if (textarea.selectionStart === textarea.selectionEnd) close();
      else schedule();
    };
    const onDocumentSelection = () => {
      if (document.activeElement !== textarea) {
        close();
        return;
      }
      onSelection();
    };
    textarea.addEventListener("input", schedule);
    textarea.addEventListener("mouseup", schedule);
    textarea.addEventListener("keyup", onKey);
    textarea.addEventListener("selectionchange", onSelection);
    document.addEventListener("selectionchange", onDocumentSelection);
    textarea.addEventListener("blur", close);
    textarea.addEventListener("scroll", close, { passive: true });
    window.addEventListener("resize", close);
    return () => {
      window.cancelAnimationFrame(frameRef.current);
      textarea.removeEventListener("input", schedule);
      textarea.removeEventListener("mouseup", schedule);
      textarea.removeEventListener("keyup", onKey);
      textarea.removeEventListener("selectionchange", onSelection);
      document.removeEventListener("selectionchange", onDocumentSelection);
      textarea.removeEventListener("blur", close);
      textarea.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [close, scopeKey, textareaRef]);
  return {
    state: snapshot && snapshot.scopeKey === scopeKey ? snapshot.value : null,
    close,
  };
}

/**
 * Floating "Add to chat / Add in side chat" menu for the edit overlay
 * textarea. Rendered next to the textarea while it is mounted; the shared
 * SelectionActionMenu provides display, viewport clamping and the single
 * 8,000-char limit notice, exactly like the markdown preview toolbar.
 */
export function EditorSelectionToolbar({
  textareaRef,
  sourceKey,
  sourceTitle,
  sourcePath,
  target,
}: {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  sourceKey: string;
  sourceTitle: string;
  sourcePath?: string;
  target: MarkdownSelectionTarget;
}) {
  const { intl } = useZCodeIntl();
  // Scope change (file/session/target switch) must not let a stale snapshot
  // route to the new target — same rule as the markdown preview scope.
  const scopeKey = useMemo(
    () => ({}),
    [sourceKey, target.workspaceKey, target.sessionId, target.draftScopeKey],
  );
  const { state, close } = useTextareaSelection({ textareaRef, scopeKey });
  // Side-chat availability mirrors MarkdownSelectionTooltip: with an explicit
  // session the exact (workspace, sessionId) key resolves; with no session the
  // workspace fallback finds the draft pane's prewarm opener (MPS10).
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
