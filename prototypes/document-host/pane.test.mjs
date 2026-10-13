import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

// pane.js（经 interactions.js）import "./client.js"——该文件只存在于部署产物
// （Build-Document-Pane.ps1 把 packages/ui/src/document-host/client.ts 打包为 client.js）。
// 聚焦测试不启动浏览器/网关，用 in-process module hooks 把该 specifier 解析为
// 可控 stub；真实 client 行为由 packages/ui/src/document-host/client.test.ts 覆盖。
// 原因（T-10）：stub 旧的 buildElicitationResponseContent 是空壳假 builder，聚焦测试
// 无法证明面板答案真的走共享 builder。修复依据：从真实源码模块直接 re-export 同一个
// 函数（Node 24 原生剥离 TS 类型；该模块只有 type-import，无运行时桌面依赖），
// 桌面 ElicitationDialog 与面板由此共享同一实现，测试用恒等断言钉住这层共享。
// T-07 的结构守卫在 packages/ui/src/document-host/paneStructureGuard.test.mjs。
const BUILDER_URL = new URL("../../packages/ui/src/lib/elicitationResponse.ts", import.meta.url).href;
const STUB_CLIENT_SOURCE = `
import { buildElicitationResponseContent } from "${BUILDER_URL}";
globalThis.__paneStubBuilder = buildElicitationResponseContent;
export { buildElicitationResponseContent };
export class DocumentSessionClient {
  constructor(adapter, changed, failed) {
    Object.assign(this, { adapter, changed, failed, connected: false, sessionId: null, projectPath: "D:/Fixture", unresolvedCommands: [], proposals: new Map(), snapshot: null, state: null, loadingOlder: false, hasOlderRows: false });
    globalThis.__paneStubClient = this;
  }
  async connect() { return []; } disconnect() {} async open() {} async create() { return "created-1"; }
  async side() { return "side-1"; } async command() {} async reconcile() { return []; } acknowledgeUnknown() {}
  async apply() {} async loadOlder() {}
}
`;
const STUB_URL = "stub:document-host-client";
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./client.js" && context.parentURL?.includes("/prototypes/document-host/"))
      return { url: STUB_URL, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === STUB_URL) return { format: "module", source: STUB_CLIENT_SOURCE, shortCircuit: true };
    return nextLoad(url, context);
  },
});

const { mountDocumentPane } = await import("./pane.js");

class FakeElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase(); this.parent = null; this.children = []; this.handlers = new Map();
    this.dataset = {}; this.className = ""; this.hidden = false; this.disabled = false; this.checked = false;
    this.title = ""; this.open = true; this.scrollHeight = 0; this.scrollTop = 0; this.clientHeight = 0;
    this.selectionStart = 0; this.selectionEnd = 0; this._value = "";
    const classes = new Set();
    this.classList = {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      toggle: (name, force) => {
        const on = force === undefined ? !classes.has(name) : Boolean(force);
        if (on) classes.add(name);
        else classes.delete(name);
        return on;
      },
      contains: (name) => classes.has(name),
    };
  }
  get value() { return this._value; }
  // 真实 DOM 语义：对 value 赋值会把光标重置到末尾。模拟该行为后，任何在流式
  // 重渲中重复赋 value 的回归都会破坏 selection 断言（T-10 测试的判别力来源）。
  set value(value) { this._value = String(value); this.selectionStart = this.selectionEnd = this._value.length; }
  get textContent() {
    return this.children.map((child) => (child && typeof child.textContent === "string" ? child.textContent : (child?.text ?? ""))).join("");
  }
  // 真实 DOM 语义：replaceChildren/remove 掉持有焦点的元素会把 activeElement 归还
  // body，而 insertBefore/append 的移动不改变焦点。按此建模，流式保焦断言才能区分
  // 「结构化保留」与「整树重建」。
  set textContent(value) { this.replaceChildren({ text: String(value) }); }
  focus() { globalThis.document.activeElement = this; }
  blur() { if (globalThis.document.activeElement === this) globalThis.document.activeElement = globalThis.document.body; }
  setParent(parent) {
    if (this.parent) this.parent.children = this.parent.children.filter((item) => item !== this);
    this.parent = parent;
    if (parent && !parent.children.includes(this)) parent.children.push(this);
  }
  addEventListener(type, listener) { this.handlers.set(type, [...(this.handlers.get(type) ?? []), listener]); }
  async fire(type, event = {}) {
    for (const listener of this.handlers.get(type) ?? []) await listener({ preventDefault() {}, ...event });
  }
  append(...nodes) {
    for (const node of nodes) {
      if (node && typeof node.setParent === "function") node.setParent(this);
      else this.children.push(node);
    }
  }
  replaceChildren(...nodes) {
    for (const child of this.children) { child.parent = null; child.blur?.(); }
    this.children = [];
    this.append(...nodes);
  }
  insertBefore(node, reference) {
    node.parent?.removeChild(node); node.parent = this;
    const index = reference ? this.children.indexOf(reference) : -1;
    if (index === -1) this.children.push(node);
    else this.children.splice(index, 0, node);
  }
  removeChild(node) { this.children = this.children.filter((item) => item !== node); }
  remove() { this.parent?.removeChild(this); this.parent = null; this.blur(); }
  after(...nodes) {
    for (const node of nodes) {
      node.parent?.removeChild(node); node.parent = this.parent;
      if (!this.parent) continue;
      this.parent.children.splice(this.parent.children.indexOf(this) + 1, 0, node);
    }
  }
  setAttribute() {}
  querySelectorAll(selector) {
    if (selector !== "input:checked") return [];
    const found = []; const visit = (element) => {
      for (const child of element.children)
        if (child instanceof FakeElement) { if (child.tagName === "INPUT" && child.checked) found.push(child); visit(child); }
    };
    visit(this);
    return found;
  }
}

// 原因：仓级 oxlint max-lines(error, 400, 不计空行/注释) 覆盖 .mjs 测试文件
// （豁免表只列 *.test.ts）；ID 清单与 stub 源保持单行紧凑写法以留在上限内。
const ELEMENT_IDS =
  "title host read document-tab selection-label quote discuss locate status threads recovery messages proposals connection connection-state connect-form endpoint workspace token disconnect side discussion-tab context prompt mode model stop send add-context composer theme".split(" ");
const descendants = (element, out = []) => {
  for (const child of element.children)
    if (child instanceof FakeElement) { out.push(child); descendants(child, out); }
  return out;
};

function harness() {
  const created = [];
  const registry = new Map(ELEMENT_IDS.map((id) => [id, new FakeElement("div")]));
  const footer = new FakeElement("footer");
  registry.get("composer").setParent(footer);
  footer.append(new FakeElement("p"));
  const storage = new Map();
  const frames = [];
  const body = new FakeElement("body");
  globalThis.document = {
    _created: created, body, activeElement: body,
    createElement: (tag) => { const element = new FakeElement(tag); created.push(element); return element; },
    createTextNode: (text) => ({ text: String(text) }),
    getElementById: (id) => registry.get(id),
    querySelector: () => null,
    documentElement: new FakeElement("html"),
  };
  globalThis.localStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  };
  globalThis.requestAnimationFrame = (callback) => (frames.push(callback), frames.length);
  globalThis.window = { addEventListener() {} };
  const flush = () => { let guard = 0; while (frames.length && guard++ < 100) frames.shift()(); };
  const adapterState = { instance: "instance-1", text: "quoted fragment" };
  const adapter = {
    descriptor: async () => ({ host: "word", documentId: "doc-1", documentInstanceId: adapterState.instance, name: "Fixture.docx" }),
    execute: async (method) => {
      if (method === "readSelection")
        return {
          host: "word", documentInstanceId: adapterState.instance,
          target: { anchorId: "anchor-1" }, data: { text: adapterState.text },
        };
      return { status: "located" };
    },
  };
  return { created, registry, flush, adapter, adapterState };
}

const snapshotWithRows = (window, firstRowId) => ({
  rows: { window, firstRowId, totalCount: window.length },
  config: { model: "fixture-model", provider: "fixture-provider", thought: "high", mode: "build" },
  control: { canStop: false, activeWorks: [] },
  pendingInteractions: [],
});

async function mountFresh(adapter) {
  const pane = await mountDocumentPane(adapter, "Word");
  return { pane, stub: globalThis.__paneStubClient };
}

test("a selection read before disconnect is never attached to a send after reconnect", async () => {
  const { registry, flush, adapter } = harness();
  const { stub } = await mountFresh(adapter);
  const sends = [];
  stub.connected = true;
  stub.sessionId = "s-live";
  stub.command = async (type, payload, sessionId) => sends.push({ type, payload, sessionId });
  stub.disconnect = () => { stub.connected = false; };
  stub.connect = async () => { stub.connected = true; return ["s-live"]; };

  await registry.get("read").fire("click");
  flush();
  assert.match(registry.get("quote").textContent, /quoted fragment/);

  registry.get("prompt").value = "first question";
  await registry.get("composer").fire("submit");
  flush();
  assert.equal(sends.length, 1);
  assert.match(sends[0].payload.text, /quoted fragment/);
  assert.match(sends[0].payload.text, /"selection"/);

  await registry.get("disconnect").fire("click");
  flush();
  assert.equal(registry.get("quote").textContent, "Выделите фрагмент в документе.");

  await registry.get("connect-form").fire("submit");
  flush();
  registry.get("prompt").value = "second question";
  await registry.get("composer").fire("submit");
  flush();
  assert.equal(sends.length, 2);
  assert.doesNotMatch(sends[1].payload.text, /quoted fragment/);
  assert.doesNotMatch(sends[1].payload.text, /"selection"/);
});

test("a fragment from a previous document instance is dropped after an in-connection document switch", async () => {
  const { registry, flush, adapter, adapterState } = harness();
  const { stub } = await mountFresh(adapter);
  const sends = [];
  stub.connected = true;
  stub.sessionId = "s-live";
  stub.command = async (type, payload) => sends.push(payload);

  await registry.get("read").fire("click");
  flush();
  assert.match(registry.get("quote").textContent, /quoted fragment/);

  adapterState.instance = "instance-2";
  registry.get("prompt").value = "after switch";
  await registry.get("composer").fire("submit");
  flush();
  assert.equal(sends.length, 1);
  assert.doesNotMatch(sends[0].text, /"selection"/);
  assert.doesNotMatch(sends[0].text, /quoted fragment/);
  assert.equal(registry.get("quote").textContent, "Выделите фрагмент в документе.");
});

test("the load-older affordance issues the native range request and reflects loading state", async () => {
  const { registry, flush, adapter } = harness();
  const { stub } = await mountFresh(adapter);
  stub.connected = true;
  stub.sessionId = "s-live";
  stub.snapshot = snapshotWithRows(
    [
      { rowId: 5, turnId: "t", kind: "assistantText", text: "row five" },
      { rowId: 6, turnId: "t", kind: "assistantText", text: "row six" },
    ],
    1,
  );
  stub.hasOlderRows = true;
  stub.loadingOlder = false;
  const olderCalls = [];
  stub.loadOlder = async () => {
    olderCalls.push(stub.snapshot.rows.window[0].rowId);
    stub.loadingOlder = true;
    stub.changed();
  };
  stub.changed();
  flush();

  const messages = registry.get("messages");
  const control = messages.children.find((element) => element.textContent === "Загрузить старее");
  assert.ok(control, "visible load-older control expected while older rows exist");
  assert.equal(messages.children[0], control);
  assert.match(messages.textContent, /row five/);

  await control.fire("click");
  flush();
  assert.deepEqual(olderCalls, [5]);
  assert.equal(control.textContent, "Загружается…");
  assert.equal(control.disabled, true);

  stub.loadingOlder = false;
  stub.hasOlderRows = false;
  stub.changed();
  flush();
  assert.equal(control.hidden, true);
  assert.ok(!messages.children.includes(control));
});

test("a restored binding session whose subscribe fails as not-found shows the retracted state and blocks sends", async () => {
  const { registry, flush, adapter } = harness();
  const { stub } = await mountFresh(adapter);
  stub.connect = async () => { stub.connected = true; return ["dead-1"]; };
  stub.open = async (sessionId) => {
    stub.sessionId = sessionId;
    stub.state = {
      status: "error",
      lastError: "Session is not active and not persisted: dead-1 (fault.subscribe.sessionNotFound)",
    };
    stub.changed();
  };

  await registry.get("connect-form").fire("submit");
  flush();

  assert.match(registry.get("messages").textContent, /Поток больше не существует/);
  // Строка потока не исчезает молча: остаётся видимой с причиной.
  assert.equal(registry.get("threads").children.length, 1);
  assert.match(registry.get("threads").textContent, /Документ/);
  assert.match(registry.get("threads").textContent, /поток больше не существует/);
  assert.equal(registry.get("send").disabled, true);

  const sends = [];
  stub.command = async (...args) => sends.push(args);
  registry.get("prompt").value = "to the dead thread";
  await registry.get("composer").fire("submit");
  flush();
  assert.equal(sends.length, 0);
  assert.match(registry.get("status").textContent, /Поток больше не существует/);
});

test("a session command rejected with the structured not-found signal marks the thread retracted", async () => {
  const { registry, flush, adapter } = harness();
  const { stub } = await mountFresh(adapter);
  stub.connected = true;
  stub.sessionId = "s-live";
  stub.command = async () => { throw new Error("proto.sessionNotFound: session was deleted"); };
  registry.get("prompt").value = "hello";
  await registry.get("composer").fire("submit");
  flush();
  assert.match(registry.get("messages").textContent, /Поток больше не существует/);

  const calls = [];
  stub.command = async (...args) => calls.push(args);
  registry.get("prompt").value = "again";
  await registry.get("composer").fire("submit");
  flush();
  assert.equal(calls.length, 0);
});

test("absent capabilities are stated with reasons instead of imitated", async () => {
  const { registry, flush, created, adapter } = harness();
  await mountFresh(adapter);
  flush();
  const notice = created.find(
    (element) =>
      element.textContent ===
      "Вложения недоступны в панели документа; используйте ZCODE. Настройки берутся из ZCODE: выбор модели в панели недоступен.",
  );
  assert.ok(notice, "visible absent-with-reason notice expected near the composer");
  const model = registry.get("model");
  assert.equal(model.textContent, "Модель ZCODE");
  assert.match(model.title, /Настройки берутся из ZCODE/);

  const { stub } = { stub: globalThis.__paneStubClient };
  stub.snapshot = snapshotWithRows([], null);
  stub.changed();
  flush();
  assert.equal(model.textContent, "fixture-model");
  assert.match(model.title, /fixture-provider · high/);
  assert.match(model.title, /выбор модели в панели недоступен/);
});

test("streamed appends keep the composer draft, caret and focus while the message list grows", async () => {
  const { registry, flush, adapter } = harness();
  const { stub } = await mountFresh(adapter);
  stub.connected = true;
  stub.sessionId = "s-live";
  const window = [{ rowId: 1, turnId: "t", kind: "assistantText", text: "streaming start" }];
  stub.snapshot = snapshotWithRows(window, null);
  stub.changed();
  flush();
  const prompt = registry.get("prompt");
  prompt.focus();
  prompt.value = "draft during stream";
  prompt.selectionStart = 6;
  prompt.selectionEnd = 12;
  assert.equal(globalThis.document.activeElement, prompt);
  for (let i = 1; i <= 12; i++) {
    if (i % 2) window[window.length - 1].text += ` chunk ${i}`;
    else window.push({ rowId: 100 + i, turnId: "t", kind: "assistantText", text: `new row ${i}` });
    stub.changed();
    flush();
    assert.equal(prompt.value, "draft during stream");
    assert.equal(prompt.selectionStart, 6);
    assert.equal(prompt.selectionEnd, 12);
    assert.equal(globalThis.document.activeElement, prompt);
  }
  assert.match(registry.get("messages").textContent, /new row 12/);
  assert.match(registry.get("messages").textContent, /chunk 11/);
});

test("an AskUserQuestion draft keeps focus across streaming and its answer is built by the shared ZCODE builder", async () => {
  const { registry, flush, adapter } = harness();
  const { stub } = await mountFresh(adapter);
  stub.connected = true;
  stub.sessionId = "s-live";
  const window = [{ rowId: 1, turnId: "t", kind: "assistantText", text: "assistant asks" }];
  stub.snapshot = snapshotWithRows(window, null);
  stub.snapshot.pendingInteractions = [
    {
      interactionId: "q-1",
      payload: {
        kind: "userInput",
        questions: [
          { question: "Choose operations", multiSelect: true, options: [{ label: "Keep", value: "keep" }, { label: "Review", value: "review" }] },
        ],
      },
    },
  ];
  stub.changed();
  flush();
  const messages = registry.get("messages");
  const custom = descendants(messages).find((element) => element.tagName === "TEXTAREA");
  assert.ok(custom, "AskUserQuestion custom-answer textarea expected");
  custom.focus();
  custom.value = "Only this selection";
  await custom.fire("input");
  const keep = descendants(messages).find((e) => e.tagName === "INPUT" && e.value === "keep");
  const review = descendants(messages).find((e) => e.tagName === "INPUT" && e.value === "review");
  keep.checked = true;
  await keep.fire("change");
  review.checked = true;
  await review.fire("change");
  window.push({ rowId: 2, turnId: "t", kind: "assistantText", text: "streamed while asking" });
  stub.changed();
  flush();
  assert.equal(descendants(messages).find((e) => e.tagName === "TEXTAREA"), custom, "interaction box must be reused, not rebuilt");
  assert.equal(custom.value, "Only this selection");
  assert.equal(globalThis.document.activeElement, custom);
  const answers = [];
  stub.command = async (type, payload, sessionId) => answers.push({ type, payload, sessionId });
  const submit = descendants(messages).find(
    (element) => element.tagName === "BUTTON" && element.textContent === "Ответить",
  );
  await submit.fire("click");
  flush();
  const real = await import(BUILDER_URL);
  assert.equal(globalThis.__paneStubBuilder, real.buildElicitationResponseContent, "the pane must answer through the real shared builder module, not a copy");
  const questions = [{ question: "Choose operations", multiSelect: true, options: [{ label: "Keep", value: "keep" }, { label: "Review", value: "review" }], key: "answer_0" }];
  assert.deepEqual(answers[0].payload.answer.content, real.buildElicitationResponseContent(questions, { answer_0: { selectedValues: ["keep", "review"], customAnswer: "Only this selection" } }));
  assert.deepEqual(answers[0].payload.answer.content, {
    answers: { "Choose operations": "keep, review, Only this selection" },
    answer_0: ["keep", "review", "Only this selection"],
    // 单题兼容路径：旧版 agent 读 { answer }（elicitationResponse.ts 同一共享实现）。
    answer: ["keep", "review", "Only this selection"],
  });
  assert.equal(answers[0].type, "resolveInteraction");
  assert.equal(answers[0].sessionId, "s-live");
});
