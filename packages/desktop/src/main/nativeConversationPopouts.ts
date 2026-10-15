import type { BrowserWindow, WindowOpenHandlerResponse } from "electron";

const children = new Set<number>();

export function isNativeConversationPopout(win: { id: number }): boolean {
  return children.has(win.id);
}

export function conversationPopoutOpenPolicy(details: {
  url: string;
  frameName: string;
}): WindowOpenHandlerResponse {
  if (
    details.url !== "about:blank" ||
    !/^zcode-conversation-[a-zA-Z0-9_-]+$/.test(details.frameName)
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
): void {
  const owned = new Set<BrowserWindow>();
  let hiddenForChildren = false;
  owner.webContents.setWindowOpenHandler(conversationPopoutOpenPolicy);
  owner.webContents.on("did-create-window", (child, details) => {
    if (!details.frameName.startsWith("zcode-conversation-")) return;
    children.add(child.id);
    owned.add(child);
    child.setMenu(null);
    child.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    // 修复根因：可迁移 UI 仅允许同源空白文档，禁止子窗口导航变成任意网站。
    child.webContents.on("will-navigate", (event) => event.preventDefault());
    child.on("closed", () => {
      children.delete(child.id);
      owned.delete(child);
      if (owned.size === 0 && hiddenForChildren && !owner.isDestroyed() && !isQuitting()) {
        hiddenForChildren = false;
        owner.show();
      }
    });
  });
  owner.on("close", (event) => {
    if (owned.size && !isQuitting()) {
      event.preventDefault();
      hiddenForChildren = true;
      owner.hide();
    }
  });
  owner.on("closed", () => {
    for (const child of owned) if (!child.isDestroyed()) child.destroy();
    owned.clear();
  });
}
