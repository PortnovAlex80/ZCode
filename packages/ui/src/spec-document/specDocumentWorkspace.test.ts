import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  resolveSpecDocumentWorkspace,
  type SpecDocumentWorkspaceCandidate,
} from "./specDocumentWorkspace.js";

// U-15（活体反馈 2026-10-14）：文档选择器的根必须是「对话所在项目」的 workspace，
// 不是 ZCODE 托管的对话后备 workspace（启动根）。两个不同的根同时在场时——
// 启动根（conversation）活跃 + 项目 tab 已打开——必须选中项目根。
const LAUNCH_ROOT = "C:\\Users\\user\\.zcode\\workspace\\default";
const PROJECT_ROOT = "D:\\Development\\MyProject";

function tab(
  overrides: Partial<SpecDocumentWorkspaceCandidate> = {},
): SpecDocumentWorkspaceCandidate {
  return { workspacePath: PROJECT_ROOT, ...overrides };
}

describe("resolveSpecDocumentWorkspace (U-15 picker root)", () => {
  test("two different roots: conversation launch root active, project tab open — project root selected", () => {
    const resolved = resolveSpecDocumentWorkspace({
      shellWorkspacePath: LAUNCH_ROOT,
      workspaceTabs: [
        tab({ workspacePath: LAUNCH_ROOT, workspacePurpose: "conversation" }),
        tab({ workspacePath: PROJECT_ROOT }),
      ],
    });
    assert.equal(resolved.workspacePath, PROJECT_ROOT);
    assert.equal(resolved.workspaceIdentity, undefined);
  });

  test("project workspace active — stays on the project root and keeps shell identity", () => {
    const resolved = resolveSpecDocumentWorkspace({
      shellWorkspacePath: PROJECT_ROOT,
      shellWorkspaceIdentity: "  ",
      workspaceTabs: [tab({ workspacePath: LAUNCH_ROOT, workspacePurpose: "conversation" }), tab()],
    });
    assert.equal(resolved.workspacePath, PROJECT_ROOT);
    // 空白 identity 不透传（与 workspaceKey 归一规则一致）。
    assert.equal(resolved.workspaceIdentity, undefined);
  });

  test("remote shell workspace keeps its identity untouched", () => {
    const resolved = resolveSpecDocumentWorkspace({
      shellWorkspacePath: "/home/dev/repo",
      shellWorkspaceIdentity: "ssh://host/home/dev/repo",
      workspaceTabs: [
        tab({
          workspacePath: "/home/dev/repo",
          workspaceIdentity: "ssh://host/home/dev/repo",
          remoteSessionId: "rs-1",
        }),
      ],
    });
    assert.deepEqual(resolved, {
      workspacePath: "/home/dev/repo",
      workspaceIdentity: "ssh://host/home/dev/repo",
    });
  });

  test("no project tab at all — conversation launch root kept as explicit degradation", () => {
    const resolved = resolveSpecDocumentWorkspace({
      shellWorkspacePath: LAUNCH_ROOT,
      workspaceTabs: [tab({ workspacePath: LAUNCH_ROOT, workspacePurpose: "conversation" })],
    });
    assert.equal(resolved.workspacePath, LAUNCH_ROOT);
  });

  test("remote and unavailable project tabs are not candidates", () => {
    const resolved = resolveSpecDocumentWorkspace({
      shellWorkspacePath: LAUNCH_ROOT,
      workspaceTabs: [
        tab({ workspacePath: LAUNCH_ROOT, workspacePurpose: "conversation" }),
        tab({
          workspacePath: "ssh://host/opt/proj",
          workspaceIdentity: "ssh://host/opt/proj",
          remoteSessionId: "rs-2",
        }),
        tab({ workspacePath: "E:\\Gone", availability: "unavailable-local-directory" }),
      ],
    });
    assert.equal(resolved.workspacePath, LAUNCH_ROOT);
  });

  test("multiple project tabs — the topmost (most recently opened) wins", () => {
    const resolved = resolveSpecDocumentWorkspace({
      shellWorkspacePath: LAUNCH_ROOT,
      workspaceTabs: [
        tab({ workspacePath: LAUNCH_ROOT, workspacePurpose: "conversation" }),
        tab({ workspacePath: "D:\\Second" }),
        tab({ workspacePath: PROJECT_ROOT }),
      ],
    });
    assert.equal(resolved.workspacePath, "D:\\Second");
  });

  test("unknown active tab (not in the list) keeps current behavior", () => {
    const resolved = resolveSpecDocumentWorkspace({
      shellWorkspacePath: "D:\\Standalone",
      workspaceTabs: [tab({ workspacePath: LAUNCH_ROOT, workspacePurpose: "conversation" }), tab()],
    });
    assert.equal(resolved.workspacePath, "D:\\Standalone");
  });
});
