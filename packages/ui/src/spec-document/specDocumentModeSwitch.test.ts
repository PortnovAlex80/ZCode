// @vitest-environment jsdom
/**
 * U-09/U-10/U-11 聚焦套件（活体回归 2026-10-14，安装在用户机器上的构建）。
 *
 * - U-10：Edit ↔ View（глаз）反复切换 × 讨论可见矩阵——渲染保持完好（查看模式回到
 *   渲染视图而不是源码）、讨论 aside 持续渲染、两种模式下 Discussions/眼睛都可用、
 *   无错误态、无卸载、原生讨论控制器节点同一性不变、不需要重开文档 tab。
 *   根因（见 SpecDocumentPane.tsx 的修复注释）：PreviewPane 内部 markdownViewMode 被
 *   编辑态强制为 "code" 后无复位路径（PreviewPane.tsx:734-736 `if (sourceEditor)
 *   setMarkdownViewMode("code")`），且 preserveDocumentViewState 对同一 source 身份
 *   早退（:719）——本套件的 PreviewPane 桩按同样语义建模，键控重挂修复必须让它失效。
 * - U-11：换文件加载（含脏缓冲）、picker 反映当前文档、per-path 草稿保留与恢复。
 * - U-09：txt 只读正文视图（whitespace-pre-wrap，无横向滚动语义）+ 编辑 textarea。
 *   jsdom 不能断言真实换行几何；几何半边保持 live-gated（checklist 约定）。
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement, useEffect, useRef, type ReactNode } from "react";
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
  writeDocumentPresentation,
  type DocumentPresentationState,
} from "./specDocumentPresentationState.js";

const pane = vi.hoisted(() => ({
  layer: null as unknown as ReturnType<typeof createPaneLayer>,
  sendCommand: null as unknown as (envelope: CommandEnvelope) => Promise<CommandAck>,
  mounts: [] as { markdownViewMode: string }[],
}));

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

/**
 * PreviewPane 桩：按真实组件的 markdown 视图状态语义建模（引用行号见文件头）——
 * 挂载或 source 身份变化时按 source 初始化（md → preview；preserveDocumentViewState
 * 对同一身份早退 → 只有身份变化才重初始化，:708-732）；sourceEditor 在场时强制
 * "code" 且没有任何复位路径（:734-736）；documentActions 恒渲染；非 md source 的
 * sourceEditor 槽直接作为内容返回（previewPaneContent.tsx:208）。
 * 若 SpecDocumentPane 不按编辑模式键控重挂，View 模式将永远停在源码视图（活体回归）。
 */
vi.mock("../PreviewPane.js", () => ({
  PreviewPane: (props: Record<string, unknown>) => {
    const source = props.source as { type?: string; language?: string; path?: string } | null;
    const sourceEditor = props.sourceEditor as ReactNode | undefined;
    const stateRef = useRef<{ markdownViewMode: string }>({
      markdownViewMode: source?.language === "markdown" ? "preview" : "code",
    });
    const identity = JSON.stringify([source?.type, source?.path]);
    const identityRef = useRef(identity);
    pane.mounts.push(stateRef.current);
    if (identityRef.current !== identity) {
      // PreviewPane.tsx:708-732：source 身份变化 → 按 source 重新初始化视图状态。
      identityRef.current = identity;
      stateRef.current.markdownViewMode = source?.language === "markdown" ? "preview" : "code";
    }
    useEffect(() => {
      // PreviewPane.tsx:734-736：编辑器在场 → 强制 code；离开编辑不复位（bug 语义）。
      if (sourceEditor) stateRef.current.markdownViewMode = "code";
    }, [Boolean(sourceEditor)]);
    const isMarkdown = source?.language === "markdown";
    const showRenderedView =
      !sourceEditor && isMarkdown && stateRef.current.markdownViewMode === "preview";
    return createElement(
      "div",
      { "data-preview-pane-stub": String(pane.mounts.length) },
      (props.documentActions as ReactNode | undefined) ?? null,
      sourceEditor
        ? sourceEditor
        : showRenderedView
          ? createElement("div", { "data-markdown-preview": "" }, "rendered markdown view")
          : createElement("div", { "data-code-view": "" }, "raw source view"),
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
  SessionPane: (props: Record<string, unknown>) =>
    createElement("div", {
      "data-native-composer-stub": String(props.sessionId ?? ""),
    }),
}));

const WORKSPACE_PATH = "D:\\ws";
const MD_PATH = "docs/spec.md";
const TXT_PATH = "notes/rendering.txt";
const MD_CONTENT =
  "# Spec\n\nbase paragraph with a rather long line of prose that should wrap in the pane width\n";
const TXT_CONTENT =
  "plain prose line one\nand a very long plain text line without any hard breaks that must wrap to the pane width\n";
const MD_SHA = "sha-md-0001";
const TXT_SHA = "sha-txt-0001";

function createDocumentsService() {
  const disk = new Map<string, { content: string; sha256: string }>([
    [MD_PATH, { content: MD_CONTENT, sha256: MD_SHA }],
    [TXT_PATH, { content: TXT_CONTENT, sha256: TXT_SHA }],
  ]);
  return {
    disk,
    service: {
      getWorkspace: async () => ({ root: "D:\\ws", writable: false }),
      list: async () => [MD_PATH, TXT_PATH],
      read: async ({ path }: { path: string }) => {
        const entry = disk.get(path);
        if (!entry) throw new Error(`ENOENT: no such file, open '${path}'`);
        return { path, ...entry };
      },
      save: async () => {
        throw new Error("read-only in this fixture");
      },
    },
  };
}

function createWatcher() {
  return {
    stub: {
      watch: async () => ({ id: "watch" }),
      unwatch: async () => {},
      onDynamicChange: () => () => ({ dispose() {} }),
    },
  };
}

interface RenderOptions {
  identity: string;
  editing?: boolean;
  discussionsVisible?: boolean;
  activeThreadId?: string | null;
  path?: string;
  parentSessionId?: string | null;
}

function renderDocumentPane(options: RenderOptions, documents = createDocumentsService()) {
  const key = documentPresentationKey(WORKSPACE_PATH, options.identity);
  const presentation: DocumentPresentationState = {
    ...defaultDocumentPresentation(),
    path: options.path ?? MD_PATH,
    editing: options.editing ?? false,
    discussionsVisible: options.discussionsVisible ?? false,
    activeThreadId: options.activeThreadId ?? null,
  };
  writeDocumentPresentation(key, presentation);
  const view = render(
    createElement(ServiceProvider, {
      services: {
        specDocumentService: documents.service,
        fileWatcherService: createWatcher().stub,
      } as unknown as Parameters<typeof ServiceProvider>[0]["services"],
      children: createElement(SpecDocumentPane, {
        workspacePath: WORKSPACE_PATH,
        workspaceIdentity: options.identity,
        parentSessionId: options.parentSessionId ?? null,
        onClose: () => {},
      }),
    }),
  );
  return { view, documents, key };
}

function seedThread(identity: string, thread: SpecThread) {
  const store = getSpecThreadStore(specThreadStorageKey(WORKSPACE_PATH, identity), identity);
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

function pickDocument(path: string) {
  fireEvent.click(screen.getByLabelText("Choose project document"));
  const row = Array.from(document.querySelectorAll<HTMLElement>("[data-picker-path]")).find(
    (element) => element.dataset.pickerPath === path,
  )!;
  fireEvent.doubleClick(row);
}

describe("U-10 edit/view toggling keeps rendering and discussions intact", () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    pane.mounts.length = 0;
    pane.layer = createPaneLayer();
    pane.sendCommand = async (envelope: CommandEnvelope): Promise<CommandAck> => ({
      commandId: envelope.commandId,
      status: "accepted",
      revisionAtDecision: 0,
      ...(envelope.type === "createSession"
        ? { result: { type: "createSession", sessionId: "child" } }
        : {}),
    });
    globalThis.ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
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

  it("mode-switch × discussions-visible matrix: rendered view, aside, toggles, no alert, no unmount", async () => {
    const identity = "u10-matrix";
    const thread: SpecThread = {
      id: "thread-u10",
      documentPath: MD_PATH,
      parentSessionId: "parent-1",
      sessionId: "child-u10",
      discussionStartRowId: 1,
      anchor: {
        start: 7,
        quote: "base paragraph",
        prefix: "# Spec\n\n",
        suffix: "\n",
        sha256: MD_SHA,
      },
    };
    pane.layer.seed("parent-1", snapshotFor("parent-1"));
    pane.layer.seed("child-u10", snapshotFor("child-u10"));
    seedThread(identity, thread);
    renderDocumentPane({
      identity,
      editing: false,
      discussionsVisible: true,
      activeThreadId: thread.id,
      parentSessionId: "parent-1",
    });

    const ownerNode = await waitFor(() => {
      const node = document.querySelector("[data-native-discussion-owner='child-u10']");
      expect(node).toBeTruthy();
      return node as Element;
    });
    const paneRoot = document.querySelector("[data-spec-document-pane]")!;
    expect(paneRoot).toBeTruthy();

    // 4 轮 Edit ↔ View（反复切换），覆盖讨论显/隐两个状态（绝对状态驱动，不做 toggle 叠加）。
    const sequence = [
      { mode: "Edit", discussionsVisible: false },
      { mode: "View", discussionsVisible: false },
      { mode: "Edit", discussionsVisible: false },
      { mode: "View", discussionsVisible: false },
      { mode: "Edit", discussionsVisible: true },
      { mode: "View", discussionsVisible: true },
      { mode: "Edit", discussionsVisible: false },
      { mode: "View", discussionsVisible: false },
    ] as const;
    let currentlyVisible = true;
    for (const step of sequence) {
      fireEvent.click(screen.getByLabelText(step.mode));
      if (currentlyVisible !== step.discussionsVisible) {
        fireEvent.click(screen.getByLabelText("Discussions"));
        currentlyVisible = step.discussionsVisible;
      }
      // 每步之后：面板根仍在（无卸载/无需重开 tab）。
      expect(document.querySelector("[data-spec-document-pane]")).toBe(paneRoot);
      // 眼睛/讨论切换在两种模式下都可用（documentActions 恒渲染）。
      expect(screen.getByLabelText("Discussions")).toBeTruthy();
      expect(screen.getByLabelText(step.mode === "Edit" ? "View" : "Edit")).toBeTruthy();
      const aside = document.querySelector('aside[aria-label="Fragment discussions"]');
      expect(aside).toBeTruthy();
      if (step.discussionsVisible) {
        expect(aside!.className).not.toContain("hidden");
        // 原生讨论控制器节点同一性不变：隐藏≠卸载，切换模式≠卸载。
        expect(document.querySelector("[data-native-discussion-owner='child-u10']")).toBe(
          ownerNode,
        );
      } else {
        expect(aside!.className).toContain("hidden");
      }
      // 无错误态。
      expect(screen.queryAllByRole("alert")).toEqual([]);
      // 渲染完好：View 步之后是渲染视图（不是卡死的源码视图）——U-10 根因断言。
      if (step.mode === "View" && step.discussionsVisible) {
        expect(
          document.querySelector("[data-markdown-preview]"),
          "view mode must return to the rendered markdown view",
        ).toBeTruthy();
        expect(screen.queryByLabelText("Document source editor")).toBeNull();
      }
      if (step.mode === "Edit") {
        expect(screen.getByLabelText("Document source editor")).toBeTruthy();
      }
    }

    // 修复机制断言：每次模式切换都挂载新的 PreviewPane（键控重挂），
    // 内部 markdownViewMode 不会跨模式泄漏（桩按真实语义建模）。
    expect(pane.mounts.length).toBeGreaterThanOrEqual(sequence.length);
  });
});

describe("U-11 switching documents loads the file, keeps per-path drafts, picker reflects current", () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    pane.mounts.length = 0;
    pane.layer = createPaneLayer();
    pane.sendCommand = async (envelope: CommandEnvelope): Promise<CommandAck> => ({
      commandId: envelope.commandId,
      status: "accepted",
      revisionAtDecision: 0,
    });
    globalThis.ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
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

  it("picking a different file loads it even with an unsaved draft; drafts are per-path and restored", async () => {
    const identity = "u11-switch";
    const { key } = renderDocumentPane({ identity, editing: true });

    const editor = (await screen.findByLabelText("Document source editor")) as HTMLTextAreaElement;
    await waitFor(() => expect(editor.value).toBe(MD_CONTENT));

    // 活体回归场景：缓冲区有未保存修改（此前 open() 会静默 no-op）。
    fireEvent.change(editor, {
      target: { value: `${MD_CONTENT}unsaved local edit` },
    });
    await waitFor(() =>
      expect(readDocumentDraft(key, MD_PATH)).toEqual({
        content: `${MD_CONTENT}unsaved local edit`,
        baseSha256: MD_SHA,
      }),
    );

    // 从头部选择器换到 txt：必须真正加载（活体反馈：换文件毫无反应）。
    pickDocument(TXT_PATH);
    const editorAfterSwitch = await waitFor(() => {
      const current = screen.getByLabelText("Document source editor") as HTMLTextAreaElement;
      expect(current.value).toBe(TXT_CONTENT);
      return current;
    });
    // picker 反映当前文档。
    expect(screen.getByLabelText("Choose project document").textContent).toContain(
      "notes/rendering.txt",
    );
    // 旧文档草稿仍按 path 保留；txt 自身无草稿（干净缓冲）。
    expect(readDocumentDraft(key, MD_PATH)).toEqual({
      content: `${MD_CONTENT}unsaved local edit`,
      baseSha256: MD_SHA,
    });
    expect(readDocumentDraft(key, TXT_PATH)).toBeNull();

    // 换回 md：未保存草稿恢复（无损切换的设计语义）。
    pickDocument(MD_PATH);
    await waitFor(() =>
      expect((screen.getByLabelText("Document source editor") as HTMLTextAreaElement).value).toBe(
        `${MD_CONTENT}unsaved local edit`,
      ),
    );
    expect(editorAfterSwitch).toBeTruthy();
  });

  it("the picker lists txt files first-class alongside md", async () => {
    const identity = "u11-txt-listed";
    renderDocumentPane({ identity, editing: false });
    await waitFor(() => expect(document.querySelector("[data-markdown-preview]")).toBeTruthy());
    fireEvent.click(screen.getByLabelText("Choose project document"));
    const paths = Array.from(document.querySelectorAll<HTMLElement>("[data-picker-path]")).map(
      (row) => row.dataset.pickerPath,
    );
    expect(paths).toContain(MD_PATH);
    expect(paths).toContain(TXT_PATH);
  });
});

describe("U-09 word wrap semantics (structure half; geometry is live-gated)", () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    pane.mounts.length = 0;
    pane.layer = createPaneLayer();
    pane.sendCommand = async (envelope: CommandEnvelope): Promise<CommandAck> => ({
      commandId: envelope.commandId,
      status: "accepted",
      revisionAtDecision: 0,
    });
    globalThis.ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
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

  it("txt read-only view is a wrapping prose view (no code viewer); the edit textarea wraps by default", async () => {
    const identity = "u09-wrap";
    renderDocumentPane({ identity, editing: false, path: TXT_PATH });
    await waitFor(() => expect(document.querySelector("[data-document-prose]")).toBeTruthy());
    const prose = document.querySelector("[data-document-prose]")!;
    expect(prose.className).toContain("whitespace-pre-wrap");
    expect(prose.className).toContain("break-words");
    expect(prose.className).toContain("overflow-y-auto");
    // 不走代码查看器路径（行号/默认横向滚动）。
    expect(document.querySelector("[data-code-view]")).toBeNull();
    expect(prose.textContent).toContain("plain prose line one");

    // 编辑模式：textarea（默认 soft wrap——无 wrap="off"），值即 txt 内容。
    fireEvent.click(screen.getByLabelText("Edit"));
    const editor = (await screen.findByLabelText("Document source editor")) as HTMLTextAreaElement;
    await waitFor(() => expect(editor.value).toBe(TXT_CONTENT));
    expect(editor.getAttribute("wrap")).not.toBe("off");
    // md 只读视图仍走渲染的 markdown 预览（换行由段落排版保证）。
    fireEvent.click(screen.getByLabelText("View"));
    fireEvent.click(screen.getByLabelText("Choose project document"));
    const mdRow = Array.from(document.querySelectorAll<HTMLElement>("[data-picker-path]")).find(
      (element) => element.dataset.pickerPath === MD_PATH,
    )!;
    fireEvent.doubleClick(mdRow);
    await waitFor(() => expect(document.querySelector("[data-markdown-preview]")).toBeTruthy());
    expect(document.querySelector("[data-document-prose]")).toBeNull();
  });
});
