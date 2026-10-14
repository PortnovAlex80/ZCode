// 客户端安全的一帧批量应用（纯函数）：与 apply.ts 的逐条不可变语义**逐字节等价**，
// 但一帧只复制一次 rows.window / 只建一次行位置索引，替代「每条 delta 线性查找 + 整窗复制」。
//
// 与服务端 MutableConversationSnapshotAccumulator 的边界（apply.ts 文件头）刻意区分：
// 那个 accumulator 允许在**未发布候选**上原地累积、跨帧存活；本函数的可变工作副本是
// **帧内私有**的——离开函数即被丢弃，任何可变状态都不外泄、不存活到下一次调用，
// 因此对客户端已发布快照是安全的，也不改变 accumulator 的文档化生命周期契约。
//
// 正确性裁判是 applyConversationDeltas（不动它）：本函数的输出必须与逐条 apply
// 深相等、且 JSON.stringify 逐字节一致（含键序），由 property 测试钉住。
// 空帧/单条帧直接走逐条实现：单条帧没有任何可省的查找/复制，委托保证零开销且语义同源。
import type { ConversationDelta } from "./delta.js";
import { applyConversationDelta, appendToRow } from "./apply.js";
import type { ConversationSnapshot, RowsWindow } from "./snapshot.js";
import type { ConversationRow } from "./rows.js";
import { applyWorkflowRunRemoved, applyWorkflowRunUpdated } from "./workflow-runs-delta.js";

/**
 * 按序应用一个逻辑帧的全部 delta，返回新快照（入参与已发布结果都不会被修改）。
 *
 * 引用语义与逐条实现一致：
 * - 全程 no-op（空帧 / 未命中行 / live-only 通知）→ 返回**同一个** snapshot 引用；
 * - row.removed 即使一行未删也产生新引用（filter 总是产出新数组，与逐条实现相同）；
 * - 未被触及的行保持 Object.is 同一引用（结构共享的前提）；
 * - state.updated 键按到达顺序合并，后到的键值整体覆盖（绝不深合并）。
 */
export function applyConversationFrame(
  snapshot: ConversationSnapshot,
  deltas: readonly ConversationDelta[],
): ConversationSnapshot {
  if (deltas.length === 0) return snapshot;
  // 单条帧：委托逐条实现。批量路径的最小收益（一次查找/一次复制）在这里本来就是成本本身。
  if (deltas.length === 1) return applyConversationDelta(snapshot, deltas[0]!);

  // 帧内私有工作副本（copy-on-write）：只在首次行变更时复制，绝不改写入参容器。
  let rows: RowsWindow = snapshot.rows;
  let window: ConversationRow[] | null = null;
  let rowsDirty = false;
  // 行位置索引：只为本帧需要按 rowId 定位的 op（row.upserted / row.delta）建，
  // 且只收这些 rowId —— 建索引本身就是一次 O(window) 扫描，把常量压到最小。
  // null = 已失效（row.removed / patch 整体换 rows 之后需要重建）。
  const lookupIds = new Set<number>();
  for (const delta of deltas) {
    if (delta.op === "row.upserted") lookupIds.add(delta.row.rowId);
    else if (delta.op === "row.delta") lookupIds.add(delta.rowId);
  }
  let positions: Map<number, number> | null = null;
  let workflowRuns = snapshot.workflowRuns;
  let workflowDirty = false;
  let overlay: Record<string, unknown> | null = null;
  // 逐条实现在每次有效 op 后都产出新快照引用；这里用同一判据决定是否新建外壳。
  let changed = false;

  const ensureRowsCopy = (): ConversationRow[] => {
    if (window === null) {
      window = [...rows.window];
      rows = { ...rows, window };
      rowsDirty = true;
    }
    return window;
  };
  // 读取一律经函数返回值拿索引：闭包内的再赋值不会解除 TS 对 let 的 null 收窄。
  const ensurePositions = (): Map<number, number> => {
    if (positions === null) {
      const built = new Map<number, number>();
      const source = window ?? rows.window;
      for (let index = 0; index < source.length; index += 1) {
        const rowId = source[index]!.rowId;
        // 重复 rowId（协议外输入）取首个匹配，与 findIndex 语义一致。
        if (lookupIds.has(rowId) && !built.has(rowId)) built.set(rowId, index);
      }
      positions = built;
    }
    return positions;
  };
  const getPositions = (): Map<number, number> | null => positions;

  for (const delta of deltas) {
    switch (delta.op) {
      case "row.appended": {
        const target = ensureRowsCopy();
        const built = getPositions();
        if (built !== null) built.set(delta.row.rowId, target.length);
        target.push(delta.row);
        rows.totalCount += 1;
        rows.firstRowId ??= delta.row.rowId;
        changed = true;
        break;
      }
      case "row.upserted": {
        const index = ensurePositions().get(delta.row.rowId);
        // §4.3：未加载 rowId = no-op，与逐条实现相同（不置 changed）。
        if (index === undefined) break;
        ensureRowsCopy()[index] = delta.row;
        changed = true;
        break;
      }
      case "row.removed": {
        // 即使一行未删，逐条实现也会经 filter 产出新数组/新快照 —— 保持引用语义一致。
        const target = ensureRowsCopy();
        const removesEntireActiveBranch =
          rows.firstRowId !== null && delta.fromRowId <= rows.firstRowId;
        let writeIndex = 0;
        for (const row of target) {
          if (row.rowId >= delta.fromRowId) continue;
          target[writeIndex] = row;
          writeIndex += 1;
        }
        const removed = target.length - writeIndex;
        target.length = writeIndex;
        rows.totalCount = removesEntireActiveBranch ? 0 : Math.max(0, rows.totalCount - removed);
        rows.firstRowId = removesEntireActiveBranch ? null : rows.firstRowId;
        positions = null; // 下标已移位，按需重建。
        changed = true;
        break;
      }
      case "row.delta": {
        const index = ensurePositions().get(delta.rowId);
        if (index === undefined) break;
        const target = ensureRowsCopy();
        target[index] = appendToRow(target[index]!, delta.path, delta.append);
        changed = true;
        break;
      }
      case "state.updated": {
        // 键级整体替换，按到达顺序合并；后到键覆盖（与逐条 Object.assign 链等价）。
        overlay ??= {};
        Object.assign(overlay, delta.patch);
        const patch = delta.patch as Record<string, unknown>;
        if (patch.workflowRuns !== undefined) {
          workflowRuns = patch.workflowRuns as ConversationSnapshot["workflowRuns"];
          workflowDirty = true;
        }
        if (patch.rows !== undefined) {
          // schema 排除 rows，正常线上不会出现；按逐条语义整体换窗，后续行 op 作用于新窗。
          rows = patch.rows as RowsWindow;
          window = null;
          positions = null;
          rowsDirty = true;
        }
        // rows / workflowRuns 的最终值由上面按序维护的帧内状态唯一决定；
        // 若留在 overlay 里，装配时会把 patch 的旧值倒灌到更晚的行/workflow op 之上。
        delete overlay.workflowRuns;
        delete overlay.rows;
        changed = true;
        break;
      }
      case "workflowRun.updated":
        workflowRuns = applyWorkflowRunUpdated(workflowRuns, delta);
        workflowDirty = true;
        changed = true;
        break;
      case "workflowRun.removed":
        workflowRuns = applyWorkflowRunRemoved(workflowRuns, delta);
        workflowDirty = true;
        changed = true;
        break;
      case "pluginUi.resourceUpdated":
      case "pluginUi.resourceListChanged":
      case "pluginUi.instanceClosed":
      case "pluginUi.appToolCall":
        // live-only 通知：不改快照，但顺序投递（这里的“跳过”即保序）。
        break;
    }
  }

  if (!changed) return snapshot;
  const result = { ...snapshot } as ConversationSnapshot & Record<string, unknown>;
  if (rowsDirty) result.rows = rows;
  if (workflowDirty) result.workflowRuns = workflowRuns;
  if (overlay !== null) Object.assign(result, overlay);
  return result;
}
