import type { ConversationRow, TurnHeaderRow } from "@zcode/shared/zcode-protocol-v4";
import { isPluginUiPinSensitiveRow } from "@/plugin-ui/index.js";
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
 * - plugin 覆盖层语义签名未变（见下）。
 *
 * 复核 #2 发现 1 的修复：resolver 失效不再看 resolver 函数身份（Timeline 每次流式
 * token 都会重建 derivation/resolver 身份，旧实现把全部含工具行轮次逐 token 打穿），
 * 改为按 resolver 答案的语义输入计算签名：
 * - 全部行的 turnId 序列（首现顺序）——autoExpand 按最近 N 回合裁决，任何新轮/删轮
 *   都会移动边界并影响旧轮（含「无插件卡的新轮占位」的情况）；
 * - pin-sensitive 行（isPluginUiPinSensitiveRow，即真正消费 resolver 裁决的行）的
 *   引用序列——同资源替代 / 成功-失败翻转 / display.ui 变化都会改变行引用；
 * - pluginUiDisclosureVersion——手动固定 / 收起版本号；未提供时保守退回 resolver
 *   身份比较（调用方自管失效）。
 * 签名不变 ⇒ resolver 语义不变 ⇒ 不失效；签名变化 ⇒ 只重物化含 pin-sensitive 行的
 * 轮次（普通工具行不消费 resolver，不再视为敏感）。这不是「无视 resolver 依赖」：
 * 手动披露、资源替代、最近回合自动展开（含对旧轮的影响）全部保留。
 *
 * 终态 headered 轮次的物化结果与 nowMs/sessionPhase/位置无关（时长取
 * header.activeMs/endedAt 事实；isLastTurn 只影响 running 分支的默认展开，由每次
 * build 的 normalize 步骤按当前下标重算并回填缓存条目）。footer（highspeed 到期标记）
 * 在每次 build 的收尾步骤统一重算；未标记单元保持引用恒等，已标记单元按
 * （源单元引用, cardId）记忆上次输出，内容与 footer 元数据未变时复用同一对象
 * （复核 #2 发现 5 的修复；源单元或 cardId 变化即产出新对象，保留到期与组尾移动语义）。
 *
 * 复杂度披露：每次 build 固定一次 O(rows) 分组行走 + 一次 O(rows) 引用比对 +
 * O(units) keep/normalize/footer 扫描；物化只发生在受影响轮次。不承诺
 * O(changed turns) 的总路径——上述线性扫描按审计要求如实披露。
 *
 * 生命周期：缓存属于单个挂载（ConversationTimeline useRef），不进任何 app-global
 * map；scopeKey（sessionKey+logEpoch）变化即整缓存清空；每轮 build 后逐出不在当前
 * 窗口的 turn。条目只持行引用（与投影窗口同一批对象）。
 */

interface CacheEntry {
  header: TurnHeaderRow | undefined;
  orderedRows: readonly ConversationRow[];
  unit: ConversationTurnRenderUnit;
  resolverSensitive: boolean;
  resolverEpoch: number;
  /** 上一次实际输出的 footer 标记克隆（发现 5：标记不变则保持输出引用恒等）。 */
  emittedFooterOutput?: {
    sourceUnit: ConversationTurnRenderUnit;
    cardId: string | null;
    emitted: ConversationTurnRenderUnit;
  };
}

export interface CachedTurnRenderUnitsStats {
  builds: number;
  hits: number;
  misses: number;
  materialized: number;
  prunedEntries: number;
  scopeEvictions: number;
  resolverEpochBumps: number;
}

export interface CachedConversationTurnRenderUnitsOptions extends BuildConversationTurnRenderUnitsOptions {
  /** 会话/epoch 身份键（sessionKey + logEpoch）；变化即整缓存清空。 */
  scopeKey: string;
  /**
   * 手动固定 / 收起（disclosure）版本号。Timeline 由 pluginUiDisclosureVersion 提供；
   * 缺省时回退为把 resolver 函数身份纳入签名（保守：身份变化即失效）。
   */
  pluginUiDisclosureVersion?: number;
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

function draftHasPinSensitiveRows(draft: ConversationTurnDraftUnit): boolean {
  return draft.assistantWorkRows.some(isPluginUiPinSensitiveRow);
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
    resolverEpochBumps: 0,
  };
  let scopeKey: string | null = null;
  let resolverEpoch = 0;
  // resolver 语义签名状态（发现 1）：turnId 序列 + pin-sensitive 行引用序列 + 版本号。
  let signatureTurnIds: string | null = null;
  let signaturePinRows: readonly ConversationRow[] | null = null;
  let signatureDisclosureVersion: number | undefined;
  let signatureResolverIdentity: unknown = null;
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

    const drafts = groupConversationTurnDraftUnits(rows);
    const seenTurnIds = new Set<string>();
    const turnIds: string[] = [];
    const pinSensitiveRows: ConversationRow[] = [];
    for (const draft of drafts) {
      if (!seenTurnIds.has(draft.turnId)) {
        seenTurnIds.add(draft.turnId);
        turnIds.push(draft.turnId);
      }
      for (const row of draft.assistantWorkRows) {
        if (isPluginUiPinSensitiveRow(row)) pinSensitiveRows.push(row);
      }
    }

    // resolver 语义签名（发现 1）：在物化循环之前判定，本 build 新存/复用的条目都登记
    // 到判定后的 epoch。只在语义输入变化时 bump；首建（signature 尚为 null）bump 一次。
    const turnIdsSignature = turnIds.join("\u0000");
    const resolverIdentityChanged =
      options.pluginUiDisclosureVersion === undefined &&
      !Object.is(options.pluginUiPinResolver, signatureResolverIdentity);
    if (
      turnIdsSignature !== signatureTurnIds ||
      !rowsReferentiallyEqual(signaturePinRows ?? [], pinSensitiveRows) ||
      options.pluginUiDisclosureVersion !== signatureDisclosureVersion ||
      resolverIdentityChanged
    ) {
      signatureTurnIds = turnIdsSignature;
      signaturePinRows = pinSensitiveRows;
      signatureDisclosureVersion = options.pluginUiDisclosureVersion;
      signatureResolverIdentity = options.pluginUiPinResolver;
      resolverEpoch += 1;
      stats.resolverEpochBumps += 1;
    }

    const units: ConversationTurnRenderUnit[] = [];
    for (let index = 0; index < drafts.length; index += 1) {
      const draft = drafts[index]!;
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
            resolverSensitive: draftHasPinSensitiveRows(draft),
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
    const footerMarked = markHighspeedOutputFooterUnits(
      normalizedUnits,
      options.nowMs ?? Date.now(),
    );
    // 发现 5：已标记单元在（源单元引用, cardId）未变时复用上一次输出对象，
    // 保留到期/组尾移动语义（源单元或 cardId 变化即产生新对象）。
    for (let index = 0; index < footerMarked.length; index += 1) {
      const output = footerMarked[index]!;
      if (output.showHighspeedOutputFooter !== true) continue;
      const sourceUnit = normalizedUnits[index]!;
      const entry = entries.get(output.turnId);
      const cardId = output.highspeedOutputFooterTarget?.cardId ?? null;
      if (
        entry?.emittedFooterOutput !== undefined &&
        entry.emittedFooterOutput.sourceUnit === sourceUnit &&
        entry.emittedFooterOutput.cardId === cardId
      ) {
        footerMarked[index] = entry.emittedFooterOutput.emitted;
        continue;
      }
      if (entry !== undefined) {
        entry.emittedFooterOutput = { sourceUnit, cardId, emitted: output };
      }
    }
    return footerMarked;
  };

  return {
    build,
    stats,
    resetForTest: () => {
      entries.clear();
    },
  };
}
