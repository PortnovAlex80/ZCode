// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement, useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import type { GroupImperativeHandle } from "react-resizable-panels";
import { Group, Panel, Separator } from "react-resizable-panels";
import { describe, expect, it, vi } from "vitest";
import {
  applySpecShellLayoutSwapOrders,
  SPEC_SHELL_DOCUMENT_CENTER_CONVERSATION_DEFAULT_SIZE,
  SPEC_SHELL_DOCUMENT_CENTER_CONVERSATION_MIN_SIZE,
  SPEC_SHELL_DOCUMENT_CENTER_SIDE_PANE_DEFAULT_SIZE,
  SPEC_SHELL_DOCUMENT_CENTER_SIDE_PANE_MAX_SIZE,
  readSpecShellLayoutSwap,
  resolveSpecShellBodyPanelIds,
  specShellBodyLayoutId,
  specShellLayoutSwapKey,
  toggleSpecShellLayoutSwapMode,
  writeSpecShellLayoutSwap,
} from "@/spec-document/specShellLayoutSwap.js";
import { resolveAnimatedSidePanePanelLayout } from "@/app-shell/animatedSidePanePanelModel.js";

function readSource(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

class FakeStorage {
  private readonly map = new Map<string, string>();
  getItem(key: string) {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  setItem(key: string, value: string) {
    this.map.set(key, String(value));
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
}

describe("specShellLayoutSwap persistence helper (U-01)", () => {
  it("defaults to chat-center and round-trips the document-center mode per workspace identity", () => {
    const storage = new FakeStorage();
    const keyA = specShellLayoutSwapKey("D:\\work\\project-a", "identity-a");
    const keyB = specShellLayoutSwapKey("D:\\work\\project-b");

    expect(readSpecShellLayoutSwap(keyA, storage)).toBe("chat-center");
    expect(writeSpecShellLayoutSwap(keyA, "document-center", storage)).toBe(true);
    expect(readSpecShellLayoutSwap(keyA, storage)).toBe("document-center");
    // 不同的 workspace identity 互不串扰。
    expect(readSpecShellLayoutSwap(keyB, storage)).toBe("chat-center");

    expect(toggleSpecShellLayoutSwapMode("chat-center")).toBe("document-center");
    expect(toggleSpecShellLayoutSwapMode("document-center")).toBe("chat-center");
  });

  it("ignores corrupted storage instead of guessing a mode", () => {
    const storage = new FakeStorage();
    const key = specShellLayoutSwapKey("/repo");
    storage.setItem(key, "{not json");
    expect(readSpecShellLayoutSwap(key, storage)).toBe("chat-center");
    storage.setItem(key, JSON.stringify({ version: 2, mode: "document-center" }));
    expect(readSpecShellLayoutSwap(key, storage)).toBe("chat-center");
    storage.setItem(key, JSON.stringify({ version: 1, mode: "unexpected" }));
    expect(readSpecShellLayoutSwap(key, storage)).toBe("chat-center");
  });

  it("prefers workspace identity over the raw path in the storage key", () => {
    expect(specShellLayoutSwapKey("D:\\a\\b", "proj-1")).toBe(
      "spec-harness-shell-layout-swap:v1:proj-1",
    );
    expect(specShellLayoutSwapKey("D:\\a\\b\\", undefined)).toBe(
      "spec-harness-shell-layout-swap:v1:D:/a/b",
    );
    expect(specShellLayoutSwapKey("D:\\a\\b", "  ")).toBe(
      "spec-harness-shell-layout-swap:v1:D:/a/b",
    );
  });

  it("keeps a separate layout namespace and panel id order per arrangement", () => {
    // RRP 的布局存储键按面板出现顺序拼接：交换排列必须同步翻转 panelIds。
    expect(specShellBodyLayoutId("workspace-body-layout", false)).toBe("workspace-body-layout");
    expect(specShellBodyLayoutId("workspace-body-layout", true)).toBe(
      "workspace-body-layout:document-center",
    );
    expect(resolveSpecShellBodyPanelIds(false, ["conversation-column", "browser"])).toEqual([
      "conversation-column",
      "browser",
    ]);
    expect(resolveSpecShellBodyPanelIds(true, ["conversation-column", "browser"])).toEqual([
      "browser",
      "conversation-column",
    ]);
  });
});

describe("AnimatedSidePanePanel document-center layout model (U-01)", () => {
  it("lets the document take most of the work area in the swapped arrangement", () => {
    expect(
      resolveAnimatedSidePanePanelLayout({
        documentCenter: true,
        mobileOverlay: false,
      }),
    ).toMatchObject({
      collapsedSize: "0px",
      defaultSize: SPEC_SHELL_DOCUMENT_CENTER_SIDE_PANE_DEFAULT_SIZE,
      maxSize: SPEC_SHELL_DOCUMENT_CENTER_SIDE_PANE_MAX_SIZE,
      minSize: "240px",
      useResizablePanel: true,
    });
    expect(Number.parseFloat(SPEC_SHELL_DOCUMENT_CENTER_SIDE_PANE_DEFAULT_SIZE)).toBeGreaterThan(
      50,
    );
  });

  it("keeps the ordinary desktop side pane arrangement unchanged", () => {
    expect(
      resolveAnimatedSidePanePanelLayout({
        documentCenter: false,
        mobileOverlay: false,
      }),
    ).toMatchObject({
      collapsedSize: "0px",
      defaultSize: "0px",
      maxSize: "65%",
      minSize: "240px",
      useResizablePanel: true,
    });
    expect(resolveAnimatedSidePanePanelLayout({ mobileOverlay: false })).toMatchObject({
      defaultSize: "0px",
      maxSize: "65%",
    });
  });

  it("keeps the mobile overlay drawer outside the resizable arrangement", () => {
    expect(
      resolveAnimatedSidePanePanelLayout({
        documentCenter: true,
        mobileOverlay: true,
      }),
    ).toMatchObject({ defaultSize: "100%", useResizablePanel: false });
  });
});

describe("WorkspaceShellLayout source contract for the swap (U-01)", () => {
  const layoutSource = readSource("packages/ui/src/app-shell/WorkspaceShellLayout.tsx");
  const sidePaneSource = readSource("packages/ui/src/app-shell/AnimatedSidePanePanel.tsx");

  it("persists the mode per workspace identity through the dedicated helper", () => {
    expect(layoutSource).toContain("specShellLayoutSwapKey(workspaceAbsPath, workspaceIdentity)");
    expect(layoutSource).toContain("readSpecShellLayoutSwap(");
    expect(layoutSource).toContain("writeSpecShellLayoutSwap(shellLayoutSwapStorageKey, nextMode)");
    expect(layoutSource).toContain("toggleSpecShellLayoutSwapMode(");
  });

  it("uses a mode-scoped layoutId and a panel id order that follows the visual arrangement", () => {
    expect(layoutSource).toContain("specShellBodyLayoutId(");
    // 固定模块级常量避免 streaming 渲染重建 panelIds 数组（性能注释约束）。
    expect(layoutSource).toContain("WORKSPACE_BODY_PANEL_IDS_DOCUMENT_CENTER");
    expect(layoutSource).toMatch(
      /isDocumentCenterLayout\s*\?\s*WORKSPACE_BODY_PANEL_IDS_DOCUMENT_CENTER\s*:\s*WORKSPACE_BODY_PANEL_IDS/u,
    );
  });

  it("keeps DOM/React tree order stable and swaps visual placement via flex order", () => {
    // DOM 顺序稳定 ⇒ chat/timeline 不重挂载、<webview> guest 不被移动；
    // 视觉换位由 order 完成，分隔条始终位于文档与聊天之间（chat=1 / handle=2 / tabs=3）。
    // RRP Panel 的 style prop 只作用于内层 div，外层 flex item 的 order 由
    // elementRef 挂载写入 + 宿主渲染期 applySpecShellLayoutSwapOrders 同步。
    expect(sidePaneSource).toContain('element.style.order = documentCenter ? "1" : "3"');
    expect(sidePaneSource).toContain("style={{ order: 2 }}");
    expect(layoutSource).toContain('element.style.order = isDocumentCenterLayout ? "3" : "1"');
    expect(layoutSource).toMatch(
      /applySpecShellLayoutSwapOrders\(\s*conversationColumnOuterElementRef\.current,\s*sidePanePanelElementRef\.current,/u,
    );
  });

  it("flips the conversation panel constraints so the mode change re-registers RRP panels", () => {
    // 约束变化触发面板重注册，库按 offsetLeft（含 flex order）重排，拖拽/键盘跟随实际位置。
    expect(layoutSource).toContain("SPEC_SHELL_DOCUMENT_CENTER_CONVERSATION_MIN_SIZE");
    expect(layoutSource).toContain("SPEC_SHELL_DOCUMENT_CENTER_CONVERSATION_DEFAULT_SIZE");
    expect(layoutSource).toContain("SPEC_SHELL_DOCUMENT_CENTER_SIDE_PANE_DEFAULT_SIZE");
  });

  it("exposes the current arrangement on the conversation frame for tests and a11y tooling", () => {
    expect(layoutSource).toMatch(
      /data-spec-shell-layout=\{\s*isDocumentCenterLayout\s*\?\s*"document-center"\s*:\s*"chat-center"\s*\}/u,
    );
    expect(layoutSource).toMatch(
      /data-spec-shell-layout-side=\{\s*isDocumentCenterLayout \? "right" : "center"\s*\}/u,
    );
  });

  it("routes Windows/Linux inline window controls to whichever caption is actually top-right", () => {
    // 普通排列：tabs 容器 caption 承载窗控；交换排列：聊天列 Header 承载；
    // «Развернуть документ» 隐藏聊天后 tabs 容器铺满，caption 重新承载。
    expect(layoutSource).toMatch(
      /sidePaneCaptionCarriesWindowControls =\s*!isDocumentCenterLayout \|\| generalChatCollapsed/u,
    );
    expect(layoutSource).toMatch(
      /isSidePaneOpen=\{\s*isSidePaneOpen &&\s*sidePaneCaptionCarriesWindowControls\s*\}/u,
    );
    expect(layoutSource).toMatch(
      /showWindowControls=\{\s*!options\.mobileOverlay &&\s*usesInlineWindowControls &&\s*sidePaneCaptionCarriesWindowControls\s*\}/u,
    );
  });

  it("offers an accessible icon toggle with the requested tooltips", () => {
    expect(sidePaneSource).toContain('data-spec-shell-layout-swap-toggle=""');
    expect(sidePaneSource).toContain("aria-pressed={documentCenter}");
    expect(sidePaneSource).toContain(
      'aria-label={documentCenter ? "Чат в центре" : "Документ в центре"}',
    );
    expect(sidePaneSource).toContain(
      'title={documentCenter ? "Чат в центре" : "Документ в центре"}',
    );
  });

  it("points the show-main-chat control toward the side the chat actually occupies", () => {
    expect(sidePaneSource).toContain(
      "const ShowChatIcon = documentCenter ? PanelRightOpen : PanelLeftOpen;",
    );
  });

  it("keeps the document-expand flow meaning: «Развернуть документ» hides the chat on the chosen side", () => {
    // 既有折叠语义未改动：仍以 generalChatCollapsed 折叠 conversation-column，
    // 交换排列下聊天在右侧被隐藏，文档铺满；«Вернуть чат» 原路恢复。
    expect(layoutSource).toContain("collapsible={generalChatCollapsed}");
    expect(sidePaneSource).toContain("generalChatCollapsed && onToggleGeneralChat");
  });
});

/**
 * 机制验证（真实 react-resizable-panels + jsdom）：DOM/组件顺序不变，仅切换 flex order
 * 与面板约束（min/default/max）。键盘方向必须跟随实际视觉排列 —— 这要求库在约束变化
 * 重注册后按 offsetLeft 重排面板（order 由宿主在渲染期写入，先于重注册 effect 生效，
 * 与 WorkspaceShellLayout 的 applySpecShellLayoutSwapOrders 同构）。jsdom 不做布局，
 * 这里用 order 桩化 offsetLeft/offsetWidth（与浏览器中 flex order 反映到 offsetLeft 的
 * 语义一致）。
 */
describe("react-resizable-panels follows the swapped placement (U-01 mechanism)", () => {
  function installLayoutGeometryStub() {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetLeft");
    const widthDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
    expect(descriptor).toBeTruthy();
    Object.defineProperty(HTMLElement.prototype, "offsetLeft", {
      configurable: true,
      get(this: HTMLElement) {
        const order = Number.parseFloat(this.style.order);
        return Number.isFinite(order) ? order * 1000 : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
      configurable: true,
      get: () => 1000,
    });
    return () => {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, "offsetLeft", descriptor);
      if (widthDescriptor)
        Object.defineProperty(HTMLElement.prototype, "offsetWidth", widthDescriptor);
    };
  }

  function SwappableBody({
    documentCenter,
    groupRef,
    onChatMountChange,
    chatDraftRef,
  }: {
    documentCenter: boolean;
    groupRef: { current: GroupImperativeHandle | null };
    onChatMountChange: (delta: 1 | -1) => void;
    chatDraftRef: { current: HTMLInputElement | null };
  }) {
    const conversationElementRef = useRef<HTMLDivElement | null>(null);
    const sidePaneElementRef = useRef<HTMLDivElement | null>(null);
    const [draft, setDraft] = useState("unsaved-draft");
    useEffect(() => {
      onChatMountChange(1);
      return () => onChatMountChange(-1);
    }, [onChatMountChange]);
    const handleConversationElementRef = useCallbackRef((element: HTMLDivElement | null) => {
      conversationElementRef.current = element;
      if (element) element.style.order = documentCenter ? "3" : "1";
    }, documentCenter);
    const handleSidePaneElementRef = useCallbackRef((element: HTMLDivElement | null) => {
      sidePaneElementRef.current = element;
      if (element) element.style.order = documentCenter ? "1" : "3";
    }, documentCenter);
    // 渲染期同步 order（与产品实现一致：必须先于 RRP 面板重注册读取 offsetLeft 生效）。
    applySpecShellLayoutSwapOrders(
      conversationElementRef.current,
      sidePaneElementRef.current,
      documentCenter,
    );
    // 与产品实现同构：约束随排列切换（触发重注册 → 库按 offsetLeft 重排面板）。
    return createElement(
      Group,
      { groupRef },
      createElement(
        Panel,
        {
          id: "conversation-column",
          defaultSize: documentCenter
            ? SPEC_SHELL_DOCUMENT_CENTER_CONVERSATION_DEFAULT_SIZE
            : "60%",
          minSize: documentCenter ? SPEC_SHELL_DOCUMENT_CENTER_CONVERSATION_MIN_SIZE : "35%",
          elementRef: handleConversationElementRef,
        },
        createElement("input", {
          "data-testid": "chat-draft",
          ref: (element: HTMLInputElement | null) => {
            chatDraftRef.current = element;
          },
          value: draft,
          onChange: (event: { target: { value: string } }) => setDraft(event.target.value),
        }),
      ),
      createElement(Separator, { style: { order: 2 } }),
      createElement(Panel, {
        id: "browser",
        defaultSize: documentCenter ? SPEC_SHELL_DOCUMENT_CENTER_SIDE_PANE_DEFAULT_SIZE : "40%",
        minSize: "10%",
        maxSize: documentCenter ? SPEC_SHELL_DOCUMENT_CENTER_SIDE_PANE_MAX_SIZE : "65%",
        elementRef: handleSidePaneElementRef,
      }),
    );
  }

  function useCallbackRef(
    apply: (element: HTMLDivElement | null) => void,
    mode: boolean,
  ): (element: HTMLDivElement | null) => void {
    const applyRef = useRef(apply);
    applyRef.current = apply;
    const stable = useRef((element: HTMLDivElement | null) => {
      applyRef.current(element);
    }).current;
    void mode;
    return stable;
  }

  it("keeps the chat mounted with its draft and follows the visual arrangement in both modes", () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    const restoreGeometry = installLayoutGeometryStub();
    const container = document.createElement("div");
    document.body.appendChild(container);
    let chatMounted = 0;
    const groupRef: { current: GroupImperativeHandle | null } = {
      current: null,
    };
    const chatDraftRef: { current: HTMLInputElement | null } = {
      current: null,
    };
    const onChatMountChange = (delta: 1 | -1) => {
      chatMounted += delta;
    };
    let root: Root | null = null;

    try {
      act(() => {
        root = createRoot(container);
        root.render(
          createElement(SwappableBody, {
            documentCenter: false,
            groupRef,
            onChatMountChange,
            chatDraftRef,
          }),
        );
      });
      expect(chatMounted).toBe(1);
      const draftInput = chatDraftRef.current;
      expect(draftInput).toBeTruthy();
      const separator = container.querySelector("[data-separator]") as HTMLElement;
      expect(separator).toBeTruthy();
      const groupElement = container.querySelector("[data-group]") as HTMLElement;
      expect(groupElement).toBeTruthy();

      const layoutNormalBefore = groupRef.current?.getLayout();
      act(() => {
        separator.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      });
      const layoutNormalAfter = groupRef.current?.getLayout() ?? {};
      // 普通排列：chat 在左、doc 在右；ArrowRight 右移分隔条 ⇒ chat 变宽、doc 变窄。
      expect(layoutNormalAfter["conversation-column"]).toBeGreaterThan(
        layoutNormalBefore?.["conversation-column"] ?? 0,
      );
      expect(layoutNormalAfter["browser"]).toBeLessThan(layoutNormalBefore?.["browser"] ?? 100);

      // 切换到 «Документ в центре»：仅 order 与约束变化，无卸载/重挂载。
      act(() => {
        root?.render(
          createElement(SwappableBody, {
            documentCenter: true,
            groupRef,
            onChatMountChange,
            chatDraftRef,
          }),
        );
      });
      expect(chatMounted).toBe(1);
      expect(chatDraftRef.current).toBe(draftInput);
      expect(draftInput?.value).toBe("unsaved-draft");
      expect(draftInput?.isConnected).toBe(true);
      // 交换排列初始默认：文档占大头（62%）。
      const layoutSwappedInitial = groupRef.current?.getLayout() ?? {};
      expect(layoutSwappedInitial["browser"]).toBeGreaterThan(55);

      const layoutSwappedBefore = groupRef.current?.getLayout();
      act(() => {
        separator.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      });
      const layoutSwappedAfter = groupRef.current?.getLayout() ?? {};
      // 交换排列：doc 在左、chat 在右；ArrowRight 仍右移分隔条 ⇒ doc 变宽、chat 变窄。
      expect(layoutSwappedAfter["browser"]).toBeGreaterThan(layoutSwappedBefore?.["browser"] ?? 0);
      expect(layoutSwappedAfter["conversation-column"]).toBeLessThan(
        layoutSwappedBefore?.["conversation-column"] ?? 100,
      );

      // 切回普通排列：方向语义恢复（ArrowLeft 左移分隔条 ⇒ chat 变窄）。
      act(() => {
        root?.render(
          createElement(SwappableBody, {
            documentCenter: false,
            groupRef,
            onChatMountChange,
            chatDraftRef,
          }),
        );
      });
      expect(chatMounted).toBe(1);
      expect(draftInput?.value).toBe("unsaved-draft");
      const layoutRestoredBefore = groupRef.current?.getLayout();
      act(() => {
        separator.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
      });
      const layoutRestoredAfter = groupRef.current?.getLayout() ?? {};
      expect(layoutRestoredAfter["conversation-column"]).toBeLessThan(
        layoutRestoredBefore?.["conversation-column"] ?? 100,
      );
      expect(layoutRestoredAfter["browser"]).toBeGreaterThan(
        layoutRestoredBefore?.["browser"] ?? 0,
      );
    } finally {
      act(() => {
        root?.unmount();
      });
      container.remove();
      restoreGeometry();
      vi.unstubAllGlobals();
    }
  });
});
