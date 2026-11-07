import { requestIndependentDocument } from "./retainedDocumentWindows.js";
import {
  documentPresentationKey,
  readDocumentPresentation,
  writeDocumentPresentation,
} from "./specDocumentPresentationState.js";

/**
 * CORR-1 (user ruling 2026-11-07): native file opening stays native; the fork's
 * document capabilities (discussion, separate window, side conversation) moved
 * from the "+" launcher / document tab into the file tree context menu. This
 * module is the single dispatch surface for those entry points.
 *
 * Minimal-invasive decision (documented per the ruling): "Discuss document" and
 * "Open in separate window" reuse the existing retained/independent document
 * window machinery (INDEPENDENT_DOCUMENT_OPEN_EVENT). No new window/session
 * entities are created; the discussion itself is owned by SpecDocumentPane
 * inside that window, exactly as before. The side conversation reuses the
 * launcher mechanics (selection-side-conversation opener registered by the
 * mounted main SessionPane) via a shell event; the request intentionally carries
 * no synthetic selection reference — the row path only names the file context,
 * and fabricating a ConversationSelectionReference from a file name would abuse
 * the message-selection contract.
 */

export const WORKSPACE_FILE_SIDE_CONVERSATION_EVENT =
  "zcode:workspace-file-side-conversation";

/**
 * Pane-level discussion activation for a document that is ALREADY open in a
 * mounted SpecDocumentPane (independent window or returned tab). The
 * presentation-state handoff below only reaches panes mounted afterwards, so
 * the discuss entry point also announces the request live; panes that do not
 * hold this exact document ignore it. threadId is absent on purpose: the pane
 * selects an existing thread or starts the document-scope discussion.
 */
export const WORKSPACE_DOCUMENT_DISCUSS_EVENT = "zcode:workspace-document-discuss";

export interface WorkspaceDocumentDiscussRequest {
  workspacePath: string;
  workspaceIdentity?: string;
  /** Workspace-relative document path, matching the pane's document identity. */
  documentPath: string;
  /**
   * MPS12 (2026-11-08): selected text carried by the "Discuss fragment" entry.
   * The pane prefills the question draft of the discussion it activates; it is
   * a convenience prefill, never an auto-sent question.
   */
  quote?: string;
}

export interface WorkspaceFileEntryPointRequest {
  workspacePath: string;
  workspaceIdentity?: string;
  /** Absolute file path of the tree row the menu was opened on. */
  path: string;
  /** File name; becomes the document window/tab title. */
  name: string;
}

function toDocumentSource(options: WorkspaceFileEntryPointRequest) {
  return {
    type: "file",
    // The retained-window pipeline only accepts fork document sources; this flag
    // is what keeps the window on SpecDocumentPane instead of a native preview.
    specDocument: true,
    workspacePath: options.workspacePath,
    ...(options.workspaceIdentity
      ? { workspaceIdentity: options.workspaceIdentity }
      : {}),
    path: options.path,
    title: options.name,
  } as const;
}

/** Open the document in its own retained window ("Открыть в отдельном окне"). */
export function openWorkspaceFileDocumentWindow(
  options: WorkspaceFileEntryPointRequest,
): void {
  requestIndependentDocument({
    workspacePath: options.workspacePath,
    ...(options.workspaceIdentity
      ? { workspaceIdentity: options.workspaceIdentity }
      : {}),
    // The file tree does not know the active session; the host (AnimatedSidePanePanel)
    // resolves parentSessionId from the current workspace/session state.
    parentSessionId: null,
    source: toDocumentSource(options),
  });
}

/**
 * MPS12 (2026-11-08) quote handoff for a pane that mounts AFTER the entry call
 * (the freshly opened independent document window): window events fired by
 * discussWorkspaceFileDocument are missed because the pane's listener does not
 * exist yet. Plumbing choice (simplest honest option, documented per the task):
 * a ONE-SHOT module-level slot instead of a persisted presentation-state field.
 * Document popouts host their React subtree in the opener's renderer
 * (SpecPopoutRegionPortal moves a single DOM host between documents), so the
 * pane consumes this slot in the same module instance that staged it. The slot
 * is deliberately not localStorage-backed: a persisted quote would resurrect a
 * stale prefill after a renderer reload or a later unrelated "Discuss
 * document", while one-shot module state dies with the context. Consumption is
 * unconditional (first consumer wins) so a quote can never surface long after
 * its selection happened.
 */
interface PendingDiscussQuote {
  workspacePath: string;
  workspaceIdentity?: string;
  documentPath: string;
  quote: string;
}
let pendingDiscussQuote: PendingDiscussQuote | null = null;

function stagePendingDiscussQuote(slot: PendingDiscussQuote): void {
  pendingDiscussQuote = slot;
}

/**
 * One-shot consumption by a mounting/activating pane. Returns the staged quote
 * only when workspace and relative document path match; any other consumer
 * clears the slot (returns null) so a foreign activation can never replay the
 * quote later.
 */
export function consumePendingDiscussQuote(scope: {
  workspacePath: string;
  workspaceIdentity?: string;
  documentPath: string;
}): string | null {
  const staged = pendingDiscussQuote;
  if (!staged) return null;
  pendingDiscussQuote = null;
  const sameWorkspace =
    (staged.workspaceIdentity?.trim() || staged.workspacePath) ===
    (scope.workspaceIdentity?.trim() || scope.workspacePath);
  const sameDocument =
    staged.documentPath.replaceAll("\\", "/") ===
    scope.documentPath.replaceAll("\\", "/");
  return sameWorkspace && sameDocument ? staged.quote : null;
}

/**
 * Open the document window with the discussion dock visible
 * ("Обсудить документ"). Two handoffs, covering both mount orders:
 * - presentation state (path + discussionsVisible) arms panes mounted afterwards
 *   (the freshly opened window);
 * - the live discuss event reveals the dock in a pane that already holds this
 *   document (an already-open window/tab gets focused, not remounted).
 * MPS12: an optional quote rides both handoffs (one-shot slot for the fresh
 * mount, event payload for the already-mounted pane) and prefills the question
 * draft of the discussion the pane activates — it never auto-sends anything.
 */
export function discussWorkspaceFileDocument(options: {
  request: WorkspaceFileEntryPointRequest;
  /** Workspace-relative document path (presentation state stores relative paths). */
  relativeDocumentPath: string;
  /** MPS12: selected text to prefill the new-thread question draft (optional). */
  quote?: string;
}): void {
  const key = documentPresentationKey(
    options.request.workspacePath,
    options.request.workspaceIdentity,
  );
  const previous = readDocumentPresentation(key);
  // activeThreadId is cleared because it may belong to a previously shown
  // document; the pane reselects (or starts) a thread for this document.
  writeDocumentPresentation(key, {
    ...previous,
    path: options.relativeDocumentPath,
    activeThreadId: null,
    discussionsVisible: true,
  });
  // Staged before the window request: the pane may mount during it.
  if (options.quote) {
    stagePendingDiscussQuote({
      workspacePath: options.request.workspacePath,
      ...(options.request.workspaceIdentity
        ? { workspaceIdentity: options.request.workspaceIdentity }
        : {}),
      documentPath: options.relativeDocumentPath,
      quote: options.quote,
    });
  }
  openWorkspaceFileDocumentWindow(options.request);
  if (
    typeof window === "undefined" ||
    typeof window.dispatchEvent !== "function" ||
    typeof CustomEvent === "undefined"
  )
    return;
  window.dispatchEvent(
    new CustomEvent<WorkspaceDocumentDiscussRequest>(
      WORKSPACE_DOCUMENT_DISCUSS_EVENT,
      {
        detail: {
          workspacePath: options.request.workspacePath,
          ...(options.request.workspaceIdentity
            ? { workspaceIdentity: options.request.workspaceIdentity }
            : {}),
          documentPath: options.relativeDocumentPath,
          ...(options.quote ? { quote: options.quote } : {}),
        },
      },
    ),
  );
}

/** Ask the shell to open a side conversation ("Боковой диалог") for a file row. */
export function requestWorkspaceFileSideConversation(
  request: WorkspaceFileEntryPointRequest,
): void {
  if (
    typeof window === "undefined" ||
    typeof window.dispatchEvent !== "function" ||
    typeof CustomEvent === "undefined"
  )
    return;
  window.dispatchEvent(
    new CustomEvent<WorkspaceFileEntryPointRequest>(
      WORKSPACE_FILE_SIDE_CONVERSATION_EVENT,
      { detail: request },
    ),
  );
}
