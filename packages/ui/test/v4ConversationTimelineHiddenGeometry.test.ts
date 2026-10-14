// 复核 #2 发现 6：隐藏几何与 reveal 覆盖。
// - 隐藏期间宽度/高度 ResizeObserver 回调（同步测高 + flushSync + 吸底批处理）挂起；
// - 隐藏流式不再做几何对账读取；
// - 手动阅读锚点在隐藏 resize + reveal 后保持；跟随态在 reveal 重测后恢复吸底；
// - hide → Highspeed 到期 → reveal（rows/options 完全相同）：render-unit memo 通过
//   revealResolvesExpiry 依赖在 reveal 边界用新鲜时钟重建，footer 落位；无全历史定时器。
//
// 器具：极简 DOM + fake ResizeObserver + 几何读/写计数器；virtualizer 仍为 mock，
// 但 measureElement/resizeItem 计数用于断言「同步测量路径」是否执行。

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationRow, UserInputRow } from "@zcode/shared/zcode-protocol-v4";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";
import { ConversationTimeline } from "@/v4/ConversationTimeline.js";

const geometry = {
  clientHeightReads: 0,
  clientWidthReads: 0,
  scrollHeightReads: 0,
  scrollTopReads: 0,
  scrollTopWrites: 0,
  rectReads: 0,
};

const measurement = {
  measureElementCalls: 0,
  resizeItemCalls: 0,
};

const cacheCapture = vi.hoisted(() => ({
  lastOutput: null as readonly { turnId: string; showHighspeedOutputFooter?: true }[] | null,
}));

const virtualizer = vi.hoisted(() => ({
  getVirtualItemForOffset: vi.fn(),
  getTotalSize: () => 1200,
  getVirtualItems: () => [] as [],
  measurementsCache: [] as unknown[],
  measure: vi.fn(),
  measureElement: vi.fn(() => {
    measurement.measureElementCalls += 1;
    return 40;
  }),
  resizeItem: vi.fn(() => {
    measurement.resizeItemCalls += 1;
  }),
  scrollOffset: null as number | null,
  scrollRect: null as { height: number } | null,
  scrollToIndex: vi.fn(),
  shouldAdjustScrollPositionOnItemSizeChange: null as unknown,
}));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: () => virtualizer,
}));

vi.mock("@/v4/ConversationTurnGroup.js", async () => {
  const React = await import("react");
  return { ConversationTurnGroup: () => React.createElement("div") };
});
vi.mock("@/v4/ConversationTurnNavigator.js", () => ({
  ConversationTurnNavigator: () => null,
}));
vi.mock("@/v4/useConversationTimelineFind.js", () => ({
  useConversationTimelineFind: () => undefined,
}));
vi.mock("@/v4/conversationTurnRenderUnitsCache.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/v4/conversationTurnRenderUnitsCache.js")>();
  return {
    createCachedConversationTurnRenderUnitsBuilder: () => {
      const inner = actual.createCachedConversationTurnRenderUnitsBuilder();
      return {
        build: (...args: Parameters<typeof inner.build>) => {
          const output = inner.build(...args);
          cacheCapture.lastOutput = output;
          return output;
        },
        stats: inner.stats,
        resetForTest: inner.resetForTest,
      };
    },
  };
});

interface FakeObserver {
  callback: ResizeObserverCallback;
  elements: Set<object>;
}
const resizeObserverState = {
  instances: [] as FakeObserver[],
};

class FakeResizeObserver {
  callback: ResizeObserverCallback;
  elements = new Set<object>();
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    resizeObserverState.instances.push(this);
  }
  observe(element: object) {
    this.elements.add(element);
  }
  unobserve(element: object) {
    this.elements.delete(element);
  }
  disconnect() {
    this.elements.clear();
  }
}

type TestEventHandler = (event: Record<string, unknown>) => void;
type TestElement = Element & {
  __attrs: Map<string, string>;
  __listeners: Map<string, TestEventHandler[]>;
  childNodes: TestElement[];
  parentNode: TestElement | null;
};

const layout = { clientHeight: 300, scrollHeight: 1200, width: 1024 };
const scheduledMicrotasks: Array<() => void> = [];
const animationFrames = new Map<number, FrameRequestCallback>();
let nextFrameId = 1;
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
    getBoundingClientRect: () => {
      geometry.rectReads += 1;
      return {
        bottom: layout.clientHeight,
        height: layout.clientHeight,
        left: 0,
        right: layout.width,
        top: 0,
        width: layout.width,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      };
    },
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
    clientHeight: { get: () => ((geometry.clientHeightReads += 1), layout.clientHeight) },
    clientWidth: { get: () => ((geometry.clientWidthReads += 1), layout.width) },
    scrollHeight: { get: () => ((geometry.scrollHeightReads += 1), layout.scrollHeight) },
    scrollTop: {
      get: () => ((geometry.scrollTopReads += 1), scrollTop),
      set: (value: number) => {
        geometry.scrollTopWrites += 1;
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
  } as unknown as Document;
  const windowMock = {
    addEventListener: () => {},
    cancelAnimationFrame: (frameId: number) => animationFrames.delete(frameId),
    clearInterval: () => {},
    clearTimeout: () => {},
    document: documentMock,
    HTMLElement: function HTMLElement() {},
    HTMLIFrameElement: function HTMLIFrameElement() {},
    Node: function Node() {},
    queueMicrotask: (callback: () => void) => scheduledMicrotasks.push(callback),
    removeEventListener: () => {},
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      const frameId = nextFrameId;
      nextFrameId += 1;
      animationFrames.set(frameId, callback);
      return frameId;
    },
    setInterval: () => 1,
    setTimeout: () => 1,
  };
  documentMock.defaultView = windowMock;
  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    Node: windowMock.Node,
    ResizeObserver: FakeResizeObserver,
    document: documentMock,
    HTMLElement: windowMock.HTMLElement,
    HTMLIFrameElement: windowMock.HTMLIFrameElement,
    queueMicrotask: windowMock.queueMicrotask,
    window: windowMock,
  });
  return createMinimalElement(documentMock, "div");
}

function fireResize(element: object) {
  for (const observer of resizeObserverState.instances) {
    if (!observer.elements.has(element)) continue;
    act(() => {
      observer.callback([], observer as unknown as ResizeObserver);
    });
  }
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

function findVirtualHistory(node: TestElement): TestElement | null {
  if (node.getAttribute("data-v4-timeline-virtual-history") === "true") return node;
  for (const child of node.childNodes) {
    if (child.nodeType !== 1) continue;
    const match = findVirtualHistory(child);
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

function renderTimeline(
  root: Root,
  rows: readonly ConversationRow[],
  options: { presentationVisible?: boolean } = {},
) {
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
      }),
    ),
  );
}

beforeEach(() => {
  geometry.clientHeightReads = 0;
  geometry.clientWidthReads = 0;
  geometry.scrollHeightReads = 0;
  geometry.scrollTopReads = 0;
  geometry.scrollTopWrites = 0;
  geometry.rectReads = 0;
  measurement.measureElementCalls = 0;
  measurement.resizeItemCalls = 0;
  cacheCapture.lastOutput = null;
  resizeObserverState.instances = [];
  layout.clientHeight = 300;
  layout.scrollHeight = 1200;
  layout.width = 1024;
  nextFrameId = 1;
  animationFrames.clear();
  scheduledMicrotasks.length = 0;
  mountedRoot = null;
});

afterEach(() => {
  act(() => {
    flushScheduledMicrotasks();
    mountedRoot?.unmount();
    flushScheduledMicrotasks();
  });
  mountedRoot = null;
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT;
  delete (globalThis as { HTMLElement?: unknown }).HTMLElement;
  delete (globalThis as { HTMLIFrameElement?: unknown }).HTMLIFrameElement;
  delete (globalThis as { Node?: unknown }).Node;
  vi.useRealTimers();
});

describe("ConversationTimeline hidden geometry & reveal (review finding 6)", () => {
  it("隐藏期间宽度变化：同步测量/吸底批处理挂起，reveal 补一次重测并恢复吸底", () => {
    const container = installMinimalDom();
    const root = createRoot(container);
    mountedRoot = root;
    const rows = [userInputRow(1), userInputRow(2), userInputRow(3)];
    act(() => {
      renderTimeline(root, rows, { presentationVisible: true });
    });
    const scrollContainer = findScrollContainer(container.childNodes[0] as TestElement)!;
    const virtualHistory = findVirtualHistory(container.childNodes[0] as TestElement)!;
    expect(scrollContainer).toBeDefined();
    expect(virtualHistory).toBeDefined();

    // 隐藏 + 宽度变化（display:none 的 RO 派发）。
    act(() => {
      renderTimeline(root, rows, { presentationVisible: false });
    });
    const widthReadsBeforeHiddenResize = geometry.clientWidthReads;
    const writesBeforeHiddenResize = geometry.scrollTopWrites;
    layout.width = 640;
    fireResize(virtualHistory);
    fireResize(scrollContainer);
    // 同步测量/吸底批处理完全挂起：无几何读、无 scrollTop 写。
    expect(geometry.clientWidthReads).toBe(widthReadsBeforeHiddenResize);
    expect(geometry.scrollTopWrites).toBe(writesBeforeHiddenResize);

    // reveal：登记过的隐藏期几何变化按同一处理函数补测。本 harness 的 virtualizer
    // 被mock为空窗口（无可测行），同步批次的可观测信号是几何读取与跟随吸底写入。
    act(() => {
      renderTimeline(root, rows, { presentationVisible: true });
    });
    expect(geometry.clientWidthReads).toBeGreaterThan(widthReadsBeforeHiddenResize);
    expect(geometry.scrollTopWrites).toBeGreaterThan(writesBeforeHiddenResize);
    // 跟随吸底：reveal 后 scrollTop 到达底部。
    expect(scrollContainer.scrollTop).toBe(900);
  });

  it("手动阅读锚点：隐藏 resize + reveal 不夺回阅读位置", () => {
    vi.useFakeTimers({ now: 1_750_080_000_000 });
    const container = installMinimalDom();
    const root = createRoot(container);
    mountedRoot = root;
    const rows = [userInputRow(1), userInputRow(2), userInputRow(3)];
    act(() => {
      renderTimeline(root, rows, { presentationVisible: true });
    });
    const scrollContainer = findScrollContainer(container.childNodes[0] as TestElement)!;
    const virtualHistory = findVirtualHistory(container.childNodes[0] as TestElement)!;
    // 挂载贴底的 layout scroll guard（250ms）过期后，用户上滚离开底部。
    act(() => {
      vi.advanceTimersByTime(300);
    });
    act(() => {
      scrollContainer.scrollTop = 120;
      scrollContainer.dispatchEvent(new Event("scroll"));
    });
    expect(scrollContainer.scrollTop).toBe(120);

    act(() => {
      renderTimeline(root, rows, { presentationVisible: false });
    });
    layout.width = 700;
    fireResize(virtualHistory);
    act(() => {
      renderTimeline(root, rows, { presentationVisible: true });
    });
    // 阅读锚点保持：reveal 重测不把用户拽回底部。
    expect(scrollContainer.scrollTop).toBe(120);
  });

  it("隐藏流式：不做几何对账读取（clientHeight/scrollHeight/scrollTop 读数零增量）", () => {
    const container = installMinimalDom();
    const root = createRoot(container);
    mountedRoot = root;
    let rows = [userInputRow(1), userInputRow(2), userInputRow(3)];
    act(() => {
      renderTimeline(root, rows, { presentationVisible: false });
    });
    const readsBeforeHiddenStreaming = {
      clientHeight: geometry.clientHeightReads,
      scrollHeight: geometry.scrollHeightReads,
      scrollTop: geometry.scrollTopReads,
      writes: geometry.scrollTopWrites,
    };
    for (let token = 0; token < 6; token += 1) {
      rows = [...rows, userInputRow(10 + token)];
      act(() => {
        renderTimeline(root, rows, { presentationVisible: false });
      });
    }
    expect(geometry.clientHeightReads).toBe(readsBeforeHiddenStreaming.clientHeight);
    expect(geometry.scrollHeightReads).toBe(readsBeforeHiddenStreaming.scrollHeight);
    expect(geometry.scrollTopReads).toBe(readsBeforeHiddenStreaming.scrollTop);
    expect(geometry.scrollTopWrites).toBe(readsBeforeHiddenStreaming.writes);
  });

  it("hide → Highspeed 到期 → reveal（rows/options 完全相同）：reveal 边界用新鲜时钟解析到期 footer", () => {
    vi.useFakeTimers({ now: 1_750_080_000_000 });
    const container = installMinimalDom();
    const root = createRoot(container);
    mountedRoot = root;
    const expiresAt = Date.now() + 1_000;
    const rows: ConversationRow[] = [
      {
        ...userInputRow(1),
        highspeed: {
          schemaVersion: 1,
          cardId: "card-geo-1",
          taskId: "task-1",
          provider: "zai",
          model: "glm-5.3",
          issuedAt: Date.now() - 10_000,
          expiresAt,
          regularTps: 10,
          highspeedTps: 100,
          outputTokens: 1200,
          durationMs: 12_000,
        },
      } as ConversationRow,
      userInputRow(2),
    ];
    act(() => {
      renderTimeline(root, rows, { presentationVisible: true });
    });
    expect(cacheCapture.lastOutput).not.toBeNull();
    expect(cacheCapture.lastOutput!.every((unit) => unit.showHighspeedOutputFooter !== true)).toBe(
      true,
    );

    // 隐藏 → 时间越过到期边界 → rows/options 完全不变地 reveal。
    act(() => {
      renderTimeline(root, rows, { presentationVisible: false });
    });
    vi.setSystemTime(expiresAt + 5_000);
    act(() => {
      renderTimeline(root, rows, { presentationVisible: true });
    });
    const revealed = cacheCapture.lastOutput!;
    expect(revealed.some((unit) => unit.showHighspeedOutputFooter === true)).toBe(true);
  });

  it("无待决 Highspeed 时可见性翻转不触发 render-unit 重建（无害聚焦事件不重建历史）", () => {
    vi.useFakeTimers({ now: 1_750_080_000_000 });
    const container = installMinimalDom();
    const root = createRoot(container);
    mountedRoot = root;
    const rows = [userInputRow(1), userInputRow(2)];
    act(() => {
      renderTimeline(root, rows, { presentationVisible: true });
    });
    const firstOutput = cacheCapture.lastOutput;
    act(() => {
      renderTimeline(root, rows, { presentationVisible: false });
    });
    expect(cacheCapture.lastOutput).toBe(firstOutput);
    act(() => {
      renderTimeline(root, rows, { presentationVisible: true });
    });
    expect(cacheCapture.lastOutput).toBe(firstOutput);
  });
});
