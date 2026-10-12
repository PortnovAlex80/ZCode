import { BrowserWindow, ipcMain, screen } from "electron";
import {
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";

const OPEN = "spec-harness:open-project-window";
const READY = "spec-harness:project-window-ready";
const TARGET = "spec-harness:project-window-target";
const STATE = "spec-harness:project-window-state";
const LABEL = "spec-harness:project-window-label";
const RETURN = "spec-harness:return-to-main";
const ACK = "spec-harness:project-window-target-ack";
type Target = { workspacePath: string; taskId?: string };
type Bounds = { x: number; y: number; width: number; height: number };

export function fitProjectWindow(bounds: Bounds, area: Bounds): Bounds {
  const width = Math.min(Math.max(480, bounds.width), area.width);
  const height = Math.min(Math.max(640, bounds.height), area.height);
  return {
    width,
    height,
    x: Math.max(area.x, Math.min(bounds.x, area.x + area.width - width)),
    y: Math.max(area.y, Math.min(bounds.y, area.y + area.height - height)),
  };
}

/** One Main coordinator; native Hosts retain task leases, command routing and stream mirrors. */
export function registerSpecProjectWindows(options: {
  stateDirectory: string;
  create: (workspacePath: string) => BrowserWindow;
  isApplicationWindow: (win: BrowserWindow) => boolean;
  getMainWindow?: () => BrowserWindow | null | undefined;
}) {
  const windows = new Map<string, BrowserWindow>();
  const targets = new Map<number, Target>();
  const ready = new Set<number>();
  const labels = new Map<number, { projectLabel?: string; sessionLabel?: string }>();
  const titledMain = new WeakSet<BrowserWindow>();
  let sequence = 0;
  type Transfer = {
    id: string;
    source: BrowserWindow;
    destination: BrowserWindow;
    destinationId: number;
    target: Target;
    sent: boolean;
    timer: ReturnType<typeof setTimeout>;
    resolve: () => void;
    reject: (error: Error) => void;
  };
  const transfers = new Map<number, Transfer>();
  const mainWindow = () => {
    const win = options.getMainWindow?.();
    return win && !win.isDestroyed() ? win : undefined;
  };
  const authorized = (event: { sender: Electron.WebContents }) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (
      !win ||
      !options.isApplicationWindow(win) ||
      (options.getMainWindow && win !== mainWindow() && !targets.has(event.sender.id))
    )
      throw new Error("Application window required");
    return win;
  };
  const role = (target?: Target) => (target ? (target.taskId ? "session" : "project") : "main");
  const title = (win: BrowserWindow, target?: Target) => {
    const label = labels.get(win.webContents.id);
    const project = label?.projectLabel || target?.workspacePath;
    win.setTitle(
      target
        ? `${target.taskId ? "Session" : "Project"} — ${project}${target.taskId ? ` — ${label?.sessionLabel || target.taskId}` : ""}`
        : "Spec Harness — Main",
    );
  };
  const sendTransfer = (transfer: Transfer) => {
    if (transfer.sent || !ready.has(transfer.destinationId)) return;
    if (transfer.destination.isDestroyed()) throw new Error("Main is unavailable");
    transfer.sent = true;
    transfer.destination.webContents.send(TARGET, {
      ...transfer.target,
      transactionId: transfer.id,
    });
  };
  const failTransfer = (contentsId: number, message: string) => {
    const transfer = transfers.get(contentsId);
    if (!transfer) return;
    clearTimeout(transfer.timer);
    transfers.delete(contentsId);
    transfer.reject(new Error(message));
  };
  const notifyLocations = () => {
    const receivers = new Set([mainWindow(), ...windows.values()]);
    for (const win of receivers)
      if (win && !win.isDestroyed()) win.webContents.send("spec-harness:project-windows-changed");
  };
  const statePath = join(options.stateDirectory, "spec-project-windows.json");
  let saved: Record<string, Bounds & { maximized?: boolean }> = {};
  try {
    const record = JSON.parse(readFileSync(statePath, "utf8"));
    if (record.version === 1 && record.windows && typeof record.windows === "object")
      saved = record.windows;
  } catch {
    /* Missing/corrupt layout does not block opening a project. */
  }
  ipcMain.on(READY, (event) => {
    try {
      authorized(event);
    } catch {
      return;
    }
    ready.add(event.sender.id);
    const target = targets.get(event.sender.id);
    if (target) event.sender.send(TARGET, target);
    const main = mainWindow();
    if (main && main.webContents.id === event.sender.id) {
      if (!titledMain.has(main)) {
        titledMain.add(main);
        main.on("page-title-updated", (event) => {
          event.preventDefault();
          title(main);
        });
      }
      title(main);
      for (const [contentsId, transfer] of transfers) {
        try {
          sendTransfer(transfer);
        } catch {
          failTransfer(contentsId, "Main is unavailable");
        }
      }
    }
  });
  ipcMain.handle(STATE, (event) => {
    authorized(event);
    const target = targets.get(event.sender.id);
    return {
      role: role(target),
      ...(target ? { target } : {}),
      windows: [...windows.values()]
        .filter((win) => !win.isDestroyed())
        .map((win) => ({
          role: role(targets.get(win.webContents.id)),
          target: targets.get(win.webContents.id),
          visible: win.isVisible(),
        })),
    };
  });
  ipcMain.handle(LABEL, (event, input: unknown) => {
    const win = authorized(event);
    if (!input || typeof input !== "object") throw new Error("Window labels required");
    const value = input as { projectLabel?: string; sessionLabel?: string };
    const clean = (label: unknown) => {
      if (label === undefined) return undefined;
      if (typeof label !== "string" || label.length > 240 || /[\r\n\x00-\x1f]/.test(label))
        throw new Error("Invalid window label");
      return label.trim() || undefined;
    };
    labels.set(event.sender.id, {
      projectLabel: clean(value.projectLabel),
      sessionLabel: clean(value.sessionLabel),
    });
    title(win, targets.get(event.sender.id));
  });
  ipcMain.handle(RETURN, (event) => {
    const source = authorized(event);
    const target = targets.get(event.sender.id);
    const destination = mainWindow();
    if (!target || !destination || source === destination)
      throw new Error("Project window and Main required");
    if (transfers.size) throw new Error("A return to Main is already pending");
    return new Promise<void>((resolve, reject) => {
      const transfer: Transfer = {
        id: `return-${++sequence}`,
        source,
        destination,
        destinationId: destination.webContents.id,
        target,
        sent: false,
        resolve,
        reject,
        timer: setTimeout(
          () => failTransfer(event.sender.id, "Main did not accept the project window"),
          15000,
        ),
      };
      transfers.set(event.sender.id, transfer);
      try {
        if (destination.isMinimized()) destination.restore();
        destination.show();
        sendTransfer(transfer);
      } catch {
        failTransfer(event.sender.id, "Main is unavailable");
      }
    });
  });
  ipcMain.on(ACK, (event, input: unknown) => {
    try {
      authorized(event);
    } catch {
      return;
    }
    if (!input || typeof input !== "object") return;
    const value = input as { transactionId?: string; ok?: boolean; error?: string };
    for (const [contentsId, transfer] of transfers) {
      if (
        !transfer.sent ||
        transfer.destinationId !== event.sender.id ||
        transfer.id !== value.transactionId
      )
        continue;
      if (value.ok !== true) {
        failTransfer(contentsId, "Main could not open the existing session");
        return;
      }
      if (transfer.source.isDestroyed() || transfer.destination.isDestroyed()) {
        failTransfer(contentsId, "Project window is unavailable");
        return;
      }
      try {
        transfer.destination.focus();
        transfer.source.hide();
      } catch {
        failTransfer(contentsId, "Project window could not return to Main");
        return;
      }
      clearTimeout(transfer.timer);
      transfers.delete(contentsId);
      transfer.resolve();
    }
  });
  ipcMain.handle(OPEN, (_event, input: unknown) => {
    authorized(_event);
    if (!input || typeof input !== "object") throw new Error("Project window target required");
    const value = input as Target;
    if (
      typeof value.workspacePath !== "string" ||
      !isAbsolute(value.workspacePath) ||
      !existsSync(value.workspacePath) ||
      !statSync(value.workspacePath).isDirectory()
    )
      throw new Error("Existing local project required");
    if (
      value.taskId !== undefined &&
      (typeof value.taskId !== "string" || !/^[\w-]{1,160}$/.test(value.taskId))
    )
      throw new Error("Invalid session identity");
    const target = {
      workspacePath: realpathSync(value.workspacePath),
      ...(value.taskId ? { taskId: value.taskId } : {}),
    };
    const key = `${target.workspacePath.toLowerCase()}::${target.taskId || "project"}`;
    const existing = windows.get(key);
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore();
      existing.show();
      existing.focus();
      existing.webContents.send(TARGET, target);
      return;
    }
    if ([...windows.values()].filter((win) => !win.isDestroyed() && win.isVisible()).length >= 12)
      throw new Error("Hide a project window before opening another (maximum 12 visible windows)");
    const win = options.create(target.workspacePath);
    const contentsId = win.webContents.id;
    windows.set(key, win);
    targets.set(contentsId, target);
    title(win, target);
    win.on("page-title-updated", (event) => {
      event.preventDefault();
      title(win, target);
    });
    const previous = saved[key];
    if (
      previous &&
      [previous.x, previous.y, previous.width, previous.height].every(Number.isFinite)
    ) {
      win.setBounds(fitProjectWindow(previous, screen.getDisplayMatching(previous).workArea));
      if (previous.maximized) win.maximize();
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const persist = () => {
      if (win.isDestroyed()) return;
      saved[key] = { ...win.getNormalBounds(), maximized: win.isMaximized() };
      const entries = Object.entries(saved).slice(-50);
      try {
        writeFileSync(
          `${statePath}.tmp`,
          JSON.stringify({ version: 1, windows: Object.fromEntries(entries) }),
        );
        renameSync(`${statePath}.tmp`, statePath);
      } catch {
        /* Window geometry is optional; runtime ownership never depends on it. */
      }
    };
    const changed = () => {
      clearTimeout(timer);
      timer = setTimeout(persist, 250);
    };
    win.on("show", notifyLocations);
    win.on("hide", notifyLocations);
    win.on("move", changed);
    win.on("resize", changed);
    win.on("close", () => {
      clearTimeout(timer);
      persist();
    });
    win.on("closed", () => {
      clearTimeout(timer);
      failTransfer(contentsId, "Project window closed before returning to Main");
      windows.delete(key);
      targets.delete(contentsId);
      ready.delete(contentsId);
      labels.delete(contentsId);
      notifyLocations();
    });
  });
}
