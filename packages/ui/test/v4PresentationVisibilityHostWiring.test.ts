// 渲染性能 Wave A：presentation visibility 的宿主接线回归。
//
// 覆盖 prompt §5 列出的隐藏来源到 SessionPane.presentationVisible 的传递：
// - force-mounted 侧栏会话宿主（subagent / 划词辅助对话 / workflow actor）：focused 即展示可见性；
// - Markdown 讨论宿主（SpecDiscussionPane）：visible 即展示可见性；
// - 分屏 workbench：所有可见叶子（包括非 focused 叶子）在 shell 前台时都保持展示，
//   shell 整体隐藏（Settings 覆盖/文档居中折叠 → foregroundEnabled=false）时全部冻结。
//
// SessionPane 以捕获 props 的替身渲染；链路本身（shell props → 面积 → 叶子 → pane）是真实组件。

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import type { SpecThread } from "@/spec-document/specThread.js";
import { SubagentSessionSidePane } from "@/app-shell/SubagentSessionSidePane.js";
import { SelectionSideChatPane } from "@/app-shell/SelectionSideChatPane.js";
import { WorkflowActorSessionSidePane } from "@/app-shell/WorkflowActorSessionSidePane.js";
import { SpecDiscussionPane } from "@/spec-document/SpecDiscussionPane.js";
import { V4WorkspaceChatArea } from "@/v4/V4WorkspaceChatArea.js";
import { usePaneLayoutStore, V4_PRIMARY_PANE_ID } from "@/v4/paneLayoutStore.js";

const paneCapture = vi.hoisted(() => ({
  byPaneId: new Map<string, Record<string, unknown>>(),
}));

vi.mock("@/v4/SessionPane.js", () => ({
  SessionPane: (props: Record<string, unknown>) => {
    paneCapture.byPaneId.set(String(props.paneId), props);
    return createElement("div", null);
  },
}));

vi.mock("@/v4/V4ConversationContext.js", () => ({
  V4PaneConversationProvider: ({ children }: { children: unknown }) => children,
  useV4Conversation: () => ({
    layer: { acquire: () => ({ sessionId: "actor-1", release: vi.fn() }) },
    sendCommand: vi.fn(),
  }),
}));

vi.mock("@/v4/useConversationProjection.js", () => ({
  useConversationProjection: () => ({
    snapshot: { workflowRuns: { runs: [] } },
  }),
}));

// WorkflowActor 门：让嵌套 SessionPane 直接进入 started 分支。
vi.mock("@/app-shell/workflowRunPanel.js", () => ({
  workflowActorStartState: () => ({ state: "started", sessionId: "actor-1" }),
}));

vi.mock("@/v4/WorkbenchSplitDivider.js", () => ({
  WorkbenchSplitDivider: () => null,
}));

vi.mock("@/v4/workbenchPointerDragDrop.js", () => ({
  registerWorkbenchPointerDropTarget: () => () => {},
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
  useSpecDiscussion: () => ({
    configurationReady: true,
    projection: { status: "live", lastError: null },
    snapshot: null,
    dispatching: false,
    canRemove: true,
    removeBlockedReason: null,
    remove: vi.fn(async () => {}),
    reconcile: vi.fn(async () => {}),
    error: "",
  }),
}));

interface MinimalElement {
  addEventListener: () => void;
  appendChild: (child: MinimalElement) => MinimalElement;
  childNodes: MinimalElement[];
  insertBefore: (child: MinimalElement, beforeChild?: MinimalElement | null) => MinimalElement;
  nodeName: string;
  nodeType: number;
  ownerDocument: unknown;
  parentNode: MinimalElement | null;
  removeAttribute: () => void;
  removeChild: (child: MinimalElement) => MinimalElement;
  removeEventListener: () => void;
  setAttribute: () => void;
  style: Record<string, unknown>;
  tagName: string;
}

// createElement 返回的元素必须指回自身 document：react-dom 创建 text 节点时读取 ownerDocument。
const documentMock = {
  addEventListener: () => {},
  createElement: (tagName: string): MinimalElement => {
    const element: MinimalElement = {
      addEventListener: () => {},
      appendChild: (child) => {
        child.parentNode = element;
        element.childNodes.push(child);
        return child;
      },
      childNodes: [],
      insertBefore: (child, beforeChild) => {
        child.parentNode = element;
        const index = beforeChild ? element.childNodes.indexOf(beforeChild) : -1;
        if (index >= 0) element.childNodes.splice(index, 0, child);
        else element.childNodes.push(child);
        return child;
      },
      nodeName: tagName.toUpperCase(),
      nodeType: 1,
      ownerDocument: null,
      parentNode: null,
      removeChild: (child) => {
        element.childNodes = element.childNodes.filter((item) => item !== child);
        child.parentNode = null;
        return child;
      },
      removeEventListener: () => {},
      removeAttribute: () => {},
      setAttribute: () => {},
      style: {
        removeProperty: () => {},
        setProperty: () => {},
      },
      tagName: tagName.toUpperCase(),
    };
    element.ownerDocument = documentMock;
    return element;
  },
  createTextNode: (nodeValue: string) => ({ nodeType: 3, nodeValue }),
  createElementNS: (_namespace: string, tagName: string) => documentMock.createElement(tagName),
  nodeType: 9,
  activeElement: null,
  removeEventListener: () => {},
};

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
    Element: function Element() {},
    HTMLElement: windowMock.HTMLElement,
    Node: windowMock.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  return documentMock.createElement("div") as unknown as import("react-dom").Container;
}

beforeEach(() => {
  paneCapture.byPaneId.clear();
  usePaneLayoutStore.getState().resetToPrimaryPane();
});

afterEach(() => {
  for (const root of mountedRoots.splice(0)) {
    act(() => root.unmount());
  }
  usePaneLayoutStore.getState().resetToPrimaryPane();
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { Element?: unknown }).Element;
  delete (globalThis as { HTMLElement?: unknown }).HTMLElement;
  delete (globalThis as { Node?: unknown }).Node;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT;
});

function subagentTab() {
  return {
    id: "tab-subagent-1",
    type: "subagent-session" as const,
    workspacePath: "/workspace",
    rootSessionId: "session-root",
    childSessionId: "session-child",
    title: "child",
    createdAt: 1,
  };
}

function selectionTab() {
  return {
    id: "tab-selection-1",
    type: "selection-side-chat" as const,
    workspacePath: "/workspace",
    parentSessionId: "session-root",
    childSessionId: "session-child",
    title: "side chat",
    createdAt: 1,
  };
}

function actorTab() {
  return {
    id: "tab-actor-1",
    type: "workflow-actor-session" as const,
    workspacePath: "/workspace",
    parentSessionId: "session-root",
    runId: "run-1",
    siteId: "site-1",
    ordinal: 1,
    actorSessionId: "actor-1",
    title: "actor",
    createdAt: 1,
  };
}

function discussionThread(): SpecThread {
  return {
    id: "thread-1",
    documentPath: "/workspace/doc.md",
    parentSessionId: "session-root",
    sessionId: "native-1",
    anchor: { quote: "quoted", prefix: "pre", suffix: "suf", start: 10, sha256: "hash" },
  };
}

function captured(paneId: string): Record<string, unknown> | undefined {
  return paneCapture.byPaneId.get(paneId);
}

describe("presentation visibility host wiring (Wave A)", () => {
  it.each([
    [
      "subagent 会话宿主",
      (focused: boolean) => createElement(SubagentSessionSidePane, { tab: subagentTab(), focused }),
    ],
    [
      "划词辅助对话宿主",
      (focused: boolean) =>
        createElement(SelectionSideChatPane, {
          tab: selectionTab(),
          focused,
          onUnavailable: () => {},
        }),
    ],
    [
      "workflow actor 会话宿主",
      (focused: boolean) =>
        createElement(WorkflowActorSessionSidePane, { tab: actorTab(), focused }),
    ],
    [
      "Markdown 讨论宿主",
      (visible: boolean) =>
        createElement(SpecDiscussionPane, {
          thread: discussionThread(),
          update: () => {},
          updateQuestionDraft: () => {},
          workspacePath: "/workspace",
          anchorCurrent: true,
          visible,
        }),
    ],
  ])("隐藏来源 %s：focused/visible=false 冻结展示，=true 恢复展示", (_label, renderHost) => {
    const root = createRoot(installMinimalDom());
    mountedRoots.push(root);
    act(() => {
      root.render(renderHost(false));
    });
    const paneId = [...paneCapture.byPaneId.keys()][0];
    expect(paneId).toBeDefined();
    expect(captured(paneId)?.presentationVisible).toBe(false);

    act(() => {
      root.render(renderHost(true));
    });
    expect(captured(paneId)?.presentationVisible).toBe(true);
  });

  it("分屏 workbench：非 focused 的可见叶子保持展示；shell 整体隐藏时全部冻结", () => {
    // 建立两个可见叶子：primary + 右侧 split。
    act(() => {
      usePaneLayoutStore
        .getState()
        .splitPane(V4_PRIMARY_PANE_ID, "row", { workspacePath: "/workspace" });
    });
    const root = createRoot(installMinimalDom());
    mountedRoots.push(root);
    const renderArea = (foregroundEnabled: boolean) =>
      act(() => {
        // 上游 3.16.2 的 WorkbenchLeafPane 调用 useZCodeIntl；workbench 链路需要 Provider。
        root.render(
          createElement(
            ZCodeIntlProvider,
            { initialLocale: "zh-CN" },
            createElement(V4WorkspaceChatArea, {
              workspacePath: "/workspace",
              sessionId: "session-1",
              foregroundEnabled,
              interactionDialogsVisible: foregroundEnabled,
              keepSpecExecutionSource: !foregroundEnabled,
            }),
          ),
        );
      });

    renderArea(true);
    const secondaryPaneId = Object.keys(usePaneLayoutStore.getState().panes)[0];
    expect(secondaryPaneId).toBeDefined();
    // splitPane 把焦点交给新叶子：primary 非 focused 但可见 → 展示保持（focus ≠ visibility）。
    expect(captured(secondaryPaneId)?.focused).toBe(true);
    expect(captured(V4_PRIMARY_PANE_ID)?.focused).toBe(false);
    expect(captured(V4_PRIMARY_PANE_ID)?.presentationVisible).toBe(true);
    expect(captured(secondaryPaneId)?.presentationVisible).toBe(true);

    // 切焦点回 primary：secondary 变为非 focused 但仍可见 → 展示保持。
    act(() => {
      usePaneLayoutStore.getState().focusPane(V4_PRIMARY_PANE_ID);
    });
    expect(captured(V4_PRIMARY_PANE_ID)?.focused).toBe(true);
    expect(captured(secondaryPaneId)?.focused).toBe(false);
    expect(captured(secondaryPaneId)?.presentationVisible).toBe(true);

    // shell 整体隐藏（Settings 覆盖 / 文档居中折叠主聊天）：两个叶子一起冻结展示。
    renderArea(false);
    expect(captured(V4_PRIMARY_PANE_ID)?.presentationVisible).toBe(false);
    expect(captured(secondaryPaneId)?.presentationVisible).toBe(false);
  });
});
