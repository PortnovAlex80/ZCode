import assert from "node:assert/strict";
import { test } from "vitest";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { runInNewContext } from "node:vm";
import {
  activateManagedNativeDiscussionOwner,
  activateNativeDiscussionOwner,
  claimNativeDiscussionOwner,
  nativeDiscussionHandoffSession,
  readManagedNativeDiscussionOwner,
  readNativeDiscussionOwner,
  registerManagedNativeDiscussion,
  releaseNativeDiscussionOwner,
  specThreadStorageKey,
  subscribeNativeDiscussionOwner,
  transferNativeDiscussionDraft,
  MANAGED_NATIVE_DISCUSSION_OPEN_EVENT,
} from "./nativeDiscussionHandoff.js";
import {
  documentPresentationKey,
  readDocumentPresentation,
  writeDocumentPresentation,
  defaultDocumentPresentation,
} from "./specDocumentPresentationState.js";
import { persistV4ComposerDraft, readV4ComposerDraft } from "../v4/composer/composerDraftStore.js";
import { getSpecThreadStore, type SpecThread } from "./specThread.js";
import { documentFirstInputBody } from "../v4/documentFirstInput.js";

test("actual first-input guards preserve document context for /plan without rewriting native commands or later turns", async () => {
  const text = await readFile(new URL("../v4/SessionPane.tsx", import.meta.url), "utf8");
  const source = ts.createSourceFile(
    "SessionPane.tsx",
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const initializers = new Map<string, string>();
  function visit(node: ts.Node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ["preparedFirstText", "applyFirstText"].includes(node.name.text)
    )
      initializers.set(node.name.text, node.initializer.getText(source));
    ts.forEachChild(node, visit);
  }
  visit(source);
  const evaluate = (name: string, scope: Record<string, unknown>) => {
    assert.ok(initializers.has(name));
    return runInNewContext(
      ts.transpileModule(`var result = (${initializers.get(name)}); result;`, {
        compilerOptions: { target: ts.ScriptTarget.ES2024 },
      }).outputText,
      scope,
    );
  };
  const empty = {
    sessionId: "child",
    rows: { totalCount: 0, window: [], firstRowId: null },
    queue: { items: [] },
  };
  const scope: Record<string, unknown> = {
    effectiveText: "Explain",
    sessionId: "child",
    current: empty,
    snapshotRef: { current: empty },
    currentFirstInput: empty,
    state: { status: "live" },
    projectionStatusRef: { current: "live" },
    firstTextAdmissionSessionIds: { current: new Set() },
    pendingCommandRegistry: { list: () => [] },
    prepareFirstText: (input: string) => `quote + paths + ${input}`,
  };
  for (const input of ["Explain", "/plan Explain"]) {
    const prepared = evaluate("preparedFirstText", {
      ...scope,
      text: input,
      firstBody: documentFirstInputBody(input, []),
    });
    assert.equal(prepared.original, input);
    assert.equal(prepared.prepared, "quote + paths + Explain");
    assert.equal(
      evaluate("applyFirstText", {
        ...scope,
        text: input,
        effectiveText: "Explain",
        preparedFirstText: prepared,
        slashCommand: null,
      }),
      true,
    );
    assert.equal(
      evaluate("applyFirstText", {
        ...scope,
        text: input,
        effectiveText: "different body",
        preparedFirstText: prepared,
        slashCommand: null,
      }),
      false,
    );
    assert.equal(
      evaluate("applyFirstText", {
        ...scope,
        text: input,
        preparedFirstText: prepared,
        slashCommand: { kind: "command" },
      }),
      false,
    );
    assert.equal(
      evaluate("applyFirstText", {
        ...scope,
        text: input,
        preparedFirstText: prepared,
        slashCommand: null,
        currentFirstInput: { ...empty, rows: { ...empty.rows, totalCount: 1 } },
      }),
      false,
    );
    assert.equal(
      evaluate("applyFirstText", {
        ...scope,
        text: input,
        preparedFirstText: prepared,
        slashCommand: null,
        pendingCommandRegistry: { list: () => ["unknown admission"] },
      }),
      false,
    );
  }
});

test("native UI owns only the bound live session after creation is acknowledged", () => {
  const thread = { sessionId: "fresh-child", discussionStartRowId: 1 };
  const projection = { status: "live", snapshotSessionId: "fresh-child", dispatching: false };
  assert.equal(nativeDiscussionHandoffSession(null, thread, projection), "fresh-child");
  const pending = { type: "sendText" } as SpecThread["pending"];
  for (const change of [
    { sessionId: undefined },
    { discussionStartRowId: undefined },
    { pending },
    { initialQuestion: "waiting for first send" },
  ]) {
    assert.equal(nativeDiscussionHandoffSession(null, { ...thread, ...change }, projection), null);
  }
  for (const change of [
    { status: "connecting" },
    { status: "error" },
    { snapshotSessionId: "other-session" },
    { dispatching: true },
  ]) {
    assert.equal(nativeDiscussionHandoffSession(null, thread, { ...projection, ...change }), null);
  }
});

test("native ownership survives reconnect and never falls back to another session/bootstrap composer", () => {
  const thread = { sessionId: "fresh-child", discussionStartRowId: 1 };
  assert.equal(
    nativeDiscussionHandoffSession("fresh-child", thread, {
      status: "error",
      snapshotSessionId: null,
      dispatching: false,
    }),
    "fresh-child",
  );
  assert.equal(
    nativeDiscussionHandoffSession(
      "fresh-child",
      { ...thread, sessionId: "replacement" },
      { status: "live", snapshotSessionId: "replacement", dispatching: false },
    ),
    null,
  );
});

test("next-question draft seed uses the actual child scope and leaves the native main draft untouched", () => {
  const entries = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => {
        entries.set(key, value);
      },
      removeItem: (key: string) => {
        entries.delete(key);
      },
    },
  });
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage } });
  const workspace = "D:/test-native-ui-handoff";
  assert.equal(
    persistV4ComposerDraft(workspace, undefined, "__draft__", { text: "main chat unsent" }),
    true,
  );
  transferNativeDiscussionDraft(workspace, undefined, "fresh-child", "next discussion question");
  assert.equal(readV4ComposerDraft(workspace, undefined, "__draft__")?.text, "main chat unsent");
  assert.equal(
    readV4ComposerDraft(workspace, undefined, "fresh-child")?.text,
    "next discussion question",
  );
  assert.throws(
    () => transferNativeDiscussionDraft(workspace, undefined, "__draft__", "wrong scope"),
    /bound native discussion/,
  );
  assert.throws(
    () => transferNativeDiscussionDraft(workspace, undefined, "fresh-child", "replacement"),
    /different draft/,
  );
  assert.equal(
    readV4ComposerDraft(workspace, undefined, "fresh-child")?.text,
    "next discussion question",
  );
});

test("two document views have one native owner; hide/reconnect and stale cleanup preserve its draft and activation", () => {
  const scope = {
    workspacePath: "D:/native-owner-test",
    workspaceIdentity: "native-owner-workspace",
    threadId: "same-thread",
    sessionId: "same-child",
  };
  const first = Symbol("first-view");
  const second = Symbol("second-view");
  let activated = 0;
  let seeds = 0;
  let notifications = 0;
  registerManagedNativeDiscussion(scope);
  const unsubscribe = subscribeNativeDiscussionOwner(scope, () => {
    notifications++;
  });
  const renderView = (token: symbol) => {
    if (
      !claimNativeDiscussionOwner(scope, token, () => {
        activated++;
      })
    )
      return "notice";
    seeds++;
    return "native";
  };
  assert.equal(renderView(first), "native");
  assert.equal(renderView(second), "notice");
  assert.equal(seeds, 1, "denied views must not seed or mount another native composer");
  assert.equal(readNativeDiscussionOwner(scope), first);
  assert.equal(
    claimNativeDiscussionOwner(scope, first, () => {}),
    true,
    "reconnect/ACK rerenders retain the same owner",
  );
  assert.equal(notifications, 1, "same-owner rerenders do not notify or replace activation");
  assert.equal(activateNativeDiscussionOwner(scope), true);
  assert.equal(activated, 1);
  releaseNativeDiscussionOwner(scope, second);
  assert.equal(readNativeDiscussionOwner(scope), first);
  assert.equal(
    persistV4ComposerDraft(scope.workspacePath, scope.workspaceIdentity, scope.sessionId, {
      text: "queued rich question",
      editorStateJson: '{"root":{"children":[]}}',
    }),
    true,
  );
  const rich = readV4ComposerDraft(scope.workspacePath, scope.workspaceIdentity, scope.sessionId);
  releaseNativeDiscussionOwner(scope, first);
  assert.equal(
    readManagedNativeDiscussionOwner(scope.workspacePath, scope.workspaceIdentity, scope.sessionId)
      ?.ownerToken,
    null,
    "closed managed child remains blocked from implicit task-catalog takeover",
  );
  assert.equal(activateNativeDiscussionOwner(scope), false, "closed tabs keep no stale callback");
  assert.equal(
    claimNativeDiscussionOwner(scope, second, () => {
      activated += 10;
    }),
    true,
  );
  transferNativeDiscussionDraft(scope.workspacePath, scope.workspaceIdentity, scope.sessionId, "");
  assert.deepEqual(
    readV4ComposerDraft(scope.workspacePath, scope.workspaceIdentity, scope.sessionId),
    rich,
    "reopen preserves native rich draft without replaying a question",
  );
  releaseNativeDiscussionOwner(scope, first);
  assert.equal(readNativeDiscussionOwner(scope), second);
  assert.equal(activateNativeDiscussionOwner(scope), true);
  assert.equal(activated, 11);
  releaseNativeDiscussionOwner(scope, second);
  unsubscribe();
});

test("owner keys isolate workspaces and exact children and refuse conflicting durable thread identity", () => {
  const base = {
    workspacePath: "D:/owner-isolation",
    workspaceIdentity: "owner-isolation",
    threadId: "thread-a",
    sessionId: "child-a",
  };
  const token = Symbol("owner-a");
  const other = Symbol("owner-b");
  assert.equal(
    claimNativeDiscussionOwner(base, token, () => {}),
    true,
  );
  assert.equal(
    claimNativeDiscussionOwner({ ...base, threadId: "thread-b" }, other, () => {}),
    false,
  );
  assert.throws(
    () => registerManagedNativeDiscussion({ ...base, threadId: "thread-b" }),
    /another document discussion/,
  );
  const child = { ...base, threadId: "thread-b", sessionId: "child-b" };
  const workspace = { ...base, workspaceIdentity: "another-workspace" };
  assert.equal(
    claimNativeDiscussionOwner(child, other, () => {}),
    true,
  );
  assert.equal(
    claimNativeDiscussionOwner(workspace, other, () => {}),
    true,
  );
  assert.equal(
    readManagedNativeDiscussionOwner(base.workspacePath, base.workspaceIdentity, "unrelated-child"),
    null,
  );
  assert.equal(
    readManagedNativeDiscussionOwner(base.workspacePath, base.workspaceIdentity, null),
    null,
  );
  assert.equal(
    readManagedNativeDiscussionOwner(base.workspacePath, base.workspaceIdentity, "__draft__"),
    null,
  );
  for (const scope of [base, child, workspace])
    releaseNativeDiscussionOwner(scope, scope === base ? token : other);
});

test("validated saved child is managed before any Documents mount; corrupt and unknown bindings leave stock IDs unchanged", () => {
  const workspacePath = "D:/saved-owner-test";
  const identity = "saved-owner-workspace";
  const saved: SpecThread = {
    id: "saved-thread",
    documentPath: "docs/a.md",
    parentSessionId: "parent",
    sessionId: "saved-child",
    anchor: { start: 0, quote: "quote", prefix: "", suffix: "", sha256: "hash" },
  };
  localStorage.setItem(specThreadStorageKey(workspacePath, identity), JSON.stringify([saved]));
  const managed = readManagedNativeDiscussionOwner(workspacePath, identity, "saved-child");
  assert.deepEqual(managed, {
    threadId: "saved-thread",
    sessionId: "saved-child",
    ownerToken: null,
  });
  assert.equal(
    readManagedNativeDiscussionOwner(workspacePath, identity, "saved-child"),
    managed,
    "snapshot remains stable",
  );
  assert.equal(activateManagedNativeDiscussionOwner(workspacePath, identity, "saved-child"), false);
  assert.equal(readManagedNativeDiscussionOwner(workspacePath, identity, "ordinary-task"), null);
  localStorage.setItem(specThreadStorageKey(workspacePath, "corrupt-owner-workspace"), "{broken");
  assert.equal(
    readManagedNativeDiscussionOwner(workspacePath, "corrupt-owner-workspace", "ordinary-task"),
    null,
  );
  localStorage.setItem(
    specThreadStorageKey(workspacePath, "unknown-owner-workspace"),
    JSON.stringify([{ unsupported: true }]),
  );
  assert.equal(
    readManagedNativeDiscussionOwner(workspacePath, "unknown-owner-workspace", "ordinary-task"),
    null,
  );
  localStorage.setItem(
    specThreadStorageKey(workspacePath, "sentinel-owner-workspace"),
    JSON.stringify([
      { ...saved, id: "sentinel-thread", sessionId: "__draft__" },
      { ...saved, id: "empty-child-thread", sessionId: " " },
      { ...saved, id: "", sessionId: "empty-thread-child" },
      { ...saved, id: "whitespace-thread", sessionId: "" },
    ]),
  );
  assert.doesNotThrow(() =>
    readManagedNativeDiscussionOwner(workspacePath, "sentinel-owner-workspace", "ordinary-task"),
  );
  assert.equal(
    readManagedNativeDiscussionOwner(workspacePath, "sentinel-owner-workspace", "ordinary-task"),
    null,
  );
  assert.equal(
    readManagedNativeDiscussionOwner(
      workspacePath,
      "sentinel-owner-workspace",
      "empty-thread-child",
    ),
    null,
  );
});

test("closed managed discussion reopens its durable document and selected thread while mounted and ordinary tasks keep their owners", () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const events = new EventTarget();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: Object.assign(events, { localStorage }),
  });
  try {
    const workspacePath = "D:/closed-discussion-reopen";
    const workspaceIdentity = "closed-discussion-reopen";
    const saved: SpecThread = {
      id: "reopen-thread",
      documentPath: "docs/reopen.md",
      parentSessionId: "parent",
      sessionId: "reopen-child",
      anchor: { start: 0, quote: "quote", prefix: "", suffix: "", sha256: "hash" },
    };
    localStorage.setItem(
      specThreadStorageKey(workspacePath, workspaceIdentity),
      JSON.stringify([saved]),
    );
    const key = documentPresentationKey(workspacePath, workspaceIdentity);
    writeDocumentPresentation(key, {
      ...defaultDocumentPresentation(),
      path: saved.documentPath,
      editing: true,
      scrollTop: 99,
    });
    const requests: unknown[] = [];
    events.addEventListener(MANAGED_NATIVE_DISCUSSION_OPEN_EVENT, (event) =>
      requests.push((event as CustomEvent).detail),
    );
    assert.equal(
      activateManagedNativeDiscussionOwner(workspacePath, workspaceIdentity, saved.sessionId!),
      true,
    );
    assert.deepEqual(requests, [
      { workspacePath, workspaceIdentity, documentPath: saved.documentPath, threadId: saved.id },
    ]);
    const restored = readDocumentPresentation(key);
    assert.equal(restored.path, saved.documentPath);
    assert.equal(restored.activeThreadId, saved.id);
    assert.equal(restored.discussionsVisible, true);
    assert.equal(restored.editing, true);
    assert.equal(restored.scrollTop, 99);
    const scope = {
      workspacePath,
      workspaceIdentity,
      threadId: saved.id,
      sessionId: saved.sessionId!,
    };
    const token = Symbol("mounted-reopen");
    let activated = 0;
    claimNativeDiscussionOwner(scope, token, () => {
      activated++;
    });
    assert.equal(
      activateManagedNativeDiscussionOwner(workspacePath, workspaceIdentity, saved.sessionId!),
      true,
    );
    assert.equal(activated, 1);
    assert.equal(
      requests.length,
      1,
      "mounted owner uses its current activation instead of reopening",
    );
    releaseNativeDiscussionOwner(scope, token);
    assert.equal(
      activateManagedNativeDiscussionOwner(workspacePath, workspaceIdentity, "ordinary-task"),
      false,
    );
    assert.equal(requests.length, 1);
    assert.deepEqual(readDocumentPresentation(key), restored);
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("an initially empty reader follows durable discussion additions and removals without replacing live ownership snapshots", () => {
  const workspacePath = "D:/managed-owner-storage-changes";
  const identity = "managed-owner-storage-changes";
  const store = getSpecThreadStore(specThreadStorageKey(workspacePath, identity), identity);
  assert.equal(readManagedNativeDiscussionOwner(workspacePath, identity, "later-child"), null);
  const saved: SpecThread = {
    id: "later-thread",
    documentPath: "docs/later.md",
    parentSessionId: "parent",
    sessionId: "later-child",
    anchor: { start: 0, quote: "quote", prefix: "", suffix: "", sha256: "hash" },
  };
  store.update(() => [saved]);
  const snapshot = readManagedNativeDiscussionOwner(workspacePath, identity, "later-child");
  assert.deepEqual(snapshot, { threadId: saved.id, sessionId: saved.sessionId, ownerToken: null });
  store.update((current) =>
    current.map((thread) => ({ ...thread, questionDraft: "another window changed draft" })),
  );
  assert.equal(readManagedNativeDiscussionOwner(workspacePath, identity, "later-child"), snapshot);
  store.update(() => []);
  assert.equal(readManagedNativeDiscussionOwner(workspacePath, identity, "later-child"), null);
  store.update(() => [saved]);
  const scope = {
    workspacePath,
    workspaceIdentity: identity,
    threadId: saved.id,
    sessionId: saved.sessionId!,
  };
  const token = Symbol("mounted-storage-owner");
  claimNativeDiscussionOwner(scope, token, () => {});
  const mounted = readManagedNativeDiscussionOwner(workspacePath, identity, "later-child");
  store.update(() => []);
  assert.equal(
    readManagedNativeDiscussionOwner(workspacePath, identity, "later-child"),
    mounted,
    "durable deletion does not steal active mounted ownership",
  );
  releaseNativeDiscussionOwner(scope, token);
  assert.equal(
    readManagedNativeDiscussionOwner(workspacePath, identity, "later-child"),
    null,
    "removed durable identity is forgotten after the mounted owner releases",
  );
});

test("actual renderer keeps bootstrap hook mounted and native/custom composers and dialogs exclusive", async () => {
  const text = await readFile(new URL("./SpecDiscussionPane.tsx", import.meta.url), "utf8");
  const source = ts.createSourceFile(
    "discussion.tsx",
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const collect = (root: ts.Node, predicate: (node: ts.Node) => boolean) => {
    const result: ts.Node[] = [];
    const visit = (node: ts.Node) => {
      if (predicate(node)) result.push(node);
      ts.forEachChild(node, visit);
    };
    visit(root);
    return result;
  };
  assert.equal(
    collect(
      source,
      (node) =>
        ts.isCallExpression(node) && node.expression.getText(source) === "useSpecDiscussion",
    ).length,
    1,
  );
  const branch = collect(
    source,
    (node) =>
      ts.isConditionalExpression(node) && node.condition.getText(source) === "nativeOwnerSessionId",
  )[0];
  assert.ok(branch && ts.isConditionalExpression(branch));
  const tags = (root: ts.Node, name: string) =>
    collect(
      root,
      (node) =>
        (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) &&
        node.tagName.getText(source) === name,
    );
  const pane = tags(branch.whenTrue, "SessionPane")[0];
  assert.ok(pane && ts.isJsxSelfClosingElement(pane));
  assert.equal(tags(branch.whenTrue, "textarea").length, 0);
  assert.equal(tags(branch.whenTrue, "V4InteractionDialogs").length, 0);
  assert.equal(tags(branch.whenFalse, "SessionPane").length, 0);
  assert.equal(tags(branch.whenFalse, "textarea").length, 0);
  const prop = (name: string) =>
    pane.attributes.properties.find(
      (node) => ts.isJsxAttribute(node) && node.name.getText(source) === name,
    );
  assert.equal(prop("sessionId")?.getText(source), "sessionId={nativeOwnerSessionId}");
  assert.equal(prop("readOnly")?.getText(source), "readOnly={!nativeInteractive}");
  assert.equal(
    prop("focused")?.getText(source),
    "focused={false}",
    "global workspace shortcuts belong to the general chat",
  );
  assert.equal(
    prop("interactionDialogsVisible")?.getText(source),
    // 评审 #2（0b3f73ef）：可见性改为 panePresented（宿主文档可见性 ∧ 宿主侧
    // visible 判定，useCombinedPresentationVisibility），非激活保留线程不得开
    // presentation/interaction dialogs——这里同步断言新形态（旧期望未跟上实现）。
    "interactionDialogsVisible={panePresented && nativeInteractive}",
  );
  assert.match(
    text.replace(/\s+/g, " "),
    /const nativeInteractive = !unavailable && !thread.pending && nativeOwnerSessionId === thread.sessionId && currentOwner === ownerToken/,
  );
  assert.match(branch.whenFalse.getText(source), /Open existing discussion/);
  assert.match(text, /prepareFirstText=\{\(text\) => documentQuestion/);
  assert.equal(tags(source, "textarea").length, 0);
  const handoffEffect = collect(
    source,
    (node) =>
      ts.isCallExpression(node) &&
      node.expression.getText(source) === "useEffect" &&
      node.getText(source).includes("transferNativeDiscussionDraft"),
  )[0];
  assert.ok(
    handoffEffect,
    "seeding waits for passive unmount draft flush before the successor native editor mounts",
  );
  assert.ok(
    handoffEffect.getText(source).indexOf("claimNativeDiscussionOwner") <
      handoffEffect.getText(source).indexOf("transferNativeDiscussionDraft"),
  );
  assert.equal(
    collect(
      source,
      (node) =>
        ts.isCallExpression(node) &&
        node.expression.getText(source) === "useLayoutEffect" &&
        node.getText(source).includes("transferNativeDiscussionDraft"),
    ).length,
    0,
  );
  assert.match(text.replace(/\s+/g, " "), /event.key === "Escape" && !event.defaultPrevented/);
  assert.match(text, /event.stopPropagation\(\)/);
  assert.equal(prop("onSessionCreated"), undefined, "our pane never navigates the general chat");
  const nativeSource = await readFile(new URL("../v4/SessionPane.tsx", import.meta.url), "utf8");
  assert.match(nativeSource, /interactionDialogsVisible = true/);
  assert.match(nativeSource, /interactionDialogsVisible && sessionId && snapshot \?/);
});
