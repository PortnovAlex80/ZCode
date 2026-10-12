import { describe, expect, it } from "vitest";
import {
  V4_REPLAY_FIXTURE_DEFAULT_SEED,
  buildV4ReplayStreamTail,
  generateV4ReplayRows,
} from "../../../scripts/perf/v4-replay-fixtures.mjs";
import {
  applyConversationDeltas,
  conversationDeltaSchema,
  conversationRowSchema,
  type ConversationRow,
  type ConversationSnapshot,
} from "@zcode/shared/zcode-protocol-v4";
import { buildConversationTurnRenderUnits } from "@/v4/conversationTurnRenderUnits.js";
import {
  buildConversationTurnNavigatorItems,
  createCachedConversationTurnNavigatorItemsBuilder,
} from "@/v4/conversationTurnNavigatorHelpers.js";

/**
 * P-01 v4 回放基线的 fixture 契约测试。
 *
 * 这里锁的是「合成回放数据在协议与渲染管线上的合法性/确定性」，不是性能数值：
 * 时间基线由 scripts/perf/run-render-baseline.mjs 记录在
 * docs/spec-harness/RENDERING-BASELINE.md，单测内做时序断言只会引入抖动。
 */
describe("v4 replay baseline fixtures", () => {
  it("is deterministic for a given seed and varies across seeds", () => {
    const first = generateV4ReplayRows({ turns: 24, seed: 7 });
    const second = generateV4ReplayRows({ turns: 24, seed: 7 });
    expect(JSON.stringify(second.rows)).toEqual(JSON.stringify(first.rows));

    const other = generateV4ReplayRows({ turns: 24, seed: 8 });
    expect(JSON.stringify(other.rows)).not.toEqual(JSON.stringify(first.rows));
  });

  it("produces rows that satisfy the frozen v4 conversation row schema", () => {
    const { rows } = generateV4ReplayRows({ turns: 120, seed: V4_REPLAY_FIXTURE_DEFAULT_SEED });
    expect(rows.length).toBeGreaterThan(120 * 8);
    for (const row of rows) {
      const parsed = conversationRowSchema.safeParse(row);
      if (!parsed.success) {
        throw new Error(
          `row ${row.rowId} (${row.kind}) invalid: ${JSON.stringify(parsed.error.issues)}`,
        );
      }
    }
  });

  it("keeps row invariants: ascending rowId, createdAtSeq mirroring, one header per turn", () => {
    const { rows, stats } = generateV4ReplayRows({
      turns: 60,
      seed: V4_REPLAY_FIXTURE_DEFAULT_SEED,
    });
    let previousRowId = 0;
    const headersByTurn = new Map<string, number>();
    for (const row of rows) {
      expect(row.rowId).toBeGreaterThan(previousRowId);
      previousRowId = row.rowId;
      expect(row.createdAtSeq).toBe(row.rowId);
      expect(row.entityId).toBe(`${row.kind}-${row.rowId}`);
      if (row.kind === "turnHeader") {
        headersByTurn.set(row.turnId, (headersByTurn.get(row.turnId) ?? 0) + 1);
      }
    }
    expect(headersByTurn.size).toBe(60);
    expect([...headersByTurn.values()].every((count) => count === 1)).toBe(true);
    expect(stats.realUserQueries).toBe(60);
  });

  it("produces stream-tail deltas that satisfy the delta schema", () => {
    const tail = buildV4ReplayStreamTail({ chunks: 12, baseRowId: 500, turnIndex: 3 });
    for (const delta of tail.deltas) {
      const parsed = conversationDeltaSchema.safeParse(delta);
      if (!parsed.success) {
        throw new Error(`delta ${delta.op} invalid: ${JSON.stringify(parsed.error.issues)}`);
      }
    }
    const appended = tail.deltas.filter((delta) => delta.op === "row.appended");
    const textDeltas = tail.deltas.filter((delta) => delta.op === "row.delta");
    expect(appended).toHaveLength(3);
    expect(textDeltas).toHaveLength(12);
  });
});

describe("v4 replay render pipeline", () => {
  const fixtureTurns = 120;
  const fixture = generateV4ReplayRows({
    turns: fixtureTurns,
    seed: V4_REPLAY_FIXTURE_DEFAULT_SEED,
  });
  const nowMs = fixture.rows[fixture.rows.length - 1]!.createdAt + 1_000;
  const units = buildConversationTurnRenderUnits(fixture.rows, {
    nowMs,
    sessionPhase: "completedSuccess",
  });

  it("materializes exactly one render unit per replayed turn", () => {
    expect(units).toHaveLength(fixtureTurns);
    for (const unit of units) {
      const realUserInputs = unit.visibleUserInputs.filter((row) => row.origin === "realUser");
      expect(realUserInputs).toHaveLength(1);
      expect(unit.isRunning).toBe(false);
    }
  });

  it("applies renderer-side visibility rules: EnterPlanMode and empty reasoning are trimmed", () => {
    for (const unit of units) {
      const visibleToolNames = unit.assistantWorkRows
        .filter((row) => row.kind === "toolCall")
        .map((row) => row.toolName);
      expect(visibleToolNames).not.toContain("EnterPlanMode");
      const visibleReasoning = unit.assistantWorkRows.filter((row) => row.kind === "reasoning");
      for (const row of visibleReasoning) {
        expect(row.text.trim().length).toBeGreaterThan(0);
      }
      for (const row of unit.renderRows) {
        expect(row.kind).not.toBe("turnHeader");
        expect(row.kind).not.toBe("hookInvocation");
      }
    }
  });

  it("routes marker lanes: light boundary leads the turn, goal verify stays in the tail", () => {
    const turn40 = units.find((unit) => unit.turnId === "turn-40");
    expect(turn40?.leadingBoundaryRows).toHaveLength(1);
    expect(turn40?.leadingBoundaryRows[0]?.kind).toBe("timelineMarker");

    const turn50 = units.find((unit) => unit.turnId === "turn-50");
    const tailMarkers = (turn50?.assistantTailRows ?? []).filter(
      (row) => row.kind === "timelineMarker",
    );
    expect(tailMarkers).toHaveLength(1);

    const turn25 = units.find((unit) => unit.turnId === "turn-25");
    const compactMarkers = (turn25?.assistantWorkRows ?? []).filter(
      (row) => row.kind === "timelineMarker" && row.marker.type === "compact",
    );
    expect(compactMarkers).toHaveLength(1);
  });

  it("extracts browser turn-end screenshots and keeps subagent rows", () => {
    const turn10 = units.find((unit) => unit.turnId === "turn-10");
    expect(turn10?.browserTurnEndRows).toHaveLength(1);
    expect(turn10?.browserTurnEndRows[0]?.display?.kind).toBe("node_repl_images");

    const turn7 = units.find((unit) => unit.turnId === "turn-7");
    expect(turn7?.assistantWorkRows.some((row) => row.kind === "subagent")).toBe(true);
  });

  it("force-opens abnormal history for interrupted turns", () => {
    const interrupted = units.find((unit) => unit.turnId === "turn-23");
    expect(interrupted?.header?.state).toBe("completedInterrupted");
    expect(interrupted?.assistantHistoryDefaultOpen).toBe(true);

    const normal = units.find((unit) => unit.turnId === "turn-24");
    expect(normal?.header?.state).toBe("completedSuccess");
    expect(normal?.latestAssistantTextRow).toBeDefined();
  });

  it("builds the same navigator directory through the cached and uncached paths", () => {
    const options = {
      assistantEmptyPreview: "（无文本输出）",
      assistantRunningPreview: "正在工作…",
      userFallbackPreview: "（用户消息）",
    };
    const uncached = buildConversationTurnNavigatorItems(units, options);
    const cachedBuilder = createCachedConversationTurnNavigatorItemsBuilder();
    cachedBuilder(units, options);
    const cachedSteadyState = cachedBuilder(units, options);

    // 目录按用户可见 realUser query 建项：background 输入（每 9 轮一条）不得进入目录。
    expect(uncached).toHaveLength(fixtureTurns);
    expect(cachedSteadyState.map((item) => item.key)).toEqual(uncached.map((item) => item.key));
    expect(uncached.every((item) => !item.isRunning)).toBe(true);
    expect(uncached.every((item) => item.userPreview.length > 0)).toBe(true);
    expect(uncached.every((item) => item.assistantPreviewKind === "text")).toBe(true);
  });
});

describe("v4 replay streaming tail replay", () => {
  function minimalSnapshot(rows: ConversationRow[]): ConversationSnapshot {
    return {
      rows: { window: rows, totalCount: rows.length, firstRowId: rows[0]?.rowId ?? null },
    } as unknown as ConversationSnapshot;
  }

  it("applies appended streaming rows, accumulates row.delta text and completes via upsert", () => {
    const { rows } = generateV4ReplayRows({ turns: 5, seed: V4_REPLAY_FIXTURE_DEFAULT_SEED });
    const tail = buildV4ReplayStreamTail({
      chunks: 16,
      baseRowId: rows[rows.length - 1]!.rowId,
      turnIndex: 6,
    });

    let snapshot = minimalSnapshot(rows);
    for (const delta of tail.deltas) {
      snapshot = applyConversationDeltas(snapshot, [delta]);
    }

    const finalTextRow = snapshot.rows.window.find((row) => row.rowId === tail.streamingRowId);
    expect(finalTextRow).toMatchObject({ kind: "assistantText", state: "complete" });
    if (finalTextRow?.kind === "assistantText") {
      expect(finalTextRow.text).toBe(tail.expectedText);
    }
    const headerRow = snapshot.rows.window.find(
      (row) => row.kind === "turnHeader" && row.turnId === tail.turnId,
    );
    expect(headerRow).toMatchObject({ state: "completedSuccess" });
    expect(snapshot.rows.window).toHaveLength(
      rows.length + tail.deltas.filter((d) => d.op === "row.appended").length,
    );
  });

  it("truncates the loaded window on row.removed like an edit/rerun branch cut", () => {
    const { rows } = generateV4ReplayRows({ turns: 5, seed: 3 });
    const snapshot = minimalSnapshot(rows);
    const cutFromRowId = rows[rows.length - 6]!.rowId;
    const truncated = applyConversationDeltas(snapshot, [
      { op: "row.removed", fromRowId: cutFromRowId },
    ]);
    expect(truncated.rows.window).toHaveLength(rows.length - 6);
    expect(truncated.rows.window.every((row) => row.rowId < cutFromRowId)).toBe(true);
    expect(truncated.rows.totalCount).toBe(rows.length - 6);
  });

  it("is a no-op for row.delta against an unloaded rowId (§4.3 patch semantics)", () => {
    const { rows } = generateV4ReplayRows({ turns: 3, seed: 3 });
    const snapshot = minimalSnapshot(rows);
    const untouched = applyConversationDeltas(snapshot, [
      { op: "row.delta", rowId: 999_999, path: "text", append: "ignored" },
    ]);
    expect(untouched.rows.window).toBe(snapshot.rows.window);
  });
});
