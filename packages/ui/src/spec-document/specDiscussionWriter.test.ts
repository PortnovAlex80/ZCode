import assert from "node:assert/strict";
import { test } from "vitest";
import {
  acquireDiscussionWriter,
  discussionWriterAllowed,
  retainDiscussionWriter,
  type DiscussionLockManager,
  type DiscussionWriterPhase,
} from "./specDiscussionWriter.js";

function fakeLocks() {
  const held = new Set<string>();
  let requests = 0;
  const locks: DiscussionLockManager = {
    async request(name, options, callback) {
      requests++;
      assert.deepEqual(options, { mode: "exclusive", ifAvailable: true });
      if (held.has(name)) return callback(null);
      held.add(name);
      try {
        return await callback({ name });
      } finally {
        held.delete(name);
      }
    },
  };
  return { locks, held, requests: () => requests };
}
test("exclusive workspace ownership blocks a competing document window and is released only on dispose", async () => {
  const manager = fakeLocks();
  const first: DiscussionWriterPhase[] = [];
  const second: DiscussionWriterPhase[] = [];
  const release = acquireDiscussionWriter("writer-first", manager.locks, (phase) =>
    first.push(phase),
  );
  assert.deepEqual(first, ["checking", "owned"]);
  assert.equal(discussionWriterAllowed("writer-first"), true);
  const reader = acquireDiscussionWriter("writer-first", manager.locks, (phase) =>
    second.push(phase),
  );
  assert.deepEqual(second, ["checking", "busy"]);
  reader();
  assert.equal(
    discussionWriterAllowed("writer-first"),
    true,
    "reader cleanup cannot release the writer",
  );
  release();
  assert.equal(
    discussionWriterAllowed("writer-first"),
    false,
    "late acknowledgements cannot write after release",
  );
  await Promise.resolve();
  await Promise.resolve();
  const reopen: DiscussionWriterPhase[] = [];
  const releaseReopen = acquireDiscussionWriter("writer-first", manager.locks, (phase) =>
    reopen.push(phase),
  );
  assert.deepEqual(reopen, ["checking", "owned"]);
  releaseReopen();
});
test("same renderer document tabs share one lease, retaining it until the last pane unmounts", async () => {
  const manager = fakeLocks();
  const phases: DiscussionWriterPhase[] = [];
  const first = retainDiscussionWriter("shared-renderer", manager.locks, (phase) =>
    phases.push(phase),
  );
  const second = retainDiscussionWriter("shared-renderer", manager.locks, (phase) =>
    phases.push(phase),
  );
  assert.equal(manager.requests(), 1);
  first();
  assert.equal(discussionWriterAllowed("shared-renderer"), true);
  second();
  assert.equal(discussionWriterAllowed("shared-renderer"), false);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(manager.held.size, 0);
});
test("missing Web Locks refuses discussion writes and unenrolled test stores retain their existing authority", () => {
  const phases: DiscussionWriterPhase[] = [];
  const release = acquireDiscussionWriter("unsupported-writer", undefined, (phase) =>
    phases.push(phase),
  );
  assert.deepEqual(phases, ["checking", "unsupported"]);
  assert.equal(discussionWriterAllowed("unsupported-writer"), false);
  assert.equal(discussionWriterAllowed("unenrolled-test-store"), true);
  release();
});
test("a pane disposed before asynchronous acquisition never becomes writer", async () => {
  let admit: (() => Promise<void>) | undefined;
  const locks: DiscussionLockManager = {
    request(_name, _options, callback) {
      return new Promise<void>((resolve) => {
        admit = async () => {
          await callback({});
          resolve();
        };
      });
    },
  };
  const phases: DiscussionWriterPhase[] = [];
  const release = acquireDiscussionWriter("late-writer", locks, (phase) => phases.push(phase));
  release();
  await admit!();
  assert.deepEqual(phases, ["checking"]);
  assert.equal(discussionWriterAllowed("late-writer"), false);
});
