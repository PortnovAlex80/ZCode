import type { CodeViewerSidePaneTab } from "@/lib/workspaceSidePane.js";

export const RETAINED_DOCUMENT_ACTIVATE_EVENT = "zcode:activate-retained-document";
const STORAGE_KEY = "spec-harness:open-document-windows:v1";
export interface RetainedDocumentWindow {
  tab: CodeViewerSidePaneTab;
  workspacePath: string;
  workspaceIdentity?: string;
  parentSessionId: string | null;
}
export interface RetainedDocumentActivation {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string | null;
  tabId: string;
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
          (entry.workspaceIdentity === undefined || typeof entry.workspaceIdentity === "string") &&
          (entry.parentSessionId === null || typeof entry.parentSessionId === "string") &&
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
    new CustomEvent<RetainedDocumentActivation>(RETAINED_DOCUMENT_ACTIVATE_EVENT, {
      detail: {
        workspacePath: entry.workspacePath,
        workspaceIdentity: entry.workspaceIdentity,
        sessionId: entry.parentSessionId,
        tabId: entry.tab.id,
      },
    }),
  );
}
export function retainedDocumentPlacementKey(entry: RetainedDocumentWindow): string {
  return `document:${JSON.stringify([entry.workspaceIdentity?.trim() || entry.workspacePath, entry.parentSessionId, entry.tab.id])}`;
}
