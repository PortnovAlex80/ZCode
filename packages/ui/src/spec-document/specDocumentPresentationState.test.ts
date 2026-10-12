import assert from "node:assert/strict";
import { test } from "vitest";
import {
  defaultDocumentPresentation,
  documentPresentationKey,
  readDocumentDraft,
  readDocumentPresentation,
  relativeDocumentPath,
  restoreDocumentDraft,
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
