// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { createElement, useEffect, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SpecWindowBridge } from "@zcode/shared";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { SpecDetachedPanelRoot } from "@/spec-document/SpecDetachedPanelRoot.js";
import {
  specDocumentCleanupKey,
  usePanelCleanupSignal,
} from "@/spec-document/specWindowBridge.js";
import { useSpecDetachedPanels } from "@/spec-document/useSpecDetachedPanels.js";

const hoisted = vi.hoisted(() => ({
  order: [] as string[],
}));

vi.mock("@/v4/SessionPane.js", () => ({
  SessionPane: () => createElement("div", { "data-testid": "session-pane" }),
}));
vi.mock("@/v4/V4ConversationContext.js", () => ({
  V4PaneConversationProvider: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
}));
vi.mock("@/spec-document/SpecDocumentPane.js", () => ({
  // 子窗口面板内容的替身：记录自己的被动清理，用于验证 ACK 晚于整个面板子树清理。
  SpecDocumentPane: () => {
    useEffect(() => () => hoisted.order.push("child-pane-cleanup"), []);
    return createElement("div", { "data-testid": "spec-pane" });
  },
}));
vi.mock("@/root/DiffsWorkerPoolProvider.js", () => ({
  DiffsWorkerPoolProvider: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
}));
vi.mock("@/useTheme.js", () => ({ useTheme: () => {} }));
vi.mock("@/AssistantCodeCommentFeatureProvider.js", () => ({
  AssistantCodeCommentFeatureProvider: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
}));
vi.mock("@/settings/CodingPlanUpgradeDialogProvider.js", () => ({
  CodingPlanUpgradeDialogProvider: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
}));
vi.mock("@/store/StoreProvider.js", () => ({
  StoreProvider: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
}));
vi.mock("@/store/TabStoreProvider.js", () => ({
  TabStoreProvider: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
}));
vi.mock("@/components/ui/tooltip.js", () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
}));

interface RecordedAck {
  action: string;
  payload: unknown;
}
function createFakeBridge(target: {
  kind: "chat" | "document" | "side-chat";
  workspacePath: string;
  panelKey: string;
  path?: string;
  sessionId?: string;
}) {
  const transfer = { transferId: "transfer-1", target };
  const acks: RecordedAck[] = [];
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const bridge: SpecWindowBridge = {
    specPanelAck(action, payload) {
      acks.push({ action, payload });
      hoisted.order.push(`ack:${action}`);
    },
    onSpecPanelEvent(action, listener) {
      const set = listeners.get(action) ?? new Set();
      set.add(listener);
      listeners.set(action, set);
      return () => set.delete(listener);
    },
    specPanelAction: vi.fn(async (action: string) =>
      action === "state" ? { ...transfer, phase: "detached" } : {},
    ),
    projectWindowState: async () => ({ role: "main", windows: [] }),
    onProjectWindowsChanged: () => () => {},
    labelProjectWindow: async () => {},
    returnToMainWindow: async () => {},
    acknowledgeProjectWindowTarget: () => {},
  };
  return {
    bridge,
    acks,
    transfer,
    emit(action: string, payload: unknown = transfer) {
      for (const listener of listeners.get(action) ?? []) listener(payload);
    },
  };
}

/** 与真实宿主同构：transfers 命中本 panelKey 时面板被移除挂载（WorkspaceShellLayout 的过滤契约）。 */
function DetachHost({ onRestore }: { onRestore?: () => void }) {
  const panels = useSpecDetachedPanels("D:/ws", onRestore);
  const detached = Boolean(panels.transfers["doc-1"]);
  return createElement(
    "div",
    null,
    createElement(
      "span",
      { "data-testid": "transfers" },
      Object.keys(panels.transfers).join(","),
    ),
    detached ? null : createElement(TrackedDocumentPane),
  );
}
/** 源窗口文档面板：按 workspace+path 登记清理完成信号；先记录清理再完成信号（hook 声明顺序）。 */
function TrackedDocumentPane() {
  useEffect(() => () => hoisted.order.push("doc-cleanup"), []);
  usePanelCleanupSignal(specDocumentCleanupKey("D:/ws", "docs/spec.md"));
  return createElement("p", { "data-testid": "doc-pane" }, "document pane");
}

describe("spec panel cleanup-completion signal", () => {
  beforeEach(() => {
    // 仓库约定：vitest 未开 globals，RTL 自动清理不会注册，需显式卸载上一棵树，
    // 否则其挂起中的作用域会按同 workspace+path 键泄漏进下一个用例的等待快照。
    cleanup();
    hoisted.order.length = 0;
  });

  it("detach-prepared ACK 只在面板清理完成信号resolve后发出（源窗口文档面板）", async () => {
    const { bridge, acks, emit } = createFakeBridge({
      kind: "document",
      workspacePath: "D:\\ws",
      panelKey: "doc-1",
      path: "docs/spec.md",
    });
    render(
      createElement(
        PlatformProvider,
        { platform: { specWindows: bridge } as never },
        createElement(DetachHost, null),
      ),
    );
    expect(screen.getByTestId("doc-pane")).toBeTruthy();

    act(() => emit("detach-prepare"));

    // 同步边界：flushSync 只提交删除（mutation/layout），被动清理与其 ACK 不可能在 emit 返回前发生。
    expect(acks.filter((ack) => ack.action === "detach-prepared")).toHaveLength(0);
    expect(screen.getByTestId("transfers").textContent).toBe("doc-1");

    await waitFor(() => expect(acks.some((ack) => ack.action === "detach-prepared")).toBe(true));
    // ACK 晚于面板被动清理：50ms 定时边界不再参与正确性。
    expect(hoisted.order).toEqual(["doc-cleanup", "ack:detach-prepared"]);
    expect(screen.queryByTestId("doc-pane")).toBeNull();
  });

  it("reattach-prepared 不等待重新挂载面板的新作用域（快照语义，无死等）", async () => {
    const { bridge, acks, emit } = createFakeBridge({
      kind: "document",
      workspacePath: "D:\\ws",
      panelKey: "doc-1",
      path: "docs/spec.md",
    });
    const onRestore = vi.fn();
    render(
      createElement(
        PlatformProvider,
        { platform: { specWindows: bridge } as never },
        createElement(DetachHost, { onRestore }),
      ),
    );
    act(() => emit("detach-prepare"));
    await waitFor(() => expect(acks.some((ack) => ack.action === "detach-prepared")).toBe(true));
    hoisted.order.length = 0;

    act(() => emit("reattach-prepare"));

    // 恢复路径：onRestore 被调用、transfer 清除、面板重新挂载（新作用域挂起中）。
    expect(onRestore).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("transfers").textContent).toBe("");
    // reattach-prepared 只等待 detach 前快照（已全部完成），新挂载面板的作用域不阻塞 ACK。
    await waitFor(() =>
      expect(acks.some((ack) => ack.action === "reattach-prepared")).toBe(true),
    );
    expect(screen.getByTestId("doc-pane")).toBeTruthy();
    expect(hoisted.order).toEqual(["ack:reattach-prepared"]);
  });

  it("子窗口 reattach-quiesced ACK 等待整个面板子树的清理完成信号", async () => {
    const target = {
      kind: "document" as const,
      workspacePath: "D:\\ws",
      panelKey: "doc-1",
      path: "docs/spec.md",
    };
    const { bridge, acks, emit } = createFakeBridge(target);
    render(
      createElement(SpecDetachedPanelRoot, {
        services: { broadcastService: undefined } as never,
        platform: { specWindows: bridge } as never,
      }),
    );
    // ready ACK + state 查询后面板可见。
    await waitFor(() => expect(screen.getByTestId("spec-pane")).toBeTruthy());
    hoisted.order.length = 0;

    act(() => emit("reattach-prepare"));

    // 同步边界：静默卸载只提交删除，quiesced ACK 未发出。
    expect(acks.filter((ack) => ack.action === "reattach-quiesced")).toHaveLength(0);
    // 可见的静默状态，而不是空白窗口。
    expect(screen.getByRole("status").textContent).toContain("Returning this panel");

    await waitFor(() =>
      expect(acks.some((ack) => ack.action === "reattach-quiesced")).toBe(true),
    );
    // 哨兵在面板内容之后清理：ACK 晚于面板内容的被动清理。
    expect(hoisted.order).toEqual(["child-pane-cleanup", "ack:reattach-quiesced"]);
    expect(screen.queryByTestId("spec-pane")).toBeNull();
  });
});
