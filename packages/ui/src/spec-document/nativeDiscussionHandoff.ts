import { getSpecThreadStore, type SpecThread } from "./specThread.js";
import { persistV4ComposerDraft, readV4ComposerDraft } from "../v4/composer/composerDraftStore.js";
import { useSyncExternalStore } from "react";
import {
  documentPresentationKey,
  readDocumentPresentation,
  relativeDocumentPath,
  writeDocumentPresentation,
} from "./specDocumentPresentationState.js";

export const MANAGED_NATIVE_DISCUSSION_OPEN_EVENT = "spec-harness:open-managed-discussion";
export interface ManagedNativeDiscussionOpenRequest {
  workspacePath: string;
  workspaceIdentity?: string;
  documentPath: string;
  threadId: string;
}

export interface NativeDiscussionOwnerScope {
  workspacePath: string;
  workspaceIdentity?: string;
  threadId: string;
  sessionId: string;
}

export interface ManagedNativeDiscussionOwner {
  threadId: string;
  sessionId: string;
  ownerToken: symbol | null;
}
interface NativeDiscussionOwner {
  snapshot: ManagedNativeDiscussionOwner;
  activate: (() => void) | null;
}
const nativeDiscussionOwners = new Map<string, NativeDiscussionOwner>();
const nativeDiscussionOwnerListeners = new Map<string, Set<() => void>>();
const hydratedManagedWorkspaces = new Set<string>();
const removedDurableOwners = new Set<string>();
export function specThreadStorageKey(
  workspacePath: string,
  workspaceIdentity: string | undefined,
): string {
  return `spec-harness-native:v1:${workspaceIdentity?.trim() || workspacePath}`;
}
function sessionKey(scope: Omit<NativeDiscussionOwnerScope, "threadId">): string {
  const workspace =
    scope.workspaceIdentity?.trim() || scope.workspacePath.replaceAll("\\", "/").replace(/\/$/, "");
  if (!workspace || !scope.sessionId || scope.sessionId === "__draft__") {
    throw new Error("A workspace and bound native session are required.");
  }
  return JSON.stringify([workspace, scope.sessionId]);
}
function notifyOwner(key: string) {
  for (const listener of nativeDiscussionOwnerListeners.get(key) ?? []) listener();
}

function hydrateManagedWorkspace(
  workspacePath: string,
  workspaceIdentity: string | undefined,
): void {
  const workspace = workspaceIdentity?.trim() || workspacePath;
  if (hydratedManagedWorkspaces.has(workspace) || typeof localStorage === "undefined") return;
  // Cache initialization during lookup prevents the task catalog from admitting
  // a saved child before a Documents pane has mounted. Invalid Spec bindings
  // cannot be used by Documents and leave unrelated stock sessions unchanged.
  try {
    const store = getSpecThreadStore(
      specThreadStorageKey(workspacePath, workspaceIdentity),
      workspace,
    );
    let durable = new Map<string, string>();
    const refresh = () => {
      const next = new Map<string, string>();
      for (const thread of store.get())
        if (thread.id.trim() && thread.sessionId?.trim() && thread.sessionId !== "__draft__") {
          const scope = {
            workspacePath,
            workspaceIdentity,
            threadId: thread.id,
            sessionId: thread.sessionId,
          };
          const key = sessionKey(scope);
          const existing = nativeDiscussionOwners.get(key);
          if (existing && existing.snapshot.threadId !== thread.id) continue;
          next.set(key, thread.id);
          removedDurableOwners.delete(key);
          // Repeated storage refreshes retain the exact snapshot object expected by
          // useSyncExternalStore, including any current mounted ownership token.
          if (!existing) {
            nativeDiscussionOwners.set(key, {
              snapshot: { threadId: thread.id, sessionId: thread.sessionId, ownerToken: null },
              activate: null,
            });
            notifyOwner(key);
          }
        }
      for (const [key, threadId] of durable)
        if (!next.has(key)) {
          const existing = nativeDiscussionOwners.get(key);
          if (existing?.snapshot.threadId !== threadId) continue;
          if (existing.snapshot.ownerToken) removedDurableOwners.add(key);
          else {
            nativeDiscussionOwners.delete(key);
            removedDurableOwners.delete(key);
            notifyOwner(key);
          }
        }
      durable = next;
    };
    // Mark before notifying readers to avoid reentrant subscription creation.
    hydratedManagedWorkspaces.add(workspace);
    try {
      refresh();
    } catch (cause) {
      hydratedManagedWorkspaces.delete(workspace);
      throw cause;
    }
    store.subscribe(() => {
      try {
        refresh();
      } catch {
        /* Corrupt durable bindings cannot replace accepted identities. */
      }
    });
  } catch {
    return;
  }
}

export function registerManagedNativeDiscussion(scope: NativeDiscussionOwnerScope): void {
  if (!scope.threadId) throw new Error("A saved discussion is required.");
  const key = sessionKey(scope);
  const existing = nativeDiscussionOwners.get(key);
  if (existing) {
    if (existing.snapshot.threadId !== scope.threadId)
      throw new Error("This native session is already bound to another document discussion.");
    return;
  }
  nativeDiscussionOwners.set(key, {
    snapshot: { threadId: scope.threadId, sessionId: scope.sessionId, ownerToken: null },
    activate: null,
  });
  notifyOwner(key);
}

export function forgetManagedNativeDiscussion(scope: NativeDiscussionOwnerScope): void {
  const key = sessionKey(scope);
  if (nativeDiscussionOwners.get(key)?.snapshot.threadId !== scope.threadId) return;
  nativeDiscussionOwners.delete(key);
  removedDurableOwners.delete(key);
  notifyOwner(key);
}

export function readNativeDiscussionOwner(scope: NativeDiscussionOwnerScope): symbol | null {
  return nativeDiscussionOwners.get(sessionKey(scope))?.snapshot.ownerToken ?? null;
}
export function subscribeNativeDiscussionOwner(
  scope: Omit<NativeDiscussionOwnerScope, "threadId">,
  listener: () => void,
): () => void {
  const key = sessionKey(scope);
  const listeners = nativeDiscussionOwnerListeners.get(key) ?? new Set<() => void>();
  nativeDiscussionOwnerListeners.set(key, listeners);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) nativeDiscussionOwnerListeners.delete(key);
  };
}
export function claimNativeDiscussionOwner(
  scope: NativeDiscussionOwnerScope,
  token: symbol,
  activate: () => void,
): boolean {
  if (!scope.threadId) throw new Error("A saved discussion is required.");
  const key = sessionKey(scope);
  const owner = nativeDiscussionOwners.get(key);
  if (
    owner &&
    (owner.snapshot.threadId !== scope.threadId ||
      (owner.snapshot.ownerToken && owner.snapshot.ownerToken !== token))
  )
    return false;
  if (owner?.snapshot.ownerToken === token) return true;
  nativeDiscussionOwners.set(key, {
    snapshot: { threadId: scope.threadId, sessionId: scope.sessionId, ownerToken: token },
    activate,
  });
  notifyOwner(key);
  return true;
}
export function releaseNativeDiscussionOwner(
  scope: NativeDiscussionOwnerScope,
  token: symbol,
): void {
  const key = sessionKey(scope);
  const owner = nativeDiscussionOwners.get(key);
  if (owner?.snapshot.ownerToken !== token || owner.snapshot.threadId !== scope.threadId) return;
  if (removedDurableOwners.delete(key)) {
    nativeDiscussionOwners.delete(key);
    notifyOwner(key);
    return;
  }
  // Keep the managed identity after close: the general task catalog must not take
  // over this child and race a later Documents mount for the same native draft.
  nativeDiscussionOwners.set(key, {
    snapshot: { ...owner.snapshot, ownerToken: null },
    activate: null,
  });
  notifyOwner(key);
}
export function activateNativeDiscussionOwner(scope: NativeDiscussionOwnerScope): boolean {
  return activateManagedNativeDiscussionOwner(
    scope.workspacePath,
    scope.workspaceIdentity,
    scope.sessionId,
  );
}
export function readManagedNativeDiscussionOwner(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  sessionId: string | null,
): ManagedNativeDiscussionOwner | null {
  if (!sessionId || sessionId === "__draft__") return null;
  hydrateManagedWorkspace(workspacePath, workspaceIdentity);
  return (
    nativeDiscussionOwners.get(sessionKey({ workspacePath, workspaceIdentity, sessionId }))
      ?.snapshot ?? null
  );
}
export function useManagedNativeDiscussionOwner(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  sessionId: string | null,
) {
  return useSyncExternalStore(
    (listener) =>
      !sessionId || sessionId === "__draft__"
        ? () => {}
        : subscribeNativeDiscussionOwner({ workspacePath, workspaceIdentity, sessionId }, listener),
    () => readManagedNativeDiscussionOwner(workspacePath, workspaceIdentity, sessionId),
  );
}
export function activateManagedNativeDiscussionOwner(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  sessionId: string,
): boolean {
  const managed = readManagedNativeDiscussionOwner(workspacePath, workspaceIdentity, sessionId);
  if (!managed) return false;
  const owner = nativeDiscussionOwners.get(
    sessionKey({ workspacePath, workspaceIdentity, sessionId }),
  );
  if (owner?.activate) {
    owner.activate();
    return true;
  }
  // A released owner retains identity only. Reopen its saved document instead of
  // admitting this child into a stock task pane or calling an unmounted view.
  if (
    typeof window === "undefined" ||
    typeof window.dispatchEvent !== "function" ||
    typeof CustomEvent === "undefined"
  )
    return false;
  try {
    const thread = getSpecThreadStore(
      specThreadStorageKey(workspacePath, workspaceIdentity),
      workspaceIdentity?.trim() || workspacePath,
    )
      .get()
      .find((item) => item.id === managed.threadId && item.sessionId === sessionId);
    const documentPath = relativeDocumentPath(thread?.documentPath);
    if (!thread || !documentPath) return false;
    const key = documentPresentationKey(workspacePath, workspaceIdentity);
    const previous = readDocumentPresentation(key);
    if (
      !writeDocumentPresentation(key, {
        ...previous,
        path: documentPath,
        activeThreadId: thread.id,
        discussionsVisible: true,
        scrollTop: previous.path === documentPath ? previous.scrollTop : 0,
      })
    )
      return false;
    window.dispatchEvent(
      new CustomEvent<ManagedNativeDiscussionOpenRequest>(MANAGED_NATIVE_DISCUSSION_OPEN_EVENT, {
        detail: {
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          documentPath,
          threadId: thread.id,
        },
      }),
    );
    return true;
  } catch {
    return false;
  }
}

export function transferNativeDiscussionDraft(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  sessionId: string,
  question: string,
): void {
  if (!sessionId || sessionId === "__draft__")
    throw new Error("A bound native discussion is required.");
  if (!question) return;
  const existing = readV4ComposerDraft(workspacePath, workspaceIdentity, sessionId);
  if (
    existing &&
    existing.text !== question &&
    (existing.text || existing.editorStateJson || existing.mention)
  ) {
    throw new Error(
      "A different draft already exists in this native discussion. Your question is retained.",
    );
  }
  if (
    !persistV4ComposerDraft(workspacePath, workspaceIdentity, sessionId, {
      ...existing,
      text: question,
    })
  ) {
    throw new Error("The native composer draft could not be saved. Your question is retained.");
  }
}

export function nativeDiscussionHandoffSession(
  ownerSessionId: string | null,
  thread: Pick<SpecThread, "sessionId" | "pending" | "initialQuestion" | "discussionStartRowId">,
  projection: { status: string; snapshotSessionId: string | null; dispatching: boolean },
): string | null {
  // Once admitted, reconnect/error/hidden states keep the native controller as owner.
  if (ownerSessionId && ownerSessionId === thread.sessionId) return ownerSessionId;
  if (
    ownerSessionId ||
    !thread.sessionId ||
    thread.pending ||
    thread.initialQuestion ||
    thread.discussionStartRowId === undefined ||
    projection.status !== "live" ||
    projection.snapshotSessionId !== thread.sessionId ||
    projection.dispatching
  )
    return null;
  return thread.sessionId;
}
