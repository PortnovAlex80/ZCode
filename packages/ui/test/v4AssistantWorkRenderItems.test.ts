import { describe, expect, it } from "vitest";
import type {
  ConversationRow,
  ReasoningRow,
  SubagentRow,
  ToolCallRow,
} from "@zcode/shared/zcode-protocol-v4";
import {
  buildAssistantWorkRenderItems,
  getActiveAssistantSummaryItem,
  groupConsecutiveAssistantSummaries,
  type ConversationAssistantWorkRenderItem,
} from "@/v4/conversationAssistantWorkItems.js";

const SHOW_ALL_REASONING = { messageStreamShowReasoning: true } as const;

function buildRenderItems(
  rows: Parameters<typeof buildAssistantWorkRenderItems>[0],
  reasoningVisibility: Parameters<typeof buildAssistantWorkRenderItems>[1] = SHOW_ALL_REASONING,
) {
  return buildAssistantWorkRenderItems(rows, reasoningVisibility);
}

// v3.18 replaced the explicit explore/execute/changes/cua group items with
// render-time summary groups: buildAssistantWorkRenderItems now emits plain
// rows (plus paired agent tool calls), and the component merges consecutive
// summary rows via groupConsecutiveAssistantSummaries. These helpers keep the
// original scenarios expressed against that merged-group model.
function buildSummaryGroups(
  rows: Parameters<typeof buildAssistantWorkRenderItems>[0],
  reasoningVisibility: Parameters<typeof buildAssistantWorkRenderItems>[1] = SHOW_ALL_REASONING,
) {
  return groupConsecutiveAssistantSummaries(buildRenderItems(rows, reasoningVisibility));
}

function groupRowIds(group: { items: readonly ConversationAssistantWorkRenderItem[] }): number[] {
  return group.items.map((item) => item.row.rowId);
}

function rowStatuses(group: {
  items: readonly ConversationAssistantWorkRenderItem[];
}): Array<ToolCallRow["status"]> {
  return group.items.map((item) => (item.row as ToolCallRow).status);
}

function toolCall(
  rowId: number,
  toolName: string,
  input: unknown,
  overrides: Partial<ToolCallRow> = {},
): ToolCallRow {
  return {
    rowId,
    turnId: "turn-1",
    createdAt: 1_700_000_000_000 + rowId,
    createdAtSeq: rowId,
    kind: "toolCall",
    toolCallId: `tool-${rowId}`,
    toolName,
    status: "success",
    input,
    inputText: JSON.stringify(input),
    ...overrides,
  };
}

function subagent(rowId: number, overrides: Partial<SubagentRow> = {}): SubagentRow {
  return {
    rowId,
    turnId: "turn-1",
    createdAt: 1_700_000_000_000 + rowId,
    createdAtSeq: rowId,
    kind: "subagent",
    subagentType: "Explore",
    status: "running",
    summaryText: "正在分析工作区",
    childSessionId: `child-session-${rowId}`,
    ...overrides,
  };
}

function reasoning(rowId: number): ReasoningRow {
  return {
    rowId,
    turnId: "turn-1",
    createdAt: 1_700_000_000_000 + rowId,
    createdAtSeq: rowId,
    kind: "reasoning",
    state: "complete",
    text: `reasoning-${rowId}`,
  };
}

describe("buildAssistantWorkRenderItems", () => {
  it("keeps a single Explore, Terminal, or Changes tool ungrouped", () => {
    expect(buildRenderItems([toolCall(1, "Read", { path: "package.json" })])).toMatchObject([
      { kind: "row", row: { rowId: 1 } },
    ]);
    expect(buildRenderItems([toolCall(2, "Bash", { command: "pnpm test" })])).toMatchObject([
      { kind: "row", row: { rowId: 2 } },
    ]);
    expect(
      buildRenderItems([toolCall(3, "Edit", { path: "package.json", newText: "{}" })]),
    ).toMatchObject([{ kind: "row", row: { rowId: 3 } }]);
  });

  it("groups two consecutive tools of the same display family", () => {
    // The explicit explore/execute/changes group items became render-time
    // summary groups over the same consecutive tools.
    const explorePair = buildSummaryGroups([
      toolCall(1, "Read", { path: "package.json" }),
      toolCall(2, "Grep", { pattern: "group" }),
    ]);
    expect(explorePair).toHaveLength(1);
    expect(groupRowIds(explorePair[0]!)).toEqual([1, 2]);

    const executePair = buildSummaryGroups([
      toolCall(3, "Bash", { command: "pnpm test" }),
      toolCall(4, "Bash", { command: "pnpm lint" }),
    ]);
    expect(executePair).toHaveLength(1);
    expect(groupRowIds(executePair[0]!)).toEqual([3, 4]);

    const changesPair = buildSummaryGroups([
      toolCall(5, "Write", { file_path: "src/a.ts", content: "a" }),
      toolCall(6, "Edit", {
        file_path: "src/b.ts",
        old_string: "b",
        new_string: "c",
      }),
    ]);
    expect(changesPair).toHaveLength(1);
    expect(groupRowIds(changesPair[0]!)).toEqual([5, 6]);
  });

  it("marks a terminal Explore group as stopped when a child was cancelled", () => {
    const groups = buildSummaryGroups([
      toolCall(1, "Read", { path: "package.json" }),
      toolCall(2, "Grep", { pattern: "group" }, { status: "cancelled" }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groupRowIds(groups[0]!)).toEqual([1, 2]);
    // The cancellation stays on the cancelled child; with no running tail the
    // group presents as completed instead of inheriting a synthetic status.
    expect(rowStatuses(groups[0]!)).toEqual(["success", "cancelled"]);
    expect(getActiveAssistantSummaryItem(groups[0]!.items)).toBeUndefined();
  });

  it("does not group same-family tools across a visible tool boundary", () => {
    const items = buildRenderItems([
      toolCall(1, "Read", { path: "src/a.ts" }),
      toolCall(2, "Edit", { path: "src/a.ts", newText: "a" }),
      toolCall(3, "Read", { path: "src/b.ts" }),
    ]);

    expect(items.map((item) => item.kind)).toEqual(["row", "row", "row"]);
  });

  it("keeps reasoning in the summary without closing it and lets an uncorrelated message close", () => {
    const rows = [
      toolCall(1, "mcp__computer-use__get_app_state", { app_ref: { pid: 691 } }),
      reasoning(2),
      {
        rowId: 3,
        turnId: "turn-1",
        createdAt: 1_700_000_000_003,
        createdAtSeq: 3,
        kind: "assistantText",
        text: "更新数据……",
        state: "complete",
      } satisfies ConversationRow,
      toolCall(4, "mcp__computer-use__left_click", {
        target: { type: "element", state_id: "s-1", index: 59 },
      }),
      toolCall(5, "Bash", { command: "pnpm test" }),
    ];

    const groups = buildSummaryGroups(rows);

    // Reasoning is part of the running summary and does not close it; the
    // assistant text is not summary material and closes the group.
    expect(groups.map(groupRowIds)).toEqual([[1, 2], [3], [4, 5]]);
  });

  it("keeps a tail CUA summary active across reasoning and starts a new group after a text boundary", () => {
    const first = buildSummaryGroups([
      toolCall(1, "mcp__computer-use__list_apps", {}, { status: "running" }),
    ]);
    const grown = buildSummaryGroups([
      toolCall(1, "mcp__computer-use__list_apps", {}),
      reasoning(2),
      toolCall(3, "mcp__computer-use__get_app_state", {}, { status: "running" }),
    ]);
    const bounded = buildSummaryGroups([
      toolCall(1, "mcp__computer-use__list_apps", {}),
      reasoning(2),
      {
        rowId: 3,
        turnId: "turn-1",
        createdAt: 1_700_000_000_003,
        createdAtSeq: 3,
        kind: "assistantText",
        text: "done",
        state: "complete",
      } satisfies ConversationRow,
      toolCall(4, "mcp__computer-use__screenshot", {}),
    ]);

    expect(groupRowIds(first[0]!)).toEqual([1]);
    expect(getActiveAssistantSummaryItem(first[0]!.items)?.row.rowId).toBe(1);
    expect(groupRowIds(grown[0]!)).toEqual([1, 2, 3]);
    // Group identity is the first member row, so it stays stable while the
    // running tail grows across the interleaved reasoning.
    expect(grown[0]!.key).toBe(first[0]!.key);
    expect(getActiveAssistantSummaryItem(grown[0]!.items)?.row.rowId).toBe(3);
    expect(bounded.map(groupRowIds)).toEqual([[1, 2], [3], [4]]);
  });

  it("does not group third-party computer-use names and honors the release gate", () => {
    const official = toolCall(1, "mcp__computer-use__wait", {});
    const thirdParty = toolCall(2, "mcp__third-party-computer-use__wait", {});

    expect(buildRenderItems([thirdParty]).map((item) => item.kind)).toEqual(["row"]);
    expect(
      buildAssistantWorkRenderItems([official], SHOW_ALL_REASONING, {
        enableCuaGrouping: false,
      }).map((item) => item.kind),
    ).toEqual(["row"]);
  });

  it("keeps Explore-compatible tools as individual rows when Explore grouping is disabled", () => {
    const rows = [
      toolCall(1, "Read", { path: "src/a.ts" }),
      toolCall(2, "Grep", { pattern: "test" }),
      toolCall(3, "Bash", { command: "rg test src" }),
    ];

    expect(
      buildAssistantWorkRenderItems(rows, SHOW_ALL_REASONING, {
        enableExploreGrouping: false,
      }).map((item) => item.kind),
    ).toEqual(["row", "row", "row"]);
  });

  it("keeps mutating Shell tools as individual rows when Terminal grouping is disabled", () => {
    const rows = [
      toolCall(1, "Bash", { command: "pnpm test" }),
      toolCall(2, "Bash", { command: "mkdir -p tmp/output" }),
    ];

    expect(
      buildAssistantWorkRenderItems(rows, SHOW_ALL_REASONING, {
        enableTerminalGrouping: false,
      }).map((item) => item.kind),
    ).toEqual(["row", "row"]);
  });

  it("keeps file-write tools as individual rows when Changes grouping uses the release default", () => {
    const rows = [
      toolCall(1, "Write", { file_path: "src/a.ts", content: "a" }),
      toolCall(2, "Edit", {
        file_path: "src/b.ts",
        old_string: "b",
        new_string: "c",
      }),
      toolCall(3, "ApplyPatch", {
        patch: "*** Begin Patch\n*** Add File: src/c.ts\n+c\n*** End Patch",
      }),
    ];

    expect(
      buildAssistantWorkRenderItems(rows, SHOW_ALL_REASONING).map((item) => item.kind),
    ).toEqual(["row", "row", "row"]);
  });

  it.each(["inputStreaming", "running"] as const)(
    "defers unclassified shell-family tools with status %s",
    (status) => {
      for (const toolName of ["Bash", "execute", "shell"]) {
        const pending = toolCall(
          1,
          toolName,
          {},
          {
            input: undefined,
            inputText: "",
            status,
          },
        );

        expect(buildRenderItems([pending])).toEqual([]);
      }
    },
  );

  it("classifies a deferred shell tool after its command arrives", () => {
    const readonly = toolCall(
      1,
      "Bash",
      { command: "rg test packages/ui" },
      { status: "inputStreaming" },
    );
    const executable = toolCall(2, "Bash", { command: "pnpm test" }, { status: "running" });

    expect(buildRenderItems([readonly])).toMatchObject([{ kind: "row", row: { rowId: 1 } }]);
    expect(buildRenderItems([executable])).toMatchObject([{ kind: "row", row: { rowId: 2 } }]);
  });

  it("keeps a running Explore tail stable while a later shell awaits its command", () => {
    const explore = toolCall(1, "Grep", { pattern: "renderer" }, { status: "running" });
    const pendingShell = toolCall(2, "Bash", undefined, {
      inputText: "",
      status: "inputStreaming",
    });

    const pendingGroups = buildSummaryGroups([explore, pendingShell]);
    expect(pendingGroups).toHaveLength(1);
    expect(groupRowIds(pendingGroups[0]!)).toEqual([1]);
    expect(getActiveAssistantSummaryItem(pendingGroups[0]!.items)?.row.rowId).toBe(1);

    const readonlyGroups = buildSummaryGroups([
      explore,
      toolCall(
        2,
        "Bash",
        { command: "ls packages/ui/src/ToolCallBlocks/renderers" },
        { status: "running" },
      ),
    ]);
    expect(readonlyGroups).toHaveLength(1);
    expect(groupRowIds(readonlyGroups[0]!)).toEqual([1, 2]);
    expect(getActiveAssistantSummaryItem(readonlyGroups[0]!.items)?.row.rowId).toBe(2);

    const executeGroups = buildSummaryGroups([
      explore,
      toolCall(2, "Bash", { command: "pnpm test" }, { status: "running" }),
    ]);
    // Summary groups merge every working family once the shell command
    // arrives, so the executable shell joins the same group as the explore
    // tail instead of closing it.
    expect(groupRowIds(executeGroups[0]!)).toEqual([1, 2]);
    expect(getActiveAssistantSummaryItem(executeGroups[0]!.items)?.row.rowId).toBe(2);
  });

  it("upgrades consecutive non-explore shell calls to a stable group", () => {
    const initialGroups = buildSummaryGroups([
      toolCall(1, "Bash", { command: "pnpm install" }, { status: "running" }),
    ]);
    const grownGroups = buildSummaryGroups([
      toolCall(1, "Bash", { command: "pnpm install" }),
      toolCall(2, "Bash", { command: "pnpm test" }, { status: "running" }),
    ]);
    const extendedGroups = buildSummaryGroups([
      toolCall(1, "Bash", { command: "pnpm install" }),
      toolCall(2, "Bash", { command: "pnpm test" }),
      toolCall(3, "Bash", { command: "pnpm lint" }, { status: "running" }),
    ]);

    expect(groupRowIds(initialGroups[0]!)).toEqual([1]);
    expect(groupRowIds(grownGroups[0]!)).toEqual([1, 2]);
    expect(groupRowIds(extendedGroups[0]!)).toEqual([1, 2, 3]);
    // The summary group key is its first member row, so it stays stable while
    // the running tail grows.
    expect(grownGroups[0]!.key).toBe(initialGroups[0]!.key);
    expect(extendedGroups[0]!.key).toBe(grownGroups[0]!.key);
    expect(getActiveAssistantSummaryItem(grownGroups[0]!.items)?.row.rowId).toBe(2);
    expect(getActiveAssistantSummaryItem(extendedGroups[0]!.items)?.row.rowId).toBe(3);
    expect(getActiveAssistantSummaryItem(initialGroups[0]!.items)?.row.rowId).toBe(1);
  });

  it("keeps child failures on execute children and stops at explore boundaries", () => {
    const groups = buildSummaryGroups([
      toolCall(1, "Bash", { command: "pnpm install" }),
      toolCall(2, "Bash", { command: "pnpm build" }, { status: "error" }),
      toolCall(3, "Bash", { command: "git status" }),
      toolCall(4, "Bash", { command: "pnpm test" }, { status: "cancelled" }),
    ]);

    expect(groups).toHaveLength(1);
    // Failures and cancellations stay on their own child rows; the merged
    // group has no running tail, so it presents as completed.
    expect(rowStatuses(groups[0]!)).toEqual(["success", "error", "success", "cancelled"]);
    expect(getActiveAssistantSummaryItem(groups[0]!.items)).toBeUndefined();
  });

  it("merges execute calls across hidden later reasoning only", () => {
    const rows = [
      reasoning(1),
      toolCall(2, "Bash", { command: "pnpm install" }),
      reasoning(3),
      toolCall(4, "Bash", { command: "pnpm test" }),
    ];

    const hiddenGroups = buildSummaryGroups(rows, {
      messageStreamShowReasoning: false,
      messageStreamFirstReasoningRowId: 1,
    });
    // Hidden reasoning rows are dropped entirely: the later reasoning no
    // longer splits the consecutive execute calls.
    expect(hiddenGroups.map(groupRowIds)).toEqual([[1, 2, 4]]);

    const visibleGroups = buildSummaryGroups(rows);
    // Visible reasoning renders inside the summary group instead of splitting it.
    expect(visibleGroups.map(groupRowIds)).toEqual([[1, 2, 3, 4]]);
  });

  it("keeps an unclassified failed shell tool visible", () => {
    const failed = toolCall(
      1,
      "Bash",
      {},
      {
        error: { message: "Permission denied" },
        input: undefined,
        inputText: "",
        status: "error",
      },
    );

    expect(buildRenderItems([failed])).toMatchObject([
      { kind: "row", row: { rowId: 1, status: "error" } },
    ]);
  });

  it("groups consecutive read-only tool calls into one explore item", () => {
    const rows = [
      toolCall(1, "Read", { path: "package.json" }),
      toolCall(2, "Bash", { command: "rg test packages/ui" }),
    ];

    const groups = buildSummaryGroups(rows);

    expect(groups).toHaveLength(1);
    expect(groupRowIds(groups[0]!)).toEqual([1, 2]);
    expect(groups[0]!.items.every((item) => item.kind === "row")).toBe(true);
  });

  it("upgrades read-only tools to an Explore group with stable identity", () => {
    const initialGroups = buildSummaryGroups([
      toolCall(1, "Read", { path: "package.json" }, { status: "running" }),
    ]);
    const grownGroups = buildSummaryGroups([
      toolCall(1, "Read", { path: "package.json" }, { status: "success" }),
      toolCall(2, "Bash", { command: "rg test packages/ui" }, { status: "running" }),
    ]);
    const extendedGroups = buildSummaryGroups([
      toolCall(1, "Read", { path: "package.json" }),
      toolCall(2, "Bash", { command: "rg test packages/ui" }),
      toolCall(3, "Grep", { pattern: "renderer" }, { status: "running" }),
    ]);

    expect(groupRowIds(initialGroups[0]!)).toEqual([1]);
    expect(groupRowIds(grownGroups[0]!)).toEqual([1, 2]);
    expect(groupRowIds(extendedGroups[0]!)).toEqual([1, 2, 3]);
    // The summary group key tracks its first member row and stays stable as
    // the explore tail grows.
    expect(grownGroups[0]!.key).toBe(initialGroups[0]!.key);
    expect(extendedGroups[0]!.key).toBe(grownGroups[0]!.key);
    expect(getActiveAssistantSummaryItem(extendedGroups[0]!.items)?.row.rowId).toBe(3);
  });

  it("derives Explore parent status from the running stage tail", () => {
    const completedGroups = buildSummaryGroups([
      toolCall(1, "Read", { path: "package.json" }),
      toolCall(2, "Grep", { pattern: "missing" }, { status: "error" }),
    ]);
    const runningGroups = buildSummaryGroups([
      toolCall(1, "Read", { path: "missing.json" }, { status: "error" }),
      toolCall(2, "Grep", { pattern: "still-running" }, { status: "running" }),
      toolCall(3, "Bash", { command: "pnpm test" }),
    ]);

    expect(completedGroups).toHaveLength(1);
    // With no running child left the summary presents as completed and keeps
    // the failure on its own child row.
    expect(getActiveAssistantSummaryItem(completedGroups[0]!.items)).toBeUndefined();
    expect(rowStatuses(completedGroups[0]!)).toEqual(["success", "error"]);
    expect(runningGroups).toHaveLength(1);
    expect(groupRowIds(runningGroups[0]!)).toEqual([1, 2, 3]);
    expect(getActiveAssistantSummaryItem(runningGroups[0]!.items)?.row.rowId).toBe(2);
  });

  it("derives Execute parent status from the running stage tail", () => {
    const settledGroups = buildSummaryGroups([
      toolCall(1, "Bash", { command: "pnpm test" }),
      toolCall(2, "Bash", { command: "pnpm lint" }),
    ]);
    const boundedGroups = buildSummaryGroups([
      toolCall(1, "Bash", { command: "pnpm test" }, { status: "running" }),
      toolCall(2, "Bash", { command: "pnpm lint" }),
      toolCall(3, "Read", { path: "package.json" }),
    ]);
    const runningGroups = buildSummaryGroups([
      toolCall(1, "Bash", { command: "pnpm test" }, { status: "running" }),
      toolCall(2, "Bash", { command: "pnpm lint" }),
    ]);

    expect(settledGroups).toHaveLength(1);
    expect(getActiveAssistantSummaryItem(settledGroups[0]!.items)).toBeUndefined();
    // The execute and explore tools now share the merged summary group, whose
    // active item is the still-running shell call.
    expect(boundedGroups).toHaveLength(1);
    expect(groupRowIds(boundedGroups[0]!)).toEqual([1, 2, 3]);
    expect(getActiveAssistantSummaryItem(boundedGroups[0]!.items)?.row.rowId).toBe(1);
    expect(rowStatuses(boundedGroups[0]!)[0]).toBe("running");
    expect(runningGroups).toHaveLength(1);
    expect(getActiveAssistantSummaryItem(runningGroups[0]!.items)?.row.rowId).toBe(1);
  });

  it("merges explore calls across hidden later reasoning only", () => {
    const rows = [
      reasoning(1),
      toolCall(2, "Read", { path: "package.json" }),
      reasoning(3),
      toolCall(4, "Bash", { command: "rg test packages/ui" }),
    ];

    const hiddenReasoningGroups = buildSummaryGroups(rows, {
      messageStreamShowReasoning: false,
      messageStreamFirstReasoningRowId: 1,
    });
    expect(hiddenReasoningGroups.map(groupRowIds)).toEqual([[1, 2, 4]]);

    const visibleReasoningGroups = buildSummaryGroups(rows);
    expect(visibleReasoningGroups.map(groupRowIds)).toEqual([[1, 2, 3, 4]]);
  });

  it("ends Explore and starts a Changes group for write tools", () => {
    const rows = [
      toolCall(1, "Read", { path: "package.json" }),
      toolCall(2, "Edit", { path: "package.json", newText: "{}" }),
      {
        rowId: 3,
        turnId: "turn-1",
        createdAt: 1_700_000_003,
        createdAtSeq: 3,
        kind: "assistantText",
        text: "done",
        state: "complete",
      } satisfies ConversationRow,
    ];

    const items = buildRenderItems(rows);

    expect(items.map((item) => item.kind)).toEqual(["row", "row", "row"]);
  });

  it("upgrades consecutive Write/Edit rows to a stable group", () => {
    const initial = buildSummaryGroups([
      toolCall(1, "Write", { file_path: "src/a.ts", content: "a" }),
    ]);
    const grown = buildSummaryGroups([
      toolCall(1, "Write", { file_path: "src/a.ts", content: "a" }),
      toolCall(2, "Edit", {
        file_path: "src/b.ts",
        old_string: "b",
        new_string: "c",
      }),
    ]);
    const extended = buildSummaryGroups([
      toolCall(1, "Write", { file_path: "src/a.ts", content: "a" }),
      toolCall(2, "Edit", {
        file_path: "src/b.ts",
        old_string: "b",
        new_string: "c",
      }),
      toolCall(3, "Write", { file_path: "src/c.ts", content: "c" }),
    ]);

    expect(groupRowIds(initial[0]!)).toEqual([1]);
    expect(groupRowIds(grown[0]!)).toEqual([1, 2]);
    expect(groupRowIds(extended[0]!)).toEqual([1, 2, 3]);
    // The Changes summary group keeps the identity of its first member row as
    // the write tail grows.
    expect(grown[0]!.key).toBe(initial[0]!.key);
    expect(extended[0]!.key).toBe(grown[0]!.key);
  });

  it("completes Changes at visible boundaries without inheriting child cancellation", () => {
    const groups = buildSummaryGroups([
      toolCall(
        1,
        "Edit",
        { file_path: "src/a.ts", old_string: "a", new_string: "b" },
        { status: "cancelled" },
      ),
      toolCall(2, "Write", { file_path: "src/b.ts", content: "b" }),
      toolCall(3, "Read", { path: "src/a.ts" }),
    ]);

    expect(groups).toHaveLength(1);
    // The cancelled child keeps its own terminal status; the merged group has
    // no running tail, so it presents as completed.
    expect(rowStatuses(groups[0]!)).toEqual(["cancelled", "success", "success"]);
    expect(getActiveAssistantSummaryItem(groups[0]!.items)).toBeUndefined();
  });

  it("merges Changes across hidden later reasoning without splitting at visible reasoning", () => {
    const rows = [
      reasoning(1),
      toolCall(2, "Write", { file_path: "src/a.ts", content: "a" }),
      reasoning(3),
      toolCall(4, "Edit", { file_path: "src/b.ts", old_string: "b", new_string: "c" }),
    ];
    const hidden = buildSummaryGroups(rows, {
      messageStreamShowReasoning: false,
      messageStreamFirstReasoningRowId: 1,
    });
    // Hidden reasoning rows are dropped and no longer split the write tail.
    expect(hidden.map(groupRowIds)).toEqual([[1, 2, 4]]);
    // Visible reasoning renders inside the merged Changes summary group.
    expect(buildSummaryGroups(rows).map(groupRowIds)).toEqual([[1, 2, 3, 4]]);
  });

  it("pairs agent tool calls with subagent rows by parentToolCallId", () => {
    const rows = [
      toolCall(1, "Agent", {
        prompt: "分析当前工作区",
        subagent_type: "Explore",
      }),
      subagent(2, { parentToolCallId: "tool-1" }),
      toolCall(3, "Read", { path: "package.json" }),
    ];

    const items = buildRenderItems(rows);

    expect(items.map((item) => item.kind)).toEqual(["agentToolCall", "row"]);
    const agentItem = items[0];
    expect(agentItem?.kind).toBe("agentToolCall");
    if (agentItem?.kind !== "agentToolCall") {
      throw new Error("expected paired agent item");
    }
    expect(agentItem.row.rowId).toBe(1);
    expect(agentItem.subagentRow.rowId).toBe(2);
    expect(agentItem).not.toHaveProperty("showSubagentOutputPreview");
    expect(items.some((item) => item.kind === "row" && item.row.rowId === 2)).toBe(false);
  });

  it("keeps concurrent agent details bound when subagents spawn in reverse order", () => {
    const rows = [
      toolCall(1, "Agent", { description: "测试 general-purpose agent" }),
      toolCall(2, "Agent", { description: "测试 Explore agent" }),
      toolCall(3, "Agent", { description: "测试 test-hello2 agent" }),
      subagent(4, {
        childSessionId: "child-test-hello2",
        parentToolCallId: "tool-3",
        subagentType: "test-hello2",
      }),
      subagent(5, {
        childSessionId: "child-explore",
        parentToolCallId: "tool-2",
        subagentType: "Explore",
      }),
      subagent(6, {
        childSessionId: "child-general-purpose",
        parentToolCallId: "tool-1",
        subagentType: "general-purpose",
      }),
    ];

    const items = buildRenderItems(rows);
    const pairs = items.flatMap((item) =>
      item.kind === "agentToolCall" ? [[item.row.toolCallId, item.subagentRow.childSessionId]] : [],
    );

    expect(pairs).toEqual([
      ["tool-1", "child-general-purpose"],
      ["tool-2", "child-explore"],
      ["tool-3", "child-test-hello2"],
    ]);
  });

  it("only falls back for one unambiguous legacy pair", () => {
    const onePair = buildRenderItems([
      toolCall(1, "Agent", { description: "旧 Agent" }),
      subagent(2),
    ]);
    expect(onePair).toMatchObject([
      {
        kind: "agentToolCall",
        row: { rowId: 1 },
        subagentRow: { rowId: 2 },
      },
    ]);

    const ambiguous = buildRenderItems([
      toolCall(1, "Agent", { description: "旧 Agent A" }),
      toolCall(2, "Agent", { description: "旧 Agent B" }),
      subagent(3),
      subagent(4),
    ]);
    expect(ambiguous.some((item) => item.kind === "agentToolCall")).toBe(false);
    expect(ambiguous.map((item) => item.kind)).toEqual(["row", "row", "row", "row"]);
  });

  it("keeps background subagents paired without requesting an inline output preview", () => {
    const rows = [
      toolCall(1, "Agent", {
        prompt: "后台分析当前工作区",
        run_in_background: true,
        subagent_type: "Explore",
      }),
      subagent(2, { backgrounded: true, parentToolCallId: "tool-1" }),
    ];

    const items = buildRenderItems(rows);

    expect(items).toHaveLength(1);
    const agentItem = items[0];
    expect(agentItem?.kind).toBe("agentToolCall");
    if (agentItem?.kind !== "agentToolCall") {
      throw new Error("expected paired agent item");
    }
    expect(agentItem.subagentRow.backgrounded).toBe(true);
    expect(agentItem).not.toHaveProperty("showSubagentOutputPreview");
  });
});
