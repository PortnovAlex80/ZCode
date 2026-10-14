import { describe, expect, it } from "vitest";
import {
  applyConversationDelta,
  applyConversationDeltas,
  applyConversationFrame,
  conversationDeltaSchema,
  type ConversationDelta,
  type ConversationRow,
  type ConversationSnapshot,
} from "../src/zcode-protocol-v4/index.js";

/**
 * Wave B：applyConversationFrame（一帧批量）与逐条 apply 裁判的等价性契约。
 *
 * 裁判是 applyConversationDeltas —— 本文件不复制它的实现，只对照它的输出：
 * 深相等 + JSON.stringify 逐字节一致（键序也是语义，workflow-runs 的先例），
 * 外加引用语义（no-op 同引用、未触及行保持 Object.is）与输入不可变性。
 */

function makeRow(rowId: number, kind: ConversationRow["kind"] = "assistantText"): ConversationRow {
  const base = {
    rowId,
    turnId: `turn-${Math.ceil(rowId / 5)}`,
    createdAt: 1000 + rowId,
    createdAtSeq: rowId,
    entityId: `${kind}-${rowId}`,
  };
  switch (kind) {
    case "turnHeader":
      return {
        ...base,
        kind,
        origin: "userInput",
        executionKind: "agent",
        sourceCommandId: `cmd-${rowId}`,
        state: "running",
        startedAt: 1000 + rowId,
      };
    case "userInput":
      return {
        ...base,
        kind,
        text: `问题 ${rowId}`,
        origin: "realUser",
        sourceCommandId: `cmd-${rowId}`,
      };
    case "assistantText":
      return { ...base, kind, assistantResponseId: `resp-${rowId}`, text: "", state: "streaming" };
    case "reasoning":
      return { ...base, kind, assistantResponseId: `resp-${rowId}`, text: "", state: "streaming" };
    case "toolCall":
      return {
        ...base,
        kind,
        assistantResponseId: `resp-${rowId}`,
        toolCallId: `tc-${rowId}`,
        toolName: "Read",
        status: "inputStreaming",
        inputText: "",
      };
    case "subagent":
      return {
        ...base,
        kind,
        subagentType: "general-purpose",
        status: "running",
        summaryText: "",
        childSessionId: `child-${rowId}`,
      };
    default:
      return {
        ...base,
        kind: "timelineMarker",
        lane: "assistantWork",
        marker: { type: "compact" },
      };
  }
}

function makeWindow(): ConversationRow[] {
  const rows: ConversationRow[] = [];
  let rowId = 0;
  const cycle: ConversationRow["kind"][] = [
    "turnHeader",
    "userInput",
    "reasoning",
    "toolCall",
    "subagent",
    "assistantText",
  ];
  for (let turn = 0; turn < 8; turn += 1) {
    for (const kind of cycle) {
      rowId += 1;
      rows.push(makeRow(rowId, kind));
    }
  }
  // toolCall 行带上既有 output，覆盖 output.text 追加路径。
  const toolRow = rows.find((row) => row.kind === "toolCall") as Extract<
    ConversationRow,
    { kind: "toolCall" }
  >;
  toolRow.output = { text: "已有输出" };
  return rows;
}

function makeSnapshot(window: ConversationRow[] = makeWindow()): ConversationSnapshot {
  return {
    protocolVersion: 1,
    sessionId: "s-1",
    logEpoch: "epoch-1",
    seq: 10,
    revision: 3,
    control: {
      phase: "running",
      sessionEnded: false,
      canStop: true,
      stopState: "stoppable",
      stopTargetKind: "assistant",
      activeWorks: [{ kind: "primaryTurn", startedAt: 1000 }],
      lastError: null,
      apiRetry: null,
    },
    availability: {
      fork: { allowed: true },
      compact: { allowed: false, reasonCode: "guard.manualCompact" },
      switchModelConfig: { allowed: true },
      setFollowupMode: { allowed: true },
      queueEdit: { allowed: true },
      sendQueuedNow: { allowed: false, reasonCode: "guard.sendQueuedNowStopsBeforeDrain" },
      pauseGoal: { allowed: false, reasonCode: "guard.noGoal" },
      resumeGoal: { allowed: false, reasonCode: "guard.stopPausesActiveGoalTarget" },
    },
    inputRouting: { mode: "enqueue" },
    meta: { title: "", titleSource: "default" },
    config: {
      provider: "glm",
      model: "glm-5",
      thought: "medium",
      thoughtLevels: ["medium", "high", "max"],
      followupMode: "queue",
      mode: "build",
    },
    modelTransition: null,
    usage: {
      contextWindow: { usedTokens: 100, maxTokens: 200000, autoCompactThresholdTokens: null },
      cumulative: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    queue: { items: [], autoDrain: true },
    pendingInteractions: [],
    pendingCommands: [],
    backgroundWorks: [],
    workspaceHookAdmission: null,
    goal: null,
    plan: null,
    rows: { window, totalCount: window.length, firstRowId: window[0]?.rowId ?? null },
  };
}

function toolRowIdAt(window: ConversationRow[], offset = 0): number {
  const tools = window.filter((row) => row.kind === "toolCall");
  return tools[offset]!.rowId;
}

function runBirth(runId: string, revision: number, ordinal = 1): ConversationDelta {
  return {
    op: "workflowRun.updated",
    runId,
    revision,
    run: {
      runId,
      status: "running",
      usage: { spentTokens: revision, nodesUsed: ordinal },
      lastEventSequence: revision,
    },
    nodes: [{ siteId: "node", ordinal, phase: "queued" }],
  };
}

function pluginDeltas(): ConversationDelta[] {
  const subscribers = [
    {
      scopeId: "scope",
      generation: 0,
      instance: {
        runtimeId: "runtime-1",
        generation: 1,
        appIdentity: "a".repeat(64),
        token: "token",
      },
    },
  ];
  return [
    { op: "pluginUi.resourceUpdated", pluginId: "p", serverName: "s", uri: "res://x", subscribers },
    { op: "pluginUi.resourceListChanged", pluginId: "p", serverName: "s", subscribers: [] },
    { op: "pluginUi.instanceClosed", pluginId: "p", serverName: "s", subscribers },
    {
      op: "pluginUi.appToolCall",
      pluginId: "p",
      serverName: "s",
      subscribers,
      callId: "c1",
      toolName: "t",
      arguments: {},
    },
  ];
}

/** 裁判对照：深相等 + JSON 逐字节一致 + （可选）引用断言。 */
function expectFrameEquivalence(
  snapshot: ConversationSnapshot,
  deltas: ConversationDelta[],
): { frame: ConversationSnapshot; oracle: ConversationSnapshot } {
  const frame = applyConversationFrame(snapshot, deltas);
  const oracle = applyConversationDeltas(snapshot, deltas);
  expect(frame).toEqual(oracle);
  expect(JSON.stringify(frame)).toBe(JSON.stringify(oracle));
  return { frame, oracle };
}

describe("applyConversationFrame equivalence with the per-delta oracle", () => {
  it("matches byte-for-byte across representative multi-op frames", () => {
    const snapshot = makeSnapshot();
    const window = snapshot.rows.window;
    const lastId = window[window.length - 1]!.rowId;
    const toolId = toolRowIdAt(window);
    const frames: ConversationDelta[][] = [
      // 24 条同 rowId 流式追加（未合并 stress 形态）。
      Array.from({ length: 24 }, () => ({
        op: "row.delta",
        rowId: lastId,
        path: "text" as const,
        append: "段落。",
      })),
      // 分布式 late 更新：老 turn 的 assistantText/toolCall 混合。
      window
        .filter((row) => row.kind === "assistantText" || row.kind === "reasoning")
        .slice(0, 10)
        .map((row) => ({
          op: "row.delta" as const,
          rowId: row.rowId,
          path: "text" as const,
          append: "后到结果",
        })),
      [
        ...window.slice(0, 5).map((row) => ({
          op: "row.delta" as const,
          rowId: row.rowId,
          path: "text" as const,
          append: "x",
        })),
        {
          op: "state.updated" as const,
          patch: { revision: 4, usage: { cumulative: { inputTokens: 9 } } },
        },
        runBirth("run-1", 5),
      ],
      // 截断 → 重新 append → 对新行 delta（索引必须在 removal 后失效/重建）。
      [
        { op: "row.removed" as const, fromRowId: window[20]!.rowId },
        { op: "row.appended" as const, row: makeRow(lastId + 1, "assistantText") },
        {
          op: "row.delta" as const,
          rowId: lastId + 1,
          path: "text" as const,
          append: "新分支流式",
        },
        {
          op: "row.upserted" as const,
          row: { ...makeRow(lastId + 1, "assistantText"), state: "complete" as const },
        },
      ],
      // 整分支重置（fromRowId <= firstRowId）：totalCount/firstRowId 归零后再 append。
      [
        { op: "row.removed" as const, fromRowId: window[0]!.rowId },
        { op: "row.appended" as const, row: makeRow(lastId + 100, "turnHeader") },
      ],
      // workflow 整键替换与增量交错（coalesce 规则 6 的屏障语义）。
      [
        { op: "state.updated" as const, patch: { workflowRuns: { revision: 9, runs: [] } } },
        runBirth("run-2", 10),
        { op: "workflowRun.removed" as const, runId: "run-2", revision: 11 },
        { op: "state.updated" as const, patch: { workflowRuns: { revision: 12, runs: [] } } },
        runBirth("run-3", 13),
      ],
      // upsert 吞并语义的前置形态：先 delta 再整行替换（未合并序列）。
      [
        { op: "row.delta" as const, rowId: toolId, path: "inputText" as const, append: "{}" },
        {
          op: "row.upserted" as const,
          row: { ...makeRow(toolId, "toolCall"), status: "success" as const },
        },
        { op: "row.delta" as const, rowId: toolId, path: "output.text" as const, append: "完成" },
      ],
      // 全 no-op 混合：未命中 upsert/delta + live-only 通知。
      [
        { op: "row.upserted" as const, row: makeRow(99_999, "assistantText") },
        { op: "row.delta" as const, rowId: 99_998, path: "text" as const, append: "miss" },
        ...pluginDeltas(),
      ],
      // row.removed 未删任何行（fromRowId 超过窗口尾）。
      [{ op: "row.removed" as const, fromRowId: lastId + 500 }],
      // 空字符串追加：逐条实现也会产出新行对象（引用变更、内容相等）。
      [
        { op: "row.delta" as const, rowId: lastId, path: "text" as const, append: "" },
        { op: "row.delta" as const, rowId: lastId, path: "text" as const, append: "y" },
      ],
      // 控制帧：只有 state 键。
      [
        {
          op: "state.updated" as const,
          patch: { revision: 7, queue: { items: [], autoDrain: true } },
        },
        { op: "state.updated" as const, patch: { availability: { fork: { allowed: false } } } },
      ],
    ];
    for (const deltas of frames) {
      expectFrameEquivalence(snapshot, deltas);
    }
  });

  it("covers every streamable path and wrong-kind no-ops", () => {
    const snapshot = makeSnapshot();
    const window = snapshot.rows.window;
    const reasoning = window.find((row) => row.kind === "reasoning")!;
    const assistant = window.filter((row) => row.kind === "assistantText")[1]!;
    const tool = window.find((row) => row.kind === "toolCall") as Extract<
      ConversationRow,
      { kind: "toolCall" }
    >;
    const toolWithoutOutput = window.filter((row) => row.kind === "toolCall")[1] as Extract<
      ConversationRow,
      { kind: "toolCall" }
    >;
    const subagent = window.find((row) => row.kind === "subagent") as Extract<
      ConversationRow,
      { kind: "subagent" }
    >;
    const deltas: ConversationDelta[] = [
      { op: "row.delta", rowId: assistant.rowId, path: "text", append: "a" },
      { op: "row.delta", rowId: reasoning.rowId, path: "text", append: "r" },
      { op: "row.delta", rowId: tool.rowId, path: "inputText", append: "i" },
      { op: "row.delta", rowId: tool.rowId, path: "output.text", append: "o" },
      { op: "row.delta", rowId: subagent.rowId, path: "summaryText", append: "s" },
      // 错误类型 / 缺失路径：逐条实现返回原行（no-op 内容）。
      { op: "row.delta", rowId: tool.rowId, path: "text", append: "wrong-kind" },
      { op: "row.delta", rowId: toolWithoutOutput.rowId, path: "output.text", append: "no-output" },
      { op: "row.delta", rowId: assistant.rowId, path: "summaryText", append: "wrong-kind" },
    ];
    const { frame } = expectFrameEquivalence(snapshot, deltas);
    const toolOut = frame.rows.window.find((row) => row.rowId === tool.rowId) as Extract<
      ConversationRow,
      { kind: "toolCall" }
    >;
    expect(toolOut.output?.text).toBe("已有输出o");
  });

  it("keeps reference semantics: no-op frames return the same snapshot, untouched rows keep identity", () => {
    const snapshot = makeSnapshot();
    const window = snapshot.rows.window;
    const lastId = window[window.length - 1]!.rowId;

    // 空帧 / 单条 no-op / 全 no-op 混合：同引用（与逐条裁判一致）。
    expect(applyConversationFrame(snapshot, [])).toBe(snapshot);
    expect(
      applyConversationFrame(snapshot, [
        { op: "row.delta", rowId: 99_999, path: "text", append: "x" },
      ]),
    ).toBe(snapshot);
    expect(
      applyConversationFrame(snapshot, [
        ...pluginDeltas(),
        { op: "row.upserted", row: makeRow(99_997, "assistantText") },
      ]),
    ).toBe(snapshot);

    // 流式帧只动目标行：其余行保持 Object.is。
    const streamed = applyConversationFrame(snapshot, [
      { op: "row.delta", rowId: lastId, path: "text", append: "token " },
      { op: "row.delta", rowId: lastId, path: "text", append: "token " },
    ]);
    for (const row of snapshot.rows.window) {
      if (row.rowId === lastId) continue;
      expect(streamed.rows.window.find((candidate) => candidate.rowId === row.rowId)).toBe(row);
    }

    // row.removed 未删任何行：与裁判一样仍产出新引用（filter 总是新数组）。
    const trimmedNothing = applyConversationFrame(snapshot, [
      { op: "row.removed", fromRowId: lastId + 500 },
    ]);
    expect(trimmedNothing).not.toBe(snapshot);
    expect(trimmedNothing.rows.window.every((row, index) => row === window[index])).toBe(true);
  });

  it("never mutates frozen inputs or previously published snapshots", () => {
    const snapshot = makeSnapshot();
    const deltas: ConversationDelta[] = [
      { op: "row.delta", rowId: snapshot.rows.window[3]!.rowId, path: "text", append: "a" },
      { op: "row.appended", row: makeRow(999, "assistantText") },
      { op: "state.updated", patch: { revision: 8 } },
      runBirth("run-x", 3),
    ];
    // 未冻结孪生先取裁判结果；再对深冻结输入跑批量路径，任何写入都会直接抛错。
    const { oracle } = expectFrameEquivalence(snapshot, deltas);
    const frozen = JSON.parse(JSON.stringify(snapshot)) as ConversationSnapshot;
    const frozenDeltas = JSON.parse(JSON.stringify(deltas)) as ConversationDelta[];
    deepFreeze(frozen);
    for (const delta of frozenDeltas) deepFreeze(delta);
    const fromFrozen = applyConversationFrame(frozen, frozenDeltas);
    expect(fromFrozen).toEqual(oracle);

    // 已发布快照不被后续帧修改；未触及行的引用跨多次发布保留。
    const first = applyConversationFrame(snapshot, deltas);
    const firstFrozenClone = structuredClone(first);
    deepFreeze(firstFrozenClone);
    const second = applyConversationFrame(first, [
      { op: "row.delta", rowId: snapshot.rows.window[4]!.rowId, path: "text", append: "b" },
      { op: "row.delta", rowId: 999, path: "text", append: "c" },
    ]);
    expect(first).toEqual(firstFrozenClone);
    expect(second.rows.window.find((row) => row.rowId === snapshot.rows.window[0]!.rowId)).toBe(
      snapshot.rows.window[0],
    );
    // 999 行在两帧间被追加+继续流式，第二帧后仍是同一对象的演化（非重建窗口全量替换）。
    const appendedInFirst = first.rows.window.find((row) => row.rowId === 999)!;
    const evolvedInSecond = second.rows.window.find((row) => row.rowId === 999)!;
    expect(evolvedInSecond).not.toBe(appendedInFirst); // 文本变了 → 新行对象（与裁判一致）
    expect(evolvedInSecond).toEqual(
      (
        applyConversationDeltas(first, [
          { op: "row.delta", rowId: 999, path: "text", append: "c" },
        ]) as ConversationSnapshot
      ).rows.window.find((row) => row.rowId === 999)!,
    );
  });

  // ── Review #2 finding 7：批量装配对“新引入状态键”的键序与显式 undefined 语义 ──

  it("assembles newly introduced state keys in the oracle arrival order", () => {
    // 评审复现：两个键在初始快照上都缺席——workspaceHookAdmission 先到、workflowRuns 后到。
    // 裁判 {...snapshot, ...patch} 链按到达顺序追加新键；候选不得因独立装配 workflowRuns 而换序。
    const stripped = makeSnapshot() as ConversationSnapshot & Record<string, unknown>;
    delete stripped.workflowRuns;
    delete stripped.workspaceHookAdmission;
    const reviewDeltas: ConversationDelta[] = [
      { op: "state.updated", patch: { workspaceHookAdmission: null } },
      { op: "state.updated", patch: { workflowRuns: { revision: 1, runs: [] } } },
    ];
    const { frame, oracle } = expectFrameEquivalence(
      stripped as ConversationSnapshot,
      reviewDeltas,
    );
    const frameKeys = Object.keys(frame as Record<string, unknown>);
    const oracleKeys = Object.keys(oracle as Record<string, unknown>);
    expect(frameKeys).toEqual(oracleKeys);
    expect(frameKeys.indexOf("workspaceHookAdmission")).toBeLessThan(
      frameKeys.indexOf("workflowRuns"),
    );

    // 反向到达：workflowRun.updated 先引入 workflowRuns 键，其后到达的新状态键缀在其后。
    const reverseDeltas: ConversationDelta[] = [
      runBirth("run-order", 2),
      { op: "state.updated", patch: { workspaceHookAdmission: null } },
    ];
    const reverse = expectFrameEquivalence(stripped as ConversationSnapshot, reverseDeltas);
    const reverseKeys = Object.keys(reverse.frame as Record<string, unknown>);
    expect(reverseKeys).toEqual(Object.keys(reverse.oracle as Record<string, unknown>));
    expect(reverseKeys.indexOf("workflowRuns")).toBeLessThan(
      reverseKeys.indexOf("workspaceHookAdmission"),
    );
  });

  it("clears workflowRuns on an explicitly present undefined patch value, like the reference", () => {
    // 公开 schema/type 允许显式 undefined：裁判 {...snapshot, ...patch} 会把该键整体置 undefined
    // （键仍在、值被清）；候选的 !== undefined 检查不得把它当成“键缺席”而保留旧值。
    const base = {
      ...makeSnapshot(),
      workflowRuns: { revision: 5, runs: [] },
    } as ConversationSnapshot;
    const clearingDelta = {
      op: "state.updated",
      patch: { workflowRuns: undefined },
    } as unknown as ConversationDelta;
    // 前提自检：线上 schema 确实放行显式 undefined（评审断言的公开契约）。
    expect(conversationDeltaSchema.safeParse(clearingDelta).success).toBe(true);

    const { frame, oracle } = expectFrameEquivalence(base, [clearingDelta]);
    expect(oracle.workflowRuns).toBeUndefined();
    expect(frame.workflowRuns).toBeUndefined();

    // 清除后同帧/后续 workflowRun.updated 在 undefined 上重新出生（与裁判一致）。
    expectFrameEquivalence(base, [clearingDelta, runBirth("run-reborn", 6)]);
    expectFrameEquivalence(base, [runBirth("run-keep", 6), clearingDelta]);
  });

  it("retains and freezes nested toolCall.output across consecutive output.text updates", () => {
    const window = makeWindow();
    const tools = window.filter((row) => row.kind === "toolCall") as Extract<
      ConversationRow,
      { kind: "toolCall" }
    >[];
    // tools[0] 已带 output {text:"已有输出"}；tools[1] 带 display，用于嵌套引用保留断言。
    tools[1]!.output = {
      text: "B0",
      display: {
        kind: "file_diff",
        filePath: "x.ts",
        additions: 1,
        deletions: 0,
        structuredPatch: [],
      },
    };
    const snapshot = makeSnapshot(window);
    const outputText = (rowId: number, append: string): ConversationDelta => ({
      op: "row.delta",
      rowId,
      path: "output.text",
      append,
    });

    // 连续两次发布都命中同一 tool 行的 output.text。
    const first = applyConversationFrame(snapshot, [outputText(tools[0]!.rowId, "+1")]);
    expect(JSON.stringify(first)).toBe(
      JSON.stringify(applyConversationDeltas(snapshot, [outputText(tools[0]!.rowId, "+1")])),
    );
    const second = applyConversationFrame(first, [
      outputText(tools[0]!.rowId, "+2"),
      outputText(tools[1]!.rowId, "+B"),
    ]);
    expect(JSON.stringify(second)).toBe(
      JSON.stringify(
        applyConversationDeltas(first, [
          outputText(tools[0]!.rowId, "+2"),
          outputText(tools[1]!.rowId, "+B"),
        ]),
      ),
    );

    // 入参与已发布快照的嵌套 output 不被后续帧修改。
    expect(tools[0]!.output?.text).toBe("已有输出");
    const firstRowAfterSecond = second.rows.window.find(
      (row) => row.rowId === tools[0]!.rowId,
    ) as Extract<ConversationRow, { kind: "toolCall" }>;
    expect(firstRowAfterSecond.output?.text).toBe("已有输出+1+2");
    expect(
      (
        first.rows.window.find((row) => row.rowId === tools[0]!.rowId) as Extract<
          ConversationRow,
          { kind: "toolCall" }
        >
      ).output?.text,
    ).toBe("已有输出+1");

    // 未触及的 tool 行整行（含嵌套 output）保持 Object.is。
    expect(second.rows.window.find((row) => row.rowId === tools[2]!.rowId)).toBe(tools[2]);

    // 被更新行的 output 外壳换新，但未变的嵌套子值（display）保留引用——与
    // {...row.output, text} 的裁判语义一致。
    const secondToolB = second.rows.window.find((row) => row.rowId === tools[1]!.rowId) as Extract<
      ConversationRow,
      { kind: "toolCall" }
    >;
    expect(secondToolB.output).not.toBe(tools[1]!.output);
    expect(secondToolB.output?.display).toBe(tools[1]!.output?.display);

    // 深冻结输入上的连续 output.text 更新（多 op 单帧 + 跨帧）不抛错、结果与裁判一致。
    const frozen = JSON.parse(JSON.stringify(snapshot)) as ConversationSnapshot;
    const frozenDeltas = JSON.parse(
      JSON.stringify([
        outputText(tools[0]!.rowId, "+f1"),
        outputText(tools[0]!.rowId, "+f2"),
        outputText(tools[1]!.rowId, "+fB"),
      ]),
    ) as ConversationDelta[];
    deepFreeze(frozen);
    for (const delta of frozenDeltas) deepFreeze(delta);
    const frozenResult = applyConversationFrame(frozen, frozenDeltas);
    expect(frozenResult).toEqual(applyConversationDeltas(snapshot, frozenDeltas));
  });

  it("rebuilds the lookup index after removals, appends and defensive window replacement", () => {
    const snapshot = makeSnapshot();
    const window = snapshot.rows.window;
    const victim = window[30]!;
    const earlier = window[10]!;
    // delta 命中 → removal 使下标失效 → 对被删行 delta 必须变 no-op → 对更早行 delta 仍命中。
    expectFrameEquivalence(snapshot, [
      { op: "row.delta", rowId: victim.rowId, path: "text", append: "命中后删除" },
      { op: "row.removed", fromRowId: victim.rowId },
      { op: "row.delta", rowId: victim.rowId, path: "text", append: "应 no-op" },
      { op: "row.delta", rowId: earlier.rowId, path: "text", append: "重建后命中" },
    ]);
    // 同帧内 append 后立刻对新增行 upsert / delta（帧内索引必须覆盖帧内新行）。
    const appendedId = window[window.length - 1]!.rowId + 1;
    expectFrameEquivalence(snapshot, [
      { op: "row.appended", row: makeRow(appendedId, "toolCall") },
      { op: "row.delta", rowId: appendedId, path: "inputText", append: "帧内新行" },
      { op: "row.upserted", row: { ...makeRow(appendedId, "toolCall"), status: "success" } },
      { op: "row.delta", rowId: appendedId, path: "inputText", append: "追加" },
    ]);
    // schema 外的 rows 整体替换键（防御分支）：后续行 op 作用于新窗，旧窗行 no-op。
    const replacement: ConversationSnapshot = makeSnapshot([
      makeRow(1, "assistantText"),
      makeRow(2, "assistantText"),
    ]);
    const rowsReplacementDelta = {
      op: "state.updated",
      patch: { rows: replacement.rows },
    } as unknown as ConversationDelta;
    expectFrameEquivalence(snapshot, [
      rowsReplacementDelta,
      { op: "row.delta", rowId: 1, path: "text", append: "新窗命中" },
      { op: "row.delta", rowId: window[0]!.rowId, path: "text", append: "旧窗应 no-op" },
    ]);
  });

  it("matches the oracle for single-delta frames of every op kind (delegation path)", () => {
    const snapshot = makeSnapshot();
    const window = snapshot.rows.window;
    const lastId = window[window.length - 1]!.rowId;
    const singles: ConversationDelta[] = [
      { op: "row.appended", row: makeRow(lastId + 1, "assistantText") },
      { op: "row.upserted", row: { ...makeRow(lastId, "assistantText"), state: "complete" } },
      { op: "row.removed", fromRowId: window[10]!.rowId },
      { op: "row.delta", rowId: lastId, path: "text", append: "one" },
      { op: "state.updated", patch: { revision: 9 } },
      runBirth("run-single", 4),
      { op: "workflowRun.removed", runId: "run-single", revision: 5 },
      ...pluginDeltas(),
    ];
    for (const delta of singles) {
      expect(applyConversationFrame(snapshot, [delta])).toEqual(
        applyConversationDelta(snapshot, delta),
      );
    }
  });

  it("matches the oracle byte-for-byte on seeded randomized valid ordered frames", () => {
    // mulberry32（与 scripts/perf/v4-replay-fixtures.mjs 同源算法）：跨 Node 版本稳定。
    const rngOf = (seed: number) => {
      let state = seed >>> 0;
      return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    };
    for (let seed = 1; seed <= 40; seed += 1) {
      const rng = rngOf(seed);
      const pick = <T>(items: readonly T[]): T => items[Math.floor(rng() * items.length)]!;
      let snapshot = makeSnapshot();
      let nextRowId = snapshot.rows.window.length + 1;
      // 每个种子连续 5 帧，帧长 0..14；每帧后与裁判比对，且用裁判输出作为下一帧基态
      // （批量与逐条交替推进同一会话，杜绝“只在干净基态上等价”）。
      for (let frameIndex = 0; frameIndex < 5; frameIndex += 1) {
        const length = Math.floor(rng() * 15);
        const deltas: ConversationDelta[] = [];
        for (let i = 0; i < length; i += 1) {
          const roll = rng();
          const loadedIds = snapshot.rows.window.map((row) => row.rowId);
          // 整分支重置后窗口可能为空：pick 必须退化为未命中 id，不能产出 undefined/NaN。
          const loadedOrMiss = (missId: number, hitProbability = 0.85): number =>
            loadedIds.length > 0 && rng() < hitProbability ? pick(loadedIds) : missId;
          if (roll < 0.3) {
            deltas.push({
              op: "row.delta",
              rowId: loadedOrMiss(90_000 + i, 0.9),
              path: pick(["text", "inputText", "output.text", "summaryText"] as const),
              append: `t${i}`,
            });
          } else if (roll < 0.5) {
            nextRowId += 1;
            deltas.push({
              op: "row.appended",
              row: makeRow(
                nextRowId,
                pick([
                  "assistantText",
                  "toolCall",
                  "userInput",
                  "reasoning",
                  "subagent",
                  "turnHeader",
                ] as const),
              ),
            });
          } else if (roll < 0.62) {
            deltas.push({
              op: "row.upserted",
              row: { ...makeRow(loadedOrMiss(91_000 + i), "toolCall"), status: "success" },
            });
          } else if (roll < 0.7) {
            deltas.push({
              op: "row.removed",
              fromRowId: loadedOrMiss(95_000),
            });
          } else if (roll < 0.82) {
            deltas.push({
              op: "state.updated",
              patch: {
                revision: snapshot.revision + 1,
                ...(rng() < 0.25
                  ? { workflowRuns: { revision: snapshot.revision + 2, runs: [] } }
                  : {}),
                ...(rng() < 0.3 ? { queue: { items: [], autoDrain: rng() < 0.5 } } : {}),
              },
            });
          } else if (roll < 0.92) {
            deltas.push(
              rng() < 0.7
                ? runBirth(`run-${seed}-${frameIndex % 3}`, snapshot.revision + 3, (i % 5) + 1)
                : {
                    op: "workflowRun.removed",
                    runId: `run-${seed}-${frameIndex % 3}`,
                    revision: snapshot.revision + 4,
                  },
            );
          } else {
            deltas.push(pick(pluginDeltas()));
          }
        }
        // 生成器自律：所有随机 op 都必须满足线上 schema（裁判对照才有意义）。
        for (const delta of deltas) {
          const parsed = conversationDeltaSchema.safeParse(delta);
          // state.updated 的 rows 键是防御分支专属，随机生成器不产它；其余必须合法。
          if (!(delta.op === "state.updated" && "rows" in (delta.patch as object))) {
            expect(parsed.success, JSON.stringify(parsed.error?.issues ?? delta)).toBe(true);
          }
        }
        const frame = applyConversationFrame(snapshot, deltas);
        const oracle = applyConversationDeltas(snapshot, deltas);
        expect(JSON.stringify(frame), `seed=${seed} frame=${frameIndex}`).toBe(
          JSON.stringify(oracle),
        );
        snapshot = oracle;
      }
    }
  });
});

// ── 深冻结工具：任何对冻结输入的写入在 strict mode 下直接抛错 ──
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  Object.freeze(value);
  return value;
}
