import { useCallback, useLayoutEffect, useSyncExternalStore } from "react";

/** Read-only identity of the focused native pane. Never carries conversation content or grants. */
export interface NativeExecutionSource {
  paneId: string;
  sessionId: string | null;
  phase: "preparing" | "ready" | "error";
  error?: string;
}

export function nativeExecutionSource(input: {
  paneId: string;
  sessionId: string | null;
  snapshotSessionId: string | null;
  projectionStatus: string;
  provider?: string;
  model?: string;
  error?: string | null;
}): NativeExecutionSource {
  if (input.error)
    return { paneId: input.paneId, sessionId: input.sessionId, phase: "error", error: input.error };
  const ready = Boolean(
    input.sessionId &&
    input.snapshotSessionId === input.sessionId &&
    input.projectionStatus === "live" &&
    input.provider?.trim() &&
    input.model?.trim(),
  );
  return { paneId: input.paneId, sessionId: input.sessionId, phase: ready ? "ready" : "preparing" };
}

interface WorkspaceSources {
  owners: Map<string, { token: symbol; source: NativeExecutionSource }>;
  current: NativeExecutionSource | null;
  listeners: Set<() => void>;
}
const workspaces = new Map<string, WorkspaceSources>();
function workspaceSources(workspaceKey: string): WorkspaceSources {
  let state = workspaces.get(workspaceKey);
  if (!state) {
    state = { owners: new Map(), current: null, listeners: new Set() };
    workspaces.set(workspaceKey, state);
  }
  return state;
}
function refresh(state: WorkspaceSources) {
  // An ambiguous focused owner must not route a document discussion to another pane.
  state.current = state.owners.size === 1 ? [...state.owners.values()][0]!.source : null;
  for (const listener of state.listeners) listener();
}

export function publishNativeExecutionSource(
  workspaceKey: string,
  source: NativeExecutionSource,
): () => void {
  const state = workspaceSources(workspaceKey);
  const token = Symbol("native-execution-source");
  state.owners.set(source.paneId, { token, source });
  refresh(state);
  return () => {
    if (state.owners.get(source.paneId)?.token !== token) return;
    state.owners.delete(source.paneId);
    refresh(state);
  };
}

export function getNativeExecutionSource(workspaceKey: string): NativeExecutionSource | null {
  return workspaceSources(workspaceKey).current;
}
export function subscribeNativeExecutionSource(
  workspaceKey: string,
  listener: () => void,
): () => void {
  const state = workspaceSources(workspaceKey);
  state.listeners.add(listener);
  return () => {
    state.listeners.delete(listener);
  };
}

export function usePublishNativeExecutionSource(
  workspaceKey: string,
  enabled: boolean,
  source: NativeExecutionSource,
): void {
  useLayoutEffect(() => {
    if (!enabled) return;
    return publishNativeExecutionSource(workspaceKey, source);
  }, [workspaceKey, enabled, source.paneId, source.sessionId, source.phase, source.error]);
}

export function useNativeExecutionSource(workspaceKey: string): NativeExecutionSource | null {
  const subscribe = useCallback(
    (listener: () => void) => subscribeNativeExecutionSource(workspaceKey, listener),
    [workspaceKey],
  );
  const snapshot = useCallback(() => getNativeExecutionSource(workspaceKey), [workspaceKey]);
  return useSyncExternalStore(subscribe, snapshot, () => null);
}

/** Shell identity remains authoritative; the draft is only a fallback execution-config source. */
export function resolveSpecExecutionSessionId(
  parentSessionId: string | null,
  source: NativeExecutionSource | null,
): string | null {
  return parentSessionId ?? (source?.phase === "ready" ? source.sessionId : null);
}
