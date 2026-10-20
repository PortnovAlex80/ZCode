// @vitest-environment jsdom
// D-05 fixture coverage：项目收起状态的持久化（非 GUI 半边）。
// 侧栏分组收起（SHELL-15 的 refresh 场景，此前"no focused fixture located for
// the refresh case"）：用真实 groupedTaskExpansionPreference/view helpers 复现
// WorkspaceSidebar 的刷新序列——瞬时空快照不清偏好、完整刷新保留收起、
// 删除组清掉陈旧记录；并以源码断言确认侧栏实际接线（守卫 + persist + prune）。
// （2026-10-13 RETIREMENT-2：跨 OS 窗口的项目目录同步 useSpecProjectCatalog 随
// move-to-window 特性一并退役，本文件只保留仍在产品中的侧栏收起偏好覆盖。）
import { cleanup } from "@testing-library/react";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";
import { beforeEach, describe, expect, it } from "vitest";
import {
  GROUPED_TASK_COLLAPSED_GROUPS_STORAGE_KEY,
  persistGroupedTaskCollapsedGroupIds,
  readGroupedTaskCollapsedGroupIds,
} from "../project-sidebar/grouped-expansion.js";
import { pruneCollapsedGroupedTaskGroupIds } from "../project-sidebar/grouped/view.js";

describe("D-05 project collapse persistence across session-list refreshes", () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("sidebar group collapse survives session-list refreshes; a transient empty refresh cannot wipe it", () => {
    // 用户收起 g1：真实 helper 立即落盘。
    persistGroupedTaskCollapsedGroupIds(new Set(["g1"]));
    expect([...readGroupedTaskCollapsedGroupIds()]).toEqual(["g1"]);

    // 瞬时空刷新（首帧 sqlite view 未加载）：直接 prune 会把偏好清空——
    // 这正是侧栏守卫要挡住的帧。守卫跳过该帧后存储原样。
    expect([...pruneCollapsedGroupedTaskGroupIds(readGroupedTaskCollapsedGroupIds(), [])]).toEqual(
      [],
    );
    expect([...readGroupedTaskCollapsedGroupIds()]).toEqual(["g1"]);

    // 完整列表刷新（g1 有新会话、g2 是新组）：g1 保持收起，g2 默认展开。
    const refreshedIds = ["g1", "g2"];
    const afterRefresh = pruneCollapsedGroupedTaskGroupIds(
      readGroupedTaskCollapsedGroupIds(),
      refreshedIds,
    );
    persistGroupedTaskCollapsedGroupIds(afterRefresh);
    expect([...readGroupedTaskCollapsedGroupIds()]).toEqual(["g1"]);

    // 再次刷新（又一次 session-list refresh）：幂等，不重复写盘语义下结果一致。
    expect([
      ...pruneCollapsedGroupedTaskGroupIds(readGroupedTaskCollapsedGroupIds(), refreshedIds),
    ]).toEqual(["g1"]);
    expect(localStorage.getItem(GROUPED_TASK_COLLAPSED_GROUPS_STORAGE_KEY)).toBe(
      JSON.stringify({ g1: true }),
    );

    // 收起的组被删除：陈旧记录被清掉，不给未来同 id 的新组留下误命中。
    persistGroupedTaskCollapsedGroupIds(
      pruneCollapsedGroupedTaskGroupIds(readGroupedTaskCollapsedGroupIds(), ["g2"]),
    );
    expect([...readGroupedTaskCollapsedGroupIds()]).toEqual([]);
    // 损坏存储回退为空集合而不是抛错（刷新路径不能因坏数据挂死）。
    localStorage.setItem(GROUPED_TASK_COLLAPSED_GROUPS_STORAGE_KEY, "{not json");
    expect([...readGroupedTaskCollapsedGroupIds()]).toEqual([]);
  });

  it("project sidebar wires persist and restore for group collapse across refreshes (source check)", async () => {
    // 上游 3.16.2 用 ProjectSidebar（TaskGroupedView）替换了旧 WorkspaceSidebar。
    // 新模型下刷新不会整体替换 collapsed 集合（只有逐组 toggle 与全展开），
    // 瞬时空快照守卫与 prune 不再有对应处理器；接线断言改为：
    // 初始集合从 localStorage 恢复 + 每次变化回写。
    const text = await readFile(
      resolve("packages/ui/src/project-sidebar/TaskGroupedView.tsx"),
      "utf8",
    );
    const source = ts.createSourceFile(
      "TaskGroupedView.tsx",
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    // 初始收起集合从 localStorage 恢复（重启/刷新后仍生效）。useState 解构名在
    // BindingElement 上，直接断言初始化器文本。
    expect(text).toContain("useState(readGroupedTaskCollapsedGroupIds)");
    // 用户收起/展开的每一步都同步到 localStorage。
    expect(text).toMatch(
      /persistGroupedTaskCollapsedGroupIds\(collapsed\);[\s\S]{0,120}?\}, \[collapsed\]\)/,
    );
  });
});
