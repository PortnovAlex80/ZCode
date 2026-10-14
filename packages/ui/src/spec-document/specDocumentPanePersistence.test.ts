// @vitest-environment jsdom
// D-05 fixture coverage：文档面板的持久化与冲突恢复（非 GUI 半边）。
// 覆盖：展开/还原文档（DOC-05 按钮接线；specGeneralChatCollapse 规则本体在
//   specGeneralChatCollapse.test.ts）、讨论显隐切换（hide ≠ stop/delete：隐藏后
//   控制器与原生会话保留，不发 stop/deleteSession）、编辑/查看模式持久化、
//   expectedSha256 CAS 保存 + 重开恢复草稿/滚动/布局、外部变更冲突的可见状态与
//   可恢复的 Reload 路径、持久化字段按稳定 workspace identity 键控。
// 仅伪造：文档服务、watcher、原生 uplink 与 SessionPane/PreviewPane 外壳
//   （非本独占路径）；保存 CAS 前置条件、草稿/展示状态持久化、watcher 冲突分支
//   全部走真实实现。GUI 几何半边（真实窗口中的浮动/停靠/拖拽/两显示器几何）保持
//   live-gated，不由本文件伪造。
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CommandAck,
  CommandEnvelope,
  ConversationSnapshot,
} from "@zcode/shared/zcode-protocol-v4";
import { ServiceProvider } from "../hooks/useServices.js";
import { SpecDocumentPane } from "./SpecDocumentPane.js";
import { getSpecThreadStore, type SpecThread } from "./specThread.js";
import { specThreadStorageKey } from "./nativeDiscussionHandoff.js";
import {
  defaultDocumentPresentation,
  documentPresentationKey,
  readDocumentDraft,
  readDocumentPresentation,
  writeDocumentPresentation,
  type DocumentPresentationState,
} from "./specDocumentPresentationState.js";

const pane = vi.hoisted(() => ({
  layer: null as unknown as ReturnType<typeof createPaneLayer>,
  sendCommand: null as unknown as (
    envelope: CommandEnvelope,
  ) => Promise<CommandAck>,
  previewProps: null as Record<string, unknown> | null,
  sessionPanes: [] as Record<string, unknown>[],
}));

/**
 * 假数据层沿用 specDocumentEntryPoints.test.ts 的只读契约：getState 返回稳定
 * projection 形状（useSyncExternalStore 要求），命令面只记录计数。
 */
function createPaneLayer() {
  interface FakeState {
    status: string;
    snapshot: ConversationSnapshot | null;
    listeners: Set<() => void>;
    projectionState: Record<string, unknown>;
  }
  const sessions = new Map<string, FakeState>();
  const rebuild = (state: FakeState) => {
    state.projectionState = {
      status: state.status,
      snapshot: state.snapshot,
      subscriptionId: null,
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
      sessionPlans: [],
      planDirectoryRevision: 0,
      plansLoading: false,
    };
  };
  return {
    sessions,
    seed(sessionId: string, snapshot: ConversationSnapshot | null) {
      const state: FakeState = {
        status: snapshot ? "live" : "idle",
        snapshot,
        listeners: new Set(),
        projectionState: {},
      };
      rebuild(state);
      sessions.set(sessionId, state);
    },
    acquire(sessionId: string) {
      if (!sessions.has(sessionId)) {
        const fresh: FakeState = {
          status: "idle",
          snapshot: null,
          listeners: new Set(),
          projectionState: {},
        };
        rebuild(fresh);
        sessions.set(sessionId, fresh);
      }
      const state = sessions.get(sessionId)!;
      return {
        sessionId,
        openKind: "pane",
        startedAt: 0,
        store: {
          subscribe: (listener: () => void) => {
            state.listeners.add(listener);
            return () => state.listeners.delete(listener);
          },
          getState: () => state.projectionState,
          markCommandPending: () => {},
          settleCommand: () => {},
          expectAcceptedInputProjection: () => {},
        },
        release: () => {},
      };
    },
    async queryCommands() {
      return { results: [] };
    },
  };
}

vi.mock("../PreviewPane.js", () => ({
  // documentActions 必须真实渲染：讨论切换、编辑/查看、Reload、Save、展开/还原
  // 按钮全部经由 PreviewPane 的 documentActions 挂载。
  PreviewPane: (props: Record<string, unknown>) => {
    pane.previewProps = props;
    return createElement(
      "div",
      null,
      (props.documentActions as ReactNode | undefined) ?? null,
      (props.sourceEditor as ReactNode | undefined) ?? null,
    );
  },
}));
vi.mock("../v4/V4ConversationContext.js", () => ({
  V4PaneConversationProvider: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  useV4Conversation: () => ({
    layer: pane.layer,
    sendCommand: pane.sendCommand,
  }),
}));
vi.mock("../v4/SessionPane.js", () => ({
  SessionPane: (props: Record<string, unknown>) => {
    pane.sessionPanes.push(props);
    return createElement("div", {
      "data-native-composer-stub": String(props.sessionId ?? ""),
    });
  },
}));

const DOC_PATH = "docs/spec.md";
const BASE_CONTENT = "# Spec\n\nbase paragraph\n";
const BASE_SHA = "sha-d5-base-0001";
const EXTERNAL_CONTENT = "# Spec\n\nrewritten by an external tool\n";
const WORKSPACE_PATH = "D:\\ws";

/** 可变磁盘 + 记录保存调用的文档服务：CAS 语义与 services 侧一致（sha 不符即拒绝）。 */
function createDocumentsService(options: { writable: boolean }) {
  const disk = new Map<string, { content: string; sha256: string }>([
    [DOC_PATH, { content: BASE_CONTENT, sha256: BASE_SHA }],
  ]);
  const saveCalls: { path: string; content: string; expectedSha256: string }[] =
    [];
  let revision = 0;
  return {
    disk,
    saveCalls,
    mutateDisk(content: string) {
      revision += 1;
      disk.set(DOC_PATH, { content, sha256: `sha-d5-external-${revision}` });
    },
    service: {
      getWorkspace: async () => ({
        root: "D:\\ws",
        writable: options.writable,
      }),
      list: async () => [DOC_PATH],
      read: async ({ path }: { path: string }) => {
        const entry = disk.get(path);
        if (!entry) throw new Error(`ENOENT: no such file, open '${path}'`);
        return { path, content: entry.content, sha256: entry.sha256 };
      },
      save: async (params: {
        path: string;
        content: string;
        expectedSha256: string;
      }) => {
        saveCalls.push({ ...params });
        const current = disk.get(params.path);
        if (!current || current.sha256 !== params.expectedSha256)
          throw new Error("Document changed on disk. Reload before saving.");
        const next = {
          content: params.content,
          sha256: `sha-d5-saved-${++revision}`,
        };
        disk.set(params.path, next);
        return { path: params.path, ...next };
      },
    },
  };
}

/**
 * watcher 桩：onDynamicChange 的真实契约是 Event<FileWatchEvent>——
 * `(listener) => IDisposable`。桩登记 listener 并返回 disposer，
 * fireExternalChange 供测试显式触发一次原生目录变更事件。
 */
function createWatcher() {
  let listener: ((event: { changedPath?: string }) => void) | null = null;
  return {
    fireExternalChange() {
      listener?.({ changedPath: "D:/ws/docs/spec.md" });
    },
    stub: {
      watch: async () => ({ id: "watch-d5" }),
      unwatch: async () => {},
      onDynamicChange:
        (_id: string) => (next: (event: { changedPath?: string }) => void) => {
          listener = next;
          return { dispose() {} };
        },
    },
  };
}

function seedThread(identity: string, thread: SpecThread) {
  const store = getSpecThreadStore(
    specThreadStorageKey(WORKSPACE_PATH, identity),
    identity,
  );
  store.update(() => [thread]);
  return store;
}

function snapshotFor(sessionId: string): ConversationSnapshot {
  return {
    sessionId,
    config: { provider: "native-provider", model: "native-model" },
    inputRouting: { mode: "startNow" },
    control: { activeWorks: [], phase: "idle", stopState: "idle" },
    queue: { items: [] },
    backgroundWorks: [],
    rows: { totalCount: 0, window: [], firstRowId: null },
  } as unknown as ConversationSnapshot;
}

interface RenderOptions {
  identity: string;
  editing?: boolean;
  discussionsVisible?: boolean;
  activeThreadId?: string | null;
  writable?: boolean;
  parentSessionId?: string | null;
  workspacePath?: string;
  /** 重开场景：消费已存在的持久化状态，不预写新展示状态。 */
  keepPersistedPresentation?: boolean;
}

/**
 * 渲染文档面板。默认按 identity 预写展示状态；keepPersistedPresentation 时跳过
 * 预写以便验证恢复。返回同一份服务/watcher 实例，供外部变更与保存断言推进。
 */
function renderDocumentPane(
  options: RenderOptions,
  documents = createDocumentsService({ writable: options.writable ?? false }),
  watcher = createWatcher(),
) {
  const workspacePath = options.workspacePath ?? WORKSPACE_PATH;
  const key = documentPresentationKey(workspacePath, options.identity);
  if (!options.keepPersistedPresentation) {
    const presentation: DocumentPresentationState = {
      ...defaultDocumentPresentation(),
      path: DOC_PATH,
      editing: options.editing ?? false,
      discussionsVisible: options.discussionsVisible ?? false,
      activeThreadId: options.activeThreadId ?? null,
    };
    writeDocumentPresentation(key, presentation);
  }
  const paneProps = {
    workspacePath,
    workspaceIdentity: options.identity,
    parentSessionId: options.parentSessionId ?? null,
    onClose: () => {},
  };
  const view = render(
    createElement(ServiceProvider, {
      services: {
        specDocumentService: documents.service,
        fileWatcherService: watcher.stub,
      } as unknown as Parameters<typeof ServiceProvider>[0]["services"],
      children: createElement(SpecDocumentPane, paneProps),
    }),
  );
  return {
    view,
    documents,
    watcher,
    key,
    rerender(next: Partial<RenderOptions> & { identity: string }) {
      const merged = { ...options, ...next };
      const props = {
        workspacePath: merged.workspacePath ?? WORKSPACE_PATH,
        workspaceIdentity: merged.identity,
        parentSessionId: merged.parentSessionId ?? null,
        onClose: () => {},
      };
      view.rerender(
        createElement(ServiceProvider, {
          services: {
            specDocumentService: documents.service,
            fileWatcherService: watcher.stub,
          } as unknown as Parameters<typeof ServiceProvider>[0]["services"],
          children: createElement(SpecDocumentPane, props),
        }),
      );
    },
  };
}

async function openedEditor(expected = BASE_CONTENT) {
  const editor = (await screen.findByLabelText(
    "Document source editor",
  )) as HTMLTextAreaElement;
  await waitFor(() => expect(editor.value).toBe(expected));
  return editor;
}

describe("D-05 document pane persistence and conflict recovery", () => {
  let sent: CommandEnvelope[] = [];
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    pane.previewProps = null;
    pane.sessionPanes.length = 0;
    pane.layer = createPaneLayer();
    sent = [];
    pane.sendCommand = async (
      envelope: CommandEnvelope,
    ): Promise<CommandAck> => {
      sent.push(envelope);
      if (envelope.type === "createSession")
        return {
          commandId: envelope.commandId,
          status: "accepted",
          result: { type: "createSession", sessionId: "child-d5" },
        } as CommandAck;
      return {
        commandId: envelope.commandId,
        status: "accepted",
      } as CommandAck;
    };
    // jsdom 没有 ResizeObserver：停靠布局测量在测试里退化为空观察器。
    globalThis.ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    // jsdom 无 Web Locks：伪造总是授予独占锁的管理器，让 discussion writer 进入 owned。
    Object.defineProperty(globalThis.navigator, "locks", {
      configurable: true,
      value: {
        request: async (
          _name: string,
          _options: unknown,
          callback: (lock: unknown) => Promise<void>,
        ) => callback({ mode: "exclusive" }),
      },
    });
  });

  it("hiding discussions keeps controllers and native sessions (hide is not stop/delete) and persists the choice", async () => {
    const identity = "d5-hide-not-delete";
    const key = documentPresentationKey(WORKSPACE_PATH, identity);
    const thread: SpecThread = {
      id: "thread-live",
      documentPath: DOC_PATH,
      parentSessionId: "parent-1",
      sessionId: "child-live",
      discussionStartRowId: 1,
      anchor: {
        start: 6,
        quote: "base paragraph",
        prefix: "# Spec\n\n",
        suffix: "\n",
        sha256: BASE_SHA,
      },
    };
    pane.layer.seed("parent-1", snapshotFor("parent-1"));
    pane.layer.seed("child-live", snapshotFor("child-live"));
    const store = seedThread(identity, thread);
    renderDocumentPane({
      identity,
      editing: false,
      discussionsVisible: true,
      activeThreadId: thread.id,
      parentSessionId: "parent-1",
    });

    // 原生控制器（SessionPane）经真实 handoff 链挂载。
    const mounted = await waitFor(() => {
      const node = document.querySelector(
        "[data-native-discussion-owner='child-live']",
      );
      expect(node).toBeTruthy();
      return node as Element;
    });
    expect(pane.sessionPanes.at(-1)).toMatchObject({
      sessionId: "child-live",
      readOnly: false,
    });

    // 隐藏：只隐藏 aside，不卸载控制器、不发 stop/deleteSession。
    fireEvent.click(screen.getByLabelText("Hide discussions"));
    await waitFor(() =>
      expect(readDocumentPresentation(key).discussionsVisible).toBe(false),
    );
    expect(
      document.querySelector("aside[data-discussion-mode='docked']")?.className,
    ).toContain("hidden");
    // 控制器仍是同一 DOM 节点：隐藏不是卸载/停止/删除。
    expect(
      document.querySelector("[data-native-discussion-owner='child-live']"),
    ).toBe(mounted);
    expect(sent).toEqual([]);
    expect(store.get()[0]!.sessionId).toBe("child-live");
    // 隐藏线程的遥测/对话框收起，但控制器仍挂载在同一会话上。
    await waitFor(() =>
      expect(pane.sessionPanes.at(-1)).toMatchObject({
        sessionId: "child-live",
        telemetryVisible: false,
        interactionDialogsVisible: false,
      }),
    );

    // 再显示：同一线程、同一原生会话，无任何新增原生命令。
    fireEvent.click(screen.getByLabelText("Discussions"));
    await waitFor(() =>
      expect(readDocumentPresentation(key).discussionsVisible).toBe(true),
    );
    expect(
      document.querySelector("[data-native-discussion-owner='child-live']"),
    ).toBe(mounted);
    await waitFor(() =>
      expect(pane.sessionPanes.at(-1)).toMatchObject({
        sessionId: "child-live",
        telemetryVisible: true,
      }),
    );
    expect(sent).toEqual([]);
    expect(store.get()[0]!.sessionId).toBe("child-live");
  });

  it("edit/view mode toggles persist, never write the file, and keep unsaved drafts across the switch", async () => {
    const identity = "d5-edit-view";
    const key = documentPresentationKey(WORKSPACE_PATH, identity);
    const { documents } = renderDocumentPane({ identity, editing: false });

    // 初始查看模式：没有编辑器，展示状态记录 editing=false。
    await waitFor(() =>
      expect(screen.queryByLabelText("Document source editor")).toBeNull(),
    );
    expect(readDocumentPresentation(key).editing).toBe(false);

    // 切到编辑：textarea 出现并持久化 editing=true。
    fireEvent.click(screen.getByLabelText("Edit"));
    const editor = await openedEditor();
    expect(readDocumentPresentation(key).editing).toBe(true);

    // 编辑内容：草稿按原始磁盘 hash 持久化（保存前置条件不随缓冲变化）。
    fireEvent.change(editor, {
      target: { value: `${BASE_CONTENT}local edit` },
    });
    await waitFor(() =>
      expect(readDocumentDraft(key, DOC_PATH)).toEqual({
        content: `${BASE_CONTENT}local edit`,
        baseSha256: BASE_SHA,
      }),
    );

    // 切回查看再切回编辑：不落盘、草稿不丢。
    fireEvent.click(screen.getByLabelText("View"));
    await waitFor(() =>
      expect(screen.queryByLabelText("Document source editor")).toBeNull(),
    );
    expect(readDocumentPresentation(key).editing).toBe(false);
    fireEvent.click(screen.getByLabelText("Edit"));
    // openedEditor 断言编辑器值 = 未保存草稿（跨模式切换不丢）。
    await openedEditor(`${BASE_CONTENT}local edit`);
    // 模式切换是纯本地视图操作：磁盘与保存调用都保持零。
    expect(documents.saveCalls).toEqual([]);
    expect(documents.disk.get(DOC_PATH)!.sha256).toBe(BASE_SHA);
  });

  it("save carries the expectedSha256 CAS precondition; reload restores draft, scroll and discussion layout", async () => {
    const identity = "d5-save-cas";
    const key = documentPresentationKey(WORKSPACE_PATH, identity);
    const first = renderDocumentPane({
      identity,
      editing: true,
      writable: true,
    });

    const editor = await openedEditor();
    fireEvent.change(editor, {
      target: { value: `${BASE_CONTENT}saved edit` },
    });
    await waitFor(() =>
      expect(
        (screen.getByLabelText("Save") as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByLabelText("Save"));

    // CAS 前置条件 = 打开文档时的磁盘 hash，而不是脏缓冲的 hash。
    // （载荷经面板的 service 边界补齐 workspacePath，属预期。）
    await waitFor(() => expect(first.documents.saveCalls.length).toBe(1));
    expect(first.documents.saveCalls[0]).toMatchObject({
      path: DOC_PATH,
      content: `${BASE_CONTENT}saved edit`,
      expectedSha256: BASE_SHA,
    });
    await waitFor(() => expect(screen.getByText("Saved on disk")).toBeTruthy());
    // 干净状态：草稿条目被移除，磁盘已是新内容。
    expect(readDocumentDraft(key, DOC_PATH)).toBeNull();
    expect(first.documents.disk.get(DOC_PATH)!.content).toBe(
      `${BASE_CONTENT}saved edit`,
    );

    // 滚动位置与浮动布局进入展示状态。
    await new Promise((resolve) => setTimeout(resolve, 30));
    editor.scrollTop = 214;
    fireEvent.scroll(editor);
    fireEvent.click(screen.getByLabelText("Float discussion"));
    await waitFor(() =>
      expect(readDocumentPresentation(key).discussionMode).toBe("floating"),
    );
    expect(readDocumentPresentation(key).scrollTop).toBe(214);

    // CAS 失败：外部先行改动后保存被拒，草稿与原始 hash 保留，错误可见。
    first.documents.mutateDisk(EXTERNAL_CONTENT);
    fireEvent.change(editor, {
      target: { value: `${BASE_CONTENT}saved edit again` },
    });
    await waitFor(() =>
      expect(
        (screen.getByLabelText("Save") as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByLabelText("Save"));
    await waitFor(() => expect(first.documents.saveCalls.length).toBe(2));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "Document changed on disk. Reload before saving.",
      ),
    );
    expect(readDocumentDraft(key, DOC_PATH)).toEqual({
      content: `${BASE_CONTENT}saved edit again`,
      baseSha256: "sha-d5-saved-1",
    });
    expect(first.documents.disk.get(DOC_PATH)!.content).toBe(EXTERNAL_CONTENT);

    // 重开（卸载后按同一 identity 重新挂载）：路径/编辑模式/草稿/滚动/布局全部恢复。
    first.view.unmount();
    const reopened = renderDocumentPane(
      {
        identity,
        editing: true,
        writable: true,
        keepPersistedPresentation: true,
      },
      first.documents,
    );
    const editorAfterReopen = (await screen.findByLabelText(
      "Document source editor",
    )) as HTMLTextAreaElement;
    await waitFor(() =>
      expect(editorAfterReopen.value).toBe(`${BASE_CONTENT}saved edit again`),
    );
    await waitFor(() => expect(editorAfterReopen.scrollTop).toBe(214));
    await waitFor(() =>
      expect(
        document.querySelector("aside[data-discussion-mode='floating']"),
      ).toBeTruthy(),
    );
    const restored = readDocumentPresentation(reopened.key);
    expect(restored.path).toBe(DOC_PATH);
    expect(restored.editing).toBe(true);
    expect(restored.discussionMode).toBe("floating");
    expect(restored.scrollTop).toBe(214);
  });

  it("external change with a dirty draft marks a visible conflict and Reload is the recoverable path", async () => {
    const identity = "d5-external-conflict";
    const key = documentPresentationKey(WORKSPACE_PATH, identity);
    const { documents, watcher } = renderDocumentPane({
      identity,
      editing: true,
    });

    const editor = await openedEditor();
    fireEvent.change(editor, {
      target: { value: `${BASE_CONTENT}unsaved conflict draft` },
    });
    await waitFor(() =>
      expect(readDocumentDraft(key, DOC_PATH)).toEqual({
        content: `${BASE_CONTENT}unsaved conflict draft`,
        baseSha256: BASE_SHA,
      }),
    );

    // 外部工具改写磁盘并触发原生 watcher：草稿在编辑 → conflict 分支，不静默覆盖。
    documents.mutateDisk(EXTERNAL_CONTENT);
    watcher.fireExternalChange();

    await waitFor(() =>
      expect(
        screen
          .getAllByRole("alert")
          .some((node) =>
            node.textContent?.includes("Document changed externally"),
          ),
      ).toBe(true),
    );
    // 状态标记：脏草稿在身时页脚显示 "Unsaved draft"，冲突细节在 alert 中给出
    // Reload（放弃草稿）与 Save（按原 hash CAS）两条路径。
    expect(screen.getByText("Unsaved draft")).toBeTruthy();
    expect(
      screen
        .getAllByRole("alert")
        .some((node) =>
          node.textContent?.includes("Reload discards your draft"),
        ),
    ).toBe(true);
    // 草稿与原始 hash 原样保留。
    expect(readDocumentDraft(key, DOC_PATH)).toEqual({
      content: `${BASE_CONTENT}unsaved conflict draft`,
      baseSha256: BASE_SHA,
    });
    expect(editor.value).toBe(`${BASE_CONTENT}unsaved conflict draft`);

    // 恢复路径：Reload 丢弃草稿并载入当前磁盘内容。
    fireEvent.click(screen.getByLabelText("Reload"));
    await waitFor(() => expect(editor.value).toBe(EXTERNAL_CONTENT));
    await waitFor(() => expect(readDocumentDraft(key, DOC_PATH)).toBeNull());
    await waitFor(() =>
      expect(screen.getByText("Reloaded from disk")).toBeTruthy(),
    );
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("a clean buffer adopts external disk changes in place without a conflict", async () => {
    const identity = "d5-external-clean";
    const { documents, watcher } = renderDocumentPane({
      identity,
      editing: true,
    });
    const editor = await openedEditor();
    documents.mutateDisk(EXTERNAL_CONTENT);
    watcher.fireExternalChange();
    await waitFor(() => expect(editor.value).toBe(EXTERNAL_CONTENT));
    await waitFor(() =>
      expect(screen.getByText("Updated from disk")).toBeTruthy(),
    );
  });

  it("document actions no longer own chat visibility; discussion controllers stay mounted (U-04)", async () => {
    const identity = "d5-expand-restore";
    const thread: SpecThread = {
      id: "thread-expand",
      documentPath: DOC_PATH,
      parentSessionId: "parent-1",
      sessionId: "child-expand",
      discussionStartRowId: 1,
      anchor: {
        start: 6,
        quote: "base paragraph",
        prefix: "# Spec\n\n",
        suffix: "\n",
        sha256: BASE_SHA,
      },
    };
    pane.layer.seed("parent-1", snapshotFor("parent-1"));
    pane.layer.seed("child-expand", snapshotFor("child-expand"));
    seedThread(identity, thread);
    renderDocumentPane({
      identity,
      editing: false,
      discussionsVisible: true,
      activeThreadId: thread.id,
      parentSessionId: "parent-1",
    });

    await waitFor(() =>
      expect(
        document.querySelector("[data-native-discussion-owner='child-expand']"),
      ).toBeTruthy(),
    );
    // U-04 迁移：⤢ «Развернуть документ»/«Вернуть чат» 已并入 tabs caption 的角色开关，
    // 文档头不再渲染任何聊天显隐控制（也不残留 stray aria-label）。
    expect(screen.queryByLabelText("Развернуть документ")).toBeNull();
    expect(screen.queryByLabelText("Вернуть чат")).toBeNull();
    // 讨论控制器保持挂载：文档动作区不因移除 ⤢ 而改变挂载语义。
    expect(
      document.querySelector("[data-native-discussion-owner='child-expand']"),
    ).toBeTruthy();
    // 讨论显隐、编辑/查看、Reload、Save 仍可用。
    for (const label of ["Discussions", "Edit", "Reload", "Save"]) {
      expect(screen.getByLabelText(label)).toBeTruthy();
    }
    expect(sent).toEqual([]);
  });

  it("persisted fields are keyed by the stable workspace identity, not the current root path", async () => {
    const identity = "d5-identity-key";
    const key = documentPresentationKey(WORKSPACE_PATH, identity);
    // identity A：留下脏草稿与完整展示状态。
    const first = renderDocumentPane({ identity, editing: true });
    const editor = await openedEditor();
    fireEvent.change(editor, {
      target: { value: `${BASE_CONTENT}identity draft` },
    });
    await waitFor(() =>
      expect(readDocumentDraft(key, DOC_PATH)).toEqual({
        content: `${BASE_CONTENT}identity draft`,
        baseSha256: BASE_SHA,
      }),
    );
    cleanup();

    // 根目录改名（路径变化、identity 不变）：同一份持久化状态恢复文档与草稿。
    renderDocumentPane(
      {
        identity,
        editing: true,
        workspacePath: "D:\\renamed-root",
        keepPersistedPresentation: true,
      },
      first.documents,
    );
    const renamedEditor = (await screen.findByLabelText(
      "Document source editor",
    )) as HTMLTextAreaElement;
    await waitFor(() =>
      expect(renamedEditor.value).toBe(`${BASE_CONTENT}identity draft`),
    );
    const renamedKey = documentPresentationKey("D:\\renamed-root", identity);
    expect(readDocumentPresentation(renamedKey).path).toBe(DOC_PATH);
    expect(readDocumentDraft(renamedKey, DOC_PATH)).toEqual({
      content: `${BASE_CONTENT}identity draft`,
      baseSha256: BASE_SHA,
    });
    cleanup();

    // 同一路径、不同 identity：默认展示状态，无草稿泄漏。
    renderDocumentPane({ identity: "d5-identity-other", editing: true });
    const otherEditor = (await screen.findByLabelText(
      "Document source editor",
    )) as HTMLTextAreaElement;
    await waitFor(() => expect(otherEditor.value).toBe(BASE_CONTENT));
    expect(
      readDocumentPresentation(
        documentPresentationKey(WORKSPACE_PATH, "d5-identity-other"),
      ),
    ).toEqual({
      ...defaultDocumentPresentation(),
      path: DOC_PATH,
      editing: true,
    });
    expect(
      readDocumentDraft(
        documentPresentationKey(WORKSPACE_PATH, "d5-identity-other"),
        DOC_PATH,
      ),
    ).toBeNull();
  });
});
