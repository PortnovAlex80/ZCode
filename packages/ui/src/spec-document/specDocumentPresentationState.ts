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
  legacyKey?: string,
): DocumentPresentationState {
  const defaults = defaultDocumentPresentation();
  try {
    storage ??= globalThis.localStorage;
    const value = JSON.parse(
      storage?.getItem(key) || (legacyKey ? storage?.getItem(legacyKey) : null) || "null",
    );
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
/**
 * 面板写入令牌（跨窗口经共享存储生效）。
 *
 * 原因：detach/return 交接期间，源窗口面板可能仍有一个迟到的草稿写入在途中；
 * 若它晚于接管面板（子窗口）的持久化落盘，就会用旧缓冲覆盖子面板已保存的草稿。
 * 修复：面板卸载清理时把自己的令牌标记为 retired；带已 retired 令牌的草稿写入
 * 被静默跳过（草稿由接管面板负责），活跃面板不登记令牌、写入行为与原先一致。
 */
export type DocumentPaneWriteToken = string;
const RETIRED_TOKEN_LIMIT = 8;
function retiredTokensKey(key: string) {
  return `${key}:pane-writer-retired`;
}
export function newDocumentPaneWriteToken(): DocumentPaneWriteToken {
  const random = globalThis.crypto;
  if (random && typeof random.randomUUID === "function") return random.randomUUID();
  return `pane-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}
export function retireDocumentPaneWrites(
  key: string,
  token: DocumentPaneWriteToken,
  storage?: StoragePort,
): void {
  try {
    storage ??= globalThis.localStorage;
    if (!storage) return;
    const raw = JSON.parse(storage.getItem(retiredTokensKey(key)) || "null");
    const retired =
      raw?.version === 1 &&
      Array.isArray(raw.retired) &&
      raw.retired.every((item: unknown) => typeof item === "string")
        ? (raw.retired as string[])
        : [];
    if (retired[retired.length - 1] === token) return;
    retired.push(token);
    storage.setItem(
      retiredTokensKey(key),
      JSON.stringify({ version: 1, retired: retired.slice(-RETIRED_TOKEN_LIMIT) }),
    );
  } catch {
    /* 存储不可用时无法拦截迟到写入；行为退回到先前的最后写入者胜出。 */
  }
}
export function documentPaneWritesRetired(
  key: string,
  token: DocumentPaneWriteToken,
  storage?: StoragePort,
): boolean {
  try {
    storage ??= globalThis.localStorage;
    const raw = JSON.parse(storage?.getItem(retiredTokensKey(key)) || "null");
    return raw?.version === 1 && Array.isArray(raw.retired) ? raw.retired.includes(token) : false;
  } catch {
    return false;
  }
}
export function writeDocumentDraft(
  key: string,
  path: string,
  draft: DocumentDraft | null,
  storage?: StoragePort,
  token?: DocumentPaneWriteToken,
): boolean {
  try {
    storage ??= globalThis.localStorage;
    if (!storage) return false;
    // 已退役面板的迟到写入不得覆盖接管面板已经持久化的草稿。
    if (token && documentPaneWritesRetired(key, token, storage)) return true;
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

/**
 * 缺失文档的可恢复状态（D-01）。
 *
 * 原因：恢复的持久化 path 指向已被删除/移动的文件时，面板只显示原始报错，
 * 过期 path 仍留在持久化视图里，下次重开还会再失败一次；草稿虽然还在存储中，
 * 但用户看不到任何可恢复的说明。
 * 修复：读取持久化文档失败且错误表明文件缺失时，清掉过期的 path/线程选择/滚动位置
 * （布局与编辑模式保留），草稿条目原样保留——文件回来或用户再次选择该文件时，
 * open() 会通过 readDocumentDraft 恢复未保存草稿。
 */
export function isMissingDocumentError(cause: unknown): boolean {
  if (!cause) return false;
  const code = (cause as { code?: unknown }).code;
  if (code === "ENOENT" || code === "ENOTDIR") return true;
  return typeof cause === "object"
    ? /ENOENT|ENOTDIR|no such file/i.test(String((cause as Error).message ?? cause))
    : /ENOENT|ENOTDIR|no such file/i.test(String(cause));
}
export function recoverMissingDocumentPresentation(
  key: string,
  storage?: StoragePort,
): DocumentPresentationState | null {
  try {
    storage ??= globalThis.localStorage;
    if (!storage) return null;
    const previous = readDocumentPresentation(key, storage);
    if (!previous.path) return previous;
    const recovered: DocumentPresentationState = {
      ...previous,
      path: null,
      activeThreadId: null,
      discussionsVisible: false,
      scrollTop: 0,
    };
    if (!writeDocumentPresentation(key, recovered, storage)) return null;
    return recovered;
  } catch {
    return null;
  }
}
