// @vitest-environment jsdom
// D-03 fixture coverage：文档面板入口在“有效新建父会话 / 有效既有父会话”两种情况下可用，
// 缺能力时禁用态有真实原因；键盘选择与源码/视图选择保留精确片段字节。
// 仅伪造：文档服务、watcher、原生 uplink 与 SessionPane/PreviewPane 外壳（非本独占路径）。
// 锚点构造（select/onDiscussFragment/onDocumentComment/discuss）全部走真实实现。
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { act, createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandAck, CommandEnvelope, ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { ServiceProvider } from "../hooks/useServices.js";
import { SpecDocumentPane } from "./SpecDocumentPane.js";
import { documentQuestion, getSpecThreadStore } from "./specThread.js";
import { specThreadStorageKey } from "./nativeDiscussionHandoff.js";
import { publishNativeExecutionSource } from "./nativeExecutionSource.js";
import {
  buildSelectionSideChatKey,
  getSelectionSideChatOpenState,
  registerSelectionSideChatOpener,
} from "../lib/selectionSideChatRuntime.js";
import {
  defaultDocumentPresentation,
  documentPresentationKey,
  writeDocumentPresentation,
} from "./specDocumentPresentationState.js";

const entry = vi.hoisted(() => ({
  layer: null as unknown as ReturnType<typeof createEntryLayer>,
  sendCommand: null as unknown as (envelope: CommandEnvelope) => Promise<CommandAck>,
  previewProps: null as Record<string, unknown> | null,
}));

function createEntryLayer() {
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

vi.mock("../PreviewPane.js", () => ({
  PreviewPane: (props: Record<string, unknown>) => {
    entry.previewProps = props;
    return createElement("div", null, props.documentActions as ReactNode ?? null, props.sourceEditor as ReactNode ?? null);
  },
}));
vi.mock("../v4/V4ConversationContext.js", () => ({
  V4PaneConversationProvider: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  useV4Conversation: () => ({ layer: entry.layer, sendCommand: entry.sendCommand }),
}));
vi.mock("../v4/SessionPane.js", () => ({
  SessionPane: (props: Record<string, unknown>) =>
    createElement("div", { "data-native-composer-stub": String(props.sessionId ?? "") }),
}));

// 文档内容包含制表符、西里尔、重音字符、emoji 与多行：验证锚点是字节级精确拷贝。
// 注：内容只用 \n 换行——DOM textarea 的 value 本身按规范归一 CRLF，锚点忠实记录
// 编辑器持有的值；磁盘 CRLF 字节的保真由 services 侧 exact-bytes 用例覆盖。
const DOC_PATH = "docs/exact-bytes.md";
const HEAD = "# Exact bytes\n\n";
const BEFORE = "lead — «cañón» paragraph before\tthe fragment\n";
const FRAGMENT = "fragment\twith tabs «и кириллицей» cañón 🎯\nsecond line of the fragment";
const AFTER = "\nclosing OUTSIDE_FRAGMENT_MARKER paragraph";
const DOC_CONTENT = HEAD + BEFORE + FRAGMENT + AFTER;
const COMMENT_FRAGMENT = "unique comment target with NBSP\u00A0inside";
const DOC_CONTENT_WITH_COMMENT = DOC_CONTENT + "\n" + COMMENT_FRAGMENT + "\n";
const AMBIGUOUS = "dup-marker";
const DOC_SHA = "sha-exact-bytes-fixture";

function specDocumentsService(content: string) {
  return {
    getWorkspace: async () => ({ root: "D:\\ws", writable: false }),
    list: async () => [DOC_PATH],
    read: async ({ path }: { path: string }) => ({ path, content, sha256: DOC_SHA }),
    save: async () => {
      throw new Error("read-only in this test");
    },
  };
}
const fileWatcherStub = {
  watch: async () => ({ id: "watch-1" }),
  unwatch: async () => {},
  onDynamicChange: () => () => {},
};

function renderEntryPane(options: {
  identity: string;
  parentSessionId: string | null;
  content?: string;
}) {
  const workspacePath = "D:\\ws";
  const presentationKey = documentPresentationKey(workspacePath, options.identity);
  writeDocumentPresentation(presentationKey, {
    ...defaultDocumentPresentation(),
    path: DOC_PATH,
    editing: true,
  });
  return render(
    createElement(
      ServiceProvider,
      {
        services: {
          specDocumentService: specDocumentsService(options.content ?? DOC_CONTENT),
          fileWatcherService: fileWatcherStub,
        } as unknown as Parameters<typeof ServiceProvider>[0]["services"],
        children: createElement(SpecDocumentPane, {
          workspacePath,
          workspaceIdentity: options.identity,
          parentSessionId: options.parentSessionId,
          onClose: () => {},
        }),
      },
    ),
  );
}

function threadStore(identity: string) {
  const workspacePath = "D:\\ws";
  return getSpecThreadStore(
    specThreadStorageKey(workspacePath, identity),
    identity,
  );
}

function selectFragment(start: number, end: number) {
  const editor = screen.getByLabelText("Document source editor") as HTMLTextAreaElement;
  act(() => {
    editor.setSelectionRange(start, end);
  });
  // select 事件与输入方式无关：键盘 shift+方向键与鼠标拖拽产生同一组
  // selectionStart/selectionEnd，锚点构造读取的正是这个区间。
  fireEvent.select(editor);
  return editor;
}

describe("D-03 document pane entry points, reasons and exact fragment bytes", () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    // jsdom 没有 ResizeObserver：文档面板的停靠布局测量在测试里退化为空观察器。
    globalThis.ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    entry.previewProps = null;
    entry.layer = createEntryLayer();
    entry.sendCommand = async (envelope: CommandEnvelope): Promise<CommandAck> => {
      if (envelope.type === "createSession")
        return {
          commandId: envelope.commandId,
          status: "accepted",
          result: { type: "createSession", sessionId: "child-entry" },
        } as CommandAck;
      return { commandId: envelope.commandId, status: "accepted" } as CommandAck;
    };
    entry.layer.seed(
      "parent-1",
      {
        sessionId: "parent-1",
        config: { provider: "native-provider", model: "native-model" },
        inputRouting: { mode: "startNow" },
        control: { activeWorks: [], phase: "idle", stopState: "idle" },
        queue: { items: [] },
        backgroundWorks: [],
        rows: { totalCount: 0, window: [], firstRowId: null },
      } as unknown as ConversationSnapshot,
    );
    // jsdom 无 Web Locks：伪造一个总是授予独占锁的管理器，让 writer 进入 owned。
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

  it("existing Discussions action opens a document-bound discussion without text selection and reuses it after hiding", async () => {
    const identity = "entry-whole-document";
    renderEntryPane({ identity, parentSessionId: "parent-1" });
    const editor = (await screen.findByLabelText("Document source editor")) as HTMLTextAreaElement;
    await waitFor(() => expect(editor.value).toBe(DOC_CONTENT));
    expect(editor.selectionStart).toBe(editor.selectionEnd);
    expect(threadStore(identity).get()).toEqual([]);
    const discussions = screen.getByRole("button", { name: "Discussions" });
    await waitFor(() => expect((discussions as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(discussions);
    await waitFor(() => expect(threadStore(identity).get()).toHaveLength(1));
    const binding = threadStore(identity).get()[0]!;
    expect(binding.scope).toBe("document");
    expect(binding.documentPath).toBe(DOC_PATH);
    expect(binding.parentSessionId).toBe("parent-1");
    expect(binding.anchor.quote).toBe(DOC_PATH);
    expect(binding.anchor.start).toBe(-1);
    expect(JSON.stringify(binding)).not.toContain(FRAGMENT);
    expect(JSON.stringify(binding)).not.toContain("OUTSIDE_FRAGMENT_MARKER");
    const initialText = documentQuestion(binding, "Format the title", "D:\\ws");
    expect(initialText).toContain(`Document link: ${DOC_PATH}`);
    expect(initialText).toContain("Read its current contents through the available tools");
    expect(initialText).not.toContain("Selected fragment:");
    expect(initialText).not.toContain(DOC_CONTENT);
    expect(initialText).not.toContain("OUTSIDE_FRAGMENT_MARKER");
    expect(discussions.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(discussions);
    expect(discussions.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(discussions);
    expect(discussions.getAttribute("aria-pressed")).toBe("true");
    expect(threadStore(identity).get()).toHaveLength(1);
    expect(threadStore(identity).get()[0]!.id).toBe(binding.id);
    expect(threadStore(identity).get()[0]!.scope).toBe("document");
    expect(editor.value).toBe(DOC_CONTENT);
  });

  it("existing parent session: keyboard selection preserves exact fragment bytes and binds the side-chat target to the parent", async () => {
    const identity = "entry-existing-parent";
    renderEntryPane({ identity, parentSessionId: "parent-1" });
    const editor = (await screen.findByLabelText(
      "Document source editor",
    )) as HTMLTextAreaElement;
    await waitFor(() => expect(editor.value).toBe(DOC_CONTENT));

    const start = DOC_CONTENT.indexOf(FRAGMENT);
    expect(start).toBeGreaterThan(0);
    selectFragment(start, start + FRAGMENT.length);
    const discuss = screen.getByRole("button", { name: "Discuss selection" });
    await waitFor(() => expect((discuss as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(discuss);

    const threads = threadStore(identity).get();
    expect(threads.length).toBe(1);
    const anchor = threads[0]!.anchor;
    // 字节级精确：quote 与文档片段逐字节相等（含 tab/emoji/CRLF 语义）。
    expect(Buffer.from(anchor.quote, "utf8").equals(Buffer.from(FRAGMENT, "utf8"))).toBe(true);
    expect(anchor.start).toBe(start);
    expect(anchor.prefix).toBe(DOC_CONTENT.slice(Math.max(0, start - 120), start));
    expect(anchor.suffix).toBe(
      DOC_CONTENT.slice(start + FRAGMENT.length, start + FRAGMENT.length + 120),
    );
    expect(anchor.sha256).toBe(DOC_SHA);
    expect(threads[0]!.parentSessionId).toBe("parent-1");
    expect(threads[0]!.documentPath).toBe(DOC_PATH);

    // Add-in-side-chat 目标绑定到既有父会话（MarkdownSelectionTooltip 按此 key 判定可用性）。
    await waitFor(() => expect(entry.previewProps).toBeTruthy());
    expect(entry.previewProps!.markdownSelectionTarget).toEqual({
      sessionId: "parent-1",
      workspaceKey: identity,
    });
    expect(typeof entry.previewProps!.onDiscussFragment).toBe("function");
    expect(typeof entry.previewProps!.onDocumentComment).toBe("function");
  });

  it("valid new parent session (focused native draft): view-selection and comment entries preserve exact bytes", async () => {
    const identity = "entry-new-parent";
    publishNativeExecutionSource(identity, {
      paneId: "main-pane",
      sessionId: "unpromoted-draft",
      phase: "ready",
    });
    renderEntryPane({ identity, parentSessionId: null, content: DOC_CONTENT_WITH_COMMENT });
    await waitFor(() => expect(entry.previewProps).toBeTruthy());

    // 新建父会话：无 shell 会话 id，父会话解析来自 ready 的原生 draft identity。
    expect((entry.previewProps!.markdownSelectionTarget as Record<string, unknown>).sessionId).toBe(
      "unpromoted-draft",
    );
    const onDiscussFragment = entry.previewProps!.onDiscussFragment as (quote: string) => void;

    // 视图选择：Markdown 预览中的引用原样进入锚点（唯一出现 → 位置可解析）。
    act(() => {
      onDiscussFragment(FRAGMENT);
    });
    let threads = threadStore(identity).get();
    expect(threads.length).toBe(1);
    const start = DOC_CONTENT_WITH_COMMENT.indexOf(FRAGMENT);
    expect(threads[0]!.anchor.start).toBe(start);
    expect(Buffer.from(threads[0]!.anchor.quote, "utf8").equals(Buffer.from(FRAGMENT, "utf8"))).toBe(
      true,
    );
    expect(threads[0]!.anchor.prefix).toBe(
      DOC_CONTENT_WITH_COMMENT.slice(Math.max(0, start - 120), start),
    );
    expect(threads[0]!.anchor.suffix).toBe(
      DOC_CONTENT_WITH_COMMENT.slice(
        start + FRAGMENT.length,
        start + FRAGMENT.length + 120,
      ),
    );
    expect(threads[0]!.parentSessionId).toBe("unpromoted-draft");

    // 重复出现的引用无法唯一定位：start=-1（location unresolved），但字节仍原样保留。
    const ambiguousContent = `${DOC_CONTENT}\nfirst ${AMBIGUOUS}\nsecond ${AMBIGUOUS}\n${COMMENT_FRAGMENT}\n`;
    entry.previewProps = null;
    rerenderWithNewContent(identity, ambiguousContent);
    await waitFor(() => expect(entry.previewProps).toBeTruthy());
    act(() => {
      (entry.previewProps!.onDiscussFragment as (quote: string) => void)(AMBIGUOUS);
    });
    threads = threadStore(identity).get();
    const ambiguousThread = threads.find((thread) => thread.anchor.quote === AMBIGUOUS);
    expect(ambiguousThread).toBeTruthy();
    expect(ambiguousThread!.anchor.start).toBe(-1);
    expect(ambiguousThread!.anchor.prefix).toBe("");
    expect(ambiguousThread!.anchor.suffix).toBe("");

    // 注释入口（行定位）：selectedText 逐字节保留，comment 成为首个问题草稿。
    const commentStartLine = ambiguousContent.slice(0, ambiguousContent.indexOf(COMMENT_FRAGMENT)).split("\n").length;
    act(() => {
      (entry.previewProps!.onDocumentComment as (params: {
        range: { startLine: number; endLine: number };
        selectedText: string;
        comment: string;
      }) => void)({
        range: { startLine: commentStartLine, endLine: commentStartLine },
        selectedText: COMMENT_FRAGMENT,
        comment: "Вопрос к фрагменту",
      });
    });
    const commentThread = threadStore(identity)
      .get()
      .find((thread) => thread.anchor.quote === COMMENT_FRAGMENT);
    expect(commentThread).toBeTruthy();
    const lines = ambiguousContent.split("\n");
    const expectedStart =
      lines.slice(0, Math.max(0, commentStartLine - 1)).join("\n").length +
      (commentStartLine > 1 ? 1 : 0);
    expect(commentThread!.anchor.start).toBe(expectedStart);
    expect(
      Buffer.from(commentThread!.anchor.quote, "utf8").equals(
        Buffer.from(COMMENT_FRAGMENT, "utf8"),
      ),
    ).toBe(true);
    expect(commentThread!.questionDraft).toBe("Вопрос к фрагменту");
    expect(commentThread!.parentSessionId).toBe("unpromoted-draft");
  });

  it("missing parent capability keeps entries off and explains itself; the side-chat action derives its reason from the same fact", async () => {
    const identity = "entry-missing-parent";
    renderEntryPane({ identity, parentSessionId: null });
    const editor = (await screen.findByLabelText(
      "Document source editor",
    )) as HTMLTextAreaElement;
    await waitFor(() => expect(editor.value).toBe(DOC_CONTENT));
    const start = DOC_CONTENT.indexOf(FRAGMENT);
    selectFragment(start, start + FRAGMENT.length);

    // 与 Discuss 按钮禁用同源的能力缺失（parentSessionId 解析失败）在页脚有真实原因。
    const discuss = screen.getByRole("button", { name: "Discuss selection" });
    expect((discuss as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toContain(
      "Preparing the native ZCODE model for fragment discussions…",
    );
    // Add-in-side-chat 目标缺失：下游 MarkdownSelectionTooltip 以 sessionId 为空
    // 判 unavailable 并给出禁用原因，而不是无解释的死控件。
    expect(entry.previewProps!.markdownSelectionTarget).toEqual({
      sessionId: null,
      workspaceKey: identity,
    });
    expect(entry.previewProps!.onDiscussFragment).toBeUndefined();
    expect(entry.previewProps!.onDocumentComment).toBeUndefined();

    // 真实能力来源出错时（prewarm 失败），同一位置显示 role=alert 的具体错误。
    act(() => {
      publishNativeExecutionSource(identity, {
        paneId: "main-pane",
        sessionId: "failing-draft",
        phase: "error",
        error: "Native draft creation was rejected.",
      });
    });
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("Native draft creation was rejected."),
    );
    expect((screen.getByRole("button", { name: "Discuss selection" }) as HTMLButtonElement).disabled).toBe(true);

    // 下游禁用原因推导链（selectionSideChatRuntime，真实函数）：无父会话 → 无 key；
    // 有父会话但无已挂载 opener → unavailable；有 opener → ready。均为真实能力事实。
    expect(getSelectionSideChatOpenState(buildSelectionSideChatKey(identity, "parent-1"))).toBe(
      "unavailable",
    );
    const release = registerSelectionSideChatOpener(
      buildSelectionSideChatKey(identity, "parent-1"),
      async () => {},
      true,
    );
    expect(getSelectionSideChatOpenState(buildSelectionSideChatKey(identity, "parent-1"))).toBe(
      "ready",
    );
    release();
    expect(getSelectionSideChatOpenState(buildSelectionSideChatKey(identity, "parent-1"))).toBe(
      "unavailable",
    );
  });

  it("writer capability missing: discussion controls stay disabled with the genuine exclusive-control reason", async () => {
    const identity = "entry-writer-unsupported";
    Reflect.deleteProperty(globalThis.navigator, "locks");
    renderEntryPane({ identity, parentSessionId: "parent-1" });
    const editor = (await screen.findByLabelText(
      "Document source editor",
    )) as HTMLTextAreaElement;
    await waitFor(() => expect(editor.value).toBe(DOC_CONTENT));
    const start = DOC_CONTENT.indexOf(FRAGMENT);
    selectFragment(start, start + FRAGMENT.length);

    await waitFor(() =>
      expect(
        screen.getByText(
          "Exclusive document discussion control is unavailable in this window. This document remains available to read.",
        ),
      ).toBeTruthy(),
    );
    const discuss = screen.getByRole("button", { name: "Discuss selection" });
    expect((discuss as HTMLButtonElement).disabled).toBe(true);
    // 能力缺失时不创建任何线程绑定。
    expect(threadStore(identity).get().length).toBe(0);
  });
});

/** 换一份文档内容重新渲染（同一 identity 的 presentation 已指向该文档）。 */
function rerenderWithNewContent(identity: string, content: string) {
  cleanup();
  const workspacePath = "D:\\ws";
  const presentationKey = documentPresentationKey(workspacePath, identity);
  writeDocumentPresentation(presentationKey, {
    ...defaultDocumentPresentation(),
    path: DOC_PATH,
    editing: true,
  });
  render(
    createElement(
      ServiceProvider,
      {
        services: {
          specDocumentService: specDocumentsService(content),
          fileWatcherService: fileWatcherStub,
        } as unknown as Parameters<typeof ServiceProvider>[0]["services"],
        children: createElement(SpecDocumentPane, {
          workspacePath,
          workspaceIdentity: identity,
          parentSessionId: null,
          onClose: () => {},
        }),
      },
    ),
  );
}
