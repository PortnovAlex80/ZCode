import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { buildConversationFindIndex } from "../v4/conversationFindIndex.js";
import {
  buildConversationTurnNavigatorItems,
  createCachedConversationTurnNavigatorItemsBuilder,
} from "../v4/conversationTurnNavigatorHelpers.js";
import type { ConversationRow, TurnHeaderRow } from "@zcode/shared/zcode-protocol-v4";
import {
  buildConversationTurnRenderUnits,
  type ConversationTurnRenderUnit,
} from "../v4/conversationTurnRenderUnits.js";

const text = await readFile(new URL("../v4/ConversationTimeline.tsx", import.meta.url), "utf8");
const source = ts.createSourceFile(
  "timeline.tsx",
  text,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
function executable(name: string): string {
  const declaration = source.statements.find(
    (node) =>
      (ts.isFunctionDeclaration(node) && node.name?.text === name) ||
      (ts.isVariableStatement(node) &&
        node.declarationList.declarations.some((entry) => entry.name.getText(source) === name)),
  );
  assert.ok(declaration, name);
  return ts.transpileModule(`${declaration.getText(source)}\n${name};`, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.None,
      jsx: ts.JsxEmit.React,
    },
  }).outputText;
}
function turnRows(
  turnId: string,
  state: TurnHeaderRow["state"],
  overrides: Partial<TurnHeaderRow> = {},
): ConversationRow[] {
  const base = { turnId, createdAt: 1000, createdAtSeq: 1 };
  return [
    {
      ...base,
      rowId: 1,
      kind: "turnHeader",
      origin: "userInput",
      executionKind: "agent",
      state,
      startedAt: 1000,
      ...overrides,
    },
    { ...base, rowId: 2, kind: "userInput", origin: "realUser", text: "question" },
    {
      ...base,
      rowId: 3,
      kind: "assistantText",
      text: "answer",
      state: state === "running" ? "streaming" : "complete",
    },
  ];
}
const plain = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;

test("duration clock computes only its mounted running turn and matches fresh full-history statuses", () => {
  const history = Array.from({ length: 2000 }, (_, index) =>
    turnRows(`old-${index}`, "completedSuccess", { activeMs: 500 }),
  ).flat();
  const runningRows = turnRows("running", "running");
  runningRows.push(
    {
      turnId: "running",
      rowId: 4,
      createdAt: 3000,
      createdAtSeq: 2,
      kind: "userInput",
      origin: "realUser",
      entityId: "guide",
      guided: true,
      text: "guide",
    },
    {
      turnId: "running",
      rowId: 5,
      createdAt: 3001,
      createdAtSeq: 3,
      kind: "reasoning",
      text: "work",
      state: "streaming",
    },
  );
  const rows = [
    ...history,
    ...runningRows,
    ...turnRows("later", "completedSuccess", { activeMs: 100 }),
  ];
  const original = buildConversationTurnRenderUnits(rows, { nowMs: 4000 });
  const unit = original.find((entry) => entry.turnId === "running")!;
  let evaluatedRows = 0;
  const refresh = runInNewContext(executable("refreshConversationTurnClock"), {
    buildConversationTurnRenderUnits: (input: readonly ConversationRow[], options: object) => {
      evaluatedRows += input.length;
      return buildConversationTurnRenderUnits(input, options);
    },
  }) as (
    unit: ConversationTurnRenderUnit,
    rows: readonly ConversationRow[],
    nowMs: number,
  ) => ConversationTurnRenderUnit;
  const updated = refresh(unit, runningRows, 9000);
  const fresh = buildConversationTurnRenderUnits(rows, { nowMs: 9000 }).find(
    (entry) => entry.turnId === "running",
  )!;
  assert.equal(evaluatedRows, runningRows.length);
  assert.ok(evaluatedRows < rows.length / 1000);
  assert.deepEqual(plain(updated.workStatus), plain(fresh.workStatus));
  assert.deepEqual(
    plain(updated.workSegments?.map((segment) => segment.workStatus)),
    plain(fresh.workSegments?.map((segment) => segment.workStatus)),
  );
  assert.equal(
    updated.isLastTurn,
    false,
    "a stale running historical turn keeps its full-timeline position",
  );
  assert.equal(updated.assistantHistoryDefaultOpen, unit.assistantHistoryDefaultOpen);
  for (const field of [
    "flowItems",
    "renderRows",
    "assistantHistoryRows",
    "assistantTextRows",
    "visibleUserInputs",
  ] as const)
    assert.equal(updated[field], unit[field]);
  for (let index = 0; index < unit.workSegments!.length; index++) {
    assert.equal(updated.workSegments![index]!.flowItems, unit.workSegments![index]!.flowItems);
    assert.equal(
      updated.workSegments![index]!.assistantHistoryDefaultOpen,
      unit.workSegments![index]!.assistantHistoryDefaultOpen,
    );
  }
  assert.equal(refresh(original[0]!, history.slice(0, 3), 9000), original[0]);
  assert.equal(evaluatedRows, runningRows.length, "completed turns never run clock computation");
});

test("clock respects authoritative duration facts and completion", () => {
  const refresh = runInNewContext(executable("refreshConversationTurnClock"), {
    buildConversationTurnRenderUnits,
  }) as (
    unit: ConversationTurnRenderUnit,
    rows: readonly ConversationRow[],
    nowMs: number,
  ) => ConversationTurnRenderUnit;
  for (const overrides of [
    { activeMs: 0 },
    { activeMs: 123 },
    { endedAt: 1500 },
    { workSegments: [{ segmentId: "one", startedAt: 2000, activeMs: 50 }] },
  ]) {
    const rows = turnRows("running", "running", overrides);
    const unit = buildConversationTurnRenderUnits(rows, { nowMs: 4000 })[0]!;
    const updated = refresh(unit, rows, 9000);
    const fresh = buildConversationTurnRenderUnits(rows, { nowMs: 9000 })[0]!;
    assert.deepEqual(plain(updated.workStatus), plain(fresh.workStatus));
    assert.deepEqual(
      plain(updated.workSegments?.map((segment) => segment.workStatus)),
      plain(fresh.workSegments?.map((segment) => segment.workStatus)),
    );
    if (!("workSegments" in overrides))
      assert.equal(updated, unit, "fixed authoritative status keeps the child memo unchanged");
  }
});

test("mounted turn clock pauses hidden documents, catches up on show and disposes all timers/listeners", () => {
  let effect!: () => (() => void) | undefined;
  let stateUpdates = 0;
  let intervalStarts = 0;
  let clockComputations = 0;
  const intervals = new Map<number, () => void>();
  const listeners = new Map<string, () => void>();
  // Wave A × U-06/U-07 集成：时钟可见性改读展示宿主文档的 visibilityState（不再读
  // 全局 document.hidden）。主文档语义 = usePresentationDocument 返回主文档本身。
  const document = {
    hidden: false,
    visibilityState: "visible",
    addEventListener: (name: string, handler: () => void) => listeners.set(name, handler),
    removeEventListener: (name: string) => listeners.delete(name),
  };
  const setHidden = (hidden: boolean) => {
    document.hidden = hidden;
    document.visibilityState = hidden ? "hidden" : "visible";
  };
  const component = runInNewContext(executable("ConversationClockedTurnGroup"), {
    memo: (fn: unknown) => fn,
    useState: () => [
      4000,
      () => {
        stateUpdates++;
      },
    ],
    useEffect: (fn: typeof effect) => {
      effect = fn;
    },
    useMemo: (fn: () => unknown) => fn(),
    usePresentationDocument: () => document,
    refreshConversationTurnClock: (unit: unknown) => {
      clockComputations++;
      return unit;
    },
    ConversationTurnGroup: () => null,
    React: { createElement: () => null },
    RUNNING_WORK_DURATION_TICK_MS: 1000,
    document,
    window: {
      setInterval: (fn: () => void) => {
        intervalStarts++;
        intervals.set(intervalStarts, fn);
        return intervalStarts;
      },
      clearInterval: (id: number) => intervals.delete(id),
    },
  }) as (props: object) => unknown;
  component({ unit: { isRunning: true }, snapshotNowMs: 5000, clockRows: [] });
  assert.equal(
    clockComputations,
    0,
    "streaming snapshots already newer than the clock need no repeated builder",
  );
  component({ unit: { isRunning: true }, snapshotNowMs: 3000, clockRows: [] });
  assert.equal(clockComputations, 1, "clock advances only after its structural snapshot");
  const dispose = effect()!;
  assert.equal(intervals.size, 1);
  setHidden(true);
  listeners.get("visibilitychange")!();
  assert.equal(intervals.size, 0);
  const beforeShow = stateUpdates;
  setHidden(false);
  listeners.get("visibilitychange")!();
  assert.equal(stateUpdates, beforeShow + 1, "show catches up immediately");
  assert.equal(intervals.size, 1);
  dispose();
  assert.equal(intervals.size, 0);
  assert.equal(listeners.size, 0);
  component({ unit: { isRunning: false } });
  assert.equal(effect(), undefined);
  assert.equal(intervals.size, 0);
  setHidden(true);
  component({ unit: { isRunning: true } });
  const disposeHidden = effect()!;
  assert.equal(intervals.size, 0, "initially hidden documents schedule no duration work");
  disposeHidden();
  assert.equal(listeners.size, 0);
});

test("mounted turn clock follows the presentation host document (PiP), not the main document", () => {
  let effect!: () => (() => void) | undefined;
  let intervalStarts = 0;
  const intervals = new Map<number, () => void>();
  const mainListeners = new Map<string, () => void>();
  const pipListeners = new Map<string, () => void>();
  const mainDocument = {
    hidden: false,
    visibilityState: "visible",
    addEventListener: (name: string, handler: () => void) => mainListeners.set(name, handler),
    removeEventListener: (name: string) => mainListeners.delete(name),
  };
  // PiP 宿主文档：聊天被弹出为独立 OS 窗口后 usePresentationDocument 返回它。
  const pipDocument = {
    visibilityState: "visible",
    addEventListener: (name: string, handler: () => void) => pipListeners.set(name, handler),
    removeEventListener: (name: string) => pipListeners.delete(name),
  };
  const component = runInNewContext(executable("ConversationClockedTurnGroup"), {
    memo: (fn: unknown) => fn,
    useState: () => [4000, () => {}],
    useEffect: (fn: typeof effect) => {
      effect = fn;
    },
    useMemo: (fn: () => unknown) => fn(),
    usePresentationDocument: () => pipDocument,
    refreshConversationTurnClock: (unit: unknown) => unit,
    ConversationTurnGroup: () => null,
    React: { createElement: () => null },
    RUNNING_WORK_DURATION_TICK_MS: 1000,
    document: mainDocument,
    window: {
      setInterval: (fn: () => void) => {
        intervalStarts++;
        intervals.set(intervalStarts, fn);
        return intervalStarts;
      },
      clearInterval: (id: number) => intervals.delete(id),
    },
  }) as (props: object) => unknown;
  component({ unit: { isRunning: true }, snapshotNowMs: 5000, clockRows: [] });
  const dispose = effect()!;
  assert.equal(intervals.size, 1, "running clock ticks while the PiP document is visible");
  assert.equal(pipListeners.size, 1, "visibility listener attaches to the PiP document");
  assert.equal(mainListeners.size, 0, "main document gets no listener while popped out");
  // 主文档最小化（隐藏）不得冻结 PiP 里仍展示的会话时钟。
  mainDocument.hidden = true;
  mainDocument.visibilityState = "hidden";
  mainListeners.get("visibilitychange")?.();
  assert.equal(intervals.size, 1, "main-document hide does not pause the PiP-hosted clock");
  // PiP 文档隐藏 → 停表；恢复 → 重新起表。
  pipDocument.visibilityState = "hidden";
  pipListeners.get("visibilitychange")!();
  assert.equal(intervals.size, 0, "PiP document hide pauses the clock");
  pipDocument.visibilityState = "visible";
  pipListeners.get("visibilitychange")!();
  assert.equal(intervals.size, 1, "PiP document show restarts the clock");
  dispose();
  assert.equal(intervals.size, 0);
  assert.equal(pipListeners.size, 0, "dispose removes the PiP listener");
});

test("duration ticks stay inside mounted turns while upstream plugin and expiry boundaries remain", () => {
  const root = source.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === "ConversationTimelineImpl",
  );
  assert.ok(root);
  const rootText = root.getText(source);
  assert.equal(
    rootText.includes("window.setInterval"),
    false,
    "history has no periodic duration clock",
  );
  assert.match(rootText, /pluginUiPinResolver/);
  assert.match(rootText, /armHighspeedFooterExpiryClock/);
  const tags: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isJsxSelfClosingElement(node)) tags.push(node.tagName.getText(source));
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.equal(tags.filter((tag) => tag === "ConversationClockedTurnGroup").length, 2);
});

test("CSS-hidden narrow navigator does not mount or build history previews and restores at its visibility boundary", () => {
  let condition: ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (
      ts.isConditionalExpression(node) &&
      node.whenFalse.getText(source).includes("<ConversationTurnNavigator") &&
      node.whenTrue.kind === ts.SyntaxKind.NullKeyword
    )
      condition = node.condition;
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(condition);
  const conditionText = condition!.getText(source);
  const hidden = (width: number, sharing: boolean) =>
    runInNewContext(conditionText, {
      hideTurnNavigator: sharing,
      turnNavigatorContainerWidthPx: width,
    }) as boolean;
  assert.equal(hidden(0, false), true, "zero-width hidden panes do no navigator work");
  assert.equal(hidden(863, false), true);
  assert.equal(hidden(864, false), false);
  assert.equal(hidden(1200, false), false);
  assert.equal(hidden(1200, true), true, "sharing continues to own the rail");
});

const findHookText = await readFile(
  new URL("../v4/useConversationTimelineFind.ts", import.meta.url),
  "utf8",
);
const findHookSource = ts.createSourceFile("find.ts", findHookText, ts.ScriptTarget.Latest, true);
function createFindMemoHarness() {
  let initializer: ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(findHookSource) === "conversationFindIndex"
    )
      initializer = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(findHookSource);
  assert.ok(initializer);
  const code = ts.transpileModule(`(${initializer!.getText(findHookSource)});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const cache = new Map();
  const unitFindCacheRef = { current: cache };
  const unitFindCacheQueryRef = { current: "" };
  let builds = 0;
  return {
    cache,
    get builds() {
      return builds;
    },
    evaluate(renderUnits: ConversationTurnRenderUnit[], conversationFindQuery: string) {
      return runInNewContext(code, {
        renderUnits,
        conversationFindQuery,
        codeCommentCardsEnabled: true,
        unitFindCacheRef,
        unitFindCacheQueryRef,
        useMemo: (calculate: () => unknown) => calculate(),
        buildConversationFindIndex: (...args: Parameters<typeof buildConversationFindIndex>) => {
          builds++;
          return buildConversationFindIndex(...args);
        },
      }) as ReturnType<typeof buildConversationFindIndex>;
    },
  };
}

test("empty find queries count rows without reading any user or assistant text in the index or hook", () => {
  const unit = buildConversationTurnRenderUnits(
    turnRows("one", "completedSuccess", { activeMs: 100 }),
  )[0]!;
  for (const row of [...unit.visibleUserInputs, ...unit.assistantTextRows]) {
    Object.defineProperty(row, "text", {
      get() {
        throw new Error("empty-query path read source text");
      },
    });
  }
  for (const query of ["", " \n\t "]) {
    for (const projectAssistantCodeComments of [false, true]) {
      const result = buildConversationFindIndex([unit], query, { projectAssistantCodeComments });
      assert.deepEqual(result, { query: "", matches: [], matchCount: 0, loadedRowCount: 2 });
    }
    const harness = createFindMemoHarness();
    harness.cache.set("previous-search", { source: [{ sourceText: "retained old text" }] });
    assert.deepEqual(plain(harness.evaluate([unit], query)), {
      query: "",
      matches: [],
      matchCount: 0,
      loadedRowCount: 2,
    });
    assert.equal(harness.builds, 0, "hook never invokes text projection when no query exists");
    assert.equal(harness.cache.size, 0, "closing search releases its cached source text");
  }
});

test("find cache reuses unchanged source rows but invalidates a completed-row replacement and prunes removed units", () => {
  const rows = turnRows("one", "completedSuccess", { activeMs: 100 });
  const first = buildConversationTurnRenderUnits(rows)[0]!;
  const harness = createFindMemoHarness();
  assert.equal(harness.evaluate([first], "answer").matchCount, 1);
  assert.equal(harness.builds, 1);
  const regrouped = buildConversationTurnRenderUnits(rows)[0]!;
  assert.notEqual(regrouped, first);
  assert.equal(harness.evaluate([regrouped], "answer").matchCount, 1);
  assert.equal(harness.builds, 1, "rebuilding turn arrays preserves reusable row identities");
  const replacedRows = rows.map((row) =>
    row.kind === "assistantText" ? { ...row, text: "answer answer replaced" } : row,
  );
  const replaced = buildConversationTurnRenderUnits(replacedRows)[0]!;
  const revised = harness.evaluate([replaced], "answer");
  assert.equal(harness.builds, 2);
  assert.equal(revised.matchCount, 2);
  assert.deepEqual(
    plain(revised),
    plain(buildConversationFindIndex([replaced], "answer", { projectAssistantCodeComments: true })),
  );
  assert.equal(harness.cache.size, 1);
  assert.equal(harness.evaluate([], "answer").loadedRowCount, 0);
  assert.equal(harness.cache.size, 0, "removed transcript units cannot retain source rows/matches");
  const laterRows = turnRows("later", "completedSuccess", { activeMs: 100 });
  const later = buildConversationTurnRenderUnits(laterRows)[0]!;
  harness.evaluate([replaced, later], "answer");
  assert.equal(harness.cache.size, 2);
  const rebased = harness.evaluate([later], "answer");
  assert.equal(harness.cache.size, 1);
  assert.equal(
    rebased.matches[0]!.unitIndex,
    0,
    "retained cached matches rebase to their current virtual position",
  );
  assert.equal(harness.evaluate([later], "question").matchCount, 1);
  assert.equal(harness.cache.size, 1, "changing the query releases previous matches");
});

test("running turn find results always refresh and report appended text", () => {
  const rows = turnRows("running", "running");
  const first = buildConversationTurnRenderUnits(rows, { nowMs: 2000 })[0]!;
  const harness = createFindMemoHarness();
  assert.equal(harness.evaluate([first], "answer").matchCount, 1);
  harness.evaluate([first], "answer");
  assert.equal(harness.builds, 2, "running turn bypasses completed-history cache");
  const appended = buildConversationTurnRenderUnits(
    rows.map((row) =>
      row.kind === "assistantText" ? { ...row, text: row.text + " answer" } : row,
    ),
    { nowMs: 2000 },
  )[0]!;
  assert.equal(harness.evaluate([appended], "answer").matchCount, 2);
  assert.equal(harness.cache.size, 0);
});

const navigatorOptions = {
  assistantEmptyPreview: "empty",
  assistantRunningPreview: "running",
  userFallbackPreview: "user",
};

test("mounted navigator cache matches the fresh builder across stream, replacement, order, deletion, identity and localized options", () => {
  const buildCached = createCachedConversationTurnNavigatorItemsBuilder();
  const historyRows = turnRows("history", "completedSuccess", { activeMs: 100 });
  const liveRows = turnRows("live", "running");
  liveRows.push({
    kind: "userInput",
    turnId: "live",
    rowId: 4,
    createdAt: 1500,
    createdAtSeq: 2,
    origin: "realUser",
    guided: true,
    text: "followup",
    entityId: "guide",
  });
  const initial = buildConversationTurnRenderUnits([...historyRows, ...liveRows], { nowMs: 2000 });
  function compare(units: ConversationTurnRenderUnit[], options = navigatorOptions) {
    assert.deepEqual(
      buildCached(units, options),
      buildConversationTurnNavigatorItems(units, options),
    );
  }
  compare(initial);
  compare(buildConversationTurnRenderUnits([...historyRows, ...liveRows], { nowMs: 3000 }));
  const streamedRows = liveRows.map((row) =>
    row.kind === "assistantText" ? { ...row, text: row.text + " more streamed text" } : row,
  );
  const streamed = buildConversationTurnRenderUnits([...historyRows, ...streamedRows], {
    nowMs: 3000,
  });
  compare(streamed);
  const revisedRows = historyRows.map((row) =>
    row.kind === "assistantText" ? { ...row, text: "replaced completed answer" } : row,
  );
  const revised = buildConversationTurnRenderUnits([...revisedRows, ...streamedRows], {
    nowMs: 3000,
  });
  compare(revised);
  compare([
    {
      ...revised[0]!,
      visibleUserInputs: revised[0]!.visibleUserInputs.map((row) => ({
        ...row,
        text: "replaced user query",
      })),
    },
    revised[1]!,
  ]);
  compare([revised[0]!, { ...revised[1]!, isRunning: false }]);
  compare([revised[1]!, revised[0]!]);
  compare([revised[1]!]);
  compare([]);
  compare(revised);
  compare([{ ...revised[0]!, turnId: "remapped-turn", isRunning: true }, revised[1]!]);
  compare([{ ...revised[0]!, timelineOnly: true }, revised[1]!]);
  const empty = {
    ...revised[0]!,
    assistantTextRows: [],
    visibleUserInputs: [{ ...revised[0]!.visibleUserInputs[0]!, text: "" }],
  };
  compare([empty, { ...empty, key: "running-empty", turnId: "running-empty", isRunning: true }]);
  compare([empty, { ...empty, key: "running-empty", turnId: "running-empty", isRunning: true }], {
    assistantEmptyPreview: "vide",
    assistantRunningPreview: "en cours",
    userFallbackPreview: "utilisateur",
  });
  for (const limit of [8, 32, 220]) {
    const options = {
      ...navigatorOptions,
      maxPreviewChars: limit,
      maxPreviewParagraphs: limit === 8 ? 1 : 2,
    };
    assert.deepEqual(
      buildCached(revised, options),
      buildConversationTurnNavigatorItems(revised, options),
    );
  }
});

test("navigator cache eliminates unchanged historical text reads, prunes removed turns and stays local to each mounted rail", () => {
  let historicalReads = 0;
  let removedReads = 0;
  const history = Array.from({ length: 100 }, (_, index) => {
    const unit = buildConversationTurnRenderUnits(
      turnRows(`old-${index}`, "completedSuccess", { activeMs: 100 }),
    )[0]!;
    for (const row of [...unit.visibleUserInputs, ...unit.assistantTextRows]) {
      const value = row.text;
      Object.defineProperty(row, "text", {
        get() {
          historicalReads++;
          if (index === 0) removedReads++;
          return value;
        },
      });
    }
    return unit;
  });
  const liveRows = turnRows("live", "running");
  const live = buildConversationTurnRenderUnits(liveRows, { nowMs: 2000 })[0]!;
  const buildCached = createCachedConversationTurnNavigatorItemsBuilder();
  const initial = buildCached([...history, live], navigatorOptions);
  assert.ok(historicalReads >= 200);
  historicalReads = 0;
  const regrouped = history.map((unit) => ({
    ...unit,
    visibleUserInputs: unit.visibleUserInputs.slice(),
    assistantTextRows: unit.assistantTextRows.slice(),
  }));
  assert.deepEqual(buildCached([...regrouped, live], navigatorOptions), initial);
  assert.equal(
    historicalReads,
    0,
    "new grouping arrays do not require rereading immutable historical text",
  );
  const changed = buildConversationTurnRenderUnits(
    liveRows.map((row) =>
      row.kind === "assistantText" ? { ...row, text: "stream replaced" } : row,
    ),
    { nowMs: 2000 },
  )[0]!;
  buildCached([...regrouped, changed], navigatorOptions);
  assert.equal(
    historicalReads,
    0,
    "live stream replacement leaves every historical preview untouched",
  );
  buildCached([...regrouped.slice(1), changed], navigatorOptions);
  removedReads = 0;
  buildCached([...regrouped, changed], navigatorOptions);
  assert.equal(
    removedReads,
    2,
    "a removed and reintroduced turn recomputes after its retained rows were pruned",
  );
  historicalReads = 0;
  const otherRail = createCachedConversationTurnNavigatorItemsBuilder();
  otherRail([...regrouped, changed], navigatorOptions);
  assert.ok(historicalReads >= 200, "another mounted rail owns a separate cache");
});

test("navigator component owns its builder in a ref instead of a global cache", async () => {
  const text = await readFile(
    new URL("../v4/ConversationTurnNavigator.tsx", import.meta.url),
    "utf8",
  );
  assert.match(text, /const itemsBuilderRef = useRef</);
  assert.match(
    text,
    /if \(itemsBuilderRef\.current === null\) \{\s*itemsBuilderRef\.current = createCachedConversationTurnNavigatorItemsBuilder\(\);/,
  );
  assert.match(text, /itemsBuilderRef\.current!\(renderUnits,/);
});
