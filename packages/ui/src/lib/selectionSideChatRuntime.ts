import type { ConversationSelectionReference } from "@/lib/conversationSelectionReference.js";

const pendingCreations = new Map<string, Promise<string>>();
const blockedChildSessionIds = new Set<string>();
const listeners = new Set<() => void>();
type SelectionSideChatOpener = (reference?: ConversationSelectionReference) => Promise<void>;
interface SelectionSideChatOpenerEntry {
  focused: boolean;
  referenceBlocked: boolean;
  open: SelectionSideChatOpener;
}
const openers = new Map<string, Map<symbol, SelectionSideChatOpenerEntry>>();

export function buildSelectionSideChatKey(workspaceKey: string, parentSessionId: string): string {
  return `${workspaceKey}\0${parentSessionId}`;
}

/**
 * 同一个用户手势在 command pending 期间只创建一次；完成后立即释放 parent scope，
 * 让固定入口的下一次点击可以创建新的 child，而不是退化回旧的单例绑定。
 */
export async function createSelectionSideChat(
  key: string,
  create: () => Promise<string>,
): Promise<string> {
  const current = pendingCreations.get(key);
  if (current) return current;
  const pending = create().finally(() => {
    if (pendingCreations.get(key) === pending) {
      pendingCreations.delete(key);
    }
    emitChange();
  });
  pendingCreations.set(key, pending);
  return pending;
}

export function clearSelectionSideChat(childSessionId: string): void {
  const changed = blockedChildSessionIds.delete(childSessionId);
  if (!changed) return;
  emitChange();
}

export function setSelectionSideChatBlocked(childSessionId: string, blocked: boolean): void {
  const changed = blocked
    ? !blockedChildSessionIds.has(childSessionId)
    : blockedChildSessionIds.has(childSessionId);
  if (!changed) return;
  if (blocked) blockedChildSessionIds.add(childSessionId);
  else blockedChildSessionIds.delete(childSessionId);
  emitChange();
}

export function isSelectionSideChatBlocked(childSessionId: string): boolean {
  return blockedChildSessionIds.has(childSessionId);
}

export function subscribeSelectionSideChatRuntime(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Side Pane 的固定入口位于会话 Provider 外，不能自己拼协议命令。
 * 由已挂载的主 SessionPane 注册创建能力，launcher 只按 workspace + parent 路由；
 * 同一父会话被多个分屏展示时优先交给 focused pane，保持命令 owner 与当前输入焦点一致。
 */
export function registerSelectionSideChatOpener(
  key: string,
  opener: SelectionSideChatOpener,
  focused: boolean,
  referenceBlocked = false,
): () => void {
  const token = Symbol(key);
  const scoped = openers.get(key) ?? new Map<symbol, SelectionSideChatOpenerEntry>();
  scoped.set(token, { focused, open: opener, referenceBlocked });
  openers.set(key, scoped);
  emitChange();

  return () => {
    const current = openers.get(key);
    current?.delete(token);
    if (current?.size === 0) openers.delete(key);
    emitChange();
  };
}

function pickPreferredOpener(candidates: SelectionSideChatOpenerEntry[]) {
  return candidates.find((candidate) => candidate.focused) ?? candidates[0];
}

function getSelectionSideChatOpener(key: string): SelectionSideChatOpenerEntry | undefined {
  const scoped = openers.get(key);
  if (!scoped?.size) return undefined;
  return pickPreferredOpener(Array.from(scoped.values()));
}

function getSelectionSideChatOpenerForWorkspace(
  workspaceKey: string,
): SelectionSideChatOpenerEntry | undefined {
  // Workspace-scoped fallback: a markdown preview selection target carries
  // sessionId: null when no main conversation is active, so it cannot build the
  // exact (workspace, parentSessionId) key. The draft SessionPane still registers
  // an opener under its prewarmed session id in that state; route to it instead
  // of disabling the side-chat action outright. Focused entry wins, mirroring
  // the exact-key lookup.
  const prefix = `${workspaceKey}\0`;
  const candidates: SelectionSideChatOpenerEntry[] = [];
  for (const [key, scoped] of openers) {
    if (!key.startsWith(prefix)) continue;
    candidates.push(...scoped.values());
  }
  if (!candidates.length) return undefined;
  return pickPreferredOpener(candidates);
}

export function getSelectionSideChatOpenState(key: string): "ready" | "blocked" | "unavailable" {
  const target = getSelectionSideChatOpener(key);
  return !target ? "unavailable" : target.referenceBlocked ? "blocked" : "ready";
}

/**
 * Same state contract as getSelectionSideChatOpenState, but resolves any opener
 * registered under the workspace (any parent session id). Used by markdown
 * preview selections whose target has no active session id.
 */
export function getSelectionSideChatOpenStateForWorkspace(
  workspaceKey: string,
): "ready" | "blocked" | "unavailable" {
  const target = getSelectionSideChatOpenerForWorkspace(workspaceKey);
  return !target ? "unavailable" : target.referenceBlocked ? "blocked" : "ready";
}

export function requestSelectionSideChatOpen(
  key: string,
  reference?: ConversationSelectionReference,
): boolean {
  const target = getSelectionSideChatOpener(key);
  if (!target || (reference && target.referenceBlocked)) return false;
  if (reference) void target.open(reference);
  else void target.open();
  return true;
}

export function requestSelectionSideChatOpenForWorkspace(
  workspaceKey: string,
  reference?: ConversationSelectionReference,
): boolean {
  const target = getSelectionSideChatOpenerForWorkspace(workspaceKey);
  if (!target || (reference && target.referenceBlocked)) return false;
  if (reference) void target.open(reference);
  else void target.open();
  return true;
}

function emitChange(): void {
  for (const listener of listeners) listener();
}
