// @vitest-environment jsdom
// U-03 regression: chat/document divider drag AND keyboard direction.
//
// Background: react-resizable-panels orders panels by offsetLeft at
// (re)registration, and the drag/keyboard pivots derive from that registry
// order. If the inline flex order is ever reset while RRP re-registers (window
// resize flips collapsible/disabled/defaultSize), the registry can fall back to
// the pre-registration order and the divider direction flips. The product
// invariant: WorkspaceShellLayout restates the order on every render
// (applySpecShellLayoutSwapOrders, diff-aware writes) before any re-registration
// effect runs. Since the side-swap arrangement was retired (user ruling
// 2026-11-07) the arrangement is fixed: chat column order 1, tabs container
// order 3. This file keeps the mechanism coverage for that single arrangement:
// 1) source contract: per-render restatement + order-writing ref callbacks;
// 2) real react-resizable-panels with product-like wiring: drag (both ways) and
//    keyboard (both ways) must always grow/shrink the visually-left panel,
//    across container resizes, side-pane close/reopen and chat hide/restore.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { act, createElement, useCallback, useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
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
import { applySpecShellLayoutSwapOrders } from "@/spec-document/specShellLayoutSwap.js";

const SEPARATOR_WIDTH = 4;
const SIDE_PANE_DEFAULT = "45%";

describe("WorkspaceShellLayout source contract for order re-assertion (U-03)", () => {
  it("restates the fixed orders on every render instead of latching on state", async () => {
    const layoutSource = await readFile(
      resolve("packages/ui/src/app-shell/WorkspaceShellLayout.tsx"),
      "utf8",
    );
    // The restatement must run unconditionally during render (diff-aware writes
    // keep it zero-mutation in steady state).
    expect(layoutSource).not.toContain("shellLayoutSwapOrderStateRef");
    expect(layoutSource).toMatch(
      /applySpecShellLayoutSwapOrders\(\s*\w+Ref\.current,\s*\w+Ref\.current,?\s*\)/u,
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
    expect(layoutSource).toContain('element.style.order = "1"');
    expect(sidePaneSource).toContain('element.style.order = "3"');
  });
});

/**
 * Mechanism verification (real react-resizable-panels + product-like wiring).
 * jsdom does no layout: offsetLeft is stubbed to follow style.order (matching
 * how flex order maps to visual position in the browser), rects follow the
 * current layout percentages, and ResizeObserver is manually triggered.
 */
describe("divider drag direction across the shell flow matrix (U-03 mechanism)", () => {
  it("keeps drag AND keyboard direction tied to the visual arrangement across resizes", async () => {
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
      // Same contract as the offsetLeft stub: visual position follows style.order.
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

    // The library attaches keydown on the separator element; the keyboard path
    // uses the registration-time cached panel pairing.
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

    // Deterministic midpoint so one probe cannot saturate at min/max and hide
    // the direction of the next probe.
    const resetLayout = () => {
      act(() => {
        groupRef.current?.setLayout({
          "conversation-column": 52,
          browser: 48,
        });
      });
      syncRects();
    };

    /**
     * Core assertion: drag (both ways) and keyboard (both ways) must grow the
     * visually-left panel (the chat column) on rightward input and shrink it on
     * leftward input. A flip on either path is the live regression.
     */
    const expectDirectionFollowsPlacement = (label: string) => {
      resetLayout();
      const dragRight = dragProbe(120);
      const dragLeft = dragProbe(-120);
      resetLayout();
      const keyRight = keyboardProbe("ArrowRight");
      const keyLeft = keyboardProbe("ArrowLeft");
      expect(
        dragRight.conversationDelta,
        `${label}: drag right grows the visually-left panel`,
      ).toBeGreaterThan(0);
      expect(
        dragLeft.conversationDelta,
        `${label}: drag left shrinks the visually-left panel`,
      ).toBeLessThan(0);
      expect(
        keyRight.conversationDelta,
        `${label}: ArrowRight grows the visually-left panel (keyboard path)`,
      ).toBeGreaterThan(0);
      expect(
        keyLeft.conversationDelta,
        `${label}: ArrowLeft shrinks the visually-left panel (keyboard path)`,
      ).toBeLessThan(0);
    };

    const render = async (options: {
      sidePaneOpen: boolean;
      chatExpanded?: boolean;
    }) => {
      act(() => {
        root?.render(
          createElement(WorkspaceBody, {
            groupRef,
            sidePaneOpen: options.sidePaneOpen,
            chatExpanded: options.chatExpanded ?? true,
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
      await render({ sidePaneOpen: true });
      expectDirectionFollowsPlacement("initial");

      // Direction survives container shrink/grow (re-registration pressure).
      groupWidth = 700;
      fireGroupResize(groupWidth);
      syncRects();
      expectDirectionFollowsPlacement("after container shrink");
      groupWidth = 1600;
      fireGroupResize(groupWidth);
      syncRects();
      expectDirectionFollowsPlacement("after container grow");

      // Window-resize auto-collapse → reopen: the separator remounts and the
      // side pane re-registers; direction must survive.
      await render({ sidePaneOpen: false });
      await render({ sidePaneOpen: true });
      expectDirectionFollowsPlacement("after side-pane close/reopen");

      // Fork chat collapse/restore keeps the direction intact.
      await render({ sidePaneOpen: true, chatExpanded: false });
      await render({ sidePaneOpen: true, chatExpanded: true });
      expectDirectionFollowsPlacement("after chat hide/restore");

      // "Reload": persisted layout, fresh root — first frame already ordered.
      act(() => {
        root?.unmount();
      });
      observers.length = 0;
      act(() => {
        root = createRoot(container);
      });
      await render({ sidePaneOpen: true });
      expectDirectionFollowsPlacement("after reload with persisted layout");

      groupWidth = 800;
      fireGroupResize(groupWidth);
      syncRects();
      expectDirectionFollowsPlacement("after reload + shrink");
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

/** Mirrors WorkspaceShellLayout + AnimatedSidePanePanel wiring for the fixed arrangement. */
function WorkspaceBody({
  groupRef,
  sidePaneOpen,
  chatExpanded,
}: {
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

  // useAnimatedResizablePanel: close syncs, open defers one frame via rAF.
  useEffect(() => {
    if (!sidePaneOpen) {
      setSidePaneVisible(false);
      return;
    }
    const raf = window.requestAnimationFrame(() => setSidePaneVisible(true));
    return () => window.cancelAnimationFrame(raf);
  }, [sidePaneOpen]);

  // Imperative collapse/resize deferred one frame (same rAF pattern).
  useEffect(() => {
    const raf = window.requestAnimationFrame(() => {
      if (!sidePaneVisible) {
        sidePanePanelRef.current?.collapse();
      } else {
        sidePanePanelRef.current?.resize(SIDE_PANE_DEFAULT);
      }
    });
    return () => window.cancelAnimationFrame(raf);
  }, [sidePaneVisible]);

  useEffect(() => {
    const raf = window.requestAnimationFrame(() => {
      if (chatCollapsed) conversationPanelRef.current?.collapse();
      else conversationPanelRef.current?.resize("52%");
    });
    return () => window.cancelAnimationFrame(raf);
  }, [chatCollapsed]);

  // Product semantics: unconditional per-render order restatement (diff-aware).
  applySpecShellLayoutSwapOrders(
    conversationElementRef.current,
    sidePaneElementRef.current,
  );

  const handleConversationElementRef = useCallback(
    (element: HTMLDivElement | null) => {
      conversationElementRef.current = element;
      if (element) element.style.order = "1";
    },
    [],
  );
  const handleSidePaneElementRef = useCallback(
    (element: HTMLDivElement | null) => {
      sidePaneElementRef.current = element;
      if (element) element.style.order = "3";
    },
    [],
  );

  return createElement(
    ResizablePanelGroup,
    {
      groupRef,
      layoutId: "workspace-body-layout:u03-divider-direction",
      panelIds: ["conversation-column", "browser"],
    },
    createElement(
      ResizablePanel,
      {
        id: "conversation-column",
        panelRef: conversationPanelRef,
        collapsible: chatCollapsed,
        collapsedSize: "0px",
        defaultSize: sidePaneVisible ? "52%" : undefined,
        minSize: "35%",
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
      defaultSize: "45%",
      minSize: "240px",
      maxSize: chatCollapsed ? "100%" : "65%",
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
  // offsetLeft follows style.order: in the browser flex order determines the
  // visual position, so registration-time sorting always reads the live order.
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
