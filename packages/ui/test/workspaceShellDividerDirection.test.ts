// @vitest-environment jsdom
// U-03 回归：文档/聊天分隔条的拖拽与键盘方向（含 5.2a 实机回归）。
//
// 背景（根因）：RRP 面板在重注册（约束变化）时按 offsetLeft 排序，拖拽/键盘的
// pivot 顺序来自该注册顺序。产品此前把 order 的渲染期重申按「排列模式字符串」
// 锁存；窗口 resize 触发自动收起/展开 → collapsible/disabled/defaultSize 翻转 →
// 面板重注册，若此刻 order 被重置（元素重建、模式未变），注册排序回到换位前
// 的顺序，分隔条绑定到换位前的一侧，拖拽方向颠倒。
//
// 5.2a（用户 2026-10-14 实机回归，build 9fe78d6c）：document-center 下中部分隔条
// 仍有输入路径方向颠倒——wave-6 只覆盖了拖拽路径。库内两条输入路径的配对来源
// 不同：pointerdown 每次都用 Je() 从当前 DOM（offsetLeft 排序）现算 hit region；
// 键盘路径用的是注册期缓存的 separatorToPanels + 面板注册表。任何让缓存配对
// 与实际视觉排列脱节的路径都会让键盘方向颠倒而拖拽正常（或反之）。本文件
// 因此对每个检查点同时验证拖拽（双向）与键盘（双向）。
//
// 修复后的不变式：宿主每次渲染都重申 order（applySpecShellLayoutSwapOrders 差量
// 写入），任何重注册读取到的 offsetLeft 必然反映当前排列。本文件三层验证：
// 1) 差量写入语义（值相同不触碰 style）；
// 2) 源码契约：锁存已删除，渲染期无条件重申；
// 3) 真实 react-resizable-panels + 产品级接线（ResizablePanelGroup + localStorage
//    持久化 + rAF 命令式 collapse/resize）下，拖拽与键盘方向在两种排列、容器
//    resize（缩小/放大）、模式切换、收起/重开、聊天隐藏/恢复、以及交换排列
//    持久化后的重载全部跟随实际视觉位置。
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createElement, useCallback, useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import type {
  GroupImperativeHandle,
  PanelImperativeHandle,
} from "react-resizable-panels";
import { Separator } from "react-resizable-panels";
import { describe, expect, it, vi } from "vitest";
import {
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable.js";
import {
  applySpecShellLayoutSwapOrders,
  specShellBodyLayoutId,
  SPEC_SHELL_DOCUMENT_CENTER_CONVERSATION_DEFAULT_SIZE,
  SPEC_SHELL_DOCUMENT_CENTER_CONVERSATION_MIN_SIZE,
  SPEC_SHELL_DOCUMENT_CENTER_SIDE_PANE_DEFAULT_SIZE,
  SPEC_SHELL_DOCUMENT_CENTER_SIDE_PANE_MAX_SIZE,
} from "@/spec-document/specShellLayoutSwap.js";
import {
  transitionSpecGeneralChatLayout,
  type SpecGeneralChatLayoutMemory,
} from "@/spec-document/specGeneralChatCollapse.js";

const SEPARATOR_WIDTH = 4;
const NORMAL_PANEL_IDS = ["conversation-column", "browser"];
const DOCUMENT_CENTER_PANEL_IDS = ["browser", "conversation-column"];
const SIDE_PANE_DEFAULT = "45%";

describe("applySpecShellLayoutSwapOrders write semantics (U-03)", () => {
  it("writes the swapped orders and reports readiness", () => {
    const conversation = document.createElement("div");
    const sidePane = document.createElement("div");
    expect(applySpecShellLayoutSwapOrders(null, sidePane, true)).toBe(false);
    expect(applySpecShellLayoutSwapOrders(conversation, null, false)).toBe(
      false,
    );
    expect(applySpecShellLayoutSwapOrders(conversation, sidePane, true)).toBe(
      true,
    );
    expect(conversation.style.order).toBe("3");
    expect(sidePane.style.order).toBe("1");
    expect(applySpecShellLayoutSwapOrders(conversation, sidePane, false)).toBe(
      true,
    );
    expect(conversation.style.order).toBe("1");
    expect(sidePane.style.order).toBe("3");
  });

  it("re-asserts after the inline order is reset without a mode change (diff-aware)", () => {
    // 窗口 resize 场景的另一半：元素重建/样式清理把 order 抹掉而排列模式未变，
    // 每次渲染的重申必须把它写回——否则 RRP 注册排序回到换位前的顺序。
    const conversation = document.createElement("div");
    const sidePane = document.createElement("div");
    applySpecShellLayoutSwapOrders(conversation, sidePane, true);
    const conversationSetProperty = vi.spyOn(conversation.style, "setProperty");
    // 稳态重申：值相同不得触碰 style（避免每帧样式突变）。
    applySpecShellLayoutSwapOrders(conversation, sidePane, true);
    expect(conversationSetProperty).not.toHaveBeenCalled();
    // order 丢失后重申恢复。
    conversation.style.removeProperty("order");
    sidePane.style.removeProperty("order");
    applySpecShellLayoutSwapOrders(conversation, sidePane, true);
    expect(conversation.style.order).toBe("3");
    expect(sidePane.style.order).toBe("1");
    conversationSetProperty.mockRestore();
  });
});

describe("WorkspaceShellLayout source contract for order re-assertion (U-03)", () => {
  it("re-asserts the swap orders on every render instead of latching on the mode string", async () => {
    const layoutSource = await readFile(
      resolve("packages/ui/src/app-shell/WorkspaceShellLayout.tsx"),
      "utf8",
    );
    // 修复前：shellLayoutSwapOrderStateRef 按模式字符串锁存，resize 触发的重注册
    // 可能读到被重置的 order，面板注册顺序回到换位前的一侧。
    expect(layoutSource).not.toContain("shellLayoutSwapOrderStateRef");
    expect(layoutSource).toMatch(
      /applySpecShellLayoutSwapOrders\(\s*conversationColumnOuterElementRef\.current,\s*sidePanePanelElementRef\.current,\s*isDocumentCenterLayout,\s*\);/u,
    );
  });

  it("keeps the order-writing elementRef callbacks for element (re)attachment", async () => {
    const layoutSource = await readFile(
      resolve("packages/ui/src/app-shell/WorkspaceShellLayout.tsx"),
      "utf8",
    );
    const sidePaneSource = await readFile(
      resolve("packages/ui/src/app-shell/AnimatedSidePanePanel.tsx"),
      "utf8",
    );
    expect(layoutSource).toContain(
      'element.style.order = isDocumentCenterLayout ? "3" : "1"',
    );
    expect(sidePaneSource).toContain(
      'element.style.order = documentCenter ? "1" : "3"',
    );
  });
});

/**
 * 机制验证（真实 react-resizable-panels + 产品级接线）。jsdom 不做布局：
 * - offsetLeft 按 style.order 桩化（与浏览器中 flex order 反映到 offsetLeft 的
 *   语义一致）——RRP 注册期排序因此始终跟随当前 order，这正是修复后产品保证
 *   的不变式（渲染期无条件重申 order，且先于任何重注册 effect）。
 * - getBoundingClientRect/offsetWidth 用按当前布局百分比铺排的 rect 桩承载
 *   pointer 命中测试与 groupSize 换算。
 * - ResizeObserver 可控：测试手动触发 group 元素回调，模拟容器/窗口 resize。
 */
describe("divider drag direction across the shell flow matrix (U-03 mechanism)", () => {
  it("keeps drag AND keyboard direction tied to the visual arrangement in both modes and across resizes", async () => {
    (
      globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    window.localStorage.clear();
    const observers: Array<{
      callback: ResizeObserverCallback;
      targets: Set<Element>;
    }> = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        targets = new Set<Element>();
        constructor(callback: ResizeObserverCallback) {
          observers.push({ callback, targets: this.targets });
        }
        observe(target: Element) {
          this.targets.add(target);
        }
        unobserve() {}
        disconnect() {}
      },
    );
    const geometry = installGeometry();
    const rects = geometry.rects;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const groupRef: { current: GroupImperativeHandle | null } = {
      current: null,
    };
    let root: Root | null = null;
    let groupWidth = 1200;

    const syncRects = () => {
      const group = container.querySelector(
        "[data-group]",
      ) as HTMLElement | null;
      if (!group) return;
      const layout = groupRef.current?.getLayout() ?? {};
      const children = Array.from(group.children).filter(
        (child) =>
          child instanceof HTMLElement &&
          (child.hasAttribute("data-panel") ||
            child.hasAttribute("data-separator")),
      ) as HTMLElement[];
      // 与 offsetLeft 桩一致：按 style.order 铺排视觉位置。
      children.sort((a, b) => {
        const orderA = Number.parseFloat(a.style.order || "0");
        const orderB = Number.parseFloat(b.style.order || "0");
        return orderA - orderB;
      });
      rects.set(group, new DOMRect(0, 0, groupWidth, 600));
      const panels = children.filter((child) =>
        child.hasAttribute("data-panel"),
      );
      const panelWidths = panels.map(
        (child) =>
          (((layout[child.id as keyof typeof layout] as number | undefined) ??
            50) /
            100) *
          (groupWidth - SEPARATOR_WIDTH),
      );
      let panelIndex = 0;
      let x = 0;
      for (const child of children) {
        const width = child.hasAttribute("data-separator")
          ? SEPARATOR_WIDTH
          : Math.max(1, Math.round(panelWidths[panelIndex++] ?? 50));
        rects.set(child, new DOMRect(x, 0, width, 600));
        x += width;
      }
    };

    const fireGroupResize = (inlineSize: number) => {
      const group = container.querySelector("[data-group]") as HTMLElement;
      for (const { callback, targets } of observers) {
        if (targets.has(group)) {
          callback(
            [
              {
                target: group,
                borderBoxSize: [{ inlineSize, blockSize: 600 }],
              } as unknown as ResizeObserverEntry,
            ],
            {} as ResizeObserver,
          );
        }
      }
    };

    const drag = (dx: number) => {
      const separator = container.querySelector(
        "[data-separator]",
      ) as HTMLElement;
      if (!separator) throw new Error("separator missing");
      const rect = rects.get(separator) ?? separator.getBoundingClientRect();
      const startX = rect.x + rect.width / 2;
      for (const [type, clientX, buttons] of [
        ["pointerdown", startX, 1],
        ["pointermove", startX + dx, 1],
        ["pointerup", startX + dx, 0],
      ] as const) {
        act(() => {
          document.dispatchEvent(
            new PointerEvent(type, {
              clientX,
              clientY: 300,
              bubbles: true,
              pointerId: 1,
              button: 0,
              buttons,
              pointerType: "mouse",
            }),
          );
        });
      }
    };

    // 键盘路径：库把 keydown 监听挂在分隔条元素上，Ge→B 用注册期缓存的面板配对。
    const keyboard = (key: string) => {
      const separator = container.querySelector(
        "[data-separator]",
      ) as HTMLElement;
      if (!separator) throw new Error("separator missing");
      act(() => {
        separator.dispatchEvent(
          new KeyboardEvent("keydown", {
            key,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
    };

    const layoutDeltas = (
      before: Record<string, number>,
      after: Record<string, number>,
    ) => ({
      conversationDelta:
        (after["conversation-column"] ?? 0) -
        (before["conversation-column"] ?? 0),
      browserDelta: (after["browser"] ?? 0) - (before["browser"] ?? 0),
    });

    const dragProbe = (dx: number) => {
      syncRects();
      const before = groupRef.current?.getLayout() ?? {};
      drag(dx);
      syncRects();
      return layoutDeltas(before, groupRef.current?.getLayout() ?? {});
    };

    const keyboardProbe = (key: "ArrowRight" | "ArrowLeft") => {
      syncRects();
      const before = groupRef.current?.getLayout() ?? {};
      keyboard(key);
      syncRects();
      return layoutDeltas(before, groupRef.current?.getLayout() ?? {});
    };

    // 回到确定性中位，避免上一个探针把布局顶到 min/max 饱和，掩盖方向判断。
    const resetLayout = (documentCenter: boolean) => {
      act(() => {
        groupRef.current?.setLayout(
          documentCenter
            ? {
                browser: Number.parseFloat(
                  SPEC_SHELL_DOCUMENT_CENTER_SIDE_PANE_DEFAULT_SIZE,
                ),
                "conversation-column": Number.parseFloat(
                  SPEC_SHELL_DOCUMENT_CENTER_CONVERSATION_DEFAULT_SIZE,
                ),
              }
            : { "conversation-column": 52, browser: 48 },
        );
      });
      syncRects();
    };

    /**
     * 5.2a 核心断言：在当前排列下，拖拽（双向）与键盘（双向）都必须让
     * 「视觉上在左的面板」随右移输入变宽、随左移输入变窄。
     * 任一路径颠倒（例如键盘用注册期缓存配对而缓存已过期）即实机回归。
     */
    const expectDirectionFollowsPlacement = (
      documentCenter: boolean,
      label: string,
      options: { reset: boolean } = { reset: true },
    ) => {
      if (options.reset) resetLayout(documentCenter);
      const dragRight = dragProbe(120);
      const dragLeft = dragProbe(-120);
      if (options.reset) resetLayout(documentCenter);
      const keyRight = keyboardProbe("ArrowRight");
      const keyLeft = keyboardProbe("ArrowLeft");
      // 视觉左侧面板：chat-center=聊天列；document-center=tabs 容器（文档）。
      const leftGrowByDrag = documentCenter
        ? dragRight.browserDelta
        : dragRight.conversationDelta;
      const leftGrowByKey = documentCenter
        ? keyRight.browserDelta
        : keyRight.conversationDelta;
      const leftShrinkByDrag = documentCenter
        ? dragLeft.browserDelta
        : dragLeft.conversationDelta;
      const leftShrinkByKey = documentCenter
        ? keyLeft.browserDelta
        : keyLeft.conversationDelta;
      expect(
        leftGrowByDrag,
        `${label}: drag right grows the visually-left panel`,
      ).toBeGreaterThan(0);
      expect(
        leftShrinkByDrag,
        `${label}: drag left shrinks the visually-left panel`,
      ).toBeLessThan(0);
      expect(
        leftGrowByKey,
        `${label}: ArrowRight grows the visually-left panel (keyboard path)`,
      ).toBeGreaterThan(0);
      expect(
        leftShrinkByKey,
        `${label}: ArrowLeft shrinks the visually-left panel (keyboard path)`,
      ).toBeLessThan(0);
    };

    const render = async (
      documentCenter: boolean,
      sidePaneOpen: boolean,
      chatExpanded = true,
    ) => {
      act(() => {
        root?.render(
          createElement(SwappableBody, {
            documentCenter,
            groupRef,
            sidePaneOpen,
            chatExpanded,
          }),
        );
      });
      await act(async () => {
        await flushFrames();
      });
      syncRects();
      fireGroupResize(groupWidth);
      syncRects();
    };

    try {
      act(() => {
        root = createRoot(container);
      });
      // 普通排列：聊天在左。
      await render(false, true);
      expectDirectionFollowsPlacement(false, "chat-center initial");

      // 容器缩小/放大后（普通排列）方向保持。
      groupWidth = 700;
      fireGroupResize(groupWidth);
      syncRects();
      expectDirectionFollowsPlacement(
        false,
        "chat-center after container shrink",
      );
      groupWidth = 1600;
      fireGroupResize(groupWidth);
      syncRects();
      expectDirectionFollowsPlacement(
        false,
        "chat-center after container grow",
      );

      // 切到 «Документ в центре»：文档在左、聊天在右。
      await render(true, true);
      expectDirectionFollowsPlacement(true, "doc-center after swap");

      // 容器缩小后方向保持。
      groupWidth = 700;
      fireGroupResize(groupWidth);
      syncRects();
      expectDirectionFollowsPlacement(
        true,
        "doc-center after container shrink",
      );

      // 容器放大后方向保持。
      groupWidth = 1600;
      fireGroupResize(groupWidth);
      syncRects();
      expectDirectionFollowsPlacement(true, "doc-center after container grow");

      // 窗口 resize 自动收起 → 重新打开（重注册 + 分隔条重挂载）后方向保持。
      await render(true, false);
      await render(true, true);
      expectDirectionFollowsPlacement(
        true,
        "doc-center after auto-collapse/reopen",
      );

      // 角色模型隐藏聊天（AUXILIARY 隐藏 ⇒ PRIMARY 铺满）再恢复后方向保持。
      await render(true, true, false);
      await render(true, true, true);
      expectDirectionFollowsPlacement(
        true,
        "doc-center after chat hide/restore",
      );

      // 切回普通排列：方向语义恢复。
      await render(false, true);
      expectDirectionFollowsPlacement(false, "chat-center after toggle back");

      // 「重载」：换位排列已持久化（localStorage 里的 layout + 模式），新 root 首帧即交换排列。
      act(() => {
        root?.unmount();
      });
      observers.length = 0;
      act(() => {
        root = createRoot(container);
      });
      await render(true, true);
      expectDirectionFollowsPlacement(
        true,
        "doc-center after reload with swapped layout persisted",
      );

      // 重载后再 resize（缩小）仍保持。
      groupWidth = 800;
      fireGroupResize(groupWidth);
      syncRects();
      expectDirectionFollowsPlacement(true, "doc-center after reload + shrink");

      // 5.2a 实机回归路径：spec 文档激活期保存的 ordinaryLayout（chat-center 的
      // key 顺序）在用户交换排列后被恢复。修复前 transitionSpecGeneralChatLayout
      // 直接 setLayout 旧顺序布局——RRP 的 le() 按值的位置（Object.values）解释
      // 布局，而 pivot/约束按当前注册表（视觉）顺序取下标，槽位错位后拖拽与
      // 键盘全部反向。修复后恢复前按当前注册表顺序重排。这里不做 resetLayout——
      // reset 会按当前排列重写布局、把错位「治好」，掩盖回归。
      act(() => {
        root?.unmount();
      });
      observers.length = 0;
      window.localStorage.clear();
      act(() => {
        root = createRoot(container);
      });
      const layoutMemory: SpecGeneralChatLayoutMemory = {
        workspaceKey: null,
        ordinaryLayout: null,
      };
      const columnMemory = { expandedSize: null as number | null };
      // chat-center 下「激活文档」：捕获 ordinary 布局（cc key 顺序）。
      await render(false, true);
      act(() => {
        transitionSpecGeneralChatLayout(
          groupRef.current,
          "ws-spec",
          layoutMemory,
          columnMemory,
        );
      });
      expect(layoutMemory.ordinaryLayout).toBeTruthy();
      // 用户交换到 document-center（文档仍激活），随后「文档失活」触发恢复。
      await render(true, true);
      act(() => {
        transitionSpecGeneralChatLayout(
          groupRef.current,
          null,
          layoutMemory,
          columnMemory,
        );
      });
      expectDirectionFollowsPlacement(
        true,
        "doc-center after spec-doc transition restored a cc-ordered layout",
        { reset: false },
      );

      // 反向路径：dc 下捕获、cc 下恢复，同样不得错位。
      act(() => {
        transitionSpecGeneralChatLayout(
          groupRef.current,
          "ws-spec-2",
          layoutMemory,
          columnMemory,
        );
      });
      await render(false, true);
      act(() => {
        transitionSpecGeneralChatLayout(
          groupRef.current,
          null,
          layoutMemory,
          columnMemory,
        );
      });
      expectDirectionFollowsPlacement(
        false,
        "chat-center after spec-doc transition restored a dc-ordered layout",
        { reset: false },
      );
    } finally {
      act(() => {
        root?.unmount();
      });
      container.remove();
      geometry.restore();
      vi.unstubAllGlobals();
      window.localStorage.clear();
    }
  });
});

/** 与 WorkspaceShellLayout + AnimatedSidePanePanel + useAnimatedResizablePanel 同构的接线。 */
function SwappableBody({
  documentCenter,
  groupRef,
  sidePaneOpen,
  chatExpanded,
}: {
  documentCenter: boolean;
  groupRef: { current: GroupImperativeHandle | null };
  sidePaneOpen: boolean;
  chatExpanded: boolean;
}) {
  const conversationElementRef = useRef<HTMLDivElement | null>(null);
  const sidePaneElementRef = useRef<HTMLDivElement | null>(null);
  const sidePanePanelRef = useRef<PanelImperativeHandle | null>(null);
  const conversationPanelRef = useRef<PanelImperativeHandle | null>(null);
  const [sidePaneVisible, setSidePaneVisible] = useState(sidePaneOpen);
  const [chatCollapsed, setChatCollapsed] = useState(!chatExpanded);

  // useAnimatedResizablePanel：关闭同步、打开 rAF 延迟一帧。
  useEffect(() => {
    if (!sidePaneOpen) {
      setSidePaneVisible(false);
      return;
    }
    const raf = window.requestAnimationFrame(() => setSidePaneVisible(true));
    return () => window.cancelAnimationFrame(raf);
  }, [sidePaneOpen]);

  // 命令式 collapse/resize 延后一帧（同 useAnimatedResizablePanel 的 rAF 命令）。
  useEffect(() => {
    const raf = window.requestAnimationFrame(() => {
      if (!sidePaneVisible) {
        sidePanePanelRef.current?.collapse();
      } else {
        sidePanePanelRef.current?.resize(
          documentCenter
            ? SPEC_SHELL_DOCUMENT_CENTER_SIDE_PANE_DEFAULT_SIZE
            : SIDE_PANE_DEFAULT,
        );
      }
    });
    return () => window.cancelAnimationFrame(raf);
  }, [sidePaneVisible, documentCenter]);

  useEffect(() => {
    const raf = window.requestAnimationFrame(() => {
      if (chatCollapsed) conversationPanelRef.current?.collapse();
      else conversationPanelRef.current?.resize(documentCenter ? "38%" : "52%");
    });
    return () => window.cancelAnimationFrame(raf);
  }, [chatCollapsed, documentCenter]);

  // 修复后的产品语义：渲染期无条件重申 order（差量写入），先于任何重注册 effect。
  applySpecShellLayoutSwapOrders(
    conversationElementRef.current,
    sidePaneElementRef.current,
    documentCenter,
  );

  const handleConversationElementRef = useCallback(
    (element: HTMLDivElement | null) => {
      conversationElementRef.current = element;
      if (element) element.style.order = documentCenter ? "3" : "1";
    },
    [documentCenter],
  );
  const handleSidePaneElementRef = useCallback(
    (element: HTMLDivElement | null) => {
      sidePaneElementRef.current = element;
      if (element) element.style.order = documentCenter ? "1" : "3";
    },
    [documentCenter],
  );

  return createElement(
    ResizablePanelGroup,
    {
      groupRef,
      layoutId: specShellBodyLayoutId("u03-divider-direction", documentCenter),
      panelIds: documentCenter ? DOCUMENT_CENTER_PANEL_IDS : NORMAL_PANEL_IDS,
    },
    createElement(
      ResizablePanel,
      {
        id: "conversation-column",
        panelRef: conversationPanelRef,
        collapsible: chatCollapsed,
        collapsedSize: "0px",
        defaultSize: documentCenter
          ? sidePaneVisible
            ? SPEC_SHELL_DOCUMENT_CENTER_CONVERSATION_DEFAULT_SIZE
            : undefined
          : sidePaneVisible
            ? "52%"
            : undefined,
        minSize: documentCenter
          ? SPEC_SHELL_DOCUMENT_CENTER_CONVERSATION_MIN_SIZE
          : "35%",
        elementRef: handleConversationElementRef,
      },
      "chat",
    ),
    sidePaneVisible && !chatCollapsed
      ? createElement(Separator, { key: "separator", style: { order: 2 } })
      : null,
    createElement(ResizablePanel, {
      id: "browser",
      panelRef: sidePanePanelRef,
      defaultSize: documentCenter
        ? SPEC_SHELL_DOCUMENT_CENTER_SIDE_PANE_DEFAULT_SIZE
        : "45%",
      minSize: "240px",
      maxSize: chatCollapsed
        ? "100%"
        : documentCenter
          ? SPEC_SHELL_DOCUMENT_CENTER_SIDE_PANE_MAX_SIZE
          : "65%",
      collapsible: !sidePaneVisible,
      disabled: !sidePaneVisible,
      collapsedSize: "0px",
      elementRef: handleSidePaneElementRef,
    }),
  );
}

function installGeometry() {
  const rects = new WeakMap<Element, DOMRect>();
  const rectDescriptor = Object.getOwnPropertyDescriptor(
    Element.prototype,
    "getBoundingClientRect",
  );
  const widthDescriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "offsetWidth",
  );
  const leftDescriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "offsetLeft",
  );
  Element.prototype.getBoundingClientRect = function (this: Element) {
    return rects.get(this) ?? new DOMRect(0, 0, 0, 0);
  };
  // offsetLeft 跟随 style.order：浏览器中 flex order 决定视觉位置，offsetLeft 是
  // 布局后位置——注册期排序因此始终读取当前 order（修复后的产品不变式）。
  Object.defineProperty(HTMLElement.prototype, "offsetLeft", {
    configurable: true,
    get(this: HTMLElement) {
      const order = Number.parseFloat(this.style.order);
      return Number.isFinite(order) ? order * 1000 : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get(this: HTMLElement) {
      const r = rects.get(this);
      return r ? r.width : 0;
    },
  });
  return {
    rects,
    restore() {
      if (rectDescriptor)
        Object.defineProperty(
          Element.prototype,
          "getBoundingClientRect",
          rectDescriptor as PropertyDescriptor,
        );
      if (leftDescriptor)
        Object.defineProperty(
          HTMLElement.prototype,
          "offsetLeft",
          leftDescriptor,
        );
      if (widthDescriptor)
        Object.defineProperty(
          HTMLElement.prototype,
          "offsetWidth",
          widthDescriptor,
        );
    },
  };
}

function flushFrames() {
  return new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => resolve());
    });
  });
}
