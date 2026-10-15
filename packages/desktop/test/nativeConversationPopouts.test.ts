import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  conversationPopoutOpenPolicy,
  installNativeConversationPopouts,
  isNativeConversationPopout,
} from "../src/main/nativeConversationPopouts.js";

function fakeWindow(id: number) {
  return Object.assign(new EventEmitter(), {
    id,
    webContents: Object.assign(new EventEmitter(), { setWindowOpenHandler: vi.fn() }),
    setMenu: vi.fn(),
    hide: vi.fn(),
    show: vi.fn(),
    destroy: vi.fn(),
    isDestroyed: () => false,
  });
}

describe("native conversation placement", () => {
  it("allows only named blank surfaces without weakening isolation", () => {
    const allowed = conversationPopoutOpenPolicy({ url: "about:blank", frameName: "zcode-conversation-abc" });
    expect(allowed).toMatchObject({ action: "allow", overrideBrowserWindowOptions: {
      alwaysOnTop: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    } });
    expect(conversationPopoutOpenPolicy({ url: "https://example.com", frameName: "zcode-conversation-abc" }).action).toBe("deny");
    expect(conversationPopoutOpenPolicy({ url: "about:blank", frameName: "other" }).action).toBe("deny");
  });

  it("retains the owner while several children exist; last close reveals it", () => {
    const owner = fakeWindow(1);
    installNativeConversationPopouts(owner as never, () => false);
    const a = fakeWindow(2);
    const b = fakeWindow(3);
    owner.webContents.emit("did-create-window", a, { frameName: "zcode-conversation-a" });
    owner.webContents.emit("did-create-window", b, { frameName: "zcode-conversation-b" });
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
    owner.webContents.emit("did-create-window", child, { frameName: "zcode-conversation-c" });
    const preventDefault = vi.fn();
    owner.emit("close", { preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
    owner.emit("closed");
    expect(child.destroy).toHaveBeenCalledOnce();
    child.emit("closed");
  });
});
