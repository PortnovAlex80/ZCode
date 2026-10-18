import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  conversationPopoutOpenPolicy,
  installNativeConversationPopouts,
  isNativeConversationPopout,
  markNativeConversationOwnersClosing,
  setNativeWindowAttachment,
} from "../src/main/nativeConversationPopouts.js";
import { NativeConversationGeometryStore } from "../src/main/nativeConversationGeometry.js";

function fakeWindow(id: number) {
  return Object.assign(new EventEmitter(), {
    id,
    webContents: Object.assign(new EventEmitter(), {
      setWindowOpenHandler: vi.fn(),
      executeJavaScript: vi.fn(async () => true),
      session: { flushStorageData: vi.fn(), cookies: { flushStore: vi.fn(async () => {}) } },
    }),
    setMenu: vi.fn(),
    hide: vi.fn(),
    show: vi.fn(),
    destroy: vi.fn(),
    isDestroyed: () => false,
  });
}

describe("native conversation placement", () => {
  it("cleans up an owner after its native webContents accessor is destroyed", () => {
    const owner = fakeWindow(780);
    Object.assign(owner.webContents, { id: 780 });
    installNativeConversationPopouts(owner as never, () => true);
    Object.defineProperty(owner, "webContents", {
      get() { throw new TypeError("Object has been destroyed"); },
    });
    expect(() => owner.emit("closed")).not.toThrow();
  });
  it("rejects attachment from other owners and invalid native targets", () => {
    const owner = fakeWindow(770);
    Object.assign(owner.webContents, { id: 770 });
    installNativeConversationPopouts(owner as never, () => false);
    const child = Object.assign(fakeWindow(771), {
      getBounds: () => ({ x: 100, y: 100, width: 400, height: 600 }),
      setBounds: vi.fn(), isMaximized: () => false, isMinimized: () => false, isFullScreen: () => false,
    });
    owner.webContents.emit("did-create-window", child, { frameName: "zcode-conversation-doc" });
    const request = { documentFrame: "zcode-conversation-doc", conversationFrame: "zcode-conversation-chat" };
    expect(setNativeWindowAttachment(770, request)).toEqual({ attached: true });
    expect(setNativeWindowAttachment(999, request)).toEqual({ attached: false });
    expect(setNativeWindowAttachment(770, { ...request, documentFrame: "zcode-conversation-other" })).toEqual({ attached: false });
    expect(setNativeWindowAttachment(770, { ...request, conversationFrame: "arbitrary-id" })).toEqual({ attached: false });
    expect(setNativeWindowAttachment(770, { ...request, side: "top" })).toEqual({ attached: false });
    expect(setNativeWindowAttachment(770, null)).toEqual({ attached: false });
    owner.emit("closed");
    expect(setNativeWindowAttachment(770, request)).toEqual({ attached: false });
  });
  it("acknowledges owner shutdown before flushing durable reopen storage", async () => {
    const owner = fakeWindow(900);
    let acknowledge!: (value: boolean) => void;
    owner.webContents.executeJavaScript.mockImplementation(() => new Promise<boolean>(resolve => { acknowledge = resolve; }));
    installNativeConversationPopouts(owner as never, () => true);
    const closing = markNativeConversationOwnersClosing();
    expect(owner.webContents.session.flushStorageData).not.toHaveBeenCalled();
    acknowledge(true);
    await closing;
    expect(owner.webContents.session.flushStorageData).toHaveBeenCalledOnce();
    expect(owner.webContents.session.cookies.flushStore).toHaveBeenCalledOnce();
    owner.emit("closed");
  });
  it("allows only named blank surfaces without weakening isolation", () => {
    const allowed = conversationPopoutOpenPolicy({
      url: "about:blank",
      frameName: "zcode-conversation-abc",
    });
    expect(allowed).toMatchObject({
      action: "allow",
      overrideBrowserWindowOptions: {
        alwaysOnTop: true,
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      },
    });
    expect(
      conversationPopoutOpenPolicy({
        url: "https://example.com",
        frameName: "zcode-conversation-abc",
      }).action,
    ).toBe("deny");
    expect(
      conversationPopoutOpenPolicy({ url: "about:blank", frameName: "other" })
        .action,
    ).toBe("deny");
  });

  it("retains the owner while several children exist; last close reveals it", () => {
    const owner = fakeWindow(1);
    installNativeConversationPopouts(owner as never, () => false);
    const a = fakeWindow(2);
    const b = fakeWindow(3);
    owner.webContents.emit("did-create-window", a, {
      frameName: "zcode-conversation-a",
    });
    owner.webContents.emit("did-create-window", b, {
      frameName: "zcode-conversation-b",
    });
    expect(isNativeConversationPopout(a)).toBe(true);
    const preventDefault = vi.fn();
    owner.emit("close", { preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(owner.hide).toHaveBeenCalledOnce();
    a.emit("closed");
    expect(owner.show).not.toHaveBeenCalled();
    b.emit("closed");
    expect(owner.show).toHaveBeenCalledOnce();
    expect(isNativeConversationPopout(a)).toBe(false);
    expect(isNativeConversationPopout(b)).toBe(false);
  });

  it("explicit Quit closes children and does not hide the owner", () => {
    const owner = fakeWindow(10);
    const child = fakeWindow(11);
    installNativeConversationPopouts(owner as never, () => true);
    owner.webContents.emit("did-create-window", child, {
      frameName: "zcode-conversation-c",
    });
    const preventDefault = vi.fn();
    owner.emit("close", { preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
    owner.emit("closed");
    expect(child.destroy).toHaveBeenCalledOnce();
    child.emit("closed");
  });

  it("hydrates addressed native bounds and saves close geometry without giving children IPC", async () => {
    const folder = await mkdtemp(join(tmpdir(), "zcode-popout-lifecycle-"));
    try {
      const store = new NativeConversationGeometryStore(
        join(folder, "geometry.json"),
      );
      await store.save("zcode-conversation-projectA_sessionA", {
        x: -1500,
        y: 40,
        width: 800,
        height: 650,
        displayId: "left",
        maximized: true,
      });
      let bounds = { x: 10, y: 20, width: 480, height: 640 };
      let maximized = false;
      const owner = fakeWindow(40);
      const child = Object.assign(fakeWindow(41), {
        getNormalBounds: () => bounds,
        isMaximized: () => maximized,
        setBounds: vi.fn((next) => {
          bounds = next;
        }),
        maximize: vi.fn(() => {
          maximized = true;
        }),
      });
      installNativeConversationPopouts(owner as never, () => false, {
        store,
        getDisplays: () => [
          {
            id: "left",
            workArea: { x: -1920, y: 0, width: 1920, height: 1080 },
          },
        ],
      });
      owner.webContents.emit("did-create-window", child, {
        frameName: "zcode-conversation-projectA_sessionA",
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(child.setBounds).toHaveBeenCalledWith({
        x: -1500,
        y: 40,
        width: 800,
        height: 650,
      });
      expect(child.maximize).toHaveBeenCalledOnce();
      expect(child.webContents.setWindowOpenHandler).toHaveBeenCalledOnce();
      bounds = { x: -1700, y: 100, width: 700, height: 600 };
      child.emit("close");
      child.emit("closed");
      await store.flush();
      expect(store.get("zcode-conversation-projectA_sessionA")).toMatchObject({
        ...bounds,
        maximized: true,
        displayId: "left",
      });
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
});
