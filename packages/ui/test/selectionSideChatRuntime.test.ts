import { describe, expect, it, vi } from "vitest";
import {
  getSelectionSideChatOpenState,
  getSelectionSideChatOpenStateForWorkspace,
  buildSelectionSideChatKey,
  clearSelectionSideChat,
  createSelectionSideChat,
  isSelectionSideChatBlocked,
  registerSelectionSideChatOpener,
  requestSelectionSideChatOpen,
  requestSelectionSideChatOpenForWorkspace,
  setSelectionSideChatBlocked,
} from "../src/lib/selectionSideChatRuntime.js";

describe("selection side chat renderer runtime", () => {
  it("同一创建手势合并 pending，但完成后再次打开会创建新的 child", async () => {
    const key = buildSelectionSideChatKey("ssh://host/workspace", "parent-1");
    let resolveCreate: ((sessionId: string) => void) | null = null;
    const create = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveCreate = resolve;
        }),
    );

    const first = createSelectionSideChat(key, create);
    const second = createSelectionSideChat(key, create);
    resolveCreate?.("child-1");

    await expect(first).resolves.toBe("child-1");
    await expect(second).resolves.toBe("child-1");
    expect(create).toHaveBeenCalledTimes(1);

    await expect(createSelectionSideChat(key, async () => "child-2")).resolves.toBe("child-2");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("创建失败不留下 pending，下一次动作可以重建", async () => {
    const key = buildSelectionSideChatKey("/workspace", "parent-failed");
    await expect(
      createSelectionSideChat(key, async () => {
        throw new Error("proto.sessionNotFound");
      }),
    ).rejects.toThrow("proto.sessionNotFound");

    await expect(createSelectionSideChat(key, async () => "child-rebuilt")).resolves.toBe(
      "child-rebuilt",
    );
  });

  it("blocked 状态按 child 隔离，关闭一个实例不影响兄弟 tab", () => {
    setSelectionSideChatBlocked("child-a", true);
    setSelectionSideChatBlocked("child-b", false);
    expect(isSelectionSideChatBlocked("child-a")).toBe(true);
    expect(isSelectionSideChatBlocked("child-b")).toBe(false);

    clearSelectionSideChat("child-a");
    expect(isSelectionSideChatBlocked("child-a")).toBe(false);
    expect(isSelectionSideChatBlocked("child-b")).toBe(false);
    clearSelectionSideChat("child-b");
  });

  it("固定入口路由到同一父任务的 focused pane，且不需要框选引用", () => {
    const key = buildSelectionSideChatKey("/workspace", "parent-launcher");
    const background = vi.fn(async () => {});
    const focused = vi.fn(async () => {});
    const unregisterBackground = registerSelectionSideChatOpener(key, background, false);
    const unregisterFocused = registerSelectionSideChatOpener(key, focused, true);

    expect(requestSelectionSideChatOpen(key)).toBe(true);
    expect(focused).toHaveBeenCalledWith();
    expect(background).not.toHaveBeenCalled();

    unregisterFocused();
    expect(requestSelectionSideChatOpen(key)).toBe(true);
    expect(background).toHaveBeenCalledWith();

    unregisterBackground();
    expect(requestSelectionSideChatOpen(key)).toBe(false);
  });
  it("Markdown 引用按精确父 scope 传递，阻塞只拒绝引用动作", () => {
    const key = buildSelectionSideChatKey("ssh:first:/same", "parent");
    const reference = {
      id: "md",
      contentType: "markdown" as const,
      sourceKey: "/same/a.md",
      sourceTitle: "a.md",
      text: "quote",
    };
    const open = vi.fn(async () => {});
    const unregister = registerSelectionSideChatOpener(key, open, true);
    expect(getSelectionSideChatOpenState(key)).toBe("ready");
    expect(requestSelectionSideChatOpen(key, reference)).toBe(true);
    expect(open).toHaveBeenCalledWith(reference);
    expect(
      requestSelectionSideChatOpen(
        buildSelectionSideChatKey("ssh:second:/same", "parent"),
        reference,
      ),
    ).toBe(false);
    unregister();
    const unregisterBlocked = registerSelectionSideChatOpener(key, open, true, true);
    expect(getSelectionSideChatOpenState(key)).toBe("blocked");
    open.mockClear();
    expect(requestSelectionSideChatOpen(key, reference)).toBe(false);
    expect(open).not.toHaveBeenCalled();
    expect(requestSelectionSideChatOpen(key)).toBe(true);
    unregisterBlocked();
    expect(getSelectionSideChatOpenState(key)).toBe("unavailable");
  });

  // Workspace-scoped fallback: a null-session markdown selection target cannot
  // build the exact (workspace, parent) key; it resolves any opener of the
  // workspace instead (the draft pane registers under its prewarm parent).
  it("workspace fallback routes sessionId-less targets to the workspace opener, focused first", () => {
    const reference = {
      id: "md-ws",
      contentType: "markdown" as const,
      sourceKey: "/ws/a.md",
      sourceTitle: "a.md",
      text: "quote",
    };
    const background = vi.fn(async () => {});
    const focused = vi.fn(async () => {});
    const foreign = vi.fn(async () => {});
    const unregisterBackground = registerSelectionSideChatOpener(
      buildSelectionSideChatKey("ssh:first:/ws", "prewarm-parent"),
      background,
      false,
    );
    const unregisterForeign = registerSelectionSideChatOpener(
      buildSelectionSideChatKey("ssh:second:/ws", "other-parent"),
      foreign,
      true,
    );
    expect(getSelectionSideChatOpenStateForWorkspace("ssh:first:/ws")).toBe("ready");
    expect(requestSelectionSideChatOpenForWorkspace("ssh:first:/ws", reference)).toBe(true);
    expect(background).toHaveBeenCalledWith(reference);
    expect(foreign).not.toHaveBeenCalled();

    const unregisterFocused = registerSelectionSideChatOpener(
      buildSelectionSideChatKey("ssh:first:/ws", "live-parent"),
      focused,
      true,
    );
    expect(requestSelectionSideChatOpenForWorkspace("ssh:first:/ws")).toBe(true);
    expect(focused).toHaveBeenCalledWith();
    expect(background).toHaveBeenCalledTimes(1);

    unregisterFocused();
    unregisterBackground();
    expect(getSelectionSideChatOpenStateForWorkspace("ssh:first:/ws")).toBe("unavailable");
    expect(requestSelectionSideChatOpenForWorkspace("ssh:first:/ws", reference)).toBe(false);
    // The foreign workspace opener must never be routed to.
    expect(foreign).not.toHaveBeenCalled();
    unregisterForeign();
  });
  it("workspace fallback reports blocked when the only workspace opener is reference-blocked", () => {
    const unregister = registerSelectionSideChatOpener(
      buildSelectionSideChatKey("ssh:blocked:/ws", "parent"),
      vi.fn(async () => {}),
      true,
      true,
    );
    expect(getSelectionSideChatOpenStateForWorkspace("ssh:blocked:/ws")).toBe("blocked");
    unregister();
  });
});
