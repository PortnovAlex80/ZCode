export type DiscussionWriterPhase = "checking" | "owned" | "busy" | "unsupported" | "error";
export interface DiscussionLockManager {
  request(
    name: string,
    options: { mode: "exclusive"; ifAvailable: true },
    callback: (lock: unknown | null) => Promise<void>,
  ): Promise<unknown>;
}
const requiredWorkspaces = new Set<string>();
const owners = new Map<string, symbol>();
export function discussionWriterAllowed(workspaceKey: string): boolean {
  return !requiredWorkspaces.has(workspaceKey) || owners.has(workspaceKey);
}
/** Web Locks arbitrate the whole durable thread array across renderers sharing the origin. */
export function acquireDiscussionWriter(
  workspaceKey: string,
  locks: DiscussionLockManager | undefined,
  changed: (phase: DiscussionWriterPhase) => void,
): () => void {
  requiredWorkspaces.add(workspaceKey);
  const token = Symbol(workspaceKey);
  let disposed = false;
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  changed("checking");
  if (!locks) changed("unsupported");
  else
    void locks
      .request(
        `spec-harness-discussion-writer:v1:${workspaceKey}`,
        { mode: "exclusive", ifAvailable: true },
        async (lock) => {
          if (disposed) return;
          if (!lock) {
            changed("busy");
            return;
          }
          owners.set(workspaceKey, token);
          changed("owned");
          await held;
          if (owners.get(workspaceKey) === token) owners.delete(workspaceKey);
        },
      )
      .catch(() => {
        if (owners.get(workspaceKey) === token) owners.delete(workspaceKey);
        if (!disposed) changed("error");
      });
  return () => {
    disposed = true;
    if (owners.get(workspaceKey) === token) owners.delete(workspaceKey);
    release?.();
  };
}

interface SharedLease {
  phase: DiscussionWriterPhase;
  listeners: Set<(phase: DiscussionWriterPhase) => void>;
  release?: () => void;
  retry?: ReturnType<typeof setTimeout>;
}
const leases = new Map<string, SharedLease>();
/** All document tabs in one renderer share the lease; another renderer gets a reader. */
export function retainDiscussionWriter(
  workspaceKey: string,
  locks: DiscussionLockManager | undefined,
  changed: (phase: DiscussionWriterPhase) => void,
): () => void {
  let lease = leases.get(workspaceKey);
  if (!lease) {
    lease = { phase: "checking", listeners: new Set() };
    leases.set(workspaceKey, lease);
  }
  const current = lease;
  current.listeners.add(changed);
  changed(current.phase);
  const acquire = () => {
    clearTimeout(current.retry);
    current.retry = undefined;
    current.release?.();
    current.release = acquireDiscussionWriter(workspaceKey, locks, (phase) => {
      if (leases.get(workspaceKey) !== current) return;
      current.phase = phase;
      for (const listener of current.listeners) listener(phase);
      // Electron 开窗可能使尚未调度的 Web Locks callback 失效；新 callback 可正常获锁。
      // 仍必须重新获得 exclusive lock，不能把临时错误永久变成只读或跳过仲裁。
      if (phase === "busy" || phase === "error")
        current.retry = setTimeout(() => {
          if (leases.get(workspaceKey) === current && current.listeners.size) acquire();
        }, 1000);
    });
  };
  if (!current.release) acquire();
  return () => {
    current.listeners.delete(changed);
    if (current.listeners.size) return;
    leases.delete(workspaceKey);
    clearTimeout(current.retry);
    current.release?.();
  };
}
