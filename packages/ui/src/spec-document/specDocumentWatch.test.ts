import assert from "node:assert/strict";
import { test } from "vitest";
import type {
  IFileWatcherService,
  ISpecDocumentService,
  SpecDocumentSnapshot,
} from "@zcode/services";
import { watchSpecDocument, type SpecDocumentViewState } from "./specDocumentWatch.js";

test("native watcher: atomic-replace event, dirty read race, stale path generation, cleanup and save echo", async () => {
  let listener: ((event: { dirPath: string; changedPath?: string }) => void) | undefined;
  let unsubscribed = 0;
  let unwatched = 0;
  let finish: ((value: SpecDocumentSnapshot) => void) | undefined;
  const snapshot = (sha256: string, content = sha256) => ({ path: "doc.md", sha256, content });
  let current: SpecDocumentViewState = {
    snapshot: snapshot("one"),
    draft: "one",
    ioPending: false,
  };
  const applied: string[] = [];
  const conflicts: string[] = [];
  const watcher = {
    watch: async ({ path }) => {
      assert.equal(path, "D:/project");
      return { id: "native-watch" };
    },
    unwatch: async () => {
      unwatched++;
    },
    onDynamicChange: () => (callback) => {
      listener = callback;
      return {
        dispose() {
          unsubscribed++;
        },
      };
    },
  } satisfies Pick<IFileWatcherService, "watch" | "unwatch" | "onDynamicChange">;
  const documents = {
    read: () =>
      new Promise<SpecDocumentSnapshot>((resolve) => {
        finish = resolve;
      }),
  } satisfies Pick<ISpecDocumentService, "read">;
  const dispose = watchSpecDocument({
    absolutePath: "D:/project/doc.md",
    relativePath: "doc.md",
    watcher,
    documents,
    current: () => current,
    apply: (next) => {
      applied.push(next.sha256);
      current = { snapshot: next, draft: next.content, ioPending: false };
    },
    conflict: (next) => conflicts.push(next.sha256),
    error: (error) => {
      throw error;
    },
  });
  await Promise.resolve();
  finish!(snapshot("one"));
  await Promise.resolve();
  listener!({ dirPath: "D:/project", changedPath: "D:/project/doc.md" });
  finish!(snapshot("two"));
  await Promise.resolve();
  assert.deepEqual(applied, ["two"]);
  listener!({ dirPath: "D:/project" }); // Native coalesced/atomic rename event.
  current.draft = "unsaved while read was in flight";
  finish!(snapshot("three"));
  await Promise.resolve();
  assert.deepEqual(conflicts, ["three"]);
  assert.equal(current.draft, "unsaved while read was in flight");
  listener!({ dirPath: "D:/project", changedPath: "D:/project/other.md" });
  assert.deepEqual(applied, ["two"]);
  listener!({ dirPath: "D:/project" });
  dispose();
  finish!(snapshot("four"));
  await Promise.resolve();
  assert.deepEqual(applied, ["two"]);
  assert.equal(unsubscribed, 1);
  assert.equal(unwatched, 1);
});
