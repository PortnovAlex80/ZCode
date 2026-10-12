import {
  DEFAULT_DISCUSSION_RECT,
  type DiscussionMode,
  type DiscussionRect,
} from "./specDiscussionGeometry.js";

export interface DocumentPresentationState {
  path: string | null;
  editing: boolean;
  scrollTop: number;
  activeThreadId: string | null;
  discussionsVisible: boolean;
  discussionMode: DiscussionMode;
  discussionRect: DiscussionRect;
}
export interface DocumentDraft {
  content: string;
  baseSha256: string;
}
type StoragePort = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export function documentPresentationKey(workspacePath: string, workspaceIdentity?: string): string {
  return `spec-harness-document-view:v1:${workspaceIdentity?.trim() || workspacePath.replaceAll("\\", "/").replace(/\/$/, "")}`;
}
export function relativeDocumentPath(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const path = value.replaceAll("\\", "/");
  return path.startsWith("/") ||
    /^[a-z]:/i.test(path) ||
    path.split("/").some((part) => !part || part === "." || part === "..")
    ? null
    : path;
}
export function defaultDocumentPresentation(): DocumentPresentationState {
  return {
    path: null,
    editing: false,
    scrollTop: 0,
    activeThreadId: null,
    discussionsVisible: false,
    discussionMode: "docked",
    discussionRect: { ...DEFAULT_DISCUSSION_RECT },
  };
}
function finite(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}
export function readDocumentPresentation(
  key: string,
  storage?: StoragePort,
): DocumentPresentationState {
  const defaults = defaultDocumentPresentation();
  try {
    storage ??= globalThis.localStorage;
    const value = JSON.parse(storage?.getItem(key) || "null");
    if (!value || value.version !== 1) return defaults;
    return {
      path: relativeDocumentPath(value.path),
      editing: value.editing === true,
      scrollTop: finite(value.scrollTop, 0),
      activeThreadId:
        typeof value.activeThreadId === "string" && value.activeThreadId
          ? value.activeThreadId
          : null,
      discussionsVisible: value.discussionsVisible === true,
      discussionMode: value.discussionMode === "floating" ? "floating" : "docked",
      discussionRect: {
        x: finite(value.discussionRect?.x, defaults.discussionRect.x),
        y: finite(value.discussionRect?.y, defaults.discussionRect.y),
        width: finite(value.discussionRect?.width, defaults.discussionRect.width),
        height: finite(value.discussionRect?.height, defaults.discussionRect.height),
      },
    };
  } catch {
    return defaults;
  }
}
export function writeDocumentPresentation(
  key: string,
  value: DocumentPresentationState,
  storage?: StoragePort,
): boolean {
  try {
    storage ??= globalThis.localStorage;
    if (!storage) return false;
    storage.setItem(key, JSON.stringify({ version: 1, ...value }));
    return true;
  } catch {
    return false;
  }
}
function draftKey(key: string, path: string) {
  return `${key}:draft:${JSON.stringify(path)}`;
}
export function readDocumentDraft(
  key: string,
  path: string,
  storage?: StoragePort,
): DocumentDraft | null {
  try {
    storage ??= globalThis.localStorage;
    const value = JSON.parse(storage?.getItem(draftKey(key, path)) || "null");
    return value?.version === 1 &&
      typeof value.content === "string" &&
      typeof value.baseSha256 === "string" &&
      value.baseSha256
      ? { content: value.content, baseSha256: value.baseSha256 }
      : null;
  } catch {
    return null;
  }
}
export function writeDocumentDraft(
  key: string,
  path: string,
  draft: DocumentDraft | null,
  storage?: StoragePort,
): boolean {
  try {
    storage ??= globalThis.localStorage;
    if (!storage) return false;
    if (draft) storage.setItem(draftKey(key, path), JSON.stringify({ version: 1, ...draft }));
    else storage.removeItem(draftKey(key, path));
    return true;
  } catch {
    return false;
  }
}
/** Disk remains the snapshot. The unsaved editor buffer retains its original save precondition. */
export function restoreDocumentDraft(
  snapshot: { content: string; sha256: string },
  draft: DocumentDraft | null,
) {
  if (!draft || draft.content === snapshot.content)
    return { content: snapshot.content, baseSha256: snapshot.sha256, conflict: false };
  return {
    content: draft.content,
    baseSha256: draft.baseSha256,
    conflict: draft.baseSha256 !== snapshot.sha256,
  };
}
