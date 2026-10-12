import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";

const checkout = fileURLToPath(new URL("../../../", import.meta.url));
const channel = (name) => `spec-harness:${name}`;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "spec-detached-test-"));
  const handlers = new Map(),
    windows = [],
    timers = new Set();
  let quitting = false,
    failAttach = false,
    attaches = 0;
  const make = () => {
    const listeners = new Map(),
      contentsListeners = new Map();
    const win = {
      destroyed: false,
      visible: true,
      messages: [],
      listeners,
      webContents: {
        id: windows.length + 1,
        send: (...args) => win.messages.push(args),
        on: (name, callback) => contentsListeners.set(name, callback),
      },
      contentsListeners,
      isDestroyed: () => win.destroyed,
      on: (name, callback) => listeners.set(name, callback),
      hide: () => {
        win.visible = false;
      },
      show: () => {
        win.visible = true;
      },
      destroy: () => {
        win.destroyed = true;
        listeners.get("closed")?.();
      },
      close: () => {
        let prevented = false;
        listeners.get("close")?.({
          preventDefault: () => {
            prevented = true;
          },
        });
        if (!prevented) win.destroy();
        return prevented;
      },
    };
    windows.push(win);
    return win;
  };
  const owner = make(),
    outsider = make();
  const exports = {};
  const ts = createRequire(join(checkout, "package.json"))("typescript");
  const source = readFileSync(
    new URL("../src/main/specDetachedPanels.ts", import.meta.url),
    "utf8",
  );
  runInNewContext(
    ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText,
    {
      exports,
      Buffer,
      setTimeout: (callback) => {
        timers.add(callback);
        return callback;
      },
      clearTimeout: (callback) => timers.delete(callback),
      require: (name) =>
        name === "electron"
          ? {
              BrowserWindow: {
                fromWebContents: (contents) => windows.find((win) => win.webContents === contents),
              },
              ipcMain: {
                handle: (name, callback) => handlers.set(name, callback),
                on: (name, callback) => handlers.set(name, callback),
              },
            }
          : createRequire(import.meta.url)(name),
    },
  );
  exports.registerSpecDetachedPanels({
    getOwnerAllowed: (win) => win === owner,
    create: make,
    attach: () => {
      attaches++;
      if (failAttach) throw Error("attach failed");
    },
    isQuitting: () => quitting,
  });
  const call = (name, win, input) =>
    handlers.get(channel(name))({ sender: win.webContents }, input);
  const target = {
    kind: "document",
    workspacePath: root,
    panelKey: "document:one",
    path: "draft.md",
    state: { selection: 10 },
  };
  const start = () => call("detach-panel", owner, target);
  const prepare = (transaction) => {
    call("panel-detach-prepared", owner, transaction);
    return windows.at(-1);
  };
  return {
    root,
    windows,
    owner,
    outsider,
    call,
    target,
    start,
    prepare,
    expire: () => {
      for (const callback of [...timers]) callback();
    },
    setQuit: () => {
      quitting = true;
    },
    setFailAttach: () => {
      failAttach = true;
    },
    attaches: () => attaches,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("detached ownership commits only after quiesced source and ready attached child; reverse handoff is ordered", () => {
  const f = fixture();
  try {
    const transfer = f.start();
    assert.equal(f.windows.length, 2, "Source quiesce precedes child creation");
    assert.throws(() => f.start(), /already detached/);
    f.call("panel-detach-prepared", f.outsider, transfer);
    assert.equal(f.windows.length, 2);
    const child = f.prepare(transfer);
    assert.equal(f.attaches(), 1);
    assert.equal(child.visible, false);
    assert.equal(f.owner.close(), true, "Owner cannot close with transferred panels");
    f.owner.hide();
    assert.equal(f.owner.visible, false, "Owner may hide");
    f.call("panel-detached-ready", f.owner, transfer);
    assert.equal(child.visible, false);
    f.call("panel-detached-ready", child, transfer);
    assert.equal(child.visible, true);
    assert.throws(() => f.call("panel-reattach", f.outsider, transfer), /owner required/);
    assert.equal(child.close(), true, "Child close initiates return without destroying ownership");
    const sourcePrepareCount = () =>
      f.owner.messages.filter(([name]) => name === channel("panel-reattach-prepare")).length;
    assert.equal(sourcePrepareCount(), 0, "Owner cannot remount until detached child quiesces");
    f.call("panel-reattach-prepared", f.owner, transfer);
    assert.equal(child.destroyed, false, "Premature owner ACK ignored");
    f.call("panel-reattach-quiesced", child, { ...transfer, state: { selection: 20 } });
    assert.equal(sourcePrepareCount(), 1);
    assert.equal(f.owner.messages.at(-1)[1].target.state.selection, 20);
    f.call("panel-reattach-prepared", child, transfer);
    assert.equal(child.destroyed, false);
    f.call("panel-reattach-prepared", f.owner, transfer);
    assert.equal(child.destroyed, true);
    assert.equal(f.owner.visible, true);
    f.call("panel-detached-ready", child, transfer);
    f.call("panel-detach-prepared", f.owner, transfer);
    assert.equal(f.windows.length, 3, "Stale ACKs cannot resurrect a transfer");
    assert.doesNotThrow(() => f.start(), "Reattached panel key is reusable");
  } finally {
    f.cleanup();
  }
});

test("Return during startup is queued; repeated Return and close preserve one ordered handoff", () => {
  for (const requestBeforePrepare of [true, false]) {
    const f = fixture();
    try {
      const transfer = f.start();
      if (requestBeforePrepare) f.call("panel-reattach", f.owner, transfer);
      const child = f.prepare(transfer);
      f.call("panel-reattach", f.owner, transfer);
      assert.equal(f.call("panel-detached-state", child).phase, "booting");
      assert.equal(child.messages.length, 0, "Return waits for child readiness");
      f.call("panel-detached-ready", child, transfer);
      assert.equal(f.call("panel-detached-state", child).phase, "quiescing");
      assert.equal(child.visible, false, "Queued Return does not flash a child window");
      f.call("panel-reattach", f.owner, transfer);
      f.call("panel-reattach", child, { ...transfer, state: { selection: 999 } });
      child.close();
      assert.equal(
        child.messages.filter(([name]) => name === channel("panel-reattach-prepare")).length,
        1,
      );
      f.call("panel-reattach-quiesced", child, { ...transfer, state: { selection: 25 } });
      f.call("panel-reattach", f.owner, { ...transfer, state: { selection: 999 } });
      assert.equal(
        f.call("panel-detached-state", child).target.state.selection,
        25,
        "Repeated Return cannot overwrite the quiesced state",
      );
      assert.equal(
        f.owner.messages.filter(([name]) => name === channel("panel-reattach-prepare")).length,
        1,
      );
      f.call("panel-reattach-prepared", f.owner, transfer);
      assert.equal(child.destroyed, true);
      assert.doesNotThrow(() => f.start());
    } finally {
      f.cleanup();
    }
  }
});

test("timeouts and attachment failures restore owner; failed reattachment retains detached owner", () => {
  const f = fixture();
  try {
    f.start();
    f.expire();
    assert.equal(f.owner.messages.at(-1)[0], channel("panel-detach-rollback"));
    const second = f.start(),
      child = f.prepare(second);
    f.expire();
    assert.equal(child.destroyed, true);
    f.setFailAttach();
    const third = f.start();
    f.prepare(third);
    assert.equal(f.windows.at(-1).destroyed, true);
    assert.match(f.owner.messages.at(-1)[1].reason, /attach/);
  } finally {
    f.cleanup();
  }
  const g = fixture();
  try {
    const transfer = g.start(),
      child = g.prepare(transfer);
    g.call("panel-detached-ready", child, transfer);
    g.call("panel-reattach", child, transfer);
    g.expire();
    assert.equal(child.destroyed, false);
    assert.equal(child.messages.at(-1)[0], channel("panel-reattach-rollback"));
    assert.equal(g.owner.messages.at(-1)[0], channel("panel-reattach-rollback"));
    assert.doesNotThrow(() => g.call("panel-reattach", child, transfer));
    g.setQuit();
    assert.equal(g.owner.close(), false, "Application quit bypasses close guard");
    assert.equal(child.destroyed, true, "Owner closure cleans auxiliary child");
  } finally {
    g.cleanup();
  }
});

test("renderer crash during Return quiescing destroys the child, restores the owner pane and frees the source window", () => {
  const f = fixture();
  try {
    const transfer = f.start(),
      child = f.prepare(transfer);
    f.call("panel-detached-ready", child, transfer);
    f.call("panel-reattach", f.owner, transfer);
    assert.equal(f.call("panel-detached-state", child).phase, "quiescing");
    child.contentsListeners.get("render-process-gone")();
    assert.equal(child.destroyed, true, "Crashed child is destroyed instead of re-shown");
    assert.equal(f.owner.messages.at(-1)[0], channel("panel-detach-rollback"));
    assert.equal(
      [...f.owner.messages, ...child.messages].some(
        ([name]) => name === channel("panel-reattach-rollback"),
      ),
      false,
      "A dead renderer must not be asked to keep the panel",
    );
    const ownerMessages = f.owner.messages.length,
      childMessages = child.messages.length;
    f.expire();
    assert.equal(f.owner.messages.length, ownerMessages, "No timeout loop stays armed after crash");
    assert.equal(child.messages.length, childMessages);
    assert.throws(() => f.call("panel-reattach", child, transfer), /owner required/);
    assert.throws(() => f.call("panel-detached-state", child), /Detached panel required/);
    assert.equal(f.owner.close(), false, "Source window is closable after crash recovery");
    assert.equal(f.owner.destroyed, true);
  } finally {
    f.cleanup();
  }
});

test("renderer crash during source restoration destroys the child and leaves no stranded handoff", () => {
  const f = fixture();
  try {
    const transfer = f.start(),
      child = f.prepare(transfer);
    f.call("panel-detached-ready", child, transfer);
    f.call("panel-reattach", f.owner, transfer);
    f.call("panel-reattach-quiesced", child, transfer);
    assert.equal(f.call("panel-detached-state", child).phase, "reattaching");
    assert.equal(f.owner.messages.at(-1)[0], channel("panel-reattach-prepare"));
    child.contentsListeners.get("render-process-gone")();
    assert.equal(child.destroyed, true);
    assert.equal(f.owner.messages.at(-1)[0], channel("panel-detach-rollback"));
    f.call("panel-reattach-prepared", f.owner, transfer);
    assert.equal(
      f.owner.messages.at(-1)[0],
      channel("panel-detach-rollback"),
      "Late owner ACK cannot commit a return whose child crashed",
    );
    const again = f.start();
    assert.notEqual(again.transferId, transfer.transferId);
    assert.equal(f.windows.length, 3, "Recovery reuses the owner window without leftover panels");
    f.expire();
    assert.equal(f.owner.messages.at(-1)[0], channel("panel-detach-rollback"));
    assert.equal(f.owner.close(), false, "Source window is closable after crash recovery");
    assert.equal(f.owner.destroyed, true);
  } finally {
    f.cleanup();
  }
});

test("IPC refuses external senders, arbitrary targets and nonserializable or oversized state", () => {
  const f = fixture();
  try {
    assert.throws(() => f.call("detach-panel", f.outsider, f.target), /owner window/);
    for (const input of [
      { ...f.target, kind: "host" },
      { ...f.target, workspacePath: "../relative" },
      { ...f.target, url: "https://external.invalid" },
      { ...f.target, hostId: "other" },
      { ...f.target, sessionId: "../outside" },
      { ...f.target, state: { fn() {} } },
      { ...f.target, state: "x".repeat(8 * 1024 * 1024 + 1) },
    ])
      assert.throws(() => f.call("detach-panel", f.owner, input));
    const cyclic = {};
    cyclic.self = cyclic;
    assert.throws(
      () => f.call("detach-panel", f.owner, { ...f.target, state: cyclic }),
      /Serializable/,
    );
    const transfer = f.start(),
      child = f.prepare(transfer);
    assert.throws(() => f.call("panel-detached-state", f.outsider), /Detached panel required/);
    assert.equal(f.call("panel-detached-state", child).transferId, transfer.transferId);
    assert.throws(
      () => f.call("detach-panel", child, { ...f.target, panelKey: "nested" }),
      /owner window|another panel/,
    );
    f.call("panel-detached-ready", child, transfer);
    child.contentsListeners.get("render-process-gone")();
    assert.equal(child.destroyed, true);
    assert.equal(f.owner.messages.at(-1)[0], channel("panel-detach-rollback"));
  } finally {
    f.cleanup();
  }
});
