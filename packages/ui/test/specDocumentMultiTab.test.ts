// @vitest-environment jsdom
/**
 * U-12 聚焦套件：«+» 文档 tab 多开。
 *
 * 分层：
 * 1. 状态层（真实纯函数）：«+» 两次 = 两张 tab；绑定不同文件（标题=文件名、
 *    稳定 sourceKey）；同文件消息链接复用既有 tab（含反斜杠路径）；关闭一张
 *    保留其它；重复绑定幂等；durable 记忆往返（重启恢复多张文档 tab）。
 * 2. 面板层（真实 SpecDocumentPane ×2，模拟两张 tab 同时挂载）：各自选择不同
 *    文件互不重置；onDocumentOpen 按实例回传相对路径；autoOpenLastDocument=false
 *    的新选择器 tab 不自动恢复上一次文档（保持 Open doc 初始态）。
 */
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  attachSpecDocumentSidePaneTab,
  buildSpecDocumentPickerSource,
  closeSidePaneTab,
  openCodeViewerSidePane,
  type CodeViewerSidePaneTab,
  type WorkspaceSidePaneState,
} from "@/lib/workspaceSidePane.js";
import {
  clearTaskSidePaneMemoryStateForTest,
  readTaskSidePaneMemoryState,
  saveTaskSidePaneMemoryState,
} from "@/lib/taskSidePaneMemory.js";
import type { FileCodeViewerSource } from "@/lib/codeViewer.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { SpecDocumentPane } from "@/spec-document/SpecDocumentPane.js";
import {
  MANAGED_NATIVE_DISCUSSION_OPEN_EVENT,
  specThreadStorageKey,
} from "@/spec-document/nativeDiscussionHandoff.js";
import {
  defaultDocumentPresentation,
  documentPresentationKey,
  readDocumentPresentation,
  writeDocumentPresentation,
} from "@/spec-document/specDocumentPresentationState.js";

const WORKSPACE_PATH = "D:\\ws";

/** «+» 点击（与 AnimatedSidePanePanel.openSpecDocument 同一 source 构造）。 */
function clickOpenDocPlus(current: WorkspaceSidePaneState | null): WorkspaceSidePaneState {
  return openCodeViewerSidePane(
    current,
    buildSpecDocumentPickerSource({ workspacePath: WORKSPACE_PATH }),
  );
}

/** 消息文件链接（与 handleOpenMarkdownFileLink 同一 source 形状）。 */
function fileLinkSource(path: string): FileCodeViewerSource {
  return {
    type: "file",
    title: path.replaceAll("\\", "/").split("/").at(-1) ?? path,
    path,
    workspacePath: WORKSPACE_PATH,
  };
}

function viewerTabs(state: WorkspaceSidePaneState | null): CodeViewerSidePaneTab[] {
  return (state?.tabs ?? []).filter(
    (tab): tab is CodeViewerSidePaneTab => tab.type === "code-viewer",
  );
}

describe("U-12 multi-tab document state (workspaceSidePane)", () => {
  beforeEach(() => {
    localStorage.clear();
    clearTaskSidePaneMemoryStateForTest();
  });

  it("«+» дважды = две вкладки: 每次点击新开一张选择器 tab（标题 Open doc）", () => {
    const first = clickOpenDocPlus(null);
    const second = clickOpenDocPlus(first);

    expect(second).not.toBeNull();
    const tabs = viewerTabs(second);
    expect(tabs).toHaveLength(2);
    // 两张 tab 身份独立（未绑定文档前 sourceKey 为 null，不参与去重）。
    expect(tabs[0]!.id).not.toBe(tabs[1]!.id);
    expect(tabs.map((tab) => tab.sourceKey)).toEqual([null, null]);
    // 第二次点击激活新 tab；标题（tab strip 取 source.title）都是 Open doc。
    expect(second.activeTabId).toBe(tabs[1]!.id);
    expect(tabs.map((tab) => tab.source.title)).toEqual(["Open doc", "Open doc"]);
  });

  it("绑定不同文件：标题=文件名、sourceKey 稳定且互不相同", () => {
    const twoTabs = clickOpenDocPlus(clickOpenDocPlus(null))!;
    const withA = attachSpecDocumentSidePaneTab(twoTabs, twoTabs.tabs[0]!.id, "docs/a.md");
    const withB = attachSpecDocumentSidePaneTab(withA, withA.tabs[1]!.id, "docs/b.md");

    const tabs = viewerTabs(withB);
    expect(tabs.map((tab) => tab.source.title)).toEqual(["a.md", "b.md"]);
    expect(tabs[0]!.sourceKey).not.toBe(tabs[1]!.sourceKey);
    // 绑定路径是 workspace 根下的绝对路径（正斜杠 POSIX 形）。
    expect(tabs[0]!.source.path).toBe("D:/ws/docs/a.md");
    expect(tabs[0]!.source.specDocument).toBe(true);
    // 重复绑定同一文件幂等：原样返回（不产生新 state 引用）。
    expect(attachSpecDocumentSidePaneTab(withB, withB.tabs[0]!.id, "docs/a.md")).toBe(withB);
  });

  it("ссылка на уже открытый файл фокусирует существующую（含反斜杠路径）", () => {
    const twoTabs = clickOpenDocPlus(clickOpenDocPlus(null))!;
    const withA = attachSpecDocumentSidePaneTab(twoTabs, twoTabs.tabs[0]!.id, "docs/a.md");
    const withB = attachSpecDocumentSidePaneTab(withA, withA.tabs[1]!.id, "docs/b.md");
    const tabA = withB.tabs[0] as CodeViewerSidePaneTab;
    // 当前激活在 tabB（第二次 + 点击）：链接 a.md 必须把 tabA 抢回激活。
    expect(withB.activeTabId).toBe(withB.tabs[1]!.id);

    // 消息链接用反斜杠绝对路径（与面板绑定的正斜杠形不同字符串）。
    const afterLink = openCodeViewerSidePane(withB, fileLinkSource("D:\\ws\\docs\\a.md"));

    // 不重复开 tab：仍两张，且激活的是绑定 a.md 的那张。
    expect(viewerTabs(afterLink)).toHaveLength(2);
    expect(afterLink.activeTabId).toBe(tabA.id);
    // 复用时保留文档 tab 标记（可持久化恢复），标题刷新为文件名。
    const linked = viewerTabs(afterLink).find((tab) => tab.id === tabA.id)!;
    expect(linked.source.specDocument).toBe(true);
    expect(linked.source.title).toBe("a.md");

    // 另一文件的链接聚焦另一张 tab（不同文件互不抢占）。
    const afterLinkB = openCodeViewerSidePane(afterLink, fileLinkSource("D:/ws/docs/b.md"));
    expect(afterLinkB.activeTabId).toBe(afterLinkB.tabs[1]!.id);
    expect(viewerTabs(afterLinkB)).toHaveLength(2);
  });

  it("закрытие одной вкладки закрывает только её", () => {
    const twoTabs = clickOpenDocPlus(clickOpenDocPlus(null))!;
    const withA = attachSpecDocumentSidePaneTab(twoTabs, twoTabs.tabs[0]!.id, "docs/a.md");
    const withB = attachSpecDocumentSidePaneTab(withA, withA.tabs[1]!.id, "docs/b.md");
    const tabA = withB.tabs[0] as CodeViewerSidePaneTab;
    const tabB = withB.tabs[1] as CodeViewerSidePaneTab;
    expect(withB.activeTabId).toBe(tabB.id);

    // 关闭当前激活的 tabB：只剩 tabA，且激活回退到它。
    const closed = closeSidePaneTab(withB, tabB.id);
    expect(closed).not.toBeNull();
    expect(closed!.tabs).toHaveLength(1);
    expect((closed!.tabs[0] as CodeViewerSidePaneTab).id).toBe(tabA.id);
    expect((closed!.tabs[0] as CodeViewerSidePaneTab).source.title).toBe("a.md");
    expect((closed!.tabs[0] as CodeViewerSidePaneTab).source.path).toBe("D:/ws/docs/a.md");
    expect(closed!.activeTabId).toBe(tabA.id);

    // 再关另一张：状态归空（面板回到 Open tab 启动页）。
    expect(closeSidePaneTab(closed, tabA.id)).toBeNull();
  });

  it("重启恢复：durable 记忆保存并恢复多张文档 tab（含各自绑定文件）", () => {
    const twoTabs = clickOpenDocPlus(clickOpenDocPlus(null))!;
    const withA = attachSpecDocumentSidePaneTab(twoTabs, twoTabs.tabs[0]!.id, "docs/a.md");
    const withB = attachSpecDocumentSidePaneTab(withA, withA.tabs[1]!.id, "docs/b.md");

    const memoryKey = "multi-tab-ws";
    saveTaskSidePaneMemoryState(memoryKey, { sidePaneState: withB, isSidePaneCollapsed: false });
    // 模拟重启：清空模块级缓存，仅从 localStorage 恢复。
    clearTaskSidePaneMemoryStateForTest();
    const restored = readTaskSidePaneMemoryState(memoryKey);

    const tabs = viewerTabs(restored.sidePaneState);
    expect(tabs).toHaveLength(2);
    expect(tabs.map((tab) => tab.source.title)).toEqual(["a.md", "b.md"]);
    expect(tabs.map((tab) => tab.source.path)).toEqual(["D:/ws/docs/a.md", "D:/ws/docs/b.md"]);
    expect(restored.isSidePaneCollapsed).toBe(false);
  });
});

// ============================================================================
// 面板层：两张文档 tab 同时挂载（TabsContent forceMount 语义）
// ============================================================================

const conversationMocks = vi.hoisted(() => {
  // layer 必须是稳定引用（useSpecWriteGuard 的 effect 依赖 [layer, ids]）。
  const layer = {
    acquire: (id: string) => ({
      sessionId: id,
      store: {
        subscribe: () => () => {},
        getState: () => ({
          status: "idle",
          snapshot: undefined,
          optimisticCommands: [],
        }),
      },
      release: () => {},
    }),
  };
  return { layer };
});
vi.mock("@/PreviewPane.js", () => ({ PreviewPane: () => null }));
vi.mock("@/v4/V4ConversationContext.js", () => ({
  V4PaneConversationProvider: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  useV4Conversation: () => ({
    layer: conversationMocks.layer,
    sendCommand: async () => {
      throw new Error("no native uplink in this test");
    },
  }),
}));

const DOC_FILES = ["docs/a.md", "docs/b.md"];
function specDocumentsService() {
  return {
    getWorkspace: async () => ({ root: "D:\\ws", writable: false }),
    list: async () => DOC_FILES,
    read: async ({ path }: { path: string }) => ({
      path,
      content: `content of ${path}`,
      sha256: `sha-${path}`,
    }),
    save: async () => {
      throw new Error("read-only in this test");
    },
  };
}
const fileWatcherStub = {
  watch: async () => ({ id: "watch-1" }),
  unwatch: async () => {},
  onDynamicChange: () => () => {},
};

function renderDocumentPaneInto(
  container: HTMLElement,
  options: {
    instanceKey: string;
    onDocumentOpen?: (path: string) => void;
    autoOpenLastDocument?: boolean;
  },
) {
  render(
    createElement(ServiceProvider, {
      services: {
        specDocumentService: specDocumentsService(),
        fileWatcherService: fileWatcherStub,
      } as unknown as Parameters<typeof ServiceProvider>[0]["services"],
      children: createElement(SpecDocumentPane, {
        workspacePath: WORKSPACE_PATH,
        parentSessionId: null,
        onClose: () => {},
        instanceKey: options.instanceKey,
        ...(options.autoOpenLastDocument === undefined
          ? {}
          : { autoOpenLastDocument: options.autoOpenLastDocument }),
        ...(options.onDocumentOpen ? { onDocumentOpen: options.onDocumentOpen } : {}),
      }),
    }),
    { container },
  );
}

async function openDocumentFromPicker(container: HTMLElement, relativePath: string) {
  await waitFor(() =>
    expect(
      (within(container).getByLabelText("Choose project document") as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  fireEvent.click(within(container).getByLabelText("Choose project document"));
  const filter = within(container).getByLabelText("Filter documents");
  fireEvent.change(filter, { target: { value: relativePath } });
  fireEvent.keyDown(filter, { key: "Enter" });
}

describe("U-12 multi-tab document panes (SpecDocumentPane instances)", () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    globalThis.ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  });

  it("选择不同文件：各 tab 独立、互不重置，onDocumentOpen 按实例回传", async () => {
    const opened: { tabId: string; path: string }[] = [];
    const containerA = document.createElement("div");
    const containerB = document.createElement("div");
    document.body.append(containerA, containerB);
    try {
      renderDocumentPaneInto(containerA, {
        instanceKey: "tab-a",
        autoOpenLastDocument: false,
        onDocumentOpen: (path) => opened.push({ tabId: "tab-a", path }),
      });
      renderDocumentPaneInto(containerB, {
        instanceKey: "tab-b",
        autoOpenLastDocument: false,
        onDocumentOpen: (path) => opened.push({ tabId: "tab-b", path }),
      });

      await openDocumentFromPicker(containerA, "docs/a.md");
      await openDocumentFromPicker(containerB, "docs/b.md");

      await waitFor(() => expect(opened).toHaveLength(2));
      expect(opened).toEqual([
        { tabId: "tab-a", path: "docs/a.md" },
        { tabId: "tab-b", path: "docs/b.md" },
      ]);
      // 两个实例各自停在各自选择的文档上（互不重置）。
      const projectViewKey = documentPresentationKey(WORKSPACE_PATH);
      await waitFor(() => {
        expect(
          readDocumentPresentation(`${projectViewKey}:pane:${JSON.stringify([null, "tab-a"])}`)
            .path,
        ).toBe("docs/a.md");
        expect(
          readDocumentPresentation(`${projectViewKey}:pane:${JSON.stringify([null, "tab-b"])}`)
            .path,
        ).toBe("docs/b.md");
      });
      const triggerA = within(containerA).getByLabelText("Choose project document");
      const triggerB = within(containerB).getByLabelText("Choose project document");
      expect(triggerA.textContent).toContain("a.md");
      expect(triggerB.textContent).toContain("b.md");

      // 讨论恢复广播只选中目标文件，不能把其它文档 tab 也切成同一文件。
      const thread = {
        id: "recover-a",
        documentPath: "docs/a.md",
        parentSessionId: "parent",
        sessionId: "child-a",
        anchor: {
          start: 0,
          quote: "content",
          prefix: "",
          suffix: "",
          sha256: "sha-docs/a.md",
        },
      };
      const key = specThreadStorageKey(WORKSPACE_PATH, undefined);
      localStorage.setItem(key, JSON.stringify([thread]));
      fireEvent(
        window,
        new StorageEvent("storage", {
          key,
          newValue: JSON.stringify([thread]),
        }),
      );
      fireEvent(
        window,
        new CustomEvent(MANAGED_NATIVE_DISCUSSION_OPEN_EVENT, {
          detail: {
            workspacePath: WORKSPACE_PATH,
            documentPath: "docs/a.md",
            threadId: thread.id,
          },
        }),
      );
      await waitFor(() =>
        expect(within(containerA).getByLabelText("Fragment discussion")).toBeTruthy(),
      );
      expect(triggerB.textContent).toContain("b.md");
      expect(opened.filter((item) => item.tabId === "tab-b").map((item) => item.path)).toEqual([
        "docs/b.md",
      ]);
      expect(triggerA.textContent).not.toContain("b.md");
      expect(triggerB.textContent).not.toContain("a.md");

      expect(triggerA.textContent).not.toContain("b.md");
      expect(triggerB.textContent).not.toContain("a.md");
    } finally {
      containerA.remove();
      containerB.remove();
    }
  });

  it("新 «+» tab 不自动恢复上一次文档：保持选择器初始态（标题 Open doc）", async () => {
    // 预置持久化的“上一次文档”——多开的新 tab 不得自动打开它。
    writeDocumentPresentation(documentPresentationKey(WORKSPACE_PATH, undefined), {
      ...defaultDocumentPresentation(),
      path: "docs/old.md",
    });
    const onDocumentOpen = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    try {
      renderDocumentPaneInto(container, {
        instanceKey: "fresh-plus-tab",
        autoOpenLastDocument: false,
        onDocumentOpen,
      });
      await waitFor(() =>
        expect(
          (within(container).getByLabelText("Choose project document") as HTMLButtonElement)
            .disabled,
        ).toBe(false),
      );
      // 未选文档：无 alert、无文档打开回调；等待微任务排空后仍保持初始态。
      await Promise.resolve();
      expect(onDocumentOpen).not.toHaveBeenCalled();
      expect(within(container).queryByRole("alert")).toBeNull();
      expect(within(container).getByLabelText("Choose project document").title).toBe(
        "Choose a document…",
      );
      expect(
        within(container).getByText(/Choose a project document above to preview/i),
      ).toBeTruthy();
    } finally {
      container.remove();
    }
  });

  it("绑定了 initialPath 的 tab 挂载即恢复该文件并回填 tab 身份", async () => {
    const onDocumentOpen = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    try {
      render(
        createElement(ServiceProvider, {
          services: {
            specDocumentService: specDocumentsService(),
            fileWatcherService: fileWatcherStub,
          } as unknown as Parameters<typeof ServiceProvider>[0]["services"],
          children: createElement(SpecDocumentPane, {
            workspacePath: WORKSPACE_PATH,
            parentSessionId: null,
            onClose: () => {},
            instanceKey: "restored-tab",
            autoOpenLastDocument: false,
            initialPath: "D:/ws/docs/b.md",
            onDocumentOpen,
          }),
        }),
        { container },
      );
      await waitFor(() => expect(onDocumentOpen).toHaveBeenCalledWith("docs/b.md"));
      expect(within(container).getByLabelText("Choose project document").textContent).toContain(
        "b.md",
      );
    } finally {
      container.remove();
    }
  });
});
