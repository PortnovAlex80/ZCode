// Focused fake-Electron coverage for checklist W-04: project/session/main roles and
// labels, locating and showing an existing view, duplicate refusal, and Return
// without spawning a second window. The production X-button wiring that hides a
// spec-harness window instead of closing it lives in
// packages/desktop/src/main/index.ts:1840-1849 (ZCODE_SPEC_HARNESS_WINDOWS gate,
// skipped on explicit Quit); these cases verify the coordinator semantics in
// specProjectWindows.ts that the wiring drives (hide keeps the view locatable,
// destroy ends it) plus the duplicate-panel refusal in specDetachedPanels.ts.
import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";

const checkout = fileURLToPath(new URL("../../../", import.meta.url));
const channel = (name) => `spec-harness:${name}`;
const settle = (promise) => Promise.resolve(promise);

function loadMainModule(relativePath, electron, timers) {
  const exports = {};
  const ts = createRequire(join(checkout, "package.json"))("typescript");
  const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
  runInNewContext(
    ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText,
    {
      exports,
      Buffer,
      setTimeout: (callback) => (timers.add(callback), callback),
      clearTimeout: (callback) => timers.delete(callback),
      require: (name) => (name === "electron" ? electron : createRequire(import.meta.url)(name)),
    },
  );
  return exports;
}

const electronStub = (windows, extra = {}) => ({
  BrowserWindow: { fromWebContents: (contents) => windows.find((w) => w.webContents === contents) },
  ipcMain: {
    handle: (name, callback) => extra.handlers.set(name, callback),
    on: (name, callback) => extra.handlers.set(name, callback),
  },
  ...(extra.screen ? { screen: extra.screen } : {}),
});

function makeWindow(registry) {
  const listeners = new Map();
  const contentsListeners = new Map();
  registry.nextId += 1;
  const win = {
    destroyed: false,
    visible: true,
    minimized: false,
    titles: [],
    messages: [],
    focusCount: 0,
    listeners,
    webContents: {
      id: registry.nextId,
      send: (...args) => win.messages.push(args),
      on: (name, callback) => contentsListeners.set(name, callback),
    },
    isDestroyed: () => win.destroyed,
    isVisible: () => win.visible,
    isMinimized: () => win.minimized,
    isMaximized: () => false,
    getNormalBounds: () => ({ x: 40, y: 40, width: 900, height: 700 }),
    setBounds: () => {},
    on: (name, callback) => listeners.set(name, callback),
    setTitle: (value) => win.titles.push(value),
    restore: () => {
      win.minimized = false;
      win.visible = true;
    },
    show: () => {
      win.visible = true;
      listeners.get("show")?.();
    },
    hide: () => {
      win.visible = false;
      listeners.get("hide")?.();
    },
    focus: () => {
      win.focusCount += 1;
    },
    destroy: () => {
      win.destroyed = true;
      listeners.get("closed")?.();
    },
    close: () => {
      let prevented = false;
      listeners.get("close")?.({ preventDefault: () => (prevented = true) });
      if (!prevented && !win.destroyed) win.destroy();
      return prevented;
    },
  };
  registry.windows.push(win);
  return win;
}

function projectFixture() {
  const root = mkdtempSync(join(tmpdir(), "spec-project-test-"));
  const stateDirectory = mkdtempSync(join(tmpdir(), "spec-project-state-"));
  const handlers = new Map();
  const timers = new Set();
  const registry = { windows: [], nextId: 0 };
  let created = 0;
  const main = makeWindow(registry);
  const outsider = makeWindow(registry);
  outsider.application = false;
  const { registerSpecProjectWindows } = loadMainModule(
    "../src/main/specProjectWindows.ts",
    electronStub(registry.windows, {
      handlers,
      screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }) },
    }),
    timers,
  );
  registerSpecProjectWindows({
    stateDirectory,
    create: () => {
      created += 1;
      return makeWindow(registry);
    },
    isApplicationWindow: (win) => win.application !== false,
    getMainWindow: () => main,
  });
  const call = (name, win, input) => handlers.get(channel(name))({ sender: win.webContents }, input);
  const count = (win, name) => win.messages.filter(([m]) => m === channel(name)).length;
  return {
    root,
    realRoot: realpathSync(root),
    windows: registry.windows,
    main,
    outsider,
    call,
    changed: (win) => count(win, "project-windows-changed"),
    targets: (win) => win.messages.filter(([m]) => m === channel("project-window-target")),
    created: () => created,
    expire: () => {
      for (const callback of Array.from(timers)) callback();
    },
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
      rmSync(stateDirectory, { recursive: true, force: true });
    },
  };
}

function detachedFixture() {
  const root = mkdtempSync(join(tmpdir(), "spec-duplicate-panel-test-"));
  const handlers = new Map();
  const timers = new Set();
  const registry = { windows: [], nextId: 0 };
  const owner = makeWindow(registry);
  makeWindow(registry);
  const { registerSpecDetachedPanels } = loadMainModule(
    "../src/main/specDetachedPanels.ts",
    electronStub(registry.windows, { handlers }),
    timers,
  );
  registerSpecDetachedPanels({
    getOwnerAllowed: (win) => win === owner,
    create: () => makeWindow(registry),
    attach: () => {},
    isQuitting: () => false,
  });
  const call = (name, win, input) => handlers.get(channel(name))({ sender: win.webContents }, input);
  const target = { kind: "document", workspacePath: root, panelKey: "document:one", path: "draft.md" };
  return {
    windows: registry.windows,
    owner,
    start: () => call("detach-panel", owner, target),
    prepare: (transfer) => {
      call("panel-detach-prepared", owner, transfer);
      return registry.windows.at(-1);
    },
    call,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("main/project/session roles and titles follow targets, labels and label validation", () => {
  const f = projectFixture();
  try {
    f.call("project-window-ready", f.main);
    assert.equal(f.main.titles.at(-1), "Spec Harness \u2014 Main");
    let state = f.call("project-window-state", f.main);
    assert.equal(state.role, "main");
    assert.equal("target" in state, false);

    f.call("open-project-window", f.main, { workspacePath: f.root });
    assert.equal(f.created(), 1);
    const project = f.windows.at(-1);
    assert.equal(project.titles.at(-1), `Project \u2014 ${f.realRoot}`);
    f.call("project-window-ready", project);
    assert.equal(f.targets(project).length, 1, "Ready project window receives its target");
    state = f.call("project-window-state", f.main);
    assert.equal(state.windows.map((w) => w.role).join(","), "project");
    assert.equal(state.windows[0].target.workspacePath, f.realRoot);
    assert.equal("taskId" in state.windows[0].target, false);
    assert.equal(f.call("project-window-state", project).role, "project");

    f.call("project-window-label", project, { projectLabel: "Alpha" });
    assert.equal(project.titles.at(-1), "Project \u2014 Alpha");
    assert.throws(() => f.call("project-window-label", project, { projectLabel: "x".repeat(241) }));
    assert.throws(() => f.call("project-window-label", project, { projectLabel: "a\nb" }));
    assert.throws(() => f.call("project-window-label", project, { projectLabel: 5 }));
    assert.throws(() => f.call("project-window-label", project, null));
    assert.equal(project.titles.at(-1), "Project \u2014 Alpha", "Invalid labels keep the last title");
    f.call("project-window-label", project, { projectLabel: "y".repeat(240) });
    f.call("project-window-label", project, { projectLabel: "   " });
    assert.equal(project.titles.at(-1), `Project \u2014 ${f.realRoot}`, "Blank label falls back to path");

    f.call("open-project-window", f.main, { workspacePath: f.root, taskId: "task-9" });
    assert.equal(f.created(), 2, "A session identity opens its own window");
    const session = f.windows.at(-1);
    f.call("project-window-ready", session);
    assert.equal(session.titles.at(-1), `Session \u2014 ${f.realRoot} \u2014 task-9`);
    f.call("project-window-label", session, { projectLabel: "Alpha", sessionLabel: "Beta" });
    assert.equal(session.titles.at(-1), "Session \u2014 Alpha \u2014 Beta");
    f.call("project-window-label", session, { projectLabel: "Alpha", sessionLabel: "  " });
    assert.equal(session.titles.at(-1), "Session \u2014 Alpha \u2014 task-9", "Blank session label falls back");
    assert.equal(project.titles.at(-1), `Project \u2014 ${f.realRoot}`, "Labels stay per window");
    assert.equal(f.call("project-window-state", session).role, "session");
    state = f.call("project-window-state", f.main);
    assert.equal(state.windows.map((w) => w.role).sort().join(","), "project,session");
    assert.equal(state.windows.find((w) => w.role === "session").target.taskId, "task-9");

    let prevented = false;
    f.main.listeners.get("page-title-updated")({ preventDefault: () => (prevented = true) });
    assert.equal(prevented, true, "Main keeps its coordinator-owned title");
    assert.equal(f.main.titles.at(-1), "Spec Harness \u2014 Main");
    assert.throws(() => f.call("project-window-state", f.outsider), /Application window required/);
    assert.throws(
      () => f.call("project-window-label", f.outsider, { projectLabel: "x" }),
      /Application window required/,
    );
  } finally {
    f.cleanup();
  }
});

test("opening an existing target shows the original window instead of spawning a duplicate", () => {
  const f = projectFixture();
  try {
    const open = (win, input) => f.call("open-project-window", win, input);
    f.call("project-window-ready", f.main);
    assert.throws(() => open(f.outsider, { workspacePath: f.root }), /Application window required/);
    assert.throws(() => open(f.main, { workspacePath: "relative/path" }), /Existing local project/);
    const filePath = join(f.root, "notes.txt");
    writeFileSync(filePath, "x");
    assert.throws(() => open(f.main, { workspacePath: filePath }), /Existing local project/);
    assert.throws(() => open(f.main, { workspacePath: f.root, taskId: "../bad" }), /Invalid session/);

    open(f.main, { workspacePath: f.root, taskId: "task-1" });
    const project = f.windows.at(-1);
    f.call("project-window-ready", project);
    assert.equal(f.targets(project).length, 1);

    f.call("open-project-window", f.main, { workspacePath: join(f.root, "."), taskId: "task-1" });
    assert.equal(f.created(), 1, "Same identity after realpath dedupe shows the original");
    assert.equal(f.windows.length, 3, "No duplicate window object exists");
    assert.equal(project.visible, true);
    assert.equal(project.focusCount, 1);
    assert.equal(f.targets(project).length, 2, "Shown window is re-targeted");

    project.minimized = true;
    project.hide();
    f.call("open-project-window", f.main, { workspacePath: f.root, taskId: "task-1" });
    assert.equal(f.created(), 1, "A hidden minimized view is restored, not respawned");
    assert.equal(project.minimized, false);
    assert.equal(project.visible, true);

    f.call("open-project-window", f.main, { workspacePath: f.root, taskId: "task-2" });
    assert.equal(f.created(), 2, "A different session identity opens its own window");
    f.call("open-project-window", f.main, { workspacePath: f.root, taskId: "task-2" });
    assert.equal(f.created(), 2);

    const session = f.windows.at(-1);
    session.close();
    assert.equal(
      f.call("project-window-state", f.main).windows.length,
      1,
      "A closed window leaves the locatable set",
    );
    f.call("open-project-window", f.main, { workspacePath: f.root, taskId: "task-2" });
    assert.equal(f.created(), 3, "A destroyed window is re-created, not resurrected");
  } finally {
    f.cleanup();
  }
});

test("Return reuses Main without spawning and settles only on the matching Main ACK", async () => {
  const f = projectFixture();
  try {
    f.call("project-window-ready", f.main);
    assert.throws(() => f.call("return-to-main", f.main), /Project window and Main required/);
    f.call("open-project-window", f.main, { workspacePath: f.root, taskId: "task-1" });
    const project = f.windows.at(-1);
    f.call("project-window-ready", project);

    const refused = settle(f.call("return-to-main", project));
    assert.equal(f.created(), 1, "Return does not spawn a window");
    assert.equal(f.main.visible, true, "Main is brought forward for the handoff");
    const target = f.targets(f.main).at(-1);
    assert.ok(target, "Main receives the session target");
    assert.equal(target[1].taskId, "task-1");
    assert.equal(typeof target[1].transactionId, "string");
    f.call("project-window-target-ack", project, { transactionId: target[1].transactionId, ok: true });
    f.call("project-window-target-ack", f.main, { transactionId: "not-mine", ok: true });
    f.call("project-window-target-ack", f.main, { transactionId: target[1].transactionId });
    await assert.rejects(refused, /Main could not open the existing session/);
    assert.equal(project.visible, true, "A refused handoff leaves the view in place");

    const returned = settle(f.call("return-to-main", project));
    const second = f.targets(f.main).at(-1);
    assert.notEqual(second[1].transactionId, target[1].transactionId);
    f.call("project-window-target-ack", f.main, { transactionId: second[1].transactionId, ok: true });
    await returned;
    assert.equal(f.main.focusCount, 1, "Main takes focus after accepting the return");
    assert.equal(project.visible, false, "The returned view hides instead of closing");
    assert.equal(project.destroyed, false);
    f.call("open-project-window", f.main, { workspacePath: f.root, taskId: "task-1" });
    assert.equal(f.created(), 1, "The hidden original is still the registered view");
    assert.equal(project.visible, true);

    f.call("open-project-window", f.main, { workspacePath: f.root, taskId: "task-2" });
    const other = f.windows.at(-1);
    f.call("project-window-ready", other);
    const pending = settle(f.call("return-to-main", other));
    assert.throws(() => f.call("return-to-main", project), /A return to Main is already pending/);
    f.expire();
    await assert.rejects(pending, /Main did not accept the project window/);
  } finally {
    f.cleanup();
  }
});

test("a return issued before Main is ready is delivered once Main appears", async () => {
  const f = projectFixture();
  try {
    f.call("open-project-window", f.main, { workspacePath: f.root });
    const project = f.windows.at(-1);
    f.call("project-window-ready", project);
    assert.equal(f.targets(f.main).length, 0, "Main gets nothing before it is ready");
    const returned = settle(f.call("return-to-main", project));
    assert.equal(f.targets(f.main).length, 0, "The target waits for Main readiness");
    f.call("project-window-ready", f.main);
    assert.equal(f.targets(f.main).length, 1, "Main ready flushes the pending target");
    const [, payload] = f.targets(f.main).at(-1);
    f.call("project-window-target-ack", f.main, { transactionId: payload.transactionId, ok: true });
    await returned;
    assert.equal(project.visible, false);
    assert.equal(f.created(), 1);
  } finally {
    f.cleanup();
  }
});

test("view close hides a locatable window; explicit destruction ends the view and fails its pending return", async () => {
  const f = projectFixture();
  try {
    f.call("project-window-ready", f.main);
    f.call("open-project-window", f.main, { workspacePath: f.root, taskId: "task-1" });
    const project = f.windows.at(-1);
    f.call("project-window-ready", project);

    const changedBefore = f.changed(f.main);
    project.hide();
    assert.equal(f.changed(f.main), changedBefore + 1, "Hiding broadcasts a locate signal");
    const state = f.call("project-window-state", f.main);
    assert.equal(state.windows.length, 1, "A hidden view stays listed for locating");
    assert.equal(state.windows[0].visible, false);
    assert.equal(project.destroyed, false, "A hidden view keeps its window and Hosts alive");
    f.call("open-project-window", f.main, { workspacePath: f.root, taskId: "task-1" });
    assert.equal(f.created(), 1, "Showing the hidden view again never spawns");

    const pending = settle(f.call("return-to-main", project));
    project.destroy();
    await assert.rejects(pending, /Project window closed before returning to Main/);
    assert.equal(f.call("project-window-state", f.main).windows.length, 0);
    f.call("open-project-window", f.main, { workspacePath: f.root, taskId: "task-1" });
    assert.equal(f.created(), 2, "Destruction frees the identity for a fresh window");
  } finally {
    f.cleanup();
  }
});

test("visible project windows are capped at twelve; hidden views never block showing an existing one", () => {
  const f = projectFixture();
  try {
    const open = (win, input) => f.call("open-project-window", win, input);
    f.call("project-window-ready", f.main);
    for (let index = 0; index < 12; index += 1)
      open(f.main, { workspacePath: f.root, taskId: `task-${index}` });
    assert.equal(f.created(), 12);
    assert.throws(() => open(f.main, { workspacePath: f.root, taskId: "task-new" }), /maximum 12/);
    assert.equal(f.created(), 12);
    open(f.main, { workspacePath: f.root, taskId: "task-3" });
    assert.equal(f.created(), 12, "Dedupe-show stays available at the cap");
    f.windows[2].hide();
    open(f.main, { workspacePath: f.root, taskId: "task-new" });
    assert.equal(f.created(), 13, "Hiding a view frees a visible slot");
  } finally {
    f.cleanup();
  }
});

test("a duplicate detach request is refused while the original panel returns cleanly", () => {
  const f = detachedFixture();
  try {
    const transfer = f.start();
    assert.throws(() => f.start(), /already detached/);
    const child = f.prepare(transfer);
    assert.throws(() => f.start(), /already detached/);
    f.call("panel-detached-ready", child, transfer);
    assert.equal(child.visible, true);
    f.call("panel-reattach", f.owner, transfer);
    f.call("panel-reattach-quiesced", child, transfer);
    f.call("panel-reattach-prepared", f.owner, transfer);
    assert.equal(child.destroyed, true, "Return releases the original child");
    assert.equal(f.owner.visible, true, "The original owner surface is restored");
    assert.equal(f.windows.length, 3, "Exactly one panel child ever existed");
    assert.doesNotThrow(() => f.start(), "The panel key is reusable after the return");
  } finally {
    f.cleanup();
  }
});
