import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import type { ConversationRow, TurnHeaderRow } from "@zcode/shared/zcode-protocol-v4";
import { buildConversationTurnRenderUnits } from "./conversationTurnRenderUnits.js";
import {
  buildConversationTurnNavigatorItems,
  createCachedConversationTurnNavigatorItemsBuilder,
} from "./conversationTurnNavigatorHelpers.js";

/**
 * P-03 热点 1 的行为约束：SessionPane 的分享渲染单元/导航目录必须以「分享面激活」为门。
 * 未激活时，流式 snapshot 身份变化不得重建 O(rows) 渲染单元；激活期间目录必须走挂载级
 * 缓存 builder（未变化轮次复用命中项），且输出与未缓存 builder 一致。
 *
 * 手法与 nativeTimelinePerformance.test.ts 相同：从 SessionPane.tsx 源码按名字抽取
 * shareRowsWindow / shareRenderUnits / shareItems 的初始化表达式，转译后在 vm 里以
 * 受控输入执行，并按 React 的 Object.is 依赖语义模拟 useMemo 的重算条件。
 */

const text = await readFile(new URL("./SessionPane.tsx", import.meta.url), "utf8");
const source = ts.createSourceFile(
  "SessionPane.tsx",
  text,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);

function variableInitializer(name: string): string {
  let found: ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (
      found === undefined &&
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name
    ) {
      found = node.initializer;
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(found, `SessionPane.tsx must declare ${name}`);
  return found.getText(source);
}

function expressionCode(exprText: string): string {
  return ts.transpileModule(`(${exprText});`, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.None,
    },
  }).outputText;
}

const shareRowsWindowCode = expressionCode(variableInitializer("shareRowsWindow"));
const shareRenderUnitsCode = expressionCode(variableInitializer("shareRenderUnits"));
const shareItemsCode = expressionCode(variableInitializer("shareItems"));

const EMPTY_SHARE_ROWS_WINDOW: readonly ConversationRow[] = [];
const navigatorOptions = {
  assistantEmptyPreview: "chat.turnNavigator.emptyAssistant",
  assistantRunningPreview: "chat.turnNavigator.runningAssistant",
  userFallbackPreview: "chat.turnNavigator.userFallback",
};
const plain = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;

function createMemoHarness() {
  let last: { deps: readonly unknown[]; value: unknown } | undefined;
  return (factory: () => unknown, deps: readonly unknown[]) => {
    if (
      last &&
      last.deps.length === deps.length &&
      last.deps.every((dep, index) => Object.is(dep, deps[index]))
    ) {
      return last.value;
    }
    last = { deps, value: factory() };
    return last.value;
  };
}

interface ShareRenderState {
  shareRowsWindow: readonly ConversationRow[];
  shareRenderUnits: readonly unknown[];
  shareItems: readonly { key: string; turnId: string }[];
  unitBuilds: number;
  builderCalls: number;
}

function createSharePaneHarness() {
  const unitsMemo = createMemoHarness();
  const itemsMemo = createMemoHarness();
  const cachedBuilder = createCachedConversationTurnNavigatorItemsBuilder();
  const intl = { formatMessage: ({ id }: { id: string }) => id };
  let unitBuilds = 0;
  let builderCalls = 0;
  const render = (shareActive: boolean, window: readonly ConversationRow[]): ShareRenderState => {
    const shareRowsWindow = runInNewContext(shareRowsWindowCode, {
      shareActive,
      snapshot: { rows: { window } },
      EMPTY_SHARE_ROWS_WINDOW,
    }) as readonly ConversationRow[];
    const shareRenderUnits = runInNewContext(shareRenderUnitsCode, {
      useMemo: unitsMemo,
      buildConversationTurnRenderUnits: (
        rows: readonly ConversationRow[],
        options?: object,
      ) => {
        unitBuilds += 1;
        return buildConversationTurnRenderUnits(rows, options);
      },
      shareRowsWindow,
    }) as readonly unknown[];
    const shareItems = runInNewContext(shareItemsCode, {
      useMemo: itemsMemo,
      shareRenderUnits,
      shareNavigatorBuilderRef: {
        current: (units: Parameters<typeof cachedBuilder>[0], options: Parameters<typeof cachedBuilder>[1]) => {
          builderCalls += 1;
          return cachedBuilder(units, options);
        },
      },
      intl,
    }) as { key: string; turnId: string }[];
    return { shareRowsWindow, shareRenderUnits, shareItems, unitBuilds, builderCalls };
  };
  return { render };
}

interface RowFixture {
  history: ConversationRow[];
  live: ConversationRow[];
  withLiveText(suffix: string): ConversationRow[];
}

function createRowFixture(): RowFixture {
  let nextRowId = 1;
  const turnRows = (
    turnId: string,
    state: TurnHeaderRow["state"],
  ): ConversationRow[] => {
    const base = { turnId, createdAt: 1000, createdAtSeq: 1 };
    return [
      {
        ...base,
        rowId: nextRowId++,
        kind: "turnHeader",
        origin: "userInput",
        executionKind: "agent",
        state,
        startedAt: 1000,
      },
      {
        ...base,
        rowId: nextRowId++,
        kind: "userInput",
        origin: "realUser",
        text: `question ${turnId}`,
      },
      {
        ...base,
        rowId: nextRowId++,
        kind: "assistantText",
        text: `answer ${turnId}`,
        state: state === "running" ? "streaming" : "complete",
      },
    ];
  };
  const history = [
    ...turnRows("history-1", "completedSuccess"),
    ...turnRows("history-2", "completedSuccess"),
  ];
  const live = turnRows("live", "running");
  return {
    history,
    live,
    withLiveText: (suffix: string) =>
      [...history, ...live].map((row) =>
        row.kind === "assistantText" && row.state === "streaming"
          ? { ...row, text: row.text + suffix }
          : row,
      ),
  };
}

test("SessionPane share memos are gated on an active share surface", () => {
  assert.match(
    text,
    /const shareRowsWindow = shareActive\s*\?\s*\(snapshot\?\.rows\.window \?\? EMPTY_SHARE_ROWS_WINDOW\)\s*: EMPTY_SHARE_ROWS_WINDOW;/,
    "the memo dependency must be pinned to the empty window while no share surface is active",
  );
  assert.match(
    text,
    /shareNavigatorBuilderRef\.current = createCachedConversationTurnNavigatorItemsBuilder\(\);/,
    "the share directory must go through the per-mount cached builder",
  );
  assert.equal(
    text.includes("buildConversationTurnNavigatorItems(shareRenderUnits"),
    false,
    "the uncached directory builder must not be called from SessionPane anymore",
  );
});

test("streaming snapshots never rebuild share units while no share surface is active", () => {
  const fixture = createRowFixture();
  const { render } = createSharePaneHarness();

  let state = render(false, fixture.withLiveText(""));
  assert.equal(state.unitBuilds, 1, "the initial render primes the memo once with the empty window");
  assert.strictEqual(state.shareRowsWindow, EMPTY_SHARE_ROWS_WINDOW);
  assert.equal(state.shareRenderUnits.length, 0);
  assert.equal(state.shareItems.length, 0);

  // 流式：每个 snapshot 都换 window 身份、live 行文本持续追加。
  for (const suffix of ["a", "bb", "ccc", "dddd"]) {
    state = render(false, fixture.withLiveText(suffix));
    assert.equal(state.shareItems.length, 0);
  }
  assert.equal(state.unitBuilds, 1, "no share surface: snapshot identity changes never rebuild units");
  assert.equal(state.shareItems.length, 0, "the selection surface keeps its stable empty directory");
});

test("activating share rebuilds once and streams the directory through the cached builder", () => {
  const fixture = createRowFixture();
  const { render } = createSharePaneHarness();

  render(false, fixture.withLiveText(""));
  let state = render(true, fixture.withLiveText("a"));
  assert.equal(state.unitBuilds, 2, "activation switches the dependency from the empty window once");
  assert.equal(state.shareItems.length, 3, "two history queries plus the live query are listed");
  assert.equal(state.shareItems[0]!.turnId, "history-1");
  assert.equal(state.builderCalls, 1, "the per-mount cached builder produced the directory");

  // 激活期间继续流式：units 随 snapshot 重建（选择面需要最新行），目录每次走缓存 builder。
  state = render(true, fixture.withLiveText("aa"));
  assert.equal(state.unitBuilds, 3);
  state = render(true, fixture.withLiveText("aaa"));
  assert.equal(state.unitBuilds, 4);
  assert.equal(state.builderCalls, 3, "every active-share recompute goes through the cached builder");
  assert.deepEqual(
    plain(state.shareItems),
    plain(
      buildConversationTurnNavigatorItems(
        buildConversationTurnRenderUnits(fixture.withLiveText("aaa")),
        navigatorOptions,
      ),
    ),
    "the cached directory stays byte-identical to the uncached builder",
  );
});

test("the cached share directory never re-reads unchanged historical text while the live turn streams", () => {
  const fixture = createRowFixture();
  const builder = createCachedConversationTurnNavigatorItemsBuilder();
  let historyTextReads = 0;
  for (const row of [...fixture.history, ...fixture.live]) {
    if ((row.kind !== "userInput" && row.kind !== "assistantText") || row.turnId === "live") {
      continue;
    }
    const value = row.text;
    Object.defineProperty(row, "text", {
      get() {
        historyTextReads += 1;
        return value;
      },
    });
  }

  builder(buildConversationTurnRenderUnits(fixture.withLiveText("a")), navigatorOptions);
  assert.ok(historyTextReads > 0, "the first directory build reads the historical text");
  historyTextReads = 0;
  for (const suffix of ["aa", "aaa", "aaaa"]) {
    // 与 SessionPane 激活分享时的节奏一致：每个流式 snapshot 重建全部 units 后再建目录。
    builder(buildConversationTurnRenderUnits(fixture.withLiveText(suffix)), navigatorOptions);
    assert.equal(
      historyTextReads,
      0,
      `streamed snapshot ${suffix} leaves every historical preview untouched`,
    );
  }
  const finalUnits = buildConversationTurnRenderUnits(fixture.withLiveText("aaaa"));
  assert.deepEqual(
    plain(builder(finalUnits, navigatorOptions)),
    plain(buildConversationTurnNavigatorItems(finalUnits, navigatorOptions)),
  );
});

test("deactivating share re-pins the empty window and stays idle across later snapshots", () => {
  const fixture = createRowFixture();
  const { render } = createSharePaneHarness();

  render(false, fixture.withLiveText(""));
  render(true, fixture.withLiveText("a"));
  let state = render(false, fixture.withLiveText("a"));
  assert.strictEqual(state.shareRowsWindow, EMPTY_SHARE_ROWS_WINDOW);
  assert.equal(state.shareItems.length, 0);
  const buildsAfterDeactivate = state.unitBuilds;

  state = render(false, fixture.withLiveText("b"));
  state = render(false, fixture.withLiveText("ccc"));
  assert.equal(state.unitBuilds, buildsAfterDeactivate, "deactivated share never rebuilds again");
});
