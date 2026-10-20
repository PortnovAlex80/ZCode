// 渲染性能复核 #2 发现 8：isolated React hidden/reveal work counts 测量口径。
// 器具复制自 v4ConversationTimelinePresentationSuspension.test.ts（同源约束）；
// 差异：插件推导走真实实现并计数（不吞真实链路），用例输出测量 JSON 供配对报告引用。
//
// 器具复制自 v4ConversationTimelineSessionSwitchScrollRestoreRepro.test.ts（最小 DOM +
// mock virtualizer）。本文件不测滚动恢复，而用计数器证明：
// 1. 隐藏（presentationVisible=false）期间的流式 rows 更新不再触发
//    buildConversationTurnRenderUnits / deriveLogicalUiInstances 重建（bounded hide work）；
// 2. 恢复展示的同一 commit 恰好重建一次，并直接落到最新 rows（无过期闪现）；
// 3. bottomDock（含 composer 的宿主 dock）跨隐藏/恢复保持同一实例（禁止靠卸载实现挂起）;
// 4. 运行轮展示时钟在隐藏时停摆、恢复时重新起表；
// 5. 纯展示驱动的目录补拉在隐藏期间不再发起（stale 结果强制 idle 重试的对照路径）。

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";
import { ConversationTimeline } from "@/v4/ConversationTimeline.js";
import { applyConversationDeltas } from "@zcode/shared/zcode-protocol-v4";
import {
  V4_REPLAY_FIXTURE_DEFAULT_SEED,
  buildV4ReplayStreamTail,
  generateV4ReplayRows,
} from "../../../scripts/perf/v4-replay-fixtures.mjs";

const counters = vi.hoisted(() => ({
  buildRenderUnits: 0,
  cacheBuilds: 0,
  materializeUnits: 0,
  derivePluginInstances: 0,
  liveTailSplit: 0,
  turnGroupRenders: 0,
  intervalArmed: 0,
  intervalCleared: 0,
}));

// splitConversationTimelineLiveTail 默认走真实实现；时钟用例需要可控的 running live tail。
const liveTailOverride = vi.hoisted(() => ({
  impl: null as
    | null
    | ((units: readonly unknown[]) => {
        virtualizedUnits: unknown[];
        liveUnit: unknown | null;
        liveUnitIndex: number | null;
      }),
}));

const virtualizer = vi.hoisted(() => ({
  getVirtualItemForOffset: vi.fn(),
  getTotalSize: () => 1200,
  getVirtualItems: () => [] as [],
  measurementsCache: [] as unknown[],
  measure: vi.fn(),
  measureElement: vi.fn(),
  scrollOffset: null as number | null,
  scrollRect: null as { height: number } | null,
  scrollToIndex: vi.fn(),
  shouldAdjustScrollPositionOnItemSizeChange: null as
    | null
    | ((item: { end: number; start: number }) => boolean),
}));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: () => virtualizer,
}));

vi.mock("@/v4/ConversationTurnGroup.js", async () => {
  const React = await import("react");
  return {
    ConversationTurnGroup: () => {
      counters.turnGroupRenders += 1;
      return React.createElement("div");
    },
  };
});

vi.mock("@/v4/ConversationTurnNavigator.js", () => ({
  ConversationTurnNavigator: () => null,
}));

vi.mock("@/v4/useConversationTimelineFind.js", () => ({
  useConversationTimelineFind: () => undefined,
}));

vi.mock("@/v4/conversationTurnRenderUnits.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/v4/conversationTurnRenderUnits.js")>();
  return {
    ...actual,
    buildConversationTurnRenderUnits: (
      ...args: Parameters<typeof actual.buildConversationTurnRenderUnits>
    ) => {
      // Wave C 起时间线走 conversationTurnRenderUnitsCache（group+materialize），
      // 全量 builder 只剩运行时钟刷新路径在用；保留计数器作对照。
      counters.buildRenderUnits += 1;
      return actual.buildConversationTurnRenderUnits(...args);
    },
    materializeDraftUnit: (...args: Parameters<typeof actual.materializeDraftUnit>) => {
      counters.materializeUnits += 1;
      return actual.materializeDraftUnit(...args);
    },
  };
});

// Wave C：时间线经缓存 builder 产出 render units；对「冻结=不重建」的断言改看
// 缓存 build 调用次数（memo 冻结期间为 0，恢复展示恰好 +1）与逐轮物化计数。
vi.mock("@/v4/conversationTurnRenderUnitsCache.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/v4/conversationTurnRenderUnitsCache.js")>();
  return {
    createCachedConversationTurnRenderUnitsBuilder: () => {
      const inner = actual.createCachedConversationTurnRenderUnitsBuilder();
      counters.cacheBuilds = 0;
      return {
        build: (...args: Parameters<typeof inner.build>) => {
          counters.cacheBuilds += 1;
          return inner.build(...args);
        },
        stats: inner.stats,
        resetForTest: inner.resetForTest,
      };
    },
  };
});

vi.mock("@/v4/conversationTimelineLiveTail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/v4/conversationTimelineLiveTail.js")>();
  return {
    // 上游 3.16.2 新增 resolveConversationLatestTurnSummary 等导出；透传实际实现。
    ...actual,
    splitConversationTimelineLiveTail: (
      ...args: Parameters<typeof actual.splitConversationTimelineLiveTail>
    ) => {
      counters.liveTailSplit += 1;
      if (liveTailOverride.impl) {
        return liveTailOverride.impl(actual.splitConversationTimelineLiveTail(...args)) as never;
      }
      return actual.splitConversationTimelineLiveTail(...args);
    },
  };
});

vi.mock("@/plugin-ui/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/plugin-ui/index.js")>();
  return {
    ...actual,
    deriveLogicalUiInstances: (
      ...args: Parameters<typeof actual.deriveLogicalUiInstances>
    ) => {
      counters.derivePluginInstances += 1;
      return actual.deriveLogicalUiInstances(...args);
    },
  };
});

type TestEventHandler = (event: Record<string, unknown>) => void;
type TestElement = Element & {
  __attrs: Map<string, string>;
  __listeners: Map<string, TestEventHandler[]>;
  childNodes: TestElement[];
  parentNode: TestElement | null;
  scrollTop: number;
};

const nextFrame = { id: 1 };
const animationFrames = new Map<number, FrameRequestCallback>();
const scheduledMicrotasks: Array<() => void> = [];
const nativeQueueMicrotask = globalThis.queueMicrotask;
let mountedRoot: Root | null = null;

function createMinimalElement(ownerDocument: Document, tagName = "div"): TestElement {
  let scrollTop = 0;
  const element = {
    __attrs: new Map<string, string>(),
    __listeners: new Map<string, TestEventHandler[]>(),
    addEventListener: (type: string, handler: TestEventHandler) => {
      element.__listeners.set(type, [...(element.__listeners.get(type) ?? []), handler]);
    },
    appendChild: (child: TestElement) => {
      child.parentNode = element as unknown as TestElement;
      element.childNodes.push(child);
      return child;
    },
    childNodes: [] as TestElement[],
    clientWidth: 1024,
    dispatchEvent: (event: Event) => {
      const forwardedEvent = {
        bubbles: event.bubbles,
        cancelBubble: event.cancelBubble,
        currentTarget: element,
        defaultPrevented: event.defaultPrevented,
        preventDefault: () => event.preventDefault(),
        stopPropagation: () => event.stopPropagation(),
        target: element,
        timeStamp: event.timeStamp,
        type: event.type,
      };
      for (const handler of element.__listeners.get(event.type) ?? []) {
        handler(forwardedEvent);
      }
      return !event.defaultPrevented;
    },
    getBoundingClientRect: () => ({
      bottom: 300,
      height: 300,
      left: 0,
      right: 1024,
      top: 0,
      width: 1024,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
    getAttribute: (name: string) => element.__attrs.get(name) ?? null,
    insertBefore: (child: TestElement, beforeChild?: TestElement | null) => {
      child.parentNode = element as unknown as TestElement;
      const index = beforeChild ? element.childNodes.indexOf(beforeChild) : -1;
      if (index >= 0) element.childNodes.splice(index, 0, child);
      else element.childNodes.push(child);
      return child;
    },
    nodeName: tagName.toUpperCase(),
    nodeType: 1,
    ownerDocument,
    parentNode: null as TestElement | null,
    removeAttribute: (name: string) => element.__attrs.delete(name),
    removeChild: (child: TestElement) => {
      element.childNodes = element.childNodes.filter((item) => item !== child);
      child.parentNode = null;
      return child;
    },
    removeEventListener: (type: string, handler: TestEventHandler) => {
      element.__listeners.set(
        type,
        (element.__listeners.get(type) ?? []).filter((item) => item !== handler),
      );
    },
    querySelectorAll: () => [] as TestElement[],
    setAttribute: (name: string, value: string) => {
      element.__attrs.set(name, String(value));
    },
    style: {},
    tagName: tagName.toUpperCase(),
  };
  Object.defineProperties(element, {
    clientHeight: { get: () => 300 },
    scrollHeight: { get: () => 1200 },
    scrollTop: {
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = Math.min(Math.max(Number(value) || 0, 0), 900);
      },
    },
  });
  return element as unknown as TestElement;
}

function installMinimalDom(): TestElement {
  const documentMock = {
    addEventListener: () => {},
    createElement: (tagName: string) =>
      createMinimalElement(documentMock as unknown as Document, tagName),
    createElementNS: (_namespace: string, tagName: string) =>
      createMinimalElement(documentMock as unknown as Document, tagName),
    createTextNode: (nodeValue: string) => ({
      nodeType: 3,
      nodeValue,
      ownerDocument: documentMock,
      parentNode: null,
    }),
    nodeType: 9,
    removeEventListener: () => {},
  } as unknown as Document & { defaultView?: unknown };
  const windowMock = {
    addEventListener: () => {},
    cancelAnimationFrame: (frameId: number) => animationFrames.delete(frameId),
    clearInterval: () => {
      counters.intervalCleared += 1;
    },
    clearTimeout: () => {},
    document: documentMock,
    HTMLElement: function HTMLElement() {},
    HTMLIFrameElement: function HTMLIFrameElement() {},
    Node: function Node() {},
    queueMicrotask: (callback: () => void) => scheduledMicrotasks.push(callback),
    removeEventListener: () => {},
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      const frameId = nextFrame.id;
      nextFrame.id += 1;
      animationFrames.set(frameId, callback);
      return frameId;
    },
    setInterval: () => {
      counters.intervalArmed += 1;
      return 1;
    },
    setTimeout: () => 1,
  };
  documentMock.defaultView = windowMock;
  Object.assign(globalThis, {
    document: documentMock,
    HTMLElement: windowMock.HTMLElement,
    HTMLIFrameElement: windowMock.HTMLIFrameElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    Node: windowMock.Node,
    queueMicrotask: windowMock.queueMicrotask,
    window: windowMock,
  });
  return createMinimalElement(documentMock, "div");
}


function flushScheduledMicrotasks(): void {
  while (scheduledMicrotasks.length > 0) {
    scheduledMicrotasks.shift()?.();
  }
}


const rowContext: ConversationRowRenderContext = {
  codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
  sessionId: "session-1",
  theme: "system",
  workspacePath: "/workspace",
};

const dockLifecycle = vi.hoisted(() => ({ mounts: 0, unmounts: 0 }));


interface RenderOptions {
  presentationVisible?: boolean;
  canLoadOlder?: boolean;
  onLoadAllOlder?: () => Promise<{ status: string }>;
  bottomDock?: ReturnType<typeof createElement>;
}

function renderTimeline(root: Root, rows: readonly ConversationRow[], options: RenderOptions = {}) {
  root.render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(ConversationTimeline, {
        rows,
        totalCount: rows.length,
        sessionKey: "session-1",
        scrollMemoryKey: null,
        rowContext,
        presentationVisible: options.presentationVisible ?? true,
        canLoadOlder: options.canLoadOlder ?? false,
        onLoadAllOlder: options.onLoadAllOlder,
        bottomDock: options.bottomDock,
      }),
    ),
  );
}

beforeEach(() => {
  counters.buildRenderUnits = 0;
  counters.cacheBuilds = 0;
  counters.materializeUnits = 0;
  counters.derivePluginInstances = 0;
  counters.liveTailSplit = 0;
  counters.turnGroupRenders = 0;
  counters.intervalArmed = 0;
  counters.intervalCleared = 0;
  dockLifecycle.mounts = 0;
  dockLifecycle.unmounts = 0;
  liveTailOverride.impl = null;
  nextFrame.id = 1;
  animationFrames.clear();
  scheduledMicrotasks.length = 0;
});

afterEach(() => {
  act(() => {
    flushScheduledMicrotasks();
    mountedRoot?.unmount();
    flushScheduledMicrotasks();
  });
  mountedRoot = null;
  animationFrames.clear();
  scheduledMicrotasks.length = 0;
  globalThis.queueMicrotask = nativeQueueMicrotask;
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT;
  delete (globalThis as { HTMLElement?: unknown }).HTMLElement;
  delete (globalThis as { HTMLIFrameElement?: unknown }).HTMLIFrameElement;
  delete (globalThis as { Node?: unknown }).Node;
});


/**
 * 复核 #2 发现 8（isolated React 证据，非 wall-clock）：真实 ConversationTimeline 在
 * 极简 DOM 中按 200/1000/2000 轮历史驱动「可见流式 → 隐藏流式 → reveal」，输出
 * 确定性 work counts（真实插件推导 / 缓存 build / 逐轮物化 / live-tail 拆分 /
 * turn group 渲染）。隐藏期计数为 0、reveal 恰好一次重建是该产品的既有回归断言
 * （见 v4ConversationTimelinePresentationSuspension.test.ts）；此处以测量口径
 * 打印各尺寸的具体计数，供配对报告引用。生产 renderer 证据仍 live-gated。
 */
describe("hidden/reveal work counts measurement (review 2 / finding 8)", () => {
  const SIZES = [200, 1000, 2000] as const;
  const TOKENS = 24;
  const VISIBLE_TOKENS = 8;

  it.each(SIZES)("isolated React work counts @ %s turns", (turns) => {
    const { rows } = generateV4ReplayRows({
      turns,
      seed: V4_REPLAY_FIXTURE_DEFAULT_SEED,
    });
    const tail = buildV4ReplayStreamTail({
      chunks: 48,
      baseRowId: rows.at(-1)!.rowId,
    });
    const head = tail.deltas.filter((delta) => delta.op === "row.appended");
    let snapshot = applyConversationDeltas(
      {
        rows: {
          window: [...rows],
          totalCount: rows.length + head.length,
          firstRowId: rows[0]?.rowId ?? null,
        },
      } as never,
      head,
    );
    const frames: Array<readonly ConversationRow[]> = [snapshot.rows.window];
    for (let token = 0; token < TOKENS; token += 1) {
      snapshot = applyConversationDeltas(snapshot, [
        {
          op: "row.delta",
          rowId: tail.streamingRowId,
          path: "text",
          append: "measurement token ",
        },
      ]);
      frames.push(snapshot.rows.window);
    }

    const root = createRoot(installMinimalDom());
    mountedRoot = root;
    // 生产形态的可见→隐藏→reveal 序列：先可见消费前 8 个 token，随后 16 个 token
    // 在隐藏期到达（rows 持续更新），reveal 落到最新窗口——此时才预期「恰好一次重建」。
    const visibleFrames = frames.slice(0, VISIBLE_TOKENS + 1);
    const hiddenFrames = frames.slice(VISIBLE_TOKENS + 1);
    act(() => {
      renderTimeline(root, visibleFrames[0]!, { presentationVisible: true });
    });
    const visibleStart = { ...counters };
    for (const frame of visibleFrames.slice(1)) {
      act(() => {
        renderTimeline(root, frame, { presentationVisible: true });
      });
    }
    const visibleCounts = {
      derive: counters.derivePluginInstances - visibleStart.derivePluginInstances,
      cacheBuilds: counters.cacheBuilds - visibleStart.cacheBuilds,
      materialize: counters.materializeUnits - visibleStart.materializeUnits,
      liveTail: counters.liveTailSplit - visibleStart.liveTailSplit,
      turnGroups: counters.turnGroupRenders - visibleStart.turnGroupRenders,
    };

    const hiddenStart = { ...counters };
    for (const frame of hiddenFrames) {
      act(() => {
        renderTimeline(root, frame, { presentationVisible: false });
      });
    }
    const hiddenCounts = {
      derive: counters.derivePluginInstances - hiddenStart.derivePluginInstances,
      cacheBuilds: counters.cacheBuilds - hiddenStart.cacheBuilds,
      materialize: counters.materializeUnits - hiddenStart.materializeUnits,
      liveTail: counters.liveTailSplit - hiddenStart.liveTailSplit,
      turnGroups: counters.turnGroupRenders - hiddenStart.turnGroupRenders,
    };

    const revealStart = { ...counters };
    act(() => {
      renderTimeline(root, frames.at(-1)!, { presentationVisible: true });
    });
    const revealCounts = {
      derive: counters.derivePluginInstances - revealStart.derivePluginInstances,
      cacheBuilds: counters.cacheBuilds - revealStart.cacheBuilds,
      materialize: counters.materializeUnits - revealStart.materializeUnits,
      liveTail: counters.liveTailSplit - revealStart.liveTailSplit,
      turnGroups: counters.turnGroupRenders - revealStart.turnGroupRenders,
    };

    console.info(
      JSON.stringify({
        measurement: "hidden-reveal-work-counts",
        turns,
        historyRows: rows.length,
        loadedRows: frames.at(-1)!.length,
        tokens: TOKENS,
        visibleTokens: VISIBLE_TOKENS,
        hiddenTokens: TOKENS - VISIBLE_TOKENS,
        visible: visibleCounts,
        hidden: hiddenCounts,
        reveal: revealCounts,
      }),
    );
    expect(hiddenCounts.derive).toBe(0);
    expect(hiddenCounts.cacheBuilds).toBe(0);
    expect(revealCounts.cacheBuilds).toBe(1);
  });
});
