import { useSyncExternalStore } from "react";
import type { PaneWorkspaceScope } from "@/v4/paneLayoutStore.js";

export interface ConversationWindowEntry {
  id: string;
  scope: PaneWorkspaceScope;
  sessionId: string;
  title: string;
  placementKey?: string;
  readOnly?: boolean;
}

export const CONVERSATION_WINDOWS_KEY = "zcode-conversation-windows:v1";
type StoragePort = Pick<Storage, "getItem" | "setItem">;

export function conversationWindowKey(scope: PaneWorkspaceScope, sessionId: string): string {
  return JSON.stringify([
    scope.workspaceIdentity?.trim() || scope.workspacePath.replaceAll("\\", "/").replace(/\/$/, ""),
    scope.workspaceIdentity?.trim() ? "" : (scope.remoteSessionId ?? ""),
    sessionId,
  ]);
}

export function readConversationWindows(storage?: StoragePort): ConversationWindowEntry[] {
  try {
    storage ??= globalThis.localStorage;
    const value: unknown = JSON.parse(storage.getItem(CONVERSATION_WINDOWS_KEY) || "null");
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    const ids = new Set<string>();
    return value
      .filter((item): item is ConversationWindowEntry => {
        if (!item || typeof item !== "object") return false;
        const entry = item as ConversationWindowEntry;
        if (
          typeof entry.id !== "string" ||
          !/^[a-zA-Z0-9_-]{1,100}$/.test(entry.id) ||
          typeof entry.title !== "string" ||
          (entry.placementKey !== undefined && typeof entry.placementKey !== "string") ||
          (entry.readOnly !== undefined && typeof entry.readOnly !== "boolean") ||
          !entry.sessionId ||
          typeof entry.sessionId !== "string" ||
          !entry.scope ||
          typeof entry.scope.workspacePath !== "string" ||
          !entry.scope.workspacePath ||
          (entry.scope.workspaceIdentity !== undefined &&
            typeof entry.scope.workspaceIdentity !== "string") ||
          (entry.scope.remoteSessionId !== undefined &&
            typeof entry.scope.remoteSessionId !== "string")
        )
          return false;
        const key = conversationWindowKey(entry.scope, entry.sessionId);
        if (seen.has(key) || ids.has(entry.id)) return false;
        seen.add(key);
        ids.add(entry.id);
        return true;
      })
      .slice(0, 50);
  } catch {
    return [];
  }
}

let entries = readConversationWindows();
const listeners = new Set<() => void>();
const focusers = new Map<string, () => void>();
function publish(next: ConversationWindowEntry[]) {
  entries = next;
  try {
    localStorage.setItem(CONVERSATION_WINDOWS_KEY, JSON.stringify(entries));
  } catch {
    /* Keep live views usable if disk storage is unavailable. */
  }
  listeners.forEach((listener) => listener());
}
export function subscribeConversationWindows(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function useConversationWindows() {
  return useSyncExternalStore(
    subscribeConversationWindows,
    () => entries,
    () => entries,
  );
}
export function findConversationWindow(scope: PaneWorkspaceScope, sessionId: string | null) {
  return sessionId
    ? entries.find(
        (entry) =>
          conversationWindowKey(entry.scope, entry.sessionId) ===
          conversationWindowKey(scope, sessionId),
      )
    : undefined;
}
export function openConversationWindow(
  scope: PaneWorkspaceScope,
  sessionId: string,
  title: string,
  readOnly = false,
) {
  const existing = findConversationWindow(scope, sessionId);
  if (existing) {
    focusConversationWindow(existing.id);
    return existing;
  }
  const entry = {
    id: crypto.randomUUID(),
    scope: { ...scope },
    sessionId,
    title,
    readOnly,
    placementKey: conversationWindowKey(scope, sessionId),
  };
  publish([...entries, entry]);
  return entry;
}
export function closeConversationWindow(id: string) {
  publish(entries.filter((entry) => entry.id !== id));
}
export function bindConversationWindow(id: string, sessionId: string) {
  const current = entries.find((entry) => entry.id === id);
  if (!current) return;
  const collision = findConversationWindow(current.scope, sessionId);
  if (collision && collision.id !== id) {
    closeConversationWindow(id);
    focusConversationWindow(collision.id);
    return;
  }
  publish(entries.map((entry) => (entry.id === id ? { ...entry, sessionId } : entry)));
}
export function registerConversationWindowFocus(id: string, focus: () => void) {
  focusers.set(id, focus);
  return () => {
    if (focusers.get(id) === focus) focusers.delete(id);
  };
}
export function focusConversationWindow(id: string) {
  focusers.get(id)?.();
}
