import { useEffect } from "react";
import type { DetachedPanelTarget, IPlatformService, SpecWindowBridge } from "@zcode/shared";
import { logger } from "@/logger.js";
export type { DetachedPanelTarget, PanelTransfer, SpecWindowBridge } from "@zcode/shared";
export function specWindowBridge(platform: IPlatformService | null | undefined) {
  return platform?.specWindows;
}

/**
 * 面板清理完成信号。
 *
 * 原因：detach-prepared / reattach-quiesced ACK 之前曾用固定 50ms 定时器等待
 * React 被动卸载清理（草稿落盘、所有权释放）。定时器既可能在清理未完成时就放行
 * ACK，也纯粹拖慢正常路径，属于用超时掩盖同步问题。
 * 修复：由面板自身在挂载时登记一个清理作用域，作用域在其被动卸载清理执行完毕时
 * 显式 complete；ACK 只等待调用瞬间已登记的作用域集合，与组件间清理顺序无关，
 * 也不再依赖任何时间估计。重新挂载产生的是新作用域，不会被旧等待捕获。
 */
export interface PanelCleanupScope {
  readonly key: string;
  readonly completed: Promise<void>;
  complete(): void;
}
const trackedPanelCleanups = new Map<string, Set<PanelCleanupScope>>();

export function trackPanelCleanup(key: string): PanelCleanupScope {
  let settle: () => void = () => {};
  const completed = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const scope: PanelCleanupScope = {
    key,
    completed,
    complete: () => {
      trackedPanelCleanups.get(key)?.delete(scope);
      settle();
    },
  };
  const scopes = trackedPanelCleanups.get(key) ?? new Set<PanelCleanupScope>();
  scopes.add(scope);
  trackedPanelCleanups.set(key, scopes);
  return scope;
}

/** Snapshot semantics: only scopes registered at call time are awaited. */
export function afterPanelCleanup(keys: readonly string[]): Promise<void> {
  const scopes = [...new Set(keys)].flatMap((key) => [
    ...(trackedPanelCleanups.get(key) ?? []),
  ]);
  return Promise.all(scopes.map((scope) => scope.completed)).then(() => undefined);
}

/** 桌面文档面板按 workspace+path 追踪：源窗口面板不知道自己的 panelKey。 */
export function specDocumentCleanupKey(workspaceKey: string, path: string): string {
  return `spec-panel-cleanup:document:${JSON.stringify([
    workspaceKey.replaceAll("\\", "/").toLowerCase().replace(/\/$/, ""),
    path.replaceAll("\\", "/").toLowerCase().replace(/^\//, ""),
  ])}`;
}

export function panelCleanupKeys(target: DetachedPanelTarget): string[] {
  const keys = [target.panelKey];
  if (target.kind === "document" && target.path)
    keys.push(
      specDocumentCleanupKey(target.workspaceIdentity?.trim() || target.workspacePath, target.path),
    );
  return keys;
}

/**
 * ACK 只在快照作用域全部完成后发出（同一显式信号，不含任何定时边界）。
 * 50ms 只作为诊断阈值保留：超时时记录 debug 日志，不阻塞、不重试。
 */
export function acknowledgePanelAfterCleanup(
  bridge: SpecWindowBridge,
  action: "detach-prepared" | "reattach-prepared" | "reattach-quiesced",
  payload: { transferId: string },
  keys: readonly string[],
): Promise<void> {
  const startedAt = Date.now();
  return afterPanelCleanup(keys).then(() => {
    const elapsed = Date.now() - startedAt;
    if (elapsed > 50)
      logger.debug("spec panel cleanup completed after 50ms diagnostic bound", {
        action,
        transferId: payload.transferId,
        elapsedMs: elapsed,
      });
    bridge.specPanelAck(action, payload);
  });
}

/** 在面板被动清理执行处完成信号；面板无 JSX 依赖，可在 .ts 中实现。 */
export function usePanelCleanupSignal(scopeKey: string | null | undefined): void {
  useEffect(() => {
    if (!scopeKey) return;
    const scope = trackPanelCleanup(scopeKey);
    return () => scope.complete();
  }, [scopeKey]);
}

export function observePanelComposition(): () => void {
  const start = () => {
    document.documentElement.dataset.specComposing = "true";
  };
  const end = () => {
    delete document.documentElement.dataset.specComposing;
  };
  document.addEventListener("compositionstart", start, true);
  document.addEventListener("compositionend", end, true);
  return () => {
    document.removeEventListener("compositionstart", start, true);
    document.removeEventListener("compositionend", end, true);
    end();
  };
}
