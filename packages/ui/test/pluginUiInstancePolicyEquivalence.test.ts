// 渲染性能 Wave C：deriveLogicalUiInstances 回合判重修复（O(rows×turns) → O(rows)）的
// 等价性回归。独立 oracle 是 test/support/pluginUiInstancePolicyFrozenBaseline.ts——
// 修复前（HEAD f6d3678e）的逐字节冻结副本。覆盖：无插件历史、插件丰富历史
// （同资源替代 / error 替换 / 分组键）、最近三回合自动展开边界（含「无插件卡的新轮
// 也占一回合」）、交错行、对抗性 turnId（__proto__/constructor/数字串）。
// 性能数字不在单测断言（避免 wall-clock 脆断言），由成对基准测量记录。

import { describe, expect, it } from "vitest";
import type { ConversationRow, ToolCallRow, UserInputRow } from "@zcode/shared/zcode-protocol-v4";
import { generateV4ReplayRows } from "../../../scripts/perf/v4-replay-fixtures.mjs";
import { deriveLogicalUiInstances } from "@/plugin-ui/domain/pluginUiInstancePolicy.js";
import { deriveLogicalUiInstancesBaseline } from "./support/pluginUiInstancePolicyFrozenBaseline.js";

let nextRowId = 1;
function baseRow(turnId: string) {
  const rowId = nextRowId++;
  return { rowId, turnId, createdAt: rowId, createdAtSeq: rowId };
}

function userInput(turnId: string, text = "q"): UserInputRow {
  return {
    ...baseRow(turnId),
    kind: "userInput",
    origin: "realUser",
    text,
    attachments: [],
    sourceCommandId: `cmd-${rowIdCounter()}`,
  } as unknown as UserInputRow;
}

function rowIdCounter() {
  return nextRowId - 1;
}

function pluginToolRow(
  turnId: string,
  options: {
    pluginId?: string;
    serverName?: string;
    resourceUri?: string;
    surface?: string;
    status?: ToolCallRow["status"];
    isError?: boolean;
    showInline?: boolean;
  } = {},
): ToolCallRow {
  const {
    pluginId = "plugin-a",
    serverName = "server-x",
    resourceUri = "ui://plugin-a/main",
    surface = "panel",
    status = "success",
    isError = false,
    showInline = false,
  } = options;
  return {
    ...baseRow(turnId),
    kind: "toolCall",
    toolCallId: `call-${rowIdCounter()}`,
    toolName: `mcp__${serverName}__edit`,
    status,
    inputText: "{}",
    display: {
      kind: "mcp_tool",
      serverName,
      toolName: "edit",
      ui: {
        pluginId,
        resourceUri,
        surface,
        preferredDisplayMode: "fullscreen",
        showInline,
        ...(isError ? { isError: true } : {}),
      },
    },
  } as unknown as ToolCallRow;
}

function textRow(turnId: string): ConversationRow {
  return {
    ...baseRow(turnId),
    kind: "assistantText",
    assistantResponseId: `resp-${turnId}`,
    text: "done",
    state: "complete",
  } as unknown as ConversationRow;
}

describe("deriveLogicalUiInstances membership fix (Wave C)", () => {
  it.each([24, 200])("无插件回放历史（%s 轮）：与冻结 oracle 深度相等", (turns) => {
    const { rows } = generateV4ReplayRows({ turns, seed: 20261012 });
    const next = deriveLogicalUiInstances(rows as ConversationRow[]);
    const baseline = deriveLogicalUiInstancesBaseline(rows as ConversationRow[]);
    expect(next).toEqual(baseline);
    expect(next.instances).toHaveLength(0);
  });

  it("插件丰富历史：同资源替代、error 行不替代、跨 plugin/server/resource 分组", () => {
    const rows: ConversationRow[] = [
      userInput("t1"),
      pluginToolRow("t1"),
      pluginToolRow("t1"), // 同 key 第二次成功 → 第一次被 superseded
      pluginToolRow("t1", { isError: true }),
      pluginToolRow("t1", { status: "running" }),
      pluginToolRow("t1", { pluginId: "plugin-b" }),
      pluginToolRow("t1", { serverName: "server-y" }),
      pluginToolRow("t1", { resourceUri: "ui://plugin-a/other" }),
      textRow("t1"),
      userInput("t2"),
      pluginToolRow("t2", { status: "failed" }),
      textRow("t2"),
    ];
    const next = deriveLogicalUiInstances(rows);
    const baseline = deriveLogicalUiInstancesBaseline(rows);
    expect(next).toEqual(baseline);
    // 4 组：t1 默认 key（成功×2 + isError + running 同 key 合并）、plugin-b、
    // server-y、resourceUri 变体；t2 的 failed 默认 key 行并入第一组。
    expect(next.instances.length).toBe(4);
    const main = next.instances.find(
      (instance) =>
        instance.key.includes("plugin-a") &&
        instance.key.includes("server-x") &&
        instance.key.includes("ui://plugin-a/main"),
    );
    expect(main).toBeDefined();
    expect(main!.supersededToolCallIds).toHaveLength(1);
  });

  it("最近三回合自动展开：无插件卡的新轮也占位，边界随新轮后移", () => {
    const fiveTurns: ConversationRow[] = [];
    for (let index = 1; index <= 5; index += 1) {
      const turnId = `t${index}`;
      fiveTurns.push(userInput(turnId), textRow(turnId));
    }
    // 只在第 2 轮放插件卡：初始它不在最近 3 回合（t3..t5）内。
    const withPluginAtTwo = [...fiveTurns];
    withPluginAtTwo.splice(3, 0, pluginToolRow("t2"));
    const before = deriveLogicalUiInstances(withPluginAtTwo);
    expect(before).toEqual(deriveLogicalUiInstancesBaseline(withPluginAtTwo));
    expect(Object.values(before.byToolCallId)[0]!.autoExpand).toBe(false);

    // 追加一个无插件卡的新轮：t2 依旧在 t2..t3... 边界外，但删掉 t5 后进入最近 3 回合。
    const trimmed = withPluginAtTwo.filter((row) => row.turnId !== "t5");
    const after = deriveLogicalUiInstances(trimmed);
    expect(after).toEqual(deriveLogicalUiInstancesBaseline(trimmed));
    expect(Object.values(after.byToolCallId)[0]!.autoExpand).toBe(true);
  });

  it("交错行与对抗性 turnId（__proto__/constructor/数字串）：回合序按首现顺序，判定安全", () => {
    const rows: ConversationRow[] = [
      pluginToolRow("__proto__"),
      pluginToolRow("constructor"),
      pluginToolRow("0"),
      pluginToolRow("__proto__", { pluginId: "plugin-b" }),
      pluginToolRow("999"),
    ];
    const next = deriveLogicalUiInstances(rows);
    const baseline = deriveLogicalUiInstancesBaseline(rows);
    expect(next).toEqual(baseline);
    // __proto__ 轮的两张不同插件卡都在（原型链键没有被吞掉）。
    const protoKeys = next.instances.filter(
      (instance) =>
        JSON.stringify(instance.key).includes("plugin-a") ||
        JSON.stringify(instance.key).includes("plugin-b"),
    );
    expect(protoKeys.length).toBeGreaterThanOrEqual(2);
  });

  it("autoExpandTurns 自定义值与冻结 oracle 一致", () => {
    const rows: ConversationRow[] = [];
    for (let index = 1; index <= 6; index += 1) {
      const turnId = `t${index}`;
      rows.push(userInput(turnId), pluginToolRow(turnId), textRow(turnId));
    }
    expect(deriveLogicalUiInstances(rows, { autoExpandTurns: 1 })).toEqual(
      deriveLogicalUiInstancesBaseline(rows, { autoExpandTurns: 1 }),
    );
    expect(deriveLogicalUiInstances(rows, { autoExpandTurns: 5 })).toEqual(
      deriveLogicalUiInstancesBaseline(rows, { autoExpandTurns: 5 }),
    );
  });
});
