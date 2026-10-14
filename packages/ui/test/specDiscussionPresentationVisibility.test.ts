// 复核 #2 发现 2：讨论可见性结构化判定回归。
// - 纯谓词矩阵：宿主可见 × 讨论区展开 × 激活线程（放置方式绝不与激活身份 OR）。
// - SpecDiscussionPane 实渲染矩阵：两个保留线程（其一为未发送草稿），
//   只有激活线程可成为 presented / 进入可见期原生准备；覆盖切线程、返回
//   （讨论区收起）、宿主文档隐藏。

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpecThread } from "@/spec-document/specThread.js";
import { isSpecDiscussionThreadPresented } from "@/spec-document/specDiscussionPresentationVisibility.js";
import { SpecDiscussionPane } from "@/spec-document/SpecDiscussionPane.js";

const paneCapture = vi.hoisted(() => ({
  byPaneId: new Map<string, Record<string, unknown>>(),
}));
const discussionHookCapture = vi.hoisted(() => ({
  visibleByThread: new Map<string, boolean>(),
}));

vi.mock("@/v4/SessionPane.js", () => ({
  SessionPane: (props: Record<string, unknown>) => {
    paneCapture.byPaneId.set(String(props.paneId), props);
    return createElement("div", null);
  },
}));
vi.mock("@/v4/V4ConversationContext.js", () => ({
  V4PaneConversationProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => ({}),
  useOptionalServices: () => null,
}));
vi.mock("@/spec-document/nativeDiscussionHandoff.js", () => ({
  claimNativeDiscussionOwner: () => true,
  subscribeNativeDiscussionOwner: () => () => {},
  readNativeDiscussionOwner: () => null,
  nativeDiscussionHandoffSession: () => "native-1",
  activateNativeDiscussionOwner: vi.fn(),
  activateManagedNativeDiscussionOwner: vi.fn(),
  useManagedNativeDiscussionOwner: () => null,
  releaseNativeDiscussionOwner: vi.fn(),
  transferNativeDiscussionDraft: vi.fn(),
}));
vi.mock("@/spec-document/useSpecDiscussion.js", () => ({
  useSpecDiscussion: (
    _thread: SpecThread,
    _update: unknown,
    _workspacePath: string,
    _workspaceIdentity: string | undefined,
    _clear: unknown,
    visible: boolean,
  ) => {
    discussionHookCapture.visibleByThread.set(_thread.id, visible);
    return {
      configurationReady: true,
      projection: { status: "live", lastError: null },
      snapshot: null,
      dispatching: false,
      canRemove: true,
      removeBlockedReason: null,
      remove: vi.fn(async () => {}),
      reconcile: vi.fn(async () => {}),
      error: "",
    };
  },
}));

const documentVisibility = { state: "visible" as "visible" | "hidden" };

const documentMock = {
  addEventListener: () => {},
  createElement: (tagName: string): object => {
    const element = {
      addEventListener: () => {},
      appendChild: (child: unknown) => {
        (child as { parentNode?: unknown }).parentNode = element;
        return child;
      },
      childNodes: [] as unknown[],
      nodeType: 1,
      nodeName: tagName.toUpperCase(),
      ownerDocument: null as unknown,
      parentNode: null as unknown,
      removeAttribute: () => {},
      removeChild: (child: unknown) => child,
      removeEventListener: () => {},
      setAttribute: () => {},
      style: {},
      tagName: tagName.toUpperCase(),
    };
    element.ownerDocument = documentMock;
    return element;
  },
  createElementNS: (_namespace: string, tagName: string) => documentMock.createElement(tagName),
  createTextNode: (nodeValue: string) => ({ nodeType: 3, nodeValue }),
  nodeType: 9,
  activeElement: null,
  removeEventListener: () => {},
  get visibilityState() {
    return documentVisibility.state;
  },
} as unknown as Document;

const windowMock = {
  addEventListener: () => {},
  document: documentMock,
  Element: function Element() {},
  HTMLElement: function HTMLElement() {},
  HTMLIFrameElement: function HTMLIFrameElement() {},
  Node: function Node() {},
  removeEventListener: () => {},
};

const mountedRoots: Root[] = [];

function installMinimalDom() {
  Object.defineProperty(globalThis, "document", { configurable: true, value: documentMock });
  Object.defineProperty(globalThis, "window", { configurable: true, value: windowMock });
  Object.assign(globalThis, {
    Element: windowMock.Element,
    HTMLElement: windowMock.HTMLElement,
    HTMLIFrameElement: windowMock.HTMLIFrameElement,
    Node: windowMock.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  return documentMock.createElement("div") as unknown as import("react-dom").Container;
}

function thread(id: string, options: { unsentDraft?: boolean } = {}): SpecThread {
  return {
    id,
    documentPath: "/workspace/doc.md",
    parentSessionId: "session-root",
    sessionId: "native-1",
    anchor: { quote: `q-${id}`, prefix: "pre", suffix: "suf", start: 10, sha256: "hash" },
    ...(options.unsentDraft ? { questionDraft: "尚未发送的草稿" } : {}),
  };
}

function renderPane(root: Root, props: { thread: SpecThread; visible: boolean }) {
  act(() => {
    root.render(
      createElement(SpecDiscussionPane, {
        thread: props.thread,
        update: () => {},
        updateQuestionDraft: () => {},
        workspacePath: "/workspace",
        anchorCurrent: true,
        visible: props.visible,
      }),
    );
  });
}

beforeEach(() => {
  paneCapture.byPaneId.clear();
  discussionHookCapture.visibleByThread.clear();
  documentVisibility.state = "visible";
});

afterEach(() => {
  for (const root of mountedRoots.splice(0)) {
    act(() => root.unmount());
  }
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { Element?: unknown }).Element;
  delete (globalThis as { HTMLElement?: unknown }).HTMLElement;
  delete (globalThis as { HTMLIFrameElement?: unknown }).HTMLIFrameElement;
  delete (globalThis as { Node?: unknown }).Node;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT;
});

describe("spec discussion presentation visibility (review finding 2)", () => {
  it("纯谓词矩阵：宿主/讨论区/激活线程的合取；激活身份不与放置方式 OR", () => {
    expect(
      isSpecDiscussionThreadPresented({
        hostVisible: true,
        discussionsVisible: true,
        isActiveThread: true,
      }),
    ).toBe(true);
    // 宿主可见（例如 popout 文档在前台）但线程非激活：不展示。
    expect(
      isSpecDiscussionThreadPresented({
        hostVisible: true,
        discussionsVisible: true,
        isActiveThread: false,
      }),
    ).toBe(false);
    expect(
      isSpecDiscussionThreadPresented({
        hostVisible: false,
        discussionsVisible: true,
        isActiveThread: true,
      }),
    ).toBe(false);
    expect(
      isSpecDiscussionThreadPresented({
        hostVisible: true,
        discussionsVisible: false,
        isActiveThread: true,
      }),
    ).toBe(false);
  });

  it("两个保留线程（其一未发送草稿）：只有激活线程 presented / 进入可见期原生准备", () => {
    const active = thread("thread-active");
    const draft = thread("thread-draft", { unsentDraft: true });
    const root = createRoot(installMinimalDom());
    mountedRoots.push(root);

    // 激活线程：宿主判定 visible=true（inline 面板可见 + 讨论区展开 + 激活）。
    renderPane(root, { thread: active, visible: true });
    expect(
      paneCapture.byPaneId.get("spec-discussion:thread-active")?.presentationVisible as boolean,
    ).toBe(true);
    expect(discussionHookCapture.visibleByThread.get("thread-active")).toBe(true);

    // 同一文档里保留的未发送草稿线程（宿主对其判 visible=false）：不展示、不准备。
    renderPane(root, { thread: draft, visible: false });
    expect(
      paneCapture.byPaneId.get("spec-discussion:thread-draft")?.presentationVisible as boolean,
    ).toBe(false);
    expect(discussionHookCapture.visibleByThread.get("thread-draft")).toBe(false);

    // 切换线程：草稿成为激活线程 → presented；原激活线程回到保留态 → 冻结。
    renderPane(root, { thread: draft, visible: true });
    expect(
      paneCapture.byPaneId.get("spec-discussion:thread-draft")?.presentationVisible as boolean,
    ).toBe(true);
    renderPane(root, { thread: active, visible: false });
    expect(
      paneCapture.byPaneId.get("spec-discussion:thread-active")?.presentationVisible as boolean,
    ).toBe(false);

    // 返回（讨论区收起 / 文档 tab 切走）：激活线程也冻结。
    renderPane(root, { thread: active, visible: false });
    expect(
      paneCapture.byPaneId.get("spec-discussion:thread-active")?.presentationVisible as boolean,
    ).toBe(false);

    // 宿主文档隐藏（popout 最小化 / 文档 visibilityState=hidden）：即便宿主侧
    // visible=true 也不展示（owner-document 折叠）。
    documentVisibility.state = "hidden";
    renderPane(root, { thread: active, visible: true });
    expect(
      paneCapture.byPaneId.get("spec-discussion:thread-active")?.presentationVisible as boolean,
    ).toBe(false);
    expect(discussionHookCapture.visibleByThread.get("thread-active")).toBe(false);

    documentVisibility.state = "visible";
    renderPane(root, { thread: active, visible: true });
    expect(
      paneCapture.byPaneId.get("spec-discussion:thread-active")?.presentationVisible as boolean,
    ).toBe(true);
  });
});
