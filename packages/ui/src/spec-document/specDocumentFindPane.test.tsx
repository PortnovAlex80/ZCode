// @vitest-environment jsdom
// U-19 pane coverage：文档 tab 的 Ctrl/Cmd+F 查找条——打开/聚焦、编辑模式命中计数与
// Enter/Shift+Enter 导航（原生 selection 作为高亮）、Esc 关闭并清理。仅伪造：文档服务、
// watcher、原生 uplink 与 PreviewPane/SessionPane 外壳；查找逻辑全部走真实实现。
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CommandAck,
  CommandEnvelope,
  ConversationSnapshot,
} from "@zcode/shared/zcode-protocol-v4";
import { ServiceProvider } from "../hooks/useServices.js";
import { SpecDocumentPane } from "./SpecDocumentPane.js";
import {
  defaultDocumentPresentation,
  documentPresentationKey,
  writeDocumentPresentation,
  type DocumentPresentationState,
} from "./specDocumentPresentationState.js";

const pane = vi.hoisted(() => ({
  layer: null as unknown as ReturnType<typeof createPaneLayer>,
  sendCommand: null as unknown as (envelope: CommandEnvelope) => Promise<CommandAck>,
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
  PreviewPane: (props: Record<string, unknown>) =>
    createElement(
      "div",
      null,
      (props.documentActions as ReactNode | undefined) ?? null,
      (props.sourceEditor as ReactNode | undefined) ?? null,
    ),
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
  SessionPane: () => createElement("div"),
}));

const DOC_PATH = "docs/spec.md";
const BASE_CONTENT = "# Spec\n\nalpha paragraph one\n\nalpha paragraph two\n";
const BASE_SHA = "sha-u19-base-0001";
const WORKSPACE_PATH = "D:\\ws";

function createDocumentsService() {
  const disk = new Map<string, { content: string; sha256: string }>([
    [DOC_PATH, { content: BASE_CONTENT, sha256: BASE_SHA }],
  ]);
  return {
    disk,
    service: {
      getWorkspace: async () => ({ root: "D:\\ws", writable: true }),
      list: async () => [DOC_PATH],
      read: async ({ path }: { path: string }) => {
        const entry = disk.get(path);
        if (!entry) throw new Error(`ENOENT: no such file, open '${path}'`);
        return { path, content: entry.content, sha256: entry.sha256 };
      },
      save: async (params: { path: string; content: string; expectedSha256: string }) => {
        const current = disk.get(params.path);
        if (!current || current.sha256 !== params.expectedSha256)
          throw new Error("Document changed on disk. Reload before saving.");
        const next = { content: params.content, sha256: "sha-u19-saved-1" };
        disk.set(params.path, next);
        return { path: params.path, ...next };
      },
    },
  };
}

function renderDocumentPane(identity: string, editing: boolean) {
  const key = documentPresentationKey(WORKSPACE_PATH, identity);
  const presentation: DocumentPresentationState = {
    ...defaultDocumentPresentation(),
    path: DOC_PATH,
    editing,
    discussionsVisible: false,
    activeThreadId: null,
  };
  writeDocumentPresentation(key, presentation);
  const documents = createDocumentsService();
  const view = render(
    createElement(ServiceProvider, {
      services: {
        specDocumentService: documents.service,
        fileWatcherService: {
          watch: async () => ({ id: "watch-u19" }),
          unwatch: async () => {},
          onDynamicChange: (_id: string) => (_next: (event: { changedPath?: string }) => void) => ({
            dispose() {},
          }),
        },
      } as unknown as Parameters<typeof ServiceProvider>[0]["services"],
      children: createElement(SpecDocumentPane, {
        workspacePath: WORKSPACE_PATH,
        workspaceIdentity: identity,
        parentSessionId: null,
        onClose: () => {},
        autosaveDelayMs: 60000,
      }),
    }),
  );
  return { view, documents };
}

async function openedEditor(expected = BASE_CONTENT) {
  const editor = (await screen.findByLabelText("Document source editor")) as HTMLTextAreaElement;
  await waitFor(() => expect(editor.value).toBe(expected));
  return editor;
}

describe("U-19 find-in-document bar", () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    // jsdom 没有 ResizeObserver：停靠布局测量在测试里退化为空观察器。
    globalThis.ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    pane.layer = createPaneLayer();
    pane.sendCommand = async (envelope: CommandEnvelope): Promise<CommandAck> => ({
      commandId: envelope.commandId,
      status: "accepted",
      revisionAtDecision: 0,
    });
  });

  it("Ctrl+F opens the bar in edit mode, counts matches and Enter/Shift+Enter navigate", async () => {
    renderDocumentPane("u19-edit", true);
    const editor = await openedEditor();

    expect(screen.queryByTestId("doc-find-bar")).toBeNull();
    fireEvent.keyDown(editor, { key: "f", ctrlKey: true });
    const input = await screen.findByLabelText("Find in document");
    expect(document.activeElement).toBe(input);

    fireEvent.change(input, { target: { value: "alpha" } });
    await waitFor(() => expect(screen.getByTestId("doc-find-count").textContent).toBe("1 / 2"));

    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.getByTestId("doc-find-count").textContent).toBe("2 / 2"));
    expect(editor.selectionStart).toBe(BASE_CONTENT.indexOf("alpha", 20));

    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    await waitFor(() => expect(screen.getByTestId("doc-find-count").textContent).toBe("1 / 2"));
    expect(editor.selectionStart).toBe(BASE_CONTENT.indexOf("alpha"));

    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("doc-find-bar")).toBeNull());
  });

  it("wraps navigation at the ends and clamps the counter when the query misses", async () => {
    renderDocumentPane("u19-wrap", true);
    const editor = await openedEditor();
    fireEvent.keyDown(editor, { key: "f", metaKey: true });
    const input = await screen.findByLabelText("Find in document");

    fireEvent.change(input, { target: { value: "paragraph" } });
    await waitFor(() => expect(screen.getByTestId("doc-find-count").textContent).toBe("1 / 2"));
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.getByTestId("doc-find-count").textContent).toBe("1 / 2"));

    fireEvent.change(input, { target: { value: "zzz-missing" } });
    await waitFor(() => expect(screen.getByTestId("doc-find-count").textContent).toBe("1 / 0"));
  });

  it("view mode shows the bar over the rendered prose and closes without leftovers", async () => {
    renderDocumentPane("u19-view", false);
    // 查看模式：文档打开的标志 = 工具条（documentActions）挂载；从其中的按钮发起
    // Ctrl+F（事件冒泡到内容容器才触发查找条）。
    const reload = await screen.findByLabelText("Reload");
    fireEvent.keyDown(reload, { key: "f", ctrlKey: true });
    const input = await screen.findByLabelText("Find in document");
    fireEvent.change(input, { target: { value: "alpha" } });
    // jsdom 无 CSS Highlight：计数来自渲染 DOM 收集器（PreviewPane 桩不含正文 → 0）。
    await waitFor(() => expect(screen.getByTestId("doc-find-count").textContent).toBe("1 / 0"));
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("doc-find-bar")).toBeNull());
  });
});
