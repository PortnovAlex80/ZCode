import { describe, expect, it } from "vitest";
import type { ProjectTask, ProjectTree, VirtualProject } from "@/project-sidebar/contract.js";
import {
  countUnreadTasksSinceBaseline,
  mergeBaselineForHosts,
  type UnreadAtBaseline,
} from "@/project-sidebar/view.js";

const task = (id: string, overrides: Partial<ProjectTask> = {}): ProjectTask => ({
  taskId: id,
  projectId: "p1",
  hostId: "local",
  pinned: false,
  archived: false,
  workspacePath: "/repo",
  title: id,
  mode: "build",
  traceId: id,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

const project = (id: string, hostId: string, deleted = false): VirtualProject => ({
  id,
  hostId,
  name: id,
  nameOverridden: false,
  roots: [],
  position: 0,
  pinned: false,
  deleted,
});

const tree = (
  tasks: ProjectTask[],
  projects: VirtualProject[] = [project("p1", "local")],
): ProjectTree => ({ projects, tasks });

// v3.18 contract: the badge no longer counts the whole tree. Each host that completed a
// read gets a startup baseline snapshot; only unreads outside that baseline count. An
// empty per-host baseline means "the host read successfully with no unread yet", so every
// current unread in the tree is treated as new — the direct analogue of the old
// count-everything semantics.
function baselineWith(hosts: string[], tree: ProjectTree = { projects: [], tasks: [] }) {
  const baseline: UnreadAtBaseline = new Map();
  mergeBaselineForHosts(new Set(hosts), tree, baseline);
  return baseline;
}

const emptyBaseline = (hosts: string[]) =>
  new Map(hosts.map((hostId) => [hostId, new Map<string, number>()]));

describe("countUnreadTasksSinceBaseline", () => {
  it("只统计非归档且有 unreadAt 的任务", () => {
    expect(
      countUnreadTasksSinceBaseline(
        tree([
          task("a", { unreadAt: 100 }),
          task("b", { unreadAt: undefined }),
          task("c", { unreadAt: 300, archived: true }),
        ]),
        emptyBaseline(["local"]),
      ),
    ).toBe(1);
  });

  it("按 host+workspace+task 去重：不同 host 的同名任务分别计数，同 key 只计一次", () => {
    const duplicate = task("a", { unreadAt: 100 });
    expect(
      countUnreadTasksSinceBaseline(
        tree(
          [
            duplicate,
            // Same host/workspace/task identity arriving twice counts once.
            { ...duplicate, unreadAt: 100 },
            task("b", { unreadAt: 200 }),
            // 本地与远端主机的同路径同名任务在树里是不同实例，分别计数
            task("a", { unreadAt: 300, hostId: "remote:server" }),
          ],
          [project("p1", "local"), project("p1", "remote:server")],
        ),
        emptyBaseline(["local", "remote:server"]),
      ),
    ).toBe(3);
  });

  it("空树计 0", () => {
    expect(countUnreadTasksSinceBaseline(tree([]), emptyBaseline(["local"]))).toBe(0);
  });

  it("host 没有基线（读取尚未成功）时整 host 不计", () => {
    expect(countUnreadTasksSinceBaseline(tree([task("a", { unreadAt: 100 })]), new Map())).toBe(0);
  });

  it("孤儿任务（项目不存在）不计入：没有蓝点落点的未读不产生幽灵提醒", () => {
    expect(
      countUnreadTasksSinceBaseline(
        tree([task("orphan", { unreadAt: 100, projectId: "ghost" })]),
        emptyBaseline(["local"]),
      ),
    ).toBe(0);
  });

  it("软删项目的未读不计入（侧边栏不渲染已删项目）", () => {
    expect(
      countUnreadTasksSinceBaseline(
        tree(
          [task("a", { unreadAt: 100 }), task("ghost", { unreadAt: 200, projectId: "p-deleted" })],
          [project("p1", "local"), project("p-deleted", "local", true)],
        ),
        emptyBaseline(["local"]),
      ),
    ).toBe(1);
  });

  it("置顶任务跨项目可见：软删项目的置顶未读仍计入", () => {
    expect(
      countUnreadTasksSinceBaseline(
        tree(
          [task("pinned", { unreadAt: 100, pinned: true, projectId: "p-deleted" })],
          [project("p1", "local"), project("p-deleted", "local", true)],
        ),
        emptyBaseline(["local"]),
      ),
    ).toBe(1);
  });

  it("本地无项目任务（projectId null + host local）计入", () => {
    expect(
      countUnreadTasksSinceBaseline(
        tree([task("local-task", { unreadAt: 100, projectId: null })]),
        emptyBaseline(["local"]),
      ),
    ).toBe(1);
  });

  it("基线吸收快照时刻已有的未读，只有基线外的新未读计数", () => {
    const baseline = baselineWith(["local"], {
      projects: [project("p1", "local")],
      tasks: [task("known", { unreadAt: 100 })],
    });
    expect(
      countUnreadTasksSinceBaseline(
        tree([task("known", { unreadAt: 100 }), task("fresh", { unreadAt: 200 })]),
        baseline,
      ),
    ).toBe(1);
    // Baseline tasks that complete again produce a new unreadAt marker and count again.
    expect(
      countUnreadTasksSinceBaseline(
        tree([task("known", { unreadAt: 300 }), task("fresh", { unreadAt: 200 })]),
        baseline,
      ),
    ).toBe(2);
  });

  it("mergeBaselineForHosts 幂等：已建基线的 host 不被后续快照覆盖", () => {
    const baseline = baselineWith(["local"], {
      projects: [project("p1", "local")],
      tasks: [task("known", { unreadAt: 100 })],
    });
    mergeBaselineForHosts(
      new Set(["local"]),
      tree([task("known", { unreadAt: 100 }), task("fresh", { unreadAt: 900 })]),
      baseline,
    );
    expect(
      countUnreadTasksSinceBaseline(
        tree([task("known", { unreadAt: 100 }), task("fresh", { unreadAt: 900 })]),
        baseline,
      ),
    ).toBe(1);
  });
});
