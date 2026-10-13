// @vitest-environment jsdom
// D-05 fixture coverage：项目收起状态的持久化（非 GUI 半边）。
// 两层：
// 1) useSpecProjectCatalog（本独占路径内的真实 hook）：跨窗口项目目录同步
//    重新加入一个已被本窗口收起的项目时，目录成员成立、收起状态不被重置；
//    会话列表刷新（tabs 变化）不广播伪 add/remove、不改收起状态；关闭项目广播
//    remove。收起偏好用真实 readWorkspaceExpansionState/persistWorkspaceExpandedPreference
//    持久化在 localStorage。
// 2) 侧栏分组收起（SHELL-15 的 refresh 场景，此前"no focused fixture located for
//    the refresh case"）：用真实 groupedTaskExpansionPreference/view helpers 复现
//    WorkspaceSidebar 的刷新序列——瞬时空快照不清偏好、完整刷新保留收起、
//    删除组清掉陈旧记录；并以源码断言确认侧栏实际接线（守卫 + persist + prune）。
// jsdom 没有 BroadcastChannel：用进程内总线桩替换（同实例互达、不同名隔离）。
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StoreApi } from "zustand";
import type { TabStoreState } from "../store/tabStore.js";
import { useSpecProjectCatalog } from "./useSpecProjectCatalog.js";
import {
  persistWorkspaceExpandedPreference,
  readWorkspaceExpansionState,
} from "../lib/workspaceExpansionPreference.js";
import {
  GROUPED_TASK_COLLAPSED_GROUPS_STORAGE_KEY,
  persistGroupedTaskCollapsedGroupIds,
  readGroupedTaskCollapsedGroupIds,
} from "../lib/groupedTaskExpansionPreference.js";
import { pruneCollapsedGroupedTaskGroupIds } from "../workspace-grouped-tasks/view.js";

/** 进程内 BroadcastChannel 桩：同名通道互达，postMessage 异步投递到对端。 */
class FakeBroadcastChannel {
  private static readonly buses = new Map<string, Set<FakeBroadcastChannel>>();
  readonly name: string;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  constructor(name: string) {
    this.name = name;
    let bus = FakeBroadcastChannel.buses.get(name);
    if (!bus) {
      bus = new Set();
      FakeBroadcastChannel.buses.set(name, bus);
    }
    bus.add(this);
  }
  postMessage(data: unknown) {
    for (const peer of FakeBroadcastChannel.buses.get(this.name) ?? new Set<FakeBroadcastChannel>())
      if (peer !== this) queueMicrotask(() => peer.onmessage?.({ data }));
  }
  close() {
    FakeBroadcastChannel.buses.get(this.name)?.delete(this);
  }
  static reset() {
    FakeBroadcastChannel.buses.clear();
  }
}

interface FakeWorkspaceTab {
  id: string;
  kind: "workspace";
  workspacePath: string;
}

/**
 * 面向 hook 契约的最小 tab store：getState/subscribe + ensureWorkspaceTab /
 * toggleWorkspaceExpanded / closeTab。ensureWorkspaceTab 复刻原生语义——
 * 新 tab 默认展开（hook 依赖这一事实来还原已记住的收起选择）。
 */
function createFakeTabStore(initial: FakeWorkspaceTab[] = []) {
  const listeners = new Set<(state: unknown) => void>();
  const notify = () => {
    // zustand 契约：subscribe 回调收到新 state 作为参数。
    for (const listener of listeners) listener(state);
  };
  const state = {
    tabs: [...initial],
    activeTabId: null as string | null,
    expandedWorkspacePaths: new Set<string>(),
    ensureWorkspaceTab(path: string) {
      if (!state.tabs.some((tab) => tab.workspacePath === path)) {
        state.tabs = [...state.tabs, { id: `tab:${path}`, kind: "workspace", workspacePath: path }];
        state.expandedWorkspacePaths.add(path);
      }
      notify();
      return `tab:${path}`;
    },
    toggleWorkspaceExpanded(path: string) {
      if (state.expandedWorkspacePaths.has(path)) state.expandedWorkspacePaths.delete(path);
      else state.expandedWorkspacePaths.add(path);
      notify();
    },
    closeTab(tabId: string) {
      state.tabs = state.tabs.filter((tab) => tab.id !== tabId);
      notify();
    },
  };
  return {
    getState: () => state,
    subscribe(listener: (state: unknown) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** 会话列表刷新：同一批项目的 tabs 以新数组引用到达（含新会话的组）。 */
    refresh(tabs: FakeWorkspaceTab[]) {
      state.tabs = [...tabs];
      notify();
    },
    /** 假 store 只实现 hook 的只读契约；按仓库惯例在接线处做有界类型收窄。 */
    asHookStore(): StoreApi<TabStoreState> {
      return this as unknown as StoreApi<TabStoreState>;
    },
  };
}

describe("D-05 project collapse persistence across session-list refreshes", () => {
  let originalBroadcastChannel: unknown;
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    FakeBroadcastChannel.reset();
    // jsdom 缺 BroadcastChannel：先记录原值再替换，测试结束还原。
    originalBroadcastChannel = (globalThis as Record<string, unknown>).BroadcastChannel;
    (globalThis as Record<string, unknown>).BroadcastChannel = FakeBroadcastChannel;
  });
  afterEach(() => {
    if (originalBroadcastChannel === undefined)
      delete (globalThis as Record<string, unknown>).BroadcastChannel;
    else (globalThis as Record<string, unknown>).BroadcastChannel = originalBroadcastChannel;
  });

  it("a cross-window catalog re-add restores this window's remembered collapse; membership without expansion", async () => {
    persistWorkspaceExpandedPreference("D:\\proj", false);
    const store = createFakeTabStore();
    const received: unknown[] = [];
    const peer = new FakeBroadcastChannel("spec-harness:project-catalog:v1");
    peer.onmessage = (event) => received.push(event.data);
    const catalog = renderHook(() => useSpecProjectCatalog(store.asHookStore(), true));

    // 挂载握手：新窗口请求快照。
    await waitFor(() => expect(received).toContainEqual({ type: "request" }));

    // 对端快照同时带回：本窗口收起过的项目、无记录的项目、非法相对路径。
    peer.postMessage({
      type: "snapshot",
      paths: ["D:\\proj", "D:\\open", "relative/invalid"],
    });
    await waitFor(() =>
      expect(store.getState().tabs.map((tab) => tab.workspacePath)).toEqual(["D:\\proj", "D:\\open"]),
    );
    // 目录成员成立，但收起选择被还原：proj 不在展开集合，open 保持默认展开。
    expect(store.getState().expandedWorkspacePaths.has("D:\\proj")).toBe(false);
    expect(store.getState().expandedWorkspacePaths.has("D:\\open")).toBe(true);
    // 偏好本身不被目录同步改写。
    expect(readWorkspaceExpansionState()["D:\\proj"]).toBe(false);

    catalog.unmount();
    peer.close();
  });

  it("session-list refreshes keep the collapse and only real membership changes broadcast", async () => {
    persistWorkspaceExpandedPreference("D:\\proj", false);
    const proj: FakeWorkspaceTab = { id: "tab:D:\\proj", kind: "workspace", workspacePath: "D:\\proj" };
    // 本窗口已打开并收起该项目（expandedWorkspacePaths 无 proj）。
    const store = createFakeTabStore([proj]);
    const received: unknown[] = [];
    const peer = new FakeBroadcastChannel("spec-harness:project-catalog:v1");
    peer.onmessage = (event) => received.push(event.data);
    const catalog = renderHook(() => useSpecProjectCatalog(store.asHookStore(), true));
    await waitFor(() => expect(received).toContainEqual({ type: "request" }));
    const messagesBeforeRefresh = received.length;

    // 会话列表刷新：同一项目、新数组引用（新会话到达）。不得广播伪 add/remove，
    // 也不得触碰收起状态。
    store.refresh([proj]);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    expect(received.length).toBe(messagesBeforeRefresh);
    expect(store.getState().expandedWorkspacePaths.has("D:\\proj")).toBe(false);
    expect(readWorkspaceExpansionState()["D:\\proj"]).toBe(false);

    // 关闭项目 → 广播 remove（对端负责自己的关闭）。
    store.refresh([]);
    await waitFor(() => expect(received).toContainEqual({ type: "remove", path: "D:\\proj" }));

    // 对端把项目加回来：本窗口记住的收起选择再次生效（ensure 默认展开后立即还原）。
    peer.postMessage({ type: "add", path: "D:\\proj" });
    await waitFor(() =>
      expect(store.getState().tabs.map((tab) => tab.workspacePath)).toEqual(["D:\\proj"]),
    );
    expect(store.getState().expandedWorkspacePaths.has("D:\\proj")).toBe(false);

    catalog.unmount();
    peer.close();
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

  it("WorkspaceSidebar wires persist+prune and the transient-empty guard for refreshes (source check)", async () => {
    // 本独占路径不含 WorkspaceSidebar；按既有模式（specGeneralChatCollapse.test.ts
    // 读 WorkspaceShellLayout）以 AST 断言真实接线，避免只测纯函数副本。
    const text = await readFile(resolve("packages/ui/src/WorkspaceSidebar.tsx"), "utf8");
    const source = ts.createSourceFile(
      "WorkspaceSidebar.tsx",
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const declarations = new Map<string, ts.VariableDeclaration>();
    function visit(node: ts.Node) {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name))
        declarations.set(node.name.text, node);
      ts.forEachChild(node, visit);
    }
    visit(source);
    const collapseHandler = declarations.get("handleCollapsedGroupedTaskGroupIdsChange");
    expect(collapseHandler, "collapse handler must exist").toBeTruthy();
    // 用户收起/展开的每一步都同步到 localStorage。
    expect(collapseHandler!.getText(source)).toContain(
      "persistGroupedTaskCollapsedGroupIds(nextGroupIds)",
    );

    const refreshHandler = declarations.get("handleGroupedTaskGroupIdsChange");
    expect(refreshHandler, "group-ids refresh handler must exist").toBeTruthy();
    const refreshText = refreshHandler!.getText(source);
    // 瞬时空快照守卫：未 hydrate 前的空列表不得当作“所有组已删除”。
    expect(refreshText).toContain("nextGroupIds.length === 0");
    expect(refreshText).toContain("!groupedTaskGroupIdsHydrated");
    // 刷新时清陈旧记录并回写偏好。
    expect(refreshText).toContain("pruneCollapsedGroupedTaskGroupIds(");
    expect(refreshText).toContain("persistGroupedTaskCollapsedGroupIds(nextCollapsedGroupIds)");
    // 初始收起集合从 localStorage 恢复（重启/刷新后仍生效）。
    expect(text).toContain("readGroupedTaskCollapsedGroupIds()");
  });
});
