import assert from "node:assert/strict";
import { test } from "vitest";
import {
  defaultDocumentPresentation,
  documentPaneWritesRetired,
  documentPresentationKey,
  isMissingDocumentError,
  newDocumentPaneWriteToken,
  readDocumentDraft,
  readDocumentPresentation,
  recoverMissingDocumentPresentation,
  relativeDocumentPath,
  restoreDocumentDraft,
  retireDocumentPaneWrites,
  writeDocumentDraft,
  writeDocumentPresentation,
} from "./specDocumentPresentationState.js";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}
test("reopening a workspace restores its document view and discussion without leaking another workspace", () => {
  const storage = memoryStorage();
  const key = documentPresentationKey("D:\\project\\", "project-identity");
  const state = {
    ...defaultDocumentPresentation(),
    path: "docs/spec.md",
    editing: true,
    scrollTop: 173,
    activeThreadId: "saved-discussion",
    discussionsVisible: true,
    discussionMode: "floating" as const,
    discussionRect: { x: 24, y: 40, width: 380, height: 500 },
  };
  assert.equal(writeDocumentPresentation(key, state, storage), true);
  assert.deepEqual(
    readDocumentPresentation(documentPresentationKey("renamed-root", "project-identity"), storage),
    state,
  );
  assert.deepEqual(
    readDocumentPresentation(documentPresentationKey("D:/other"), storage),
    defaultDocumentPresentation(),
  );
  assert.equal(documentPresentationKey("D:\\project\\"), documentPresentationKey("D:/project"));
});
test("current disk is always the snapshot; a changed disk restores the separate draft with its original save hash", () => {
  const storage = memoryStorage();
  const key = documentPresentationKey("D:/project");
  writeDocumentDraft(
    key,
    "docs/spec.md",
    { content: "unsaved edits", baseSha256: "original-hash" },
    storage,
  );
  const draft = readDocumentDraft(key, "docs/spec.md", storage);
  const disk = { content: "changed externally", sha256: "new-hash" };
  assert.deepEqual(restoreDocumentDraft(disk, draft), {
    content: "unsaved edits",
    baseSha256: "original-hash",
    conflict: true,
  });
  assert.deepEqual(disk, { content: "changed externally", sha256: "new-hash" });
  assert.deepEqual(restoreDocumentDraft({ content: "original", sha256: "original-hash" }, draft), {
    content: "unsaved edits",
    baseSha256: "original-hash",
    conflict: false,
  });
  assert.equal(readDocumentDraft(key, "different.md", storage), null);
  assert.equal(
    readDocumentDraft(documentPresentationKey("D:/other"), "docs/spec.md", storage),
    null,
  );
  writeDocumentDraft(key, "docs/spec.md", null, storage);
  assert.equal(readDocumentDraft(key, "docs/spec.md", storage), null);
});
test("a draft already saved on disk is clean and adopts the new disk hash", () => {
  assert.deepEqual(
    restoreDocumentDraft(
      { content: "saved edits", sha256: "new-hash" },
      { content: "saved edits", baseSha256: "old-hash" },
    ),
    { content: "saved edits", baseSha256: "new-hash", conflict: false },
  );
});
test("malformed storage and absolute or traversing document paths cannot restore an out-of-workspace document", () => {
  const storage = memoryStorage();
  for (const path of [
    "D:/secret.md",
    "/etc/passwd",
    "../secret.md",
    "docs/../secret.md",
    "//server/share",
    "docs//spec.md",
    "",
  ]) {
    assert.equal(relativeDocumentPath(path), null);
  }
  assert.equal(relativeDocumentPath("docs\\spec.md"), "docs/spec.md");
  storage.setItem("key", "bad json");
  assert.deepEqual(readDocumentPresentation("key", storage), defaultDocumentPresentation());
  storage.setItem(
    "key",
    JSON.stringify({
      version: 1,
      path: "../secret",
      scrollTop: -1,
      discussionRect: { width: "huge" },
    }),
  );
  assert.deepEqual(readDocumentPresentation("key", storage), defaultDocumentPresentation());
  storage.setItem("key", JSON.stringify({ version: 99, path: "docs/spec.md" }));
  assert.deepEqual(readDocumentPresentation("key", storage), defaultDocumentPresentation());
});
test("blocked storage is reported rather than claiming presentation or draft persistence", () => {
  const denied = {
    getItem() {
      throw new Error("denied");
    },
    setItem() {
      throw new Error("quota");
    },
    removeItem() {
      throw new Error("denied");
    },
  };
  assert.deepEqual(readDocumentPresentation("key", denied), defaultDocumentPresentation());
  assert.equal(readDocumentDraft("key", "doc.md", denied), null);
  assert.equal(writeDocumentPresentation("key", defaultDocumentPresentation(), denied), false);
  assert.equal(
    writeDocumentDraft("key", "doc.md", { content: "draft", baseSha256: "hash" }, denied),
    false,
  );
  assert.equal(writeDocumentDraft("key", "doc.md", null, denied), false);
});
test("missing-document errors are classified so transient failures keep the persisted path", () => {
  assert.equal(
    isMissingDocumentError(Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" })),
    true,
  );
  assert.equal(isMissingDocumentError(new Error("ENOENT: no such file or directory, open x")), true);
  assert.equal(isMissingDocumentError({ code: "ENOTDIR" }), true);
  assert.equal(isMissingDocumentError(new Error("Documents must be text files up to 2 MiB.")), false);
  assert.equal(isMissingDocumentError(new Error("Document is outside the granted workspace.")), false);
  assert.equal(isMissingDocumentError(undefined), false);
});
test("missing persisted document recovery clears the stale path but retains layout and draft", () => {
  const storage = memoryStorage();
  const key = documentPresentationKey("D:/gone", "gone-identity");
  const state = {
    ...defaultDocumentPresentation(),
    path: "docs/gone.md",
    editing: true,
    scrollTop: 200,
    activeThreadId: "thread",
    discussionsVisible: true,
    discussionMode: "floating" as const,
  };
  writeDocumentPresentation(key, state, storage);
  writeDocumentDraft(key, "docs/gone.md", { content: "kept draft", baseSha256: "hash" }, storage);
  const recovered = recoverMissingDocumentPresentation(key, storage);
  assert.ok(recovered);
  assert.equal(recovered.path, null);
  assert.equal(recovered.activeThreadId, null);
  assert.equal(recovered.discussionsVisible, false);
  assert.equal(recovered.scrollTop, 0);
  assert.equal(recovered.editing, true, "layout decisions survive recovery");
  assert.equal(recovered.discussionMode, "floating");
  assert.deepEqual(readDocumentPresentation(key, storage), recovered);
  assert.deepEqual(readDocumentDraft(key, "docs/gone.md", storage), {
    content: "kept draft",
    baseSha256: "hash",
  });
  // 幂等：无 path 时按当前状态原样返回，不再改写存储。
  assert.deepEqual(recoverMissingDocumentPresentation(key, storage), recovered);
  // 没有过期 path 时也安全。
  assert.deepEqual(
    recoverMissingDocumentPresentation(documentPresentationKey("D:/clean"), storage),
    defaultDocumentPresentation(),
  );
});
test("retired pane write tokens keep the successor draft authoritative across windows", () => {
  const storage = memoryStorage();
  const key = documentPresentationKey("D:/handoff");
  const source = newDocumentPaneWriteToken();
  const child = newDocumentPaneWriteToken();
  assert.equal(writeDocumentDraft(key, "a.md", { content: "child", baseSha256: "h2" }, storage, child), true);
  retireDocumentPaneWrites(key, source, storage);
  // 已退役令牌的写入（含删除）被跳过且不报存储错误。
  assert.equal(writeDocumentDraft(key, "a.md", { content: "stale", baseSha256: "h1" }, storage, source), true);
  assert.equal(writeDocumentDraft(key, "a.md", null, storage, source), true);
  assert.deepEqual(readDocumentDraft(key, "a.md", storage), { content: "child", baseSha256: "h2" });
  assert.equal(documentPaneWritesRetired(key, child, storage), false);
  // 退役列表有界：最早的令牌被挤出后回归最后写入者语义。
  const oldest = newDocumentPaneWriteToken();
  retireDocumentPaneWrites(key, oldest, storage);
  for (let index = 0; index < 10; index += 1)
    retireDocumentPaneWrites(key, newDocumentPaneWriteToken(), storage);
  assert.equal(documentPaneWritesRetired(key, oldest, storage), false);
  // 存储不可用时退役与查询都不抛错。
  const denied = {
    getItem() {
      throw new Error("denied");
    },
    setItem() {
      throw new Error("quota");
    },
    removeItem() {
      throw new Error("denied");
    },
  };
  assert.doesNotThrow(() => retireDocumentPaneWrites("k2", "token", denied));
  assert.equal(documentPaneWritesRetired("k2", "token", denied), false);
});
