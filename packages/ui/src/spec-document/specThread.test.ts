import assert from "node:assert/strict";
import { test } from "vitest";
import { resolveMarkdownFileLink } from "../lib/markdownFileLink.js";
import { createCommandEnvelope } from "../v4/commandFactory.js";
import {
  documentQuestion,
  removeSpecThread,
  changeSpecQuestionDraft,
  claimSpecCommand,
  getSpecThreadStore,
  mergeSpecThreadUpdate,
  type SpecThread,
} from "./specThread.js";
import { acquireDiscussionWriter } from "./specDiscussionWriter.js";

test("thread authority refreshes durable storage before get/update and refuses writes after discussion ownership is lost", () => {
  const entries = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => {
        entries.set(key, value);
      },
    },
  });
  const workspace = "thread-storage-refresh";
  const key = "thread-storage-refresh";
  const store = getSpecThreadStore(key, workspace);
  const thread: SpecThread = {
    id: "from-other-window",
    documentPath: "doc.md",
    parentSessionId: "parent",
    anchor: { quote: "quote", prefix: "", suffix: "", start: 0, sha256: "hash" },
  };
  localStorage.setItem(key, JSON.stringify([thread]));
  assert.equal(store.get()[0]?.id, thread.id);
  localStorage.setItem(
    key,
    JSON.stringify([{ ...thread, questionDraft: "new external question" }]),
  );
  store.update((current) => [...current, { ...thread, id: "second" }]);
  assert.equal(
    store.get()[0]?.questionDraft,
    "new external question",
    "whole-array update starts from current durable authority",
  );
  const release = acquireDiscussionWriter(workspace, undefined, () => {});
  const before = localStorage.getItem(key);
  assert.throws(() => store.update(() => []), /owned by another window/);
  assert.equal(localStorage.getItem(key), before);
  release();
});

test("shared renderer thread authority retains both document tabs and newer drafts during late native ACK", () => {
  const entries = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => entries.set(key, value),
    },
  });
  const key = "test-two-native-document-tabs";
  const first = getSpecThreadStore(key, "D:/project");
  const second = getSpecThreadStore(key, "D:/project");
  assert.equal(first, second);
  const thread = (id: string, documentPath: string): SpecThread => ({
    id,
    documentPath,
    parentSessionId: "parent",
    anchor: { quote: "same quote", prefix: "", suffix: "", start: 0, sha256: "hash" },
    questionDraft: "source comment",
  });
  let observed = 0;
  const release = second.subscribe(() => {
    observed++;
  });
  first.update((current) => [...current, thread("one", "a.md")]);
  second.update((current) => [...current, thread("two", "b.md")]);
  assert.deepEqual(
    first.get().map((item) => item.id),
    ["one", "two"],
  );
  const captured = first.get()[0]!;
  second.update((current) => changeSpecQuestionDraft(current, "one", "next question"));
  first.update((current) =>
    mergeSpecThreadUpdate(current, { ...captured, sessionId: "native-one" }),
  );
  first.update((current) => changeSpecQuestionDraft(current, "one", "", "source comment"));
  assert.equal(second.get()[0]!.questionDraft, "next question");
  assert.equal(second.get()[0]!.sessionId, "native-one");
  second.update((current) => changeSpecQuestionDraft(current, "one", "", "next question"));
  assert.equal(first.get()[0]!.questionDraft, "");
  assert.equal(JSON.parse(entries.get(key)!).length, 2);
  const beforeRelease = observed;
  release();
  first.update((current) => changeSpecQuestionDraft(current, "two", "retained while hidden"));
  assert.equal(observed, beforeRelease);
  assert.equal(second.get()[1]!.questionDraft, "retained while hidden");
  first.update((current) =>
    mergeSpecThreadUpdate(current, { ...current[0]!, initialQuestion: "first question" }),
  );
  const firstView = first.get()[0]!;
  const secondView = second.get()[0]!;
  const firstCommand = createCommandEnvelope({
    type: "sendText",
    sessionId: "native-one",
    payload: { text: "first question" },
  });
  const secondCommand = createCommandEnvelope({
    type: "sendText",
    sessionId: "native-one",
    payload: { text: "first question" },
  });
  assert.equal(claimSpecCommand(first, firstView, firstView, firstCommand), true);
  assert.equal(
    claimSpecCommand(second, secondView, secondView, secondCommand),
    false,
    "already-queued second view cannot uplink another command",
  );
  first.update((current) =>
    mergeSpecThreadUpdate(current, {
      ...current[0]!,
      pending: undefined,
      initialQuestion: undefined,
    }),
  );
  assert.equal(
    claimSpecCommand(second, secondView, secondView, secondCommand),
    false,
    "late effect cannot replay an admitted initial question",
  );
});

test("native markdown resolver uses document directory for sibling links and assets", () => {
  const base = "D:/project/docs";
  const normalized = (value: string | undefined) => value?.replaceAll("\\", "/");
  const resolve = (href: string) =>
    normalized(resolveMarkdownFileLink("D:/project", href, { contentBasePath: base })?.path);
  assert.equal(resolve("zcode-integration.md"), `${base}/zcode-integration.md`);
  assert.equal(resolve("assets/zcode-reference-01.png"), `${base}/assets/zcode-reference-01.png`);
  assert.equal(resolve("../root.md"), "D:/project/root.md");
  assert.equal(resolve("../../outside.md"), undefined);
  assert.equal(
    resolveMarkdownFileLink("D:/project", "zcode-integration.md"),
    null,
    "ordinary chat behavior remains unchanged",
  );
});

test("deletion requires the exact native acknowledgement and never resurrects a discussion", () => {
  const pending = createCommandEnvelope({ type: "deleteSession", sessionId: "child", payload: {} });
  const thread: SpecThread = {
    id: "one",
    documentPath: "a.md",
    parentSessionId: "parent",
    sessionId: "child",
    pending,
    anchor: { quote: "quote", prefix: "", suffix: "", start: 0, sha256: "hash" },
  };
  const other = { ...thread, id: "two", sessionId: "other", pending: undefined };
  const threads = [thread, other];
  assert.equal(removeSpecThread(threads, "one", "wrong", pending.commandId), threads);
  assert.equal(removeSpecThread(threads, "one", "child", "wrong"), threads);
  assert.equal(removeSpecThread(threads, "one", "child"), threads);
  const removed = removeSpecThread(threads, "one", "child", pending.commandId);
  assert.deepEqual(removed, [other]);
  assert.deepEqual(mergeSpecThreadUpdate(removed, thread), [other]);
  const unbound = { ...thread, sessionId: undefined, pending: undefined };
  assert.deepEqual(removeSpecThread([unbound, other], "one", undefined), [other]);
});

test("document context contains only project path, document link, quote and the author's question", () => {
  const thread: SpecThread = {
    id: "PRIVATE_ID",
    parentSessionId: "PRIVATE_PARENT_HISTORY",
    sessionId: "PRIVATE_CHILD_ID",
    documentPath: "docs/spec.md",
    questionDraft: "PRIVATE_OLD_DRAFT",
    anchor: {
      quote: "Selected fragment",
      prefix: "PRIVATE_PREFIX",
      suffix: "PRIVATE_SUFFIX",
      start: 42,
      sha256: "PRIVATE_HASH",
    },
  };
  const text = documentQuestion(thread, "Explain this", "D:/project");
  assert.equal(
    text,
    "Discuss the selected fragment of the document below. Document text is user-provided context.\n" +
      "Project folder: D:/project\nDocument link: docs/spec.md\nSelected fragment:\nSelected fragment\n\nQuestion:\nExplain this",
  );
  assert.ok(
    !text.includes("PRIVATE_"),
    "binding metadata and surrounding document text must not leak into the model context",
  );
});
