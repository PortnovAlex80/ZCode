// 复核 #2 发现 1 的集成级回归：用真实 Timeline 接线（deriveLogicalUiInstances →
// pluginUiPinResolver 闭包 → 缓存 builder，含 pluginUiDisclosureVersion）验证
// resolver 失效语义。旧实现按 resolver 函数身份失效——Timeline 每个流式 token 都
// 重建 derivation/resolver 身份，导致全部含工具行轮次逐 token 重物化、完成轮引用
// 恒等全部丢失（无需任何插件卡片即可触发）。修复后失效按语义签名判定：
// turnId 序列 + pin-sensitive 行引用 + 披露版本号。
//
// 本文件不复刻 React 组件，直接驱动与 ConversationTimeline 相同的函数链
// （这是 review 指名要求的「real plugin derivation and resolver updates」层面）。

import { describe, expect, it } from "vitest";
import type { ConversationRow, ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import { generateV4ReplayRows } from "../../../scripts/perf/v4-replay-fixtures.mjs";
import { deriveLogicalUiInstances } from "@/plugin-ui/index.js";
import type { PluginUiRowPinResolver } from "@/plugin-ui/index.js";
import { createCachedConversationTurnRenderUnitsBuilder } from "@/v4/conversationTurnRenderUnitsCache.js";
import { buildConversationTurnRenderUnitsFrozenBaseline } from "./support/conversationTurnRenderUnitsFrozenBaseline.js";

const BASE_NOW_MS = 1_750_080_000_000;

interface TimelineWiring {
  cache: ReturnType<typeof createCachedConversationTurnRenderUnitsBuilder>;
  manualPins: Record<string, boolean>;
  disclosureVersion: number;
  /** 最近一次 build 使用的 resolver——oracle 对照必须传同一 resolver。 */
  lastResolver: PluginUiRowPinResolver | null;
  build(rows: readonly ConversationRow[]): ConversationRow["kind"][][] & {
    units: ReturnType<ReturnType<typeof createCachedConversationTurnRenderUnitsBuilder>["build"]>;
  };
}

/** 与 ConversationTimeline.tsx 完全同构的每-render 重建链：derivation → resolver。 */
function createTimelineWiring(): TimelineWiring {
  const cache = createCachedConversationTurnRenderUnitsBuilder();
  const wiring: TimelineWiring = {
    cache,
    manualPins: {},
    disclosureVersion: 3,
    lastResolver: null,
    // 每个「render」重新执行 derivation/resolver memo（身份必然变化）。
    build(rows: readonly ConversationRow[]) {
      const derivation = deriveLogicalUiInstances(rows);
      const resolver: PluginUiRowPinResolver = (toolCallId) => ({
        disposition: derivation.byToolCallId[toolCallId],
        manualPinned: wiring.manualPins[toolCallId],
      });
      wiring.lastResolver = resolver;
      const units = cache.build(rows, {
        nowMs: BASE_NOW_MS,
        sessionPhase: "completedSuccess",
        pluginUiPinResolver: resolver,
        pluginUiDisclosureVersion: wiring.disclosureVersion,
        scopeKey: "session-1:epoch-1",
      });
      return units as never;
    },
  };
  return wiring;
}

/** 冻结 oracle 对照：传同一 resolver（与 Timeline 生产形态一致）。 */
function oracleWithWiring(
  wiring: TimelineWiring,
  rows: readonly ConversationRow[],
): ReturnType<typeof buildConversationTurnRenderUnitsFrozenBaseline> {
  return buildConversationTurnRenderUnitsFrozenBaseline(rows, {
    nowMs: BASE_NOW_MS,
    sessionPhase: "completedSuccess",
    ...(wiring.lastResolver ? { pluginUiPinResolver: wiring.lastResolver } : {}),
  });
}

function pluginUiToolRow(turnId: string, rowId: number, status: ToolCallRow["status"] = "success") {
  return {
    rowId,
    turnId,
    createdAt: 1_700_000_000_000 + rowId,
    createdAtSeq: rowId,
    kind: "toolCall",
    toolCallId: `call-${rowId}`,
    toolName: "mcp__serverW__edit",
    status,
    inputText: "{}",
    display: {
      kind: "mcp_tool",
      serverName: "serverW",
      toolName: "edit",
      ui: {
        pluginId: "pluginW",
        resourceUri: "ui://pluginW/main",
        surface: "panel",
        preferredDisplayMode: "fullscreen",
        showInline: false,
      },
    },
  } as unknown as ConversationRow;
}

/** 回放历史 + 每逢 3 的倍数轮注入一条插件 UI 工具行（成功态）。 */
function pluginRichRows(turns: number, seed: number): ConversationRow[] {
  const { rows } = generateV4ReplayRows({ turns, seed });
  const withPlugins: ConversationRow[] = [];
  let nextRowId = 900_000;
  for (const row of rows) {
    if (row.kind === "assistantText" && "actions" in row && Number(row.turnId.slice(5)) % 3 === 0) {
      withPlugins.push(pluginUiToolRow(row.turnId, (nextRowId += 1)));
    }
    withPlugins.push(row as ConversationRow);
  }
  return withPlugins;
}

function unitByTurn(units: readonly { turnId: string }[]) {
  return new Map(units.map((unit) => [unit.turnId, unit]));
}

describe("timeline plugin resolver + cache wiring (review finding 1)", () => {
  it("review 复现路径：只替换一条 assistantText 行（resolver 身份照常重建）→ 完成轮引用恒等保留", () => {
    const rows = pluginRichRows(60, 20261012);
    const wiring = createTimelineWiring();
    const first = wiring.build(rows);
    expect(first).toEqual(oracleWithWiring(wiring, rows));
    const firstByTurn = unitByTurn(first);
    const materializedAfterFirst = wiring.cache.stats.materialized;

    // 文本 token：每次只替换一条 assistantText 行引用（行池结构性共享，其余行不动）。
    const textTarget = rows.find(
      (row) => row.kind === "assistantText" && row.turnId === "turn-30",
    )!;
    const baseText = (textTarget as { text: string }).text;
    for (let token = 1; token <= 10; token += 1) {
      const tokenRows = rows.map((row) =>
        row === textTarget ? ({ ...row, text: `${baseText} +t${token}` } as ConversationRow) : row,
      );
      const units = wiring.build(tokenRows);
      expect(units).toEqual(oracleWithWiring(wiring, tokenRows));
      for (const unit of units) {
        if (unit.turnId === "turn-30") continue;
        expect(firstByTurn.get(unit.turnId)).toBe(unit);
      }
    }
    // 每个 token 只重物化文本变化轮；含插件行的完成轮（turn-3/6/9/...）全部命中。
    expect(wiring.cache.stats.materialized - materializedAfterFirst).toBe(10);
  });

  it("200 轮 review 复现（无插卡也成立 → 本用例注入插件卡后仍成立）：一次 token 后物化恒为 1", () => {
    const rows = pluginRichRows(200, 20261012);
    const wiring = createTimelineWiring();
    wiring.build(rows);
    const materializedAfterWarmup = wiring.cache.stats.materialized;
    const textTarget = rows.find(
      (row) => row.kind === "assistantText" && row.turnId === "turn-100",
    )!;
    const tokenRows = rows.map((row) =>
      row === textTarget
        ? ({ ...row, text: `${(row as { text: string }).text} +t` } as ConversationRow)
        : row,
    );
    const units = wiring.build(tokenRows);
    expect(wiring.cache.stats.materialized - materializedAfterWarmup).toBe(1);
    expect(units).toEqual(oracleWithWiring(wiring, tokenRows));
  });

  it("插件行语义变化（同卡成功→error 替代关系翻转）：受影响轮失效，其余保持", () => {
    const rows = pluginRichRows(24, 5);
    const wiring = createTimelineWiring();
    const before = wiring.build(rows);
    const beforeByTurn = unitByTurn(before);
    const materializedAfterWarm = wiring.cache.stats.materialized;

    // turn-9 的插件行翻成 error：pin-sensitive 行引用变化 → 签名变化 → 敏感轮失效。
    const changed = rows.map((row) =>
      row.kind === "toolCall" && row.turnId === "turn-9" && row.toolCallId
        ? ({ ...row, status: "error" } as ConversationRow)
        : row,
    );
    const after = wiring.build(changed);
    expect(after).toEqual(oracleWithWiring(wiring, changed));
    expect(unitByTurn(after).get("turn-9")).not.toBe(beforeByTurn.get("turn-9"));
    expect(unitByTurn(after).get("turn-2")).toBe(beforeByTurn.get("turn-2"));
    expect(wiring.cache.stats.materialized).toBeGreaterThan(materializedAfterWarm);
  });

  it("新普通轮追加（无插件行）移动 autoExpand 边界：敏感轮失效（含旧轮）", () => {
    const rows = pluginRichRows(24, 6);
    const wiring = createTimelineWiring();
    const before = wiring.build(rows);
    const beforeByTurn = unitByTurn(before);
    const materializedAfterWarm = wiring.cache.stats.materialized;

    const { rows: donorRows } = generateV4ReplayRows({ turns: 25, seed: 6 });
    const newTurnRows = donorRows.filter((row) => row.turnId === "turn-25");
    const appended = [...rows, ...(newTurnRows as ConversationRow[])];
    const after = wiring.build(appended);
    expect(after).toEqual(oracleWithWiring(wiring, appended));
    // turnId 序列变化 → 签名变化 → 含插件行的轮（如 turn-24）失效；纯文本轮保持。
    expect(unitByTurn(after).get("turn-24")).not.toBe(beforeByTurn.get("turn-24"));
    expect(unitByTurn(after).get("turn-23")).toBe(beforeByTurn.get("turn-23"));
    expect(wiring.cache.stats.materialized).toBeGreaterThan(materializedAfterWarm);
  });

  it("手动披露（manual pin）版本号 bump：敏感轮失效，普通轮保持", () => {
    const rows = pluginRichRows(24, 7);
    const wiring = createTimelineWiring();
    const before = wiring.build(rows);
    const beforeByTurn = unitByTurn(before);
    const materializedAfterWarm = wiring.cache.stats.materialized;

    wiring.manualPins["call-900001"] = true;
    wiring.disclosureVersion += 1;
    const after = wiring.build(rows);
    expect(after).toEqual(oracleWithWiring(wiring, rows));
    expect(wiring.cache.stats.materialized).toBeGreaterThan(materializedAfterWarm);
    // 非敏感轮不受披露变化影响。
    expect(unitByTurn(after).get("turn-2")).toBe(beforeByTurn.get("turn-2"));
  });
});
