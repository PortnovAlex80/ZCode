// 渲染性能 Wave A：presentation visibility 冻结重量级展示推导的 work-count 回归。
//
// 器具复制自 v4ConversationTimelineSessionSwitchScrollRestoreRepro.test.ts（最小 DOM +
// mock virtualizer）。本文件不测滚动恢复，而用计数器证明：
// 1. 隐藏（presentationVisible=false）期间的流式 rows 更新不再触发
//    buildConversationTurnRenderUnits / deriveLogicalUiInstances 重建（bounded hide work）；
// 2. 恢复展示的同一 commit 恰好重建一次，并直接落到最新 rows（无过期闪现）；
// 3. bottomDock（含 composer 的宿主 dock）跨隐藏/恢复保持同一实例（禁止靠卸载实现挂起）;
// 4. 运行轮展示时钟在隐藏时停摆、恢复时重新起表；
// 5. 纯展示驱动的目录补拉在隐藏期间不再发起（stale 结果强制 idle 重试的对照路径）。

import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationRow, UserInputRow } from "@zcode/shared/zcode-protocol-v4";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";
import { ConversationTimeline } from "@/v4/ConversationTimeline.js";

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

vi.mock("@/plugin-ui/index.js", () => ({
  deriveLogicalUiInstances: () => {
    counters.derivePluginInstances += 1;
    return { instances: [], byToolCallId: {} };
  },
  getPluginUiDisclosureVersion: () => 0,
  getPluginUiManualPin: () => false,
  setPluginUiInstanceDerivation: () => {},
  subscribePluginUiDisclosure: () => () => {},
}));

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

function findScrollContainer(node: TestElement): TestElement | null {
  if (node.getAttribute("data-v4-timeline-scroll") === "true") return node;
  for (const child of node.childNodes) {
    if (child.nodeType !== 1) continue;
    const match = findScrollContainer(child);
    if (match) return match;
  }
  return null;
}

function flushScheduledMicrotasks(): void {
  while (scheduledMicrotasks.length > 0) {
    scheduledMicrotasks.shift()?.();
  }
}

function userInputRow(rowId: number): UserInputRow {
  return {
    rowId,
    turnId: `turn-${rowId}`,
    createdAt: 1_700_000_000_000 + rowId,
    createdAtSeq: rowId,
    kind: "userInput",
    origin: "realUser",
    text: `message ${rowId}`,
    attachments: [],
  };
}

const rowContext: ConversationRowRenderContext = {
  codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
  sessionId: "session-1",
  theme: "system",
  workspacePath: "/workspace",
};

const dockLifecycle = vi.hoisted(() => ({ mounts: 0, unmounts: 0 }));

function BottomDockProbe() {
  useEffect(() => {
    dockLifecycle.mounts += 1;
    return () => {
      dockLifecycle.unmounts += 1;
    };
  }, []);
  return createElement("div", { "data-testid": "bottom-dock-probe" });
}

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

describe("ConversationTimeline presentation suspension (Wave A)", () => {
  it("隐藏期间流式 rows 更新不再重建 render units / plugin 派生，恢复时恰好重建一次并落到最新 rows", () => {
    const container = installMinimalDom();
    const root = createRoot(container);
    mountedRoot = root;
    const visibleRows = [userInputRow(1), userInputRow(2), userInputRow(3)];

    act(() => {
      renderTimeline(root, visibleRows, { presentationVisible: true });
    });
    // Wave C 起计数口径：缓存 build（整个 memo 重算）+ 逐轮物化 + plugin 派生。
    const cacheBuildsAfterVisible = counters.cacheBuilds;
    const materializedAfterVisible = counters.materializeUnits;
    const pluginAfterVisible = counters.derivePluginInstances;
    expect(cacheBuildsAfterVisible).toBeGreaterThanOrEqual(1);
    expect(materializedAfterVisible).toBeGreaterThanOrEqual(1);
    expect(pluginAfterVisible).toBeGreaterThanOrEqual(1);

    // 隐藏后推送 24 次 token 形状的 rows 更新（每次都是新的数组身份）。
    let rows = visibleRows;
    act(() => {
      renderTimeline(root, rows, { presentationVisible: false });
    });
    for (let token = 0; token < 24; token += 1) {
      rows = [...rows, userInputRow(10 + token)];
      act(() => {
        renderTimeline(root, rows, { presentationVisible: false });
      });
    }
    expect(counters.cacheBuilds).toBe(cacheBuildsAfterVisible);
    expect(counters.materializeUnits).toBe(materializedAfterVisible);
    expect(counters.derivePluginInstances).toBe(pluginAfterVisible);

    const scrollContainerAfterHide = findScrollContainer(container.childNodes[0] as TestElement);
    expect(scrollContainerAfterHide?.getAttribute("data-v4-timeline-presentation-visible")).toBe(
      "false",
    );
    // 冻结窗口停留在隐藏前的 3 行。
    expect(scrollContainerAfterHide?.getAttribute("data-window-row-count")).toBe("3");

    // 恢复展示：同一 commit 重建一次，直接展示隐藏期间累计的最新窗口。
    act(() => {
      renderTimeline(root, rows, { presentationVisible: true });
    });
    expect(counters.cacheBuilds).toBe(cacheBuildsAfterVisible + 1);
    expect(counters.derivePluginInstances).toBe(pluginAfterVisible + 1);
    const scrollContainerAfterReveal = findScrollContainer(container.childNodes[0] as TestElement);
    expect(scrollContainerAfterReveal?.getAttribute("data-v4-timeline-presentation-visible")).toBe(
      "true",
    );
    expect(scrollContainerAfterReveal?.getAttribute("data-window-row-count")).toBe(
      String(rows.length),
    );
  });

  it("bottomDock 跨隐藏/恢复保持同一挂载实例（不得靠卸载 composer 实现挂起）", () => {
    const container = installMinimalDom();
    const root = createRoot(container);
    mountedRoot = root;
    const dock = createElement(BottomDockProbe);
    const rows = [userInputRow(1), userInputRow(2)];

    act(() => {
      renderTimeline(root, rows, { presentationVisible: true, bottomDock: dock });
    });
    act(() => {
      renderTimeline(root, rows, { presentationVisible: false, bottomDock: dock });
    });
    act(() => {
      renderTimeline(root, [...rows, userInputRow(3)], {
        presentationVisible: false,
        bottomDock: dock,
      });
    });
    act(() => {
      renderTimeline(root, [...rows, userInputRow(3)], {
        presentationVisible: true,
        bottomDock: dock,
      });
    });
    expect(dockLifecycle.mounts).toBe(1);
    expect(dockLifecycle.unmounts).toBe(0);
  });

  it("运行轮展示时钟在隐藏时停摆，恢复展示时重新起表", () => {
    liveTailOverride.impl = (result) => {
      const last = result.virtualizedUnits[result.virtualizedUnits.length - 1];
      return {
        virtualizedUnits: result.virtualizedUnits.slice(0, -1),
        liveUnit: { ...last, isRunning: true },
        liveUnitIndex: result.virtualizedUnits.length - 1,
      };
    };
    const container = installMinimalDom();
    const root = createRoot(container);
    mountedRoot = root;
    const rows = [userInputRow(1), userInputRow(2)];

    act(() => {
      renderTimeline(root, rows, { presentationVisible: true });
    });
    const armedWhileVisible = counters.intervalArmed;
    expect(armedWhileVisible).toBeGreaterThanOrEqual(1);

    act(() => {
      renderTimeline(root, rows, { presentationVisible: false });
    });
    const armedAfterHide = counters.intervalArmed;
    // 隐藏后推送 token 更新：时钟不得重新起表。
    act(() => {
      renderTimeline(root, [...rows, userInputRow(3)], { presentationVisible: false });
    });
    expect(counters.intervalArmed).toBe(armedAfterHide);

    act(() => {
      renderTimeline(root, [...rows, userInputRow(3)], { presentationVisible: true });
    });
    expect(counters.intervalArmed).toBeGreaterThan(armedAfterHide);
  });

  it("纯展示驱动的目录补拉在隐藏期间不再发起（stale 强制 idle 重试的对照路径）", async () => {
    const hydrationCalls = vi.fn(async () => ({ status: "stale" }));
    const container = installMinimalDom();
    const root = createRoot(container);
    mountedRoot = root;
    const rows = [userInputRow(1), userInputRow(2)];

    await act(async () => {
      renderTimeline(root, rows, {
        presentationVisible: true,
        canLoadOlder: true,
        onLoadAllOlder: hydrationCalls,
      });
      flushScheduledMicrotasks();
    });
    expect(hydrationCalls.mock.calls.length).toBeGreaterThanOrEqual(1);

    act(() => {
      renderTimeline(root, rows, {
        presentationVisible: false,
        canLoadOlder: true,
        onLoadAllOlder: hydrationCalls,
      });
    });
    const callsAfterHide = hydrationCalls.mock.calls.length;
    // 隐藏期间 rows 持续变化（未设 gate 时 stale→idle 会在每次 effect 重跑时再次发起）。
    for (let token = 0; token < 6; token += 1) {
      act(() => {
        renderTimeline(root, [...rows, userInputRow(10 + token)], {
          presentationVisible: false,
          canLoadOlder: true,
          onLoadAllOlder: hydrationCalls,
        });
      });
    }
    expect(hydrationCalls.mock.calls.length).toBe(callsAfterHide);
  });
});
