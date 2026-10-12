import { BrowserWindow, ipcMain } from "electron";
import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";

export type SpecDetachedPanelTarget = {
  kind: "chat" | "document" | "side-chat";
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId?: string;
  path?: string;
  panelKey: string;
  state?: unknown;
};
const channel = (name: string) => `spec-harness:${name}`;
const TIMEOUT = 15_000;
const STATE_LIMIT = 8 * 1024 * 1024;

function serializableState(state: unknown): unknown {
  if (state === undefined) return undefined;
  const ancestors = new Set<object>();
  const visit = (value: unknown, depth: number) => {
    if (depth > 100) throw new Error("Panel state nesting limit exceeded");
    if (value === null || typeof value === "string" || typeof value === "boolean") return;
    if (typeof value === "number" && Number.isFinite(value)) return;
    if (typeof value !== "object" || ancestors.has(value))
      throw new Error("Serializable panel state required");
    if (!Array.isArray(value) && Object.prototype.toString.call(value) !== "[object Object]")
      throw new Error("Serializable panel state required");
    ancestors.add(value);
    for (const item of Object.values(value)) visit(item, depth + 1);
    ancestors.delete(value);
  };
  visit(state, 0);
  const encoded = JSON.stringify(state);
  if (Buffer.byteLength(encoded, "utf8") > STATE_LIMIT) throw new Error("Panel state exceeds 8 MB");
  return JSON.parse(encoded);
}

function validateTarget(input: unknown): SpecDetachedPanelTarget {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Panel target required");
  const value = input as Record<string, unknown>;
  const allowed = new Set([
    "kind",
    "workspacePath",
    "workspaceIdentity",
    "sessionId",
    "path",
    "panelKey",
    "state",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key)))
    throw new Error("Unsupported panel target field");
  if (!["chat", "document", "side-chat"].includes(value.kind as string))
    throw new Error("Invalid panel kind");
  const text = (name: string, maximum: number, required = false) => {
    const field = value[name];
    if (field === undefined && !required) return undefined;
    if (
      typeof field !== "string" ||
      !field.trim() ||
      field.length > maximum ||
      /[\x00-\x1f]/.test(field)
    )
      throw new Error(`Invalid ${name}`);
    return field;
  };
  const workspacePath = text("workspacePath", 4096, true)!;
  if (
    !isAbsolute(workspacePath) ||
    !existsSync(workspacePath) ||
    !statSync(workspacePath).isDirectory()
  )
    throw new Error("Existing local absolute workspace required");
  const panelKey = text("panelKey", 256, true)!;
  const sessionId = text("sessionId", 256);
  if (sessionId && !/^[A-Za-z0-9._:-]+$/.test(sessionId)) throw new Error("Invalid sessionId");
  return {
    kind: value.kind as SpecDetachedPanelTarget["kind"],
    workspacePath,
    panelKey,
    workspaceIdentity: text("workspaceIdentity", 4096),
    sessionId,
    path: text("path", 4096),
    state: serializableState(value.state),
  };
}

/** Main coordinates ownership only. Host attachment and renderer fencing remain injected boundaries. */
export function registerSpecDetachedPanels(options: {
  getOwnerAllowed: (win: BrowserWindow) => boolean;
  create: (
    source: BrowserWindow,
    target: SpecDetachedPanelTarget,
    transferId: string,
  ) => BrowserWindow;
  attach: (source: BrowserWindow, child: BrowserWindow) => void;
  restoreSource?: (source: BrowserWindow, target: SpecDetachedPanelTarget) => void;
  getMain?: () => BrowserWindow | null | undefined;
  isQuitting?: () => boolean;
}) {
  type Transfer = {
    id: string;
    key: string;
    source: BrowserWindow;
    target: SpecDetachedPanelTarget;
    child?: BrowserWindow;
    phase: "preparing" | "booting" | "detached" | "quiescing" | "reattaching";
    closing: boolean;
    returnRequested?: boolean;
    timer?: ReturnType<typeof setTimeout>;
  };
  const transfers = new Map<string, Transfer>();
  const panels = new Map<string, Transfer>();
  const guarded = new WeakSet<BrowserWindow>();
  const send = (win: BrowserWindow, name: string, value: unknown) => {
    if (!win.isDestroyed()) win.webContents.send(channel(name), value);
  };
  const payload = (transfer: Transfer) => ({ transferId: transfer.id, target: transfer.target });
  const cancelTimer = (transfer: Transfer) => {
    if (transfer.timer) clearTimeout(transfer.timer);
    transfer.timer = undefined;
  };
  const discard = (transfer: Transfer) => {
    cancelTimer(transfer);
    transfers.delete(transfer.id);
    panels.delete(transfer.key);
  };
  const rollback = (transfer: Transfer, reason: string) => {
    if (!transfers.has(transfer.id)) return;
    cancelTimer(transfer);
    if (
      (transfer.phase === "reattaching" || transfer.phase === "quiescing") &&
      !transfer.source.isDestroyed() &&
      transfer.child &&
      !transfer.child.isDestroyed()
    ) {
      transfer.phase = "detached";
      send(transfer.source, "panel-reattach-rollback", { ...payload(transfer), reason });
      send(transfer.child, "panel-reattach-rollback", { ...payload(transfer), reason });
      transfer.child.show();
      return;
    }
    discard(transfer);
    transfer.closing = true;
    if (transfer.child && !transfer.child.isDestroyed()) transfer.child.destroy();
    send(transfer.source, "panel-detach-rollback", { ...payload(transfer), reason });
  };
  const arm = (transfer: Transfer) => {
    cancelTimer(transfer);
    transfer.timer = setTimeout(
      () => rollback(transfer, "Panel ownership transfer timed out"),
      TIMEOUT,
    );
  };
  const owner = (sender: Electron.WebContents) => {
    const win = BrowserWindow.fromWebContents(sender);
    if (!win || win.isDestroyed() || !options.getOwnerAllowed(win))
      throw new Error("Application owner window required");
    if ([...transfers.values()].some((transfer) => transfer.child === win))
      throw new Error("Detached panel cannot own another panel");
    return win;
  };
  const lookup = (input: unknown) => {
    const id =
      input && typeof input === "object"
        ? (input as { transferId?: unknown }).transferId
        : undefined;
    return typeof id === "string" ? transfers.get(id) : undefined;
  };
  const reattach = (transfer: Transfer, state?: unknown) => {
    if (transfer.source.isDestroyed()) throw new Error("Panel owner is unavailable");
    // Close and Return may race, or the source may request Return while the child boots.
    // A repeated request must not restart the ownership handshake or overwrite its state.
    if (
      transfer.phase === "quiescing" ||
      transfer.phase === "reattaching" ||
      transfer.returnRequested
    )
      return;
    if (state !== undefined)
      transfer.target = { ...transfer.target, state: serializableState(state) };
    if (transfer.phase === "preparing" || transfer.phase === "booting") {
      transfer.returnRequested = true;
      return;
    }
    transfer.phase = "quiescing";
    arm(transfer);
    send(transfer.child!, "panel-reattach-prepare", payload(transfer));
  };
  ipcMain.handle(channel("detach-panel"), (event, input: unknown) => {
    const source = owner(event.sender);
    const target = validateTarget(input);
    const key = `${source.webContents.id}:${target.panelKey}`;
    if (panels.has(key)) throw new Error("Panel already detached or transferring");
    const transfer: Transfer = {
      id: randomUUID(),
      key,
      source,
      target,
      phase: "preparing",
      closing: false,
    };
    transfers.set(transfer.id, transfer);
    panels.set(key, transfer);
    arm(transfer);
    if (!guarded.has(source)) {
      guarded.add(source);
      source.on("close", (event) => {
        if (
          !options.isQuitting?.() &&
          [...transfers.values()].some((item) => item.source === source)
        )
          event.preventDefault();
      });
      source.on("closed", () => {
        for (const item of [...transfers.values()])
          if (item.source === source) rollback(item, "Panel owner closed");
      });
    }
    try {
      send(source, "panel-detach-prepare", payload(transfer));
    } catch {
      rollback(transfer, "Unable to prepare panel owner");
      throw new Error("Unable to prepare panel owner");
    }
    return payload(transfer);
  });
  ipcMain.on(channel("panel-detach-prepared"), (event, input: unknown) => {
    const transfer = lookup(input);
    if (
      !transfer ||
      transfer.phase !== "preparing" ||
      transfer.source.isDestroyed() ||
      transfer.source.webContents !== event.sender
    )
      return;
    try {
      const state = (input as { state?: unknown }).state;
      if (state !== undefined)
        transfer.target = { ...transfer.target, state: serializableState(state) };
      transfer.phase = "booting";
      arm(transfer);
      const child = options.create(transfer.source, transfer.target, transfer.id);
      transfer.child = child;
      child.hide();
      child.on("close", (event) => {
        if (transfer.closing || options.isQuitting?.()) return;
        event.preventDefault();
        if (transfer.phase === "detached") reattach(transfer);
        else if (transfer.phase !== "reattaching" && transfer.phase !== "quiescing")
          rollback(transfer, "Detached panel closed before readiness");
      });
      child.on("closed", () => {
        if (!transfer.closing) rollback(transfer, "Detached panel closed unexpectedly");
      });
      child.webContents.on("render-process-gone", () =>
        rollback(transfer, "Detached panel renderer stopped"),
      );
      child.webContents.on("did-fail-load", (_event, code, _description, _url, isMainFrame) => {
        if (isMainFrame && code !== -3) rollback(transfer, "Detached panel failed to load");
      });
      options.attach(transfer.source, child);
    } catch {
      rollback(transfer, "Unable to create or attach detached panel");
    }
  });
  ipcMain.handle(channel("panel-detached-state"), (event) => {
    const transfer = [...transfers.values()].find(
      (item) => item.child && !item.child.isDestroyed() && item.child.webContents === event.sender,
    );
    if (!transfer) throw new Error("Detached panel required");
    return { ...payload(transfer), phase: transfer.phase };
  });
  ipcMain.on(channel("panel-detached-ready"), (event, input: unknown) => {
    const transfer = lookup(input);
    if (
      !transfer ||
      transfer.phase !== "booting" ||
      !transfer.child ||
      transfer.child.isDestroyed() ||
      transfer.child.webContents !== event.sender
    )
      return;
    try {
      transfer.phase = "detached";
      cancelTimer(transfer);
      send(transfer.source, "panel-detached", payload(transfer));
      send(transfer.child, "panel-detached", payload(transfer));
      if (transfer.returnRequested) {
        transfer.returnRequested = false;
        reattach(transfer);
      } else transfer.child.show();
    } catch {
      rollback(transfer, "Unable to commit detached panel");
    }
  });
  ipcMain.handle(channel("panel-reattach"), (event, input: unknown) => {
    const transfer = lookup(input);
    if (
      !transfer ||
      (transfer.source.webContents !== event.sender && transfer.child?.webContents !== event.sender)
    )
      throw new Error("Panel transfer owner required");
    reattach(transfer, (input as { state?: unknown }).state);
    return payload(transfer);
  });
  ipcMain.on(channel("panel-reattach-prepared"), (event, input: unknown) => {
    const transfer = lookup(input);
    if (
      !transfer ||
      transfer.phase !== "reattaching" ||
      transfer.source.isDestroyed() ||
      transfer.source.webContents !== event.sender
    )
      return;
    discard(transfer);
    transfer.closing = true;
    if (transfer.child && !transfer.child.isDestroyed()) transfer.child.destroy();
    send(transfer.source, "panel-reattached", payload(transfer));
    transfer.source.show();
  });
  ipcMain.on(channel("panel-reattach-quiesced"), (event, input: unknown) => {
    const transfer = lookup(input);
    if (
      !transfer ||
      transfer.phase !== "quiescing" ||
      !transfer.child ||
      transfer.child.isDestroyed() ||
      transfer.child.webContents !== event.sender
    )
      return;
    try {
      const state = (input as { state?: unknown }).state;
      if (state !== undefined)
        transfer.target = { ...transfer.target, state: serializableState(state) };
      transfer.phase = "reattaching";
      arm(transfer);
      options.restoreSource?.(transfer.source, transfer.target);
      send(transfer.source, "panel-reattach-prepare", payload(transfer));
    } catch {
      rollback(transfer, "Unable to prepare panel restoration");
    }
  });
  ipcMain.on(channel("panel-transfer-failed"), (event, input: unknown) => {
    const transfer = lookup(input);
    if (
      transfer &&
      (transfer.source.webContents === event.sender || transfer.child?.webContents === event.sender)
    )
      rollback(transfer, "Renderer rejected panel ownership transfer");
  });
}
