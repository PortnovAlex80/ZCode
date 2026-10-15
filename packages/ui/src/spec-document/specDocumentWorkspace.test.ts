import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "vitest";
import { createSpecDocumentService } from "../../../services/src/spec-document/specDocumentService.js";
import { resolveSpecDocumentWorkspace } from "./specDocumentWorkspace.js";

const APP_ROOT = "D:\\Development\\ZCode-Harness";
const A = "D:\\Projects\\A";
const B = "D:\\Projects\\B";
const common = {
  shellWorkspacePath: APP_ROOT,
  workspaceTabs: [{ workspacePath: APP_ROOT }, { workspacePath: B }, { workspacePath: A }],
};

describe("U-15 conversation-owned document workspace", () => {
  test("active session metadata wins over shell root and topmost project", () => {
    assert.deepEqual(
      resolveSpecDocumentWorkspace({
        ...common,
        activeTaskId: "a",
        activeTaskMeta: { taskId: "a", workspacePath: A },
      }),
      { workspacePath: A, sessionId: "a" },
    );
    assert.deepEqual(
      resolveSpecDocumentWorkspace({
        ...common,
        activeTaskId: "b",
        activeTaskMeta: { taskId: "b", workspacePath: B },
      }),
      { workspacePath: B, sessionId: "b" },
    );
  });
  test("missing or stale session metadata never falls back to launch root", () => {
    assert.equal(resolveSpecDocumentWorkspace({ ...common, activeTaskId: "a" }), null);
    assert.equal(
      resolveSpecDocumentWorkspace({
        ...common,
        activeTaskId: "b",
        activeTaskMeta: { taskId: "a", workspacePath: A },
      }),
      null,
    );
  });
  test("focused cross-project pane wins over primary conversation metadata", () => {
    assert.deepEqual(
      resolveSpecDocumentWorkspace({
        ...common,
        activeTaskId: "a",
        activeTaskMeta: { taskId: "a", workspacePath: A },
        focusedBinding: { sessionId: "b", workspaceScope: { workspacePath: B } },
      }),
      { workspacePath: B, sessionId: "b" },
    );
  });
  test("remote or unvalidated focus cannot enumerate a local path", () => {
    for (const focusedBinding of [
      {
        sessionId: "remote",
        workspaceScope: { workspacePath: A, workspaceIdentity: "ssh://host/A" },
      },
      { sessionId: "old", workspaceScope: { workspacePath: B }, restoredUnvalidated: true },
    ])
      assert.equal(
        resolveSpecDocumentWorkspace({ ...common, activeTaskId: "a", focusedBinding }),
        null,
      );
  });
  test("draft uses its selected project, not another project tab", () => {
    assert.deepEqual(
      resolveSpecDocumentWorkspace({ ...common, shellWorkspacePath: A, activeTaskId: null }),
      { workspacePath: A, sessionId: null },
    );
  });
  test("managed conversation draft does not guess a project", () => {
    assert.equal(
      resolveSpecDocumentWorkspace({
        ...common,
        activeTaskId: null,
        workspaceTabs: [
          { workspacePath: APP_ROOT, workspacePurpose: "conversation" },
          { workspacePath: A },
        ],
      }),
      null,
    );
  });
  test("real picker IO resolves A and B while process cwd stays in the application repo", async () => {
    const directory = await mkdtemp(join(tmpdir(), "spec-picker-project-binding-"));
    const a = join(directory, "project-a");
    const b = join(directory, "project-b");
    const cwd = process.cwd();
    try {
      await mkdir(join(a, "docs"), { recursive: true });
      await mkdir(join(b, "notes"), { recursive: true });
      await writeFile(join(a, "docs", "selected.md"), "A document");
      await writeFile(join(b, "notes", "selected.txt"), "B document");
      const service = createSpecDocumentService({ desktopLocal: true });
      const workspaceTabs = [{ workspacePath: cwd }, { workspacePath: b }, { workspacePath: a }];
      for (const [taskId, workspacePath, expected, content] of [
        ["a", a, "docs/selected.md", "A document"],
        ["b", b, "notes/selected.txt", "B document"],
      ] as const) {
        const target = resolveSpecDocumentWorkspace({
          shellWorkspacePath: cwd,
          workspaceTabs,
          activeTaskId: taskId,
          activeTaskMeta: { taskId, workspacePath },
        });
        assert.ok(target);
        assert.notEqual(target.workspacePath, cwd);
        assert.deepEqual(await service.list(target), [expected]);
        assert.equal((await service.read({ ...target, path: expected })).content, content);
      }
      assert.equal(process.cwd(), cwd);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
