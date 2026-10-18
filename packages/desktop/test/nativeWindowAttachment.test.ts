import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { NativeWindowAttachments } from "../src/main/nativeWindowAttachment.js";
import type { ConversationRectangle } from "../src/main/nativeConversationGeometry.js";

function surface(initial: ConversationRectangle) {
  let bounds = { ...initial };
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    isMaximized: () => false,
    isMinimized: () => false,
    isFullScreen: () => false,
    getBounds: () => ({ ...bounds }),
    setBounds: vi.fn((value: ConversationRectangle) => { bounds = { ...value }; }),
    move(value: Partial<ConversationRectangle>) { bounds = { ...bounds, ...value }; window.emit("move"); },
  });
  return window;
}

function fixture(width = 1800) {
  const controller = new NativeWindowAttachments(() => [{ id: "main", workArea: { x: 0, y: 0, width, height: 1000 } }]);
  const chat = surface({ x: 100, y: 100, width: 400, height: 600 });
  const doc = surface({ x: 80, y: 80, width: 500, height: 700 });
  controller.register("chat", chat);
  controller.register("doc", doc);
  return { controller, chat, doc };
}

describe("independent native window attachment", () => {
  it("waits for both saved layouts before grouping and preserves restored vertical offset", () => {
    const controller = new NativeWindowAttachments(() => [{ id: "main", workArea: { x: 0, y: 0, width: 1800, height: 1000 } }]);
    const chat = surface({ x: 10, y: 10, width: 400, height: 600 });
    const doc = surface({ x: 20, y: 20, width: 500, height: 700 });
    controller.register("chat", chat, false); controller.register("doc", doc, false);
    controller.set("doc", "chat");
    chat.setBounds({ x: 100, y: 120, width: 400, height: 600 });
    controller.ready("chat");
    expect(doc.getBounds().x).toBe(20);
    doc.setBounds({ x: 500, y: 170, width: 500, height: 700 });
    controller.ready("doc");
    expect(doc.getBounds()).toMatchObject({ x: 500, y: 170 });
    chat.move({ x: 150, y: 140 });
    expect(doc.getBounds()).toMatchObject({ x: 550, y: 190 });
  });
  it("places adjacent windows and moves either partner without asynchronous feedback", () => {
    const { controller, chat, doc } = fixture();
    expect(controller.set("doc", "chat")).toBe(true);
    expect(doc.getBounds()).toMatchObject({ x: 500, y: 100 });
    chat.move({ x: 150, y: 120 });
    expect(doc.getBounds()).toMatchObject({ x: 550, y: 120 });
    const calls = doc.setBounds.mock.calls.length;
    // A delayed acknowledgement of programmatic placement must be a no-op.
    doc.emit("move"); doc.emit("resize");
    expect(doc.setBounds).toHaveBeenCalledTimes(calls);
    expect(chat.getBounds()).toMatchObject({ x: 150, y: 120 });
    doc.move({ x: 600, y: 160 });
    expect(chat.getBounds()).toMatchObject({ x: 200, y: 160 });
    chat.emit("move");
    expect(doc.getBounds()).toMatchObject({ x: 600, y: 160 });
  });

  it("keeps the adjacent edge after resize and stops group movement on detach", () => {
    const { controller, chat, doc } = fixture();
    controller.set("doc", "chat");
    chat.move({ width: 450 });
    expect(doc.getBounds().x).toBe(550);
    expect(controller.set("doc", null)).toBe(false);
    chat.move({ x: 200 });
    expect(doc.getBounds().x).toBe(550);
  });

  it("admits a pending target and attaches when its native surface appears", () => {
    const { controller, doc } = fixture();
    expect(controller.set("doc", "later")).toBe(true);
    const later = surface({ x: 200, y: 200, width: 400, height: 600 });
    controller.register("later", later);
    expect(doc.getBounds()).toMatchObject({ x: 600, y: 200 });
    later.emit("closed");
    doc.move({ x: 700 });
    expect(later.getBounds().x).toBe(200);
    expect(controller.set("missing", "later")).toBe(false);
    expect(controller.set("doc", "doc")).toBe(false);
  });

  it("suspends grouping while maximized, minimized or fullscreen", () => {
    const { controller, chat, doc } = fixture();
    controller.set("doc", "chat");
    chat.isMaximized = () => true;
    chat.move({ x: 130 });
    expect(doc.getBounds().x).toBe(500);
    chat.isMaximized = () => false;
    chat.isMinimized = () => true;
    chat.move({ x: 140 });
    expect(doc.getBounds().x).toBe(500);
    chat.isMinimized = () => false;
    chat.isFullScreen = () => true;
    chat.move({ x: 150 });
    expect(doc.getBounds().x).toBe(500);
    chat.isFullScreen = () => false;
    chat.emit("leave-full-screen");
    expect(doc.getBounds().x).toBe(550);
  });

  it("does not translate partners by the maximized-to-normal size delta", () => {
    const { controller, chat, doc } = fixture();
    controller.set("doc", "chat");
    chat.isMaximized = () => true;
    chat.move({ x: 0, y: 0, width: 1800, height: 1000 });
    chat.isMaximized = () => false;
    chat.move({ x: 100, y: 100, width: 400, height: 600 });
    chat.emit("unmaximize");
    expect(doc.getBounds()).toMatchObject({ x: 500, y: 100 });
  });

  it("drops a closed document's ephemeral link and accepts detach after close", () => {
    const { controller, chat, doc } = fixture();
    controller.set("doc", "chat");
    doc.emit("closed");
    expect(controller.set("doc", null)).toBe(false);
    const reopened = surface({ x: 40, y: 80, width: 500, height: 700 });
    controller.register("doc", reopened);
    chat.move({ x: 200 });
    expect(reopened.getBounds()).toMatchObject({ x: 40, y: 80 });
  });

  it("uses the left side near the right display edge and clamps group movement", () => {
    const { controller, chat, doc } = fixture(1000);
    chat.move({ x: 600 });
    controller.set("doc", "chat");
    expect(doc.getBounds().x).toBe(100);
    doc.move({ x: -100, y: 180 });
    expect(doc.getBounds().x).toBe(0);
    expect(chat.getBounds()).toMatchObject({ x: 500, y: 180 });
  });

  it("preserves saved offset when right-side preference must restore on the left", () => {
    const { controller, chat, doc } = fixture(1000);
    chat.move({ x: 600, y: 100 });
    doc.move({ x: 100, y: 160 });
    controller.set("doc", "chat");
    expect(doc.getBounds()).toMatchObject({ x: 100, y: 160 });
  });

  it("keeps separate windows visible when the pair cannot fit on any display", () => {
    const { controller, chat, doc } = fixture(800);
    const original = doc.getBounds();
    expect(controller.set("doc", "chat")).toBe(true);
    expect(doc.getBounds()).toEqual(original);
    chat.move({ x: 200 });
    expect(doc.getBounds()).toEqual(original);
  });

  it("supports negative monitor coordinates without changing sizes", () => {
    const controller = new NativeWindowAttachments(() => [{ id: "left", workArea: { x: -1600, y: -100, width: 1600, height: 1000 } }]);
    const chat = surface({ x: -1500, y: 100, width: 400, height: 600 });
    const doc = surface({ x: 10, y: 10, width: 500, height: 700 });
    controller.register("chat", chat); controller.register("doc", doc);
    controller.set("doc", "chat");
    expect(doc.getBounds()).toEqual({ x: -1100, y: 100, width: 500, height: 700 });
  });
});
