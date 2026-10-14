import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import type { PluginUiRowDisposition } from "./pluginUiInstancePolicy.js";

/** 渲染层提供的按 toolCallId 的裁决：推导结果 + 用户手动固定 / 收起。 */
export interface PluginUiRowPinContext {
  disposition?: PluginUiRowDisposition;
  /** 用户手动固定（true）或收起（false）；undefined 按默认规则。 */
  manualPinned?: boolean;
}

export type PluginUiRowPinResolver = (toolCallId: string) => PluginUiRowPinContext | undefined;

/**
 * 带插件 UI 的工具行是否留在"已工作 N 秒"折叠区外：
 * 失败 / 取消的行照常折叠；被较新成功结果替代的行进折叠区（普通工具记录）；其余按 手动状态 → 强制常驻 → 最近三回合自动展开。
 * 没有 resolver 的调用方（只读分享时间线）沿用"全部常驻"。
 */
export function isPluginUiPinnedToolRow(
  row: ConversationRow,
  resolve?: PluginUiRowPinResolver,
): boolean {
  if (row.kind !== "toolCall") return false;
  if (row.status === "error" || row.status === "cancelled") return false;
  const display = row.display;
  if (display?.kind !== "mcp_tool" || display.ui === undefined) return false;
  // MCP isError 不一定映射为行级 error；必须先排除，再应用固定/最近回合策略，避免错误卡片常驻。
  if (display.ui.isError === true) return false;
  if (!resolve) return true;
  const context = resolve(row.toolCallId);
  if (!context) return true;
  if (context.disposition?.superseded) return false;
  if (context.manualPinned !== undefined) return context.manualPinned;
  if (!context.disposition) return true;
  return context.disposition.forcedInline || context.disposition.autoExpand;
}

/**
 * 渲染性能 Wave C（独立复核 #2 发现 1）：该行的 pinned 裁决是否可能随 resolver 语义变化翻转。
 * 与 isPluginUiPinnedToolRow 的前置过滤链（toolCall / 非终态失败 / mcp ui / 非 isError）同源：
 * 通过前置过滤的行才消费 resolver；其余行无论 resolver 如何都返回 false。
 * completed-turn 复用缓存据此把 resolver 失效范围收窄到真正消费裁决的轮次，并用
 * 「哪些行是 pin-sensitive」的引用签名代替 resolver 函数身份判定语义是否变化。
 * 两处过滤链必须同步修改——由 pluginUiRowPolicy 域内相邻定义约束。
 */
export function isPluginUiPinSensitiveRow(row: ConversationRow): boolean {
  if (row.kind !== "toolCall") return false;
  if (row.status === "error" || row.status === "cancelled") return false;
  const display = row.display;
  if (display?.kind !== "mcp_tool" || display.ui === undefined) return false;
  return display.ui.isError !== true;
}
