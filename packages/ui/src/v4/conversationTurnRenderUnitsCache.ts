import type { ConversationRow, TurnHeaderRow } from "@zcode/shared/zcode-protocol-v4";
import {
  groupConversationTurnDraftUnits,
  materializeDraftUnit,
  normalizeRenderUnitPosition,
  shouldKeepRenderUnit,
  type BuildConversationTurnRenderUnitsOptions,
  type ConversationTurnDraftUnit,
  type ConversationTurnRenderUnit,
} from "@/v4/conversationTurnRenderUnits.js";
import { markHighspeedOutputFooterUnits } from "@/highspeed/highspeedOutputFooter.js";

/**
 * 渲染性能 Wave C：completed-turn 渲染单元复用缓存。
 *
 * 独立参照实现是 `buildConversationTurnRenderUnits`（全量 builder）；本缓存与其共享
 * 同一 group/materialize/keep/normalize/footer 步骤（自该模块导出），只把「物化」一步
 * 换成按轮次复用。等价性由 v4ConversationTurnRenderUnitsCache.test.ts 对照
 * test/support/conversationTurnRenderUnitsFrozenBaseline.ts（重构前的冻结副本）约束。
 *
 * 复用条件（全部满足才命中）：
 * - 轮次带 turnHeader 且为终态（state !== "running"）、物化结果 !isRunning——
 *   running/headerless 轮次依赖 nowMs（工作时长时钟）/sessionPhase（headerless 相位
 *   回退）覆盖层，不进缓存，token 频率下照常重建；
 * - header 行引用与 orderedRows 逐行引用完全一致（projection 的行池结构性共享保证
 *   未变行保持引用恒等；任何迟到结果/头部变更都会改变该轮引用，精确失效该轮）；
 * - 覆盖层 epoch 未变：resolverSensitive（含 toolCall 行）的轮次在 pluginUiPinResolver
 *   身份变化（手动固定/折叠版本）后失效重物化。
 *
 * 终态 headered 轮次的物化结果已被证明与 nowMs/sessionPhase/位置无关（时长取
 * header.activeMs/endedAt 事实；isLastTurn 只影响 running 分支的默认展开，由每次
 * build 的 normalize 步骤按当前下标重算）。footer（highspeed 到期标记）在每次 build
 * 的收尾步骤统一重算——未标记单元保持引用恒等。
 *
 * 复杂度披露：每次 build 固定一次 O(rows) 分组行走 + 一次 O(rows) 引用比对 +
 * O(units) keep/normalize/footer 扫描；物化只发生在受影响轮次（流式尾轮、迟到结果、
 * 失效覆盖层）。不承诺 O(changed turns) 的总路径——上述线性扫描按审计要求如实披露。
 *
 * 生命周期：缓存属于单个挂载（ConversationTimeline useRef），不进任何 app-global
 * map；scopeKey（sessionKey+logEpoch）变化即整缓存清空；每轮 build 后逐出不在当前
 * 窗口的 turn（截断/回退/快照替换/会话消失即修剪）。条目只持行引用（与投影窗口同一
 * 批对象），不在长生命周期闭包里捕获整份历史快照。
 */

interface CacheEntry {
  header: TurnHeaderRow | undefined;
  orderedRows: readonly ConversationRow[];
  unit: ConversationTurnRenderUnit;
  resolverSensitive: boolean;
  resolverEpoch: number;
}

export interface CachedTurnRenderUnitsStats {
  builds: number;
  hits: number;
  misses: number;
  materialized: number;
  prunedEntries: number;
  scopeEvictions: number;
}

export interface CachedConversationTurnRenderUnitsOptions extends BuildConversationTurnRenderUnitsOptions {
  /** 会话/epoch 身份键（sessionKey + logEpoch）；变化即整缓存清空。 */
  scopeKey: string;
}

export interface CachedConversationTurnRenderUnitsBuilder {
  build(
    rows: readonly ConversationRow[],
    options: CachedConversationTurnRenderUnitsOptions,
  ): ConversationTurnRenderUnit[];
  /** 挂载级诊断/测试断言用计数；生产代码不得据此分支。 */
  readonly stats: CachedTurnRenderUnitsStats;
  /** 测试用：立即清空。 */
  resetForTest(): void;
}

function rowsReferentiallyEqual(
  cached: readonly ConversationRow[],
  next: readonly ConversationRow[],
): boolean {
  if (cached.length !== next.length) return false;
  for (let index = 0; index < cached.length; index += 1) {
    if (cached[index] !== next[index]) return false;
  }
  return true;
}

function draftHasToolCallRows(draft: ConversationTurnDraftUnit): boolean {
  return draft.assistantWorkRows.some((row) => row.kind === "toolCall");
}

function isCacheableDraft(
  draft: ConversationTurnDraftUnit,
  unit: ConversationTurnRenderUnit,
): boolean {
  // running（header.state === "running" 或 headerless 回退）与 headerless 轮次
  // 依赖时钟/相位覆盖层，不缓存；它们的数量以活跃尾部为界。
  return draft.header !== undefined && draft.header.state !== "running" && !unit.isRunning;
}

export function createCachedConversationTurnRenderUnitsBuilder(): CachedConversationTurnRenderUnitsBuilder {
  const stats: CachedTurnRenderUnitsStats = {
    builds: 0,
    hits: 0,
    misses: 0,
    materialized: 0,
    prunedEntries: 0,
    scopeEvictions: 0,
  };
  let scopeKey: string | null = null;
  let resolverEpoch = 0;
  let lastResolver: unknown = Symbol("initial-resolver");
  const entries = new Map<string, CacheEntry>();

  const build = (
    rows: readonly ConversationRow[],
    options: CachedConversationTurnRenderUnitsOptions,
  ): ConversationTurnRenderUnit[] => {
    stats.builds += 1;
    if (options.scopeKey !== scopeKey) {
      scopeKey = options.scopeKey;
      entries.clear();
      stats.scopeEvictions += 1;
    }
    if (!Object.is(options.pluginUiPinResolver, lastResolver)) {
      lastResolver = options.pluginUiPinResolver;
      resolverEpoch += 1;
    }

    const drafts = groupConversationTurnDraftUnits(rows);
    const units: ConversationTurnRenderUnit[] = [];
    const seenTurnIds = new Set<string>();
    for (let index = 0; index < drafts.length; index += 1) {
      const draft = drafts[index]!;
      seenTurnIds.add(draft.turnId);
      const entry = entries.get(draft.turnId);
      let unit: ConversationTurnRenderUnit | null = null;
      if (
        entry !== undefined &&
        entry.header === draft.header &&
        rowsReferentiallyEqual(entry.orderedRows, draft.orderedRows) &&
        (!entry.resolverSensitive || entry.resolverEpoch === resolverEpoch)
      ) {
        unit = entry.unit;
        stats.hits += 1;
      }
      if (unit === null) {
        unit = materializeDraftUnit(draft, index, drafts.length, options);
        stats.misses += 1;
        stats.materialized += 1;
        if (isCacheableDraft(draft, unit)) {
          entries.set(draft.turnId, {
            header: draft.header,
            orderedRows: draft.orderedRows,
            unit,
            resolverSensitive: draftHasToolCallRows(draft),
            resolverEpoch,
          });
        } else {
          // 该轮进入不可缓存形态（如 rewind 后重开）：移除旧终态条目，避免陈旧复用。
          entries.delete(draft.turnId);
        }
      }
      units.push(unit);
    }

    // 修剪：本轮窗口未出现的 turn 条目立即逐出，缓存规模以当前窗口轮数为界。
    for (const turnId of entries.keys()) {
      if (!seenTurnIds.has(turnId)) {
        entries.delete(turnId);
        stats.prunedEntries += 1;
      }
    }

    const keptUnits = units.filter(shouldKeepRenderUnit);
    const normalizedUnits = keptUnits.map((unit, index) =>
      normalizeRenderUnitPosition(unit, index, keptUnits.length, options),
    );
    // 位置归一化回填：条目保存「上一次实际输出的归一化 unit」。否则条目会带着
    // 物化时刻的 isLastTurn/默认展开旧值，后续 build 的 normalize 每帧克隆一个
    // 内容相同的新对象，引用恒等性被粘性位置失配破坏。normalize 幂等：同位置
    // 早退保持引用；位置变化只克隆一次并立即回填。
    for (let index = 0; index < normalizedUnits.length; index += 1) {
      const normalized = normalizedUnits[index]!;
      const entry = entries.get(normalized.turnId);
      if (entry !== undefined && entry.unit !== normalized) {
        entry.unit = normalized;
      }
    }
    return markHighspeedOutputFooterUnits(normalizedUnits, options.nowMs ?? Date.now());
  };

  return {
    build,
    stats,
    resetForTest: () => {
      entries.clear();
    },
  };
}
