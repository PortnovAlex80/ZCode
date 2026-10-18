import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attachConversationGeometry,
  NativeConversationGeometryStore,
  parseConversationGeometry,
  resolveConversationGeometry,
  type ConversationGeometry,
} from "../src/main/nativeConversationGeometry.js";

const monitors = [
  { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
  { id: 2, workArea: { x: -1920, y: 0, width: 1920, height: 1080 } },
];
const original: ConversationGeometry = {
  x: -1500,
  y: 90,
  width: 800,
  height: 700,
  maximized: false,
  displayId: "2",
};
const folders: string[] = [];
async function storeFixture() {
  const folder = await mkdtemp(join(tmpdir(), "zcode-native-geometry-"));
  folders.push(folder);
  const path = join(folder, "geometry.json");
  return { path, store: new NativeConversationGeometryStore(path) };
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    folders.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("native conversation geometry", () => {
  it("keeps negative monitor coordinates and independent maximized state", () => {
    expect(
      resolveConversationGeometry({ ...original, maximized: true }, monitors),
    ).toEqual({ ...original, maximized: true });
  });

  it("clamps a missing monitor and oversized bounds into the remaining DIP work area", () => {
    expect(
      resolveConversationGeometry({ ...original, width: 8000, height: 5000 }, [
        monitors[0]!,
      ]),
    ).toEqual({
      x: 0,
      y: 0,
      width: 1920,
      height: 1040,
      displayId: "1",
      maximized: false,
    });
    expect(resolveConversationGeometry(original, [])).toBeUndefined();
    expect(
      resolveConversationGeometry({ ...original, x: 2000, y: 900 }, [
        monitors[0]!,
      ]),
    ).toMatchObject({ x: 1120, y: 340 });
  });

  it("rejects corrupt, coercible, non-finite and unbounded stored coordinates", () => {
    for (const value of [
      null,
      {},
      { ...original, width: "800" },
      { ...original, x: NaN },
      { ...original, width: -1 },
      { ...original, y: 100001 },
      { ...original, maximized: 1 },
    ]) {
      expect(parseConversationGeometry(value)).toBeUndefined();
    }
    expect(parseConversationGeometry(original)).toEqual(original);
  });

  it("hydrates before serialized atomic saves and restores separate conversation keys", async () => {
    const { path } = await storeFixture();
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        windows: { "zcode-conversation-first": original },
      }),
    );
    const store = new NativeConversationGeometryStore(path);
    const second = { ...original, x: 50, displayId: "1" };
    await Promise.all([
      store.save("zcode-conversation-second", second),
      store.save("zcode-conversation-first", { ...original, maximized: true }),
    ]);
    const restored = new NativeConversationGeometryStore(path);
    await restored.ready;
    expect(restored.get("zcode-conversation-first")).toEqual({
      ...original,
      maximized: true,
    });
    expect(restored.get("zcode-conversation-second")).toEqual(second);
    expect(JSON.parse(await readFile(path, "utf8")).version).toBe(1);
    await store.save("bad/frame", original);
    expect(store.get("bad/frame")).toBeUndefined();
  });

  it("recovers from malformed storage without admitting invalid entries", async () => {
    const { path } = await storeFixture();
    await writeFile(path, "{broken");
    const onError = vi.fn();
    const store = new NativeConversationGeometryStore(path, onError);
    await store.save("zcode-conversation-valid", original);
    expect(onError).toHaveBeenCalledOnce();
    const restored = new NativeConversationGeometryStore(path);
    await restored.ready;
    expect(restored.get("zcode-conversation-valid")).toEqual(original);
  });

  it("restores normal bounds, debounces movement and captures pending geometry on close", async () => {
    const { store } = await storeFixture();
    await store.save("zcode-conversation-one", {
      ...original,
      maximized: true,
    });
    let bounds = { ...original };
    let maximized = false;
    let destroyed = false;
    const win = Object.assign(new EventEmitter(), {
      isDestroyed: () => destroyed,
      getNormalBounds: () => bounds,
      isMaximized: () => maximized,
      setBounds: vi.fn((next) => {
        bounds = next;
      }),
      maximize: vi.fn(() => {
        maximized = true;
      }),
    });
    const save = vi.spyOn(store, "save");
    vi.useFakeTimers();
    attachConversationGeometry(
      win,
      "zcode-conversation-one",
      store,
      () => monitors,
    );
    expect(win.setBounds).toHaveBeenCalledWith({
      x: -1500,
      y: 90,
      width: 800,
      height: 700,
    });
    expect(win.maximize).toHaveBeenCalledOnce();
    bounds = { ...original, x: -1300, width: 900 };
    win.emit("move");
    win.emit("resize");
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    expect(save).toHaveBeenCalledOnce();
    bounds = { ...original, x: 25, y: 40 };
    maximized = false;
    win.emit("move");
    win.emit("close");
    destroyed = true;
    win.emit("closed");
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
    await store.flush();
    expect(store.get("zcode-conversation-one")).toEqual({
      ...original,
      x: 25,
      y: 40,
      displayId: "1",
    });
  });
});
