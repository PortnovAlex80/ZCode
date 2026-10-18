import type { BrowserWindow, WindowOpenHandlerResponse } from "electron";
import { join } from "node:path";
import {
  attachConversationGeometry,
  isConversationFrameName,
  NativeConversationGeometryStore,
  type ConversationDisplay,
} from "./nativeConversationGeometry.js";

const children = new Set<number>();
const captures = new Set<() => void>();
const attachments = new Set<Promise<void>>();
const owners = new Set<BrowserWindow>();
let geometryRuntime: Promise<ConversationGeometryRuntime> | undefined;

export interface ConversationGeometryRuntime {
  store: NativeConversationGeometryStore;
  getDisplays(): readonly ConversationDisplay[];
}

function getGeometryRuntime(): Promise<ConversationGeometryRuntime> {
  geometryRuntime ??= Promise.all([
    import("electron"),
    import("./logger.js"),
  ]).then(([{ app, screen }, { logger }]) => ({
    store: new NativeConversationGeometryStore(
      join(app.getPath("userData"), "conversation-window-geometry.json"),
      (error) =>
        logger.warn("[conversation-window] geometry persistence failed", error),
    ),
    getDisplays: () => screen.getAllDisplays(),
  }));
  return geometryRuntime;
}

/** Called from the existing app quit barrier before renderer/Host teardown. */
export async function flushNativeConversationGeometry(): Promise<void> {
  await Promise.all(attachments);
  for (const capture of captures) capture();
  if (geometryRuntime) await (await geometryRuntime).store.flush();
}

/** Await renderer acknowledgement before child close events can clear reopen intent. */
export async function markNativeConversationOwnersClosing(): Promise<void> {
  await Promise.all(Array.from(owners, async owner => {
    if (owner.isDestroyed()) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        owner.webContents.executeJavaScript('window.dispatchEvent(new Event("zcode:conversation-owner-closing"))').catch(() => undefined),
        new Promise(resolve => { timer = setTimeout(resolve, 1500); }),
      ]);
      // app.exit follows the Host shutdown barrier and can precede Chromium's
      // periodic DOM-storage commit. Flush the owner's partition while it is
      // still alive so the saved open collection is durable on cold restart.
      try {
        owner.webContents.session.flushStorageData();
        await owner.webContents.session.cookies.flushStore();
      } catch { /* A failed storage flush must not strand application shutdown. */ }
    } finally { if (timer) clearTimeout(timer); }
  }));
}

export function isNativeConversationPopout(win: { id: number }): boolean {
  return children.has(win.id);
}

export function conversationPopoutOpenPolicy(details: {
  url: string;
  frameName: string;
}): WindowOpenHandlerResponse {
  if (
    details.url !== "about:blank" ||
    !isConversationFrameName(details.frameName)
  ) {
    return { action: "deny" };
  }
  return {
    action: "allow",
    overrideBrowserWindowOptions: {
      title: "ZCode — Conversation",
      show: true,
      alwaysOnTop: true,
      autoHideMenuBar: true,
      minWidth: 320,
      minHeight: 240,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
      },
    },
  };
}

/** Native placement only: the existing React tree and Host remain the sole owners. */
export function installNativeConversationPopouts(
  owner: BrowserWindow,
  isQuitting: () => boolean,
  geometry?: ConversationGeometryRuntime,
): void {
  owners.add(owner);
  const owned = new Set<BrowserWindow>();
  let hiddenForChildren = false;
  owner.webContents.setWindowOpenHandler(conversationPopoutOpenPolicy);
  owner.webContents.on("did-create-window", (child, details) => {
    if (!isConversationFrameName(details.frameName)) return;
    children.add(child.id);
    owned.add(child);
    child.setMenu(null);
    child.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    // 修复根因：可迁移 UI 仅允许同源空白文档，禁止子窗口导航变成任意网站。
    child.webContents.on("will-navigate", (event) => event.preventDefault());
    // Geometry is Main-owned; presentation children receive no new privileged IPC.
    if (typeof child.getNormalBounds === "function") {
      const attachment = (async () => {
        const runtime = geometry ?? (await getGeometryRuntime());
        await runtime.store.ready;
        if (child.isDestroyed()) return;
        const capture = attachConversationGeometry(
          child,
          details.frameName,
          runtime.store,
          runtime.getDisplays,
        );
        captures.add(capture);
        child.on("closed", () => captures.delete(capture));
      })().catch(() => undefined);
      attachments.add(attachment);
      void attachment.finally(() => attachments.delete(attachment));
    }
    child.on("closed", () => {
      children.delete(child.id);
      owned.delete(child);
      if (
        owned.size === 0 &&
        hiddenForChildren &&
        !owner.isDestroyed() &&
        !isQuitting()
      ) {
        hiddenForChildren = false;
        owner.show();
      }
    });
  });
  owner.on("close", (event) => {
    for (const capture of captures) capture();
    if (owned.size && !isQuitting()) {
      event.preventDefault();
      hiddenForChildren = true;
      owner.hide();
    }
  });
  owner.on("closed", () => {
    owners.delete(owner);
    for (const child of owned) if (!child.isDestroyed()) child.destroy();
    owned.clear();
  });
}
