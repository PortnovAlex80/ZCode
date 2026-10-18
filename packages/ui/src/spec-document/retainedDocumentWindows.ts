import type { CodeViewerSidePaneTab } from "@/lib/workspaceSidePane.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";

export const RETAINED_DOCUMENT_ACTIVATE_EVENT =
  "zcode:activate-retained-document";
const STORAGE_KEY = "spec-harness:open-document-windows:v1";
export const INDEPENDENT_DOCUMENT_OPEN_EVENT =
  "zcode:open-independent-document";
export interface IndependentDocumentOpenRequest {
  workspacePath: string;
  workspaceIdentity?: string;
  parentSessionId: string | null;
  source: CodeViewerSource;
}
export function requestIndependentDocument(
  request: IndependentDocumentOpenRequest,
): void {
  window.dispatchEvent(
    new CustomEvent(INDEPENDENT_DOCUMENT_OPEN_EVENT, { detail: request }),
  );
}
export interface RetainedDocumentWindow {
  tab: CodeViewerSidePaneTab;
  workspacePath: string;
  workspaceIdentity?: string;
  parentSessionId: string | null;
  attachmentSide?: "left" | "right";
}
export interface RetainedDocumentActivation {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string | null;
  tabId: string;
  tab?: CodeViewerSidePaneTab;
}
/** Only local document descriptors, never transcripts, credentials or document bodies. */
export function readRetainedDocumentWindows(
  storage?: Pick<Storage, "getItem">,
): RetainedDocumentWindow[] {
  try {
    storage ??= globalThis.localStorage;
    const value = JSON.parse(storage?.getItem(STORAGE_KEY) || "null");
    if (value?.version !== 1 || !Array.isArray(value.windows)) return [];
    return value.windows
      .filter(
        (entry: RetainedDocumentWindow) =>
          entry &&
          typeof entry.workspacePath === "string" &&
          entry.workspacePath.trim() &&
          (entry.workspaceIdentity === undefined ||
            typeof entry.workspaceIdentity === "string") &&
          (entry.parentSessionId === null ||
            typeof entry.parentSessionId === "string") &&
          (entry.attachmentSide === undefined ||
            entry.attachmentSide === "left" ||
            entry.attachmentSide === "right") &&
          entry.tab?.type === "code-viewer" &&
          typeof entry.tab.id === "string" &&
          entry.tab.source?.type === "file" &&
          entry.tab.source.specDocument === true &&
          !entry.tab.source.workspaceRemoteSessionId &&
          typeof entry.tab.source.path === "string",
      )
      .slice(0, 24);
  } catch {
    return [];
  }
}
export function writeRetainedDocumentWindows(
  windows: RetainedDocumentWindow[],
  storage?: Pick<Storage, "setItem">,
): void {
  try {
    storage ??= globalThis.localStorage;
    storage?.setItem(STORAGE_KEY, JSON.stringify({ version: 1, windows }));
  } catch {
    /* Storage denial must not destroy the live owner. */
  }
}
export function activateRetainedDocument(entry: RetainedDocumentWindow): void {
  window.dispatchEvent(
    new CustomEvent<RetainedDocumentActivation>(
      RETAINED_DOCUMENT_ACTIVATE_EVENT,
      {
        detail: {
          workspacePath: entry.workspacePath,
          workspaceIdentity: entry.workspaceIdentity,
          sessionId: entry.parentSessionId,
          tabId: entry.tab.id,
          tab: entry.tab,
        },
      },
    ),
  );
}
export function retainedDocumentPlacementKey(
  entry: RetainedDocumentWindow,
): string {
  return `document:${JSON.stringify([entry.workspaceIdentity?.trim() || entry.workspacePath, entry.parentSessionId, entry.tab.id])}`;
}

export function documentSurfacePlacementKey(
  entry: RetainedDocumentWindow,
): string {
  return `document-surface:${retainedDocumentPlacementKey(entry)}`;
}

/** Seed only a new surface; an explicit native close must survive remount. */
export function initializeDocumentSurfaceIntent(
  key: string,
  storage?: Pick<Storage, "getItem" | "setItem">,
): void {
  try {
    storage ??= globalThis.localStorage;
    const intentKey = `zcode-popout-open:v1:${key}`;
    if (storage.getItem(intentKey) === null) storage.setItem(intentKey, "true");
  } catch {
    /* The inline open control stays available if persistence is denied. */
  }
}

const documentFocusers = new Map<
  string,
  { entry: RetainedDocumentWindow; focus: () => void; isOpen: boolean }
>();
export function registerRetainedDocumentFocus(
  entry: RetainedDocumentWindow,
  focus: () => void,
  isOpen: boolean,
): () => void {
  const registration = { entry, focus, isOpen };
  documentFocusers.set(entry.tab.id, registration);
  return () => {
    if (documentFocusers.get(entry.tab.id) === registration)
      documentFocusers.delete(entry.tab.id);
  };
}
export function focusRetainedDocument(tabId: string): boolean {
  const target = documentFocusers.get(tabId);
  target?.focus();
  return Boolean(target);
}
export function revealRetainedDocumentsForParent(
  scope: { workspacePath: string; workspaceIdentity?: string },
  sessionId: string | null,
): boolean {
  const normalize = (path: string) =>
    path.replaceAll("\\", "/").replace(/\/$/, "");
  const key = scope.workspaceIdentity?.trim() || normalize(scope.workspacePath);
  let revealed = false;
  for (const { entry, focus, isOpen } of documentFocusers.values()) {
    if (
      isOpen &&
      entry.parentSessionId === sessionId &&
      (entry.workspaceIdentity?.trim() || normalize(entry.workspacePath)) ===
        key
    ) {
      focus();
      revealed = true;
    }
  }
  return revealed;
}
