import {
  EMPTY_PLUGIN_UI_INSTANCE_DERIVATION,
  type PluginUiInstanceDerivation,
  type PluginUiRowDisposition,
} from "../domain/pluginUiInstancePolicy.js";

/**
 * 每个会话最近一次由时间线推导出的逻辑 UI 裁决（renderer 内存）。时间线在 effect 里写入，
 * 工具卡片按 (sessionKey, toolCallId) 读自己的裁决（是否被替代、是否强制常驻）；不持有任何沙箱状态。
 */
const derivations = new Map<string, PluginUiInstanceDerivation>();
const listeners = new Set<() => void>();

export function setPluginUiInstanceDerivation(
  sessionKey: string,
  derivation: PluginUiInstanceDerivation,
): void {
  const previous = derivations.get(sessionKey);
  if (previous === derivation) return;
  // 每个文本 token 都会重建 derivation；直接发布新对象会让未变化的插件卡片
  // useSyncExternalStore 快照失效。仅复用展示裁决，不干预插件资源/工具实时事件。
  const byToolCallId: Record<string, PluginUiRowDisposition> = Object.create(null);
  const entries = Object.entries(derivation.byToolCallId);
  let changed = Object.keys(previous?.byToolCallId ?? {}).length !== entries.length;
  for (const [toolCallId, next] of entries) {
    const old = previous?.byToolCallId[toolCallId];
    if (
      old &&
      old.key === next.key &&
      old.superseded === next.superseded &&
      old.autoExpand === next.autoExpand &&
      old.forcedInline === next.forcedInline
    ) {
      byToolCallId[toolCallId] = old;
    } else {
      byToolCallId[toolCallId] = next;
      changed = true;
    }
  }
  derivations.set(sessionKey, { ...derivation, byToolCallId });
  if (!changed) return;
  for (const listener of listeners) listener();
}

export function getPluginUiRowDisposition(
  sessionKey: string,
  toolCallId: string,
): PluginUiRowDisposition | undefined {
  return (derivations.get(sessionKey) ?? EMPTY_PLUGIN_UI_INSTANCE_DERIVATION).byToolCallId[
    toolCallId
  ];
}

export function subscribePluginUiInstances(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 测试用：清空全部记录。 */
export function resetPluginUiInstancesForTest(): void {
  derivations.clear();
  listeners.clear();
}
