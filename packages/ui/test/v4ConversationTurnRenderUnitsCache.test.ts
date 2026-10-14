// 渲染性能 Wave C：completed-turn 渲染单元复用缓存的等价性 / identity / 有界物化回归。
//
// 独立 oracle 是 test/support/conversationTurnRenderUnitsFrozenBaseline.ts——重构前
// （HEAD f6d3678e）buildConversationTurnRenderUnits 的逐字节冻结副本，仅重命名导出；
// 不与生产实现共享任何被测代码。生产全量 builder（重构后）也同时对照，锁定
// 「共享步骤抽取」本身没有改变行为。
//
// 覆盖 prompt §7 要求的全部显式失效场景：历史前插、移除/回退、窗口/快照替换、
// session/epoch 变化、迟到工具结果、旧轮 header/kind 变化、headerless 相位回退、
// last-turn 归一化、plugin pin/disclosure（resolver 身份）变化、highspeed 跨轮
// footer 到期、纯文本流式期间完成轮的引用恒等、缓存修剪与有界物化计数。

import { describe, expect, it } from "vitest";
import {
  V4_REPLAY_FIXTURE_DEFAULT_SEED,
  buildV4ReplayStreamTail,
  generateV4ReplayRows,
} from "../../../scripts/perf/v4-replay-fixtures.mjs";
import {
  applyConversationDeltas,
  type ConversationSnapshot,
} from "@zcode/shared/zcode-protocol-v4";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { buildConversationTurnRenderUnits } from "@/v4/conversationTurnRenderUnits.js";
import { createCachedConversationTurnRenderUnitsBuilder } from "@/v4/conversationTurnRenderUnitsCache.js";
import { buildConversationTurnRenderUnitsFrozenBaseline } from "./support/conversationTurnRenderUnitsFrozenBaseline.js";
import type { PluginUiRowPinResolver } from "@/plugin-ui/index.js";

const BASE_NOW_MS = 1_750_080_000_000;

function oracle(
  rows: readonly ConversationRow[],
  options: {
    nowMs?: number;
    sessionPhase?: "running" | "completedSuccess";
    pluginUiPinResolver?: PluginUiRowPinResolver;
  } = {},
) {
  return buildConversationTurnRenderUnitsFrozenBaseline(rows, options);
}

function liveOracle(rows: readonly ConversationRow[], options: Parameters<typeof oracle>[1] = {}) {
  return buildConversationTurnRenderUnits(rows, options);
}

function minimalSnapshot(rows: readonly ConversationRow[]): ConversationSnapshot {
  return {
    rows: {
      window: rows as ConversationRow[],
      totalCount: rows.length,
      firstRowId: rows[0]?.rowId ?? null,
    },
  } as unknown as ConversationSnapshot;
}

function unitByTurn(units: readonly { turnId: string }[]) {
  return new Map(units.map((unit) => [unit.turnId, unit]));
}

/** 与 projection 行池同一假设：未变行保持引用恒等；本工具只替换目标行引用。 */
function replaceRow(
  rows: readonly ConversationRow[],
  rowId: number,
  update: (row: ConversationRow) => ConversationRow,
): ConversationRow[] {
  return rows.map((row) => (row.rowId === rowId ? update(row) : row));
}

function insertRowBefore(
  rows: readonly ConversationRow[],
  beforeRowId: number,
  row: ConversationRow,
): ConversationRow[] {
  const next: ConversationRow[] = [];
  for (const current of rows) {
    if (current.rowId === beforeRowId) next.push(row);
    next.push(current);
  }
  return next;
}

describe("cached conversation turn render units (Wave C)", () => {
  it("纯文本流式：逐帧等价（冻结 oracle + 生产 oracle），完成轮引用恒等，物化有界", () => {
    const { rows: baseRows } = generateV4ReplayRows({
      turns: 12,
      seed: V4_REPLAY_FIXTURE_DEFAULT_SEED,
    });
    const tail = buildV4ReplayStreamTail({
      chunks: 24,
      baseRowId: baseRows[baseRows.length - 1]!.rowId,
      turnIndex: 13,
    });
    const cache = createCachedConversationTurnRenderUnitsBuilder();
    let rows = baseRows as ConversationRow[];
    let snapshot = minimalSnapshot(rows);

    const first = cache.build(rows, {
      nowMs: BASE_NOW_MS,
      sessionPhase: "running",
      scopeKey: "s1",
    });
    expect(first).toEqual(oracle(rows, { nowMs: BASE_NOW_MS, sessionPhase: "running" }));
    expect(first).toEqual(liveOracle(rows, { nowMs: BASE_NOW_MS, sessionPhase: "running" }));
    const materializedAfterWarmup = cache.stats.materialized;
    // 12 个完成轮 + 1 个即将出现的流式轮：warm-up 物化次数以轮数为界。
    expect(materializedAfterWarmup).toBeLessThanOrEqual(13);

    let previousUnits = unitByTurn(first);
    // 流式首帧会让「上一个尾轮」（turn-12）的 isLastTurn 翻转——输出确实改变，
    // normalize 产出新对象是预期行为；首帧之后它必须同样保持引用恒等。
    const previousLastTurnId = "turn-12";
    let previousLastTurnSettledUnit: unknown = null;
    let frameCount = 0;
    for (const delta of tail.deltas) {
      snapshot = applyConversationDeltas(snapshot, [delta]);
      rows = snapshot.rows.window;
      frameCount += 1;
      const nowMs = BASE_NOW_MS + frameCount * 50;
      const units = cache.build(rows, { nowMs, sessionPhase: "running", scopeKey: "s1" });
      expect(units).toEqual(oracle(rows, { nowMs, sessionPhase: "running" }));
      // 完成轮在 text-only 流式期间保持引用恒等（虚拟列表行不重渲染的依据）。
      for (const unit of units) {
        if (unit.turnId === tail.turnId || unit.turnId === previousLastTurnId) continue;
        expect(previousUnits.get(unit.turnId)).toBe(unit);
      }
      if (previousLastTurnSettledUnit !== null) {
        expect(unitByTurn(units).get(previousLastTurnId)).toBe(previousLastTurnSettledUnit);
      } else {
        previousLastTurnSettledUnit = unitByTurn(units).get(previousLastTurnId);
      }
      previousUnits = unitByTurn(units);
    }
    // 物化只发生在流式轮：每个 frame 至多一次。
    expect(cache.stats.materialized - materializedAfterWarmup).toBeLessThanOrEqual(frameCount);
    expect(cache.stats.materialized - materializedAfterWarmup).toBeGreaterThanOrEqual(1);
  });

  it("历史前插（loadOlder）：新轮物化、旧轮命中且引用恒等", () => {
    const { rows } = generateV4ReplayRows({ turns: 24, seed: V4_REPLAY_FIXTURE_DEFAULT_SEED });
    const tailWindow = rows.slice(rows.findIndex((row) => row.turnId === "turn-13"));
    const cache = createCachedConversationTurnRenderUnitsBuilder();
    const before = cache.build(tailWindow, { nowMs: BASE_NOW_MS, scopeKey: "s1" });
    expect(before).toEqual(oracle(tailWindow, { nowMs: BASE_NOW_MS }));
    const beforeByTurn = unitByTurn(before);
    const materializedBefore = cache.stats.materialized;

    const full = cache.build(rows, { nowMs: BASE_NOW_MS, scopeKey: "s1" });
    expect(full).toEqual(oracle(rows, { nowMs: BASE_NOW_MS }));
    // 只有前插的 12 个轮次重新物化。
    expect(cache.stats.materialized - materializedBefore).toBe(12);
    for (const unit of full) {
      if (beforeByTurn.has(unit.turnId)) {
        expect(beforeByTurn.get(unit.turnId)).toBe(unit);
      }
    }
  });

  it("窗口截断 / 回退（row.removed）：等价、整轮消失即修剪、无陈旧复用", () => {
    const { rows } = generateV4ReplayRows({ turns: 12, seed: 5 });
    const cache = createCachedConversationTurnRenderUnitsBuilder();
    cache.build(rows, { nowMs: BASE_NOW_MS, scopeKey: "s1" });
    // 从 turn-9 的首行剪掉：turn-9..turn-12 四个整轮从窗口消失。
    const turnNineFirstRow = rows.find((row) => row.turnId === "turn-9")!;
    const truncated = applyConversationDeltas(minimalSnapshot(rows), [
      { op: "row.removed", fromRowId: turnNineFirstRow.rowId },
    ]).rows.window;
    expect(truncated.every((row) => row.turnId !== "turn-9")).toBe(true);
    const prunedBefore = cache.stats.prunedEntries;
    const units = cache.build(truncated, { nowMs: BASE_NOW_MS, scopeKey: "s1" });
    expect(units).toEqual(oracle(truncated, { nowMs: BASE_NOW_MS }));
    expect(cache.stats.prunedEntries - prunedBefore).toBe(4);
  });

  it("session/epoch 变化（scopeKey）：整缓存清空后仍等价", () => {
    const { rows } = generateV4ReplayRows({ turns: 12, seed: 6 });
    const cache = createCachedConversationTurnRenderUnitsBuilder();
    cache.build(rows, { nowMs: BASE_NOW_MS, scopeKey: "session-a:epoch-1" });
    const evictionsBefore = cache.stats.scopeEvictions;
    const materializedBefore = cache.stats.materialized;
    const units = cache.build(rows, { nowMs: BASE_NOW_MS, scopeKey: "session-a:epoch-2" });
    expect(units).toEqual(oracle(rows, { nowMs: BASE_NOW_MS }));
    expect(cache.stats.scopeEvictions).toBe(evictionsBefore + 1);
    expect(cache.stats.materialized).toBeGreaterThan(materializedBefore);
  });

  it("旧轮迟到结果：仅该轮重建，相邻轮引用恒等", () => {
    const { rows } = generateV4ReplayRows({ turns: 12, seed: 7 });
    const cache = createCachedConversationTurnRenderUnitsBuilder();
    const before = cache.build(rows, { nowMs: BASE_NOW_MS, scopeKey: "s1" });
    const beforeByTurn = unitByTurn(before);
    const materializedBefore = cache.stats.materialized;

    // turn-5 尾部（最终答复行之前）插入一条迟到的完成态工具行：克隆既有工具行保持协议形状。
    const donorTool = rows.find((row) => row.kind === "toolCall" && row.turnId === "turn-6")!;
    const turnFiveFinalText = rows.find(
      (row) => row.kind === "assistantText" && row.turnId === "turn-5" && "actions" in row,
    )!;
    const lateRow = {
      ...donorTool,
      rowId: 900_001,
      createdAtSeq: 900_001,
      entityId: "toolCall-900001",
      turnId: "turn-5",
      toolCallId: "late-call-900001",
    } as ConversationRow;
    const withLate = insertRowBefore(rows, turnFiveFinalText.rowId, lateRow);

    const after = cache.build(withLate, { nowMs: BASE_NOW_MS, scopeKey: "s1" });
    expect(after).toEqual(oracle(withLate, { nowMs: BASE_NOW_MS }));
    const afterByTurn = unitByTurn(after);
    expect(afterByTurn.get("turn-5")).not.toBe(beforeByTurn.get("turn-5"));
    expect(afterByTurn.get("turn-4")).toBe(beforeByTurn.get("turn-4"));
    expect(afterByTurn.get("turn-6")).toBe(beforeByTurn.get("turn-6"));
    expect(cache.stats.materialized - materializedBefore).toBe(1);
  });

  it("旧轮 header 状态变化：仅该轮重建", () => {
    const { rows } = generateV4ReplayRows({ turns: 12, seed: 8 });
    const headerFive = rows.find((row) => row.kind === "turnHeader" && row.turnId === "turn-5")!;
    const replaced = replaceRow(rows, headerFive.rowId, (row) =>
      row.kind === "turnHeader" ? ({ ...row, state: "completedInterrupted" } as typeof row) : row,
    );
    const cache = createCachedConversationTurnRenderUnitsBuilder();
    const before = cache.build(rows, { nowMs: BASE_NOW_MS, scopeKey: "s1" });
    const beforeByTurn = unitByTurn(before);
    const after = cache.build(replaced, { nowMs: BASE_NOW_MS, scopeKey: "s1" });
    expect(after).toEqual(oracle(replaced, { nowMs: BASE_NOW_MS }));
    expect(unitByTurn(after).get("turn-5")).not.toBe(beforeByTurn.get("turn-5"));
    expect(unitByTurn(after).get("turn-4")).toBe(beforeByTurn.get("turn-4"));
  });

  it("headerless 相位回退：sessionPhase 变化逐帧等价（此类轮次不缓存）", () => {
    const { rows } = generateV4ReplayRows({ turns: 3, seed: 9 });
    const headerless = rows.filter((row) => row.kind !== "turnHeader");
    const cache = createCachedConversationTurnRenderUnitsBuilder();
    const runningUnits = cache.build(headerless, {
      nowMs: BASE_NOW_MS,
      sessionPhase: "running",
      scopeKey: "s1",
    });
    expect(runningUnits).toEqual(
      oracle(headerless, { nowMs: BASE_NOW_MS, sessionPhase: "running" }),
    );
    const completedUnits = cache.build(headerless, {
      nowMs: BASE_NOW_MS,
      sessionPhase: "completedSuccess",
      scopeKey: "s1",
    });
    expect(completedUnits).toEqual(
      oracle(headerless, { nowMs: BASE_NOW_MS, sessionPhase: "completedSuccess" }),
    );
  });

  it("新增普通完成轮：last-turn 归一化重算（旧尾轮输出改变），等价保持", () => {
    const { rows: twelve } = generateV4ReplayRows({ turns: 12, seed: 10 });
    const { rows: thirteen } = generateV4ReplayRows({ turns: 13, seed: 10 });
    const thirteenthTurnRows = thirteen.filter((row) => row.turnId === "turn-13");
    const appended = [...twelve, ...thirteenthTurnRows];
    const cache = createCachedConversationTurnRenderUnitsBuilder();
    const before = cache.build(twelve, { nowMs: BASE_NOW_MS, scopeKey: "s1" });
    const beforeByTurn = unitByTurn(before);
    const after = cache.build(appended, { nowMs: BASE_NOW_MS, scopeKey: "s1" });
    expect(after).toEqual(oracle(appended, { nowMs: BASE_NOW_MS }));
    // 旧尾轮 isLastTurn 翻转 → normalize 产出新对象（输出确实变了）。
    expect(unitByTurn(after).get("turn-12")).not.toBe(beforeByTurn.get("turn-12"));
    expect(unitByTurn(after).get("turn-11")).toBe(beforeByTurn.get("turn-11"));
  });

  it("pluginUiPinResolver 失效（发现 1 语义）：普通工具行不敏感；无版本号时身份翻转只失效 pin-sensitive 轮", () => {
    const { rows } = generateV4ReplayRows({ turns: 12, seed: 11 });
    // 回放 fixture 的工具行都是普通 toolCall（无 mcp ui）——按发现 1 的修复它们不消费
    // resolver 裁决，不再视为敏感。给 turn-3 注入一条真正的插件 UI 工具行作对照组；
    // turn-2 保留普通工具行。
    const donor = rows.find((row) => row.kind === "toolCall" && row.turnId === "turn-4")!;
    const pluginRow = {
      ...donor,
      rowId: 900_010,
      createdAtSeq: 900_010,
      entityId: "toolCall-900010",
      turnId: "turn-3",
      toolCallId: "plugin-call-900010",
      status: "success",
      display: {
        kind: "mcp_tool",
        serverName: "server-c",
        toolName: "edit",
        ui: {
          pluginId: "plugin-c",
          resourceUri: "ui://plugin-c/main",
          surface: "panel",
          preferredDisplayMode: "fullscreen",
          showInline: false,
        },
      },
    } as typeof donor;
    const curated = insertRowBefore(
      rows,
      rows.find(
        (row) => row.kind === "assistantText" && row.turnId === "turn-3" && "actions" in row,
      )!.rowId,
      pluginRow,
    );
    const unpinned: PluginUiRowPinResolver = () => ({
      disposition: undefined,
      manualPinned: false,
    });
    const pinned: PluginUiRowPinResolver = () => ({ disposition: undefined, manualPinned: true });
    const cache = createCachedConversationTurnRenderUnitsBuilder();
    const first = cache.build(curated, {
      nowMs: BASE_NOW_MS,
      pluginUiPinResolver: unpinned,
      scopeKey: "s1",
    });
    expect(first).toEqual(oracle(curated, { nowMs: BASE_NOW_MS, pluginUiPinResolver: unpinned }));
    const warm = cache.build(curated, {
      nowMs: BASE_NOW_MS,
      pluginUiPinResolver: unpinned,
      scopeKey: "s1",
    });
    const warmByTurn = unitByTurn(warm);
    const materializedAfterWarm = cache.stats.materialized;
    const flipped = cache.build(curated, {
      nowMs: BASE_NOW_MS,
      pluginUiPinResolver: pinned,
      scopeKey: "s1",
    });
    expect(flipped).toEqual(oracle(curated, { nowMs: BASE_NOW_MS, pluginUiPinResolver: pinned }));
    const flippedByTurn = unitByTurn(flipped);
    // 普通工具行轮（turn-2，fixture 原生工具）不失效；无工具轮也不失效。
    expect(flippedByTurn.get("turn-2")).toBe(warmByTurn.get("turn-2"));
    expect(flippedByTurn.get("turn-5")).toBe(warmByTurn.get("turn-5"));
    // 含插件 UI 工具行的轮（turn-3）在保守身份回退（未提供版本号）下失效。
    expect(flippedByTurn.get("turn-3")).not.toBe(warmByTurn.get("turn-3"));
    expect(cache.stats.materialized).toBeGreaterThan(materializedAfterWarm);
  });

  it("pluginUiPinResolver 语义签名（发现 1）：提供版本号时身份翻转不失效；版本号变化才失效", () => {
    const { rows } = generateV4ReplayRows({ turns: 12, seed: 15 });
    const donor = rows.find((row) => row.kind === "toolCall" && row.turnId === "turn-4")!;
    const pluginRow = {
      ...donor,
      rowId: 900_020,
      createdAtSeq: 900_020,
      entityId: "toolCall-900020",
      turnId: "turn-3",
      toolCallId: "plugin-call-900020",
      status: "success",
      display: {
        kind: "mcp_tool",
        serverName: "server-d",
        toolName: "edit",
        ui: {
          pluginId: "plugin-d",
          resourceUri: "ui://plugin-d/main",
          surface: "panel",
          preferredDisplayMode: "fullscreen",
          showInline: false,
        },
      },
    } as typeof donor;
    const curated = insertRowBefore(
      rows,
      rows.find(
        (row) => row.kind === "assistantText" && row.turnId === "turn-3" && "actions" in row,
      )!.rowId,
      pluginRow,
    );
    const cache = createCachedConversationTurnRenderUnitsBuilder();
    const resolverA: PluginUiRowPinResolver = () => ({
      disposition: undefined,
      manualPinned: false,
    });
    cache.build(curated, {
      nowMs: BASE_NOW_MS,
      pluginUiPinResolver: resolverA,
      pluginUiDisclosureVersion: 7,
      scopeKey: "s1",
    });
    const warm = cache.build(curated, {
      nowMs: BASE_NOW_MS,
      pluginUiPinResolver: resolverA,
      pluginUiDisclosureVersion: 7,
      scopeKey: "s1",
    });
    const warmByTurn = unitByTurn(warm);
    const materializedAfterWarm = cache.stats.materialized;

    // Timeline 的真实形态：每个 token 重建 derivation/resolver 身份，版本号不变。
    const resolverB: PluginUiRowPinResolver = () => ({
      disposition: undefined,
      manualPinned: false,
    });
    const sameVersion = cache.build(curated, {
      nowMs: BASE_NOW_MS,
      pluginUiPinResolver: resolverB,
      pluginUiDisclosureVersion: 7,
      scopeKey: "s1",
    });
    expect(cache.stats.materialized).toBe(materializedAfterWarm);
    for (const unit of sameVersion) {
      expect(warmByTurn.get(unit.turnId)).toBe(unit);
    }

    // 手动披露版本号变化（manual pin / 收起）→ pin-sensitive 轮失效。
    const pinned: PluginUiRowPinResolver = () => ({ disposition: undefined, manualPinned: true });
    const bumped = cache.build(curated, {
      nowMs: BASE_NOW_MS,
      pluginUiPinResolver: pinned,
      pluginUiDisclosureVersion: 8,
      scopeKey: "s1",
    });
    expect(bumped).toEqual(oracle(curated, { nowMs: BASE_NOW_MS, pluginUiPinResolver: pinned }));
    expect(unitByTurn(bumped).get("turn-3")).not.toBe(warmByTurn.get("turn-3"));
    expect(unitByTurn(bumped).get("turn-2")).toBe(warmByTurn.get("turn-2"));
  });

  it("highspeed 跨轮 footer 到期：nowMs 越过 expiresAt 时与 oracle 一致，标记与未标记轮引用恒等（发现 5）", () => {
    const { rows } = generateV4ReplayRows({ turns: 4, seed: 12 });
    const expiresAt = BASE_NOW_MS + 1_000;
    const withCard = replaceRow(
      rows,
      rows.find((row) => row.kind === "userInput" && row.turnId === "turn-2")!.rowId,
      (row) =>
        row.kind === "userInput"
          ? ({
              ...row,
              highspeed: {
                schemaVersion: 1,
                cardId: "card-c-1",
                taskId: "task-1",
                provider: "zai",
                model: "glm-5.3",
                issuedAt: BASE_NOW_MS - 10_000,
                expiresAt,
                regularTps: 10,
                highspeedTps: 100,
                outputTokens: 2000,
                durationMs: 20_000,
              },
            } as typeof row)
          : row,
    );
    const cache = createCachedConversationTurnRenderUnitsBuilder();
    const before = cache.build(withCard, { nowMs: BASE_NOW_MS, scopeKey: "s1" });
    expect(before).toEqual(oracle(withCard, { nowMs: BASE_NOW_MS }));
    expect(before.every((unit) => unit.showHighspeedOutputFooter !== true)).toBe(true);

    const after = cache.build(withCard, { nowMs: expiresAt + 5_000, scopeKey: "s1" });
    expect(after).toEqual(oracle(withCard, { nowMs: expiresAt + 5_000 }));
    const marked = after.filter((unit) => unit.showHighspeedOutputFooter === true);
    expect(marked).toHaveLength(1);
    // 复核 #2 发现 5：已标记单元同样保持引用恒等（标记内容未变时复用上次输出对象），
    // 不再豁免标记单元；未标记轮照旧原样返回。
    const settled = cache.build(withCard, { nowMs: expiresAt + 6_000, scopeKey: "s1" });
    expect(settled).toEqual(after);
    for (let index = 0; index < after.length; index += 1) {
      expect(settled[index]).toBe(after[index]);
    }
  });

  it("复核 #2 发现 5 复现：四个终态轮各持一张已到期卡，相同 rows/options 两次 build → 0 次物化、全部输出引用恒等", () => {
    const { rows } = generateV4ReplayRows({ turns: 4, seed: 13 });
    const expiredAt = BASE_NOW_MS - 60_000;
    let withCards = rows;
    for (let turnIndex = 1; turnIndex <= 4; turnIndex += 1) {
      const target = rows.find(
        (row) => row.kind === "userInput" && row.turnId === `turn-${turnIndex}`,
      )!;
      withCards = replaceRow(withCards, target.rowId, (row) =>
        row.kind === "userInput"
          ? ({
              ...row,
              highspeed: {
                schemaVersion: 1,
                cardId: `card-distinct-${turnIndex}`,
                taskId: "task-1",
                provider: "zai",
                model: "glm-5.3",
                issuedAt: expiredAt - 30_000,
                expiresAt: expiredAt,
                regularTps: 10,
                highspeedTps: 100,
                outputTokens: 1500 + turnIndex,
                durationMs: 15_000,
              },
            } as typeof row)
          : row,
      );
    }
    const cache = createCachedConversationTurnRenderUnitsBuilder();
    const first = cache.build(withCards, { nowMs: BASE_NOW_MS, scopeKey: "s1" });
    expect(first).toEqual(oracle(withCards, { nowMs: BASE_NOW_MS }));
    expect(first.filter((unit) => unit.showHighspeedOutputFooter === true)).toHaveLength(4);
    const materializedAfterFirst = cache.stats.materialized;

    const second = cache.build(withCards, { nowMs: BASE_NOW_MS, scopeKey: "s1" });
    expect(cache.stats.materialized).toBe(materializedAfterFirst);
    expect(second.length).toBe(first.length);
    for (let index = 0; index < first.length; index += 1) {
      expect(second[index]).toBe(first[index]);
    }
  });

  it("highspeed 组尾移动语义保留：同卡新轮加入后 footer 迁移到新组尾", () => {
    const { rows } = generateV4ReplayRows({ turns: 3, seed: 14 });
    const expiredAt = BASE_NOW_MS - 60_000;
    const card = (turnIndex: number) => ({
      schemaVersion: 1 as const,
      cardId: "card-move-1",
      taskId: "task-1",
      provider: "zai",
      model: "glm-5.3",
      issuedAt: expiredAt - 30_000,
      expiresAt: expiredAt,
      regularTps: 10,
      highspeedTps: 100,
      outputTokens: 900 + turnIndex,
      durationMs: 12_000,
    });
    let withCard = replaceRow(
      rows,
      rows.find((row) => row.kind === "userInput" && row.turnId === "turn-2")!.rowId,
      (row) => (row.kind === "userInput" ? ({ ...row, highspeed: card(2) } as typeof row) : row),
    );
    const cache = createCachedConversationTurnRenderUnitsBuilder();
    const before = cache.build(withCard, { nowMs: BASE_NOW_MS, scopeKey: "s1" });
    const markedBefore = before.filter((unit) => unit.showHighspeedOutputFooter === true);
    expect(markedBefore).toHaveLength(1);
    expect(markedBefore[0]!.turnId).toBe("turn-2");

    // 同一张卡的后续轮到达：footer 组尾必须后移到 turn-3（跨轮语义不被 identity 记忆破坏）。
    withCard = replaceRow(
      withCard,
      withCard.find((row) => row.kind === "userInput" && row.turnId === "turn-3")!.rowId,
      (row) => (row.kind === "userInput" ? ({ ...row, highspeed: card(3) } as typeof row) : row),
    );
    const after = cache.build(withCard, { nowMs: BASE_NOW_MS, scopeKey: "s1" });
    expect(after).toEqual(oracle(withCard, { nowMs: BASE_NOW_MS }));
    const markedAfter = after.filter((unit) => unit.showHighspeedOutputFooter === true);
    expect(markedAfter).toHaveLength(1);
    expect(markedAfter[0]!.turnId).toBe("turn-3");
    const afterByTurn = unitByTurn(after);
    expect(afterByTurn.get("turn-2")!.showHighspeedOutputFooter).toBeUndefined();
  });

  it("交错行与对抗性 turnId（__proto__/constructor）：分组与缓存键安全", () => {
    const base = { createdAt: 1, createdAtSeq: 1 };
    const header = (turnId: string, rowId: number, state: "completedSuccess" | "running") =>
      ({
        ...base,
        kind: "turnHeader",
        rowId,
        turnId,
        origin: "userInput",
        executionKind: "agent",
        sourceCommandId: `cmd-${rowId}`,
        state,
        startedAt: 1,
        activeMs: 5,
      }) as ConversationRow;
    const text = (turnId: string, rowId: number, body: string) =>
      ({
        ...base,
        kind: "assistantText",
        rowId,
        turnId,
        entityId: `assistantText-${rowId}`,
        assistantResponseId: `r-${turnId}`,
        text: body,
        state: "complete",
      }) as ConversationRow;
    // 两轮行交错 + 原型链敏感的 turnId。
    const interleaved: ConversationRow[] = [
      header("__proto__", 1, "completedSuccess"),
      header("constructor", 2, "completedSuccess"),
      text("__proto__", 3, "a"),
      text("constructor", 4, "b"),
      text("__proto__", 5, "a2"),
    ];
    const cache = createCachedConversationTurnRenderUnitsBuilder();
    const first = cache.build(interleaved, { nowMs: BASE_NOW_MS, scopeKey: "s1" });
    expect(first).toEqual(oracle(interleaved, { nowMs: BASE_NOW_MS }));
    const warm = cache.build(interleaved, { nowMs: BASE_NOW_MS, scopeKey: "s1" });
    // 第二次全命中：引用恒等。
    expect(warm).toEqual(first);
    for (let index = 0; index < first.length; index += 1) {
      expect(warm[index]).toBe(first[index]);
    }
  });

  it("200 轮暖机后 24 个 token：物化计数有界（仅流式轮），终帧与冻结 oracle 深度相等", () => {
    const { rows: baseRows } = generateV4ReplayRows({
      turns: 200,
      seed: V4_REPLAY_FIXTURE_DEFAULT_SEED,
    });
    const tail = buildV4ReplayStreamTail({
      chunks: 24,
      baseRowId: baseRows[baseRows.length - 1]!.rowId,
      turnIndex: 201,
    });
    const cache = createCachedConversationTurnRenderUnitsBuilder();
    let snapshot = minimalSnapshot(baseRows as ConversationRow[]);
    cache.build(baseRows, { nowMs: BASE_NOW_MS, sessionPhase: "running", scopeKey: "s1" });
    const materializedAfterWarmup = cache.stats.materialized;
    for (const delta of tail.deltas) {
      snapshot = applyConversationDeltas(snapshot, [delta]);
      cache.build(snapshot.rows.window, {
        nowMs: BASE_NOW_MS,
        sessionPhase: "running",
        scopeKey: "s1",
      });
    }
    expect(cache.stats.materialized - materializedAfterWarmup).toBeLessThanOrEqual(
      tail.deltas.length,
    );
    const finalUnits = cache.build(snapshot.rows.window, {
      nowMs: BASE_NOW_MS,
      sessionPhase: "running",
      scopeKey: "s1",
    });
    expect(finalUnits).toEqual(
      oracle(snapshot.rows.window, { nowMs: BASE_NOW_MS, sessionPhase: "running" }),
    );
    // 200 个完成轮全部命中（每轮恰好一次物化发生在暖机）。
    expect(materializedAfterWarmup).toBeLessThanOrEqual(201);
  });
});
