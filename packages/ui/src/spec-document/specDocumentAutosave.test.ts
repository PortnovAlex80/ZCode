// @vitest-environment jsdom
// U-18 fixture coverage：文档 tab 手动编辑自动落盘（非 GUI 半边）。
// 覆盖：防抖自动保存的 CAS 载荷与磁盘结果、保存期间继续键入不被回退且随后
//   基于新 hash 再次保存、CAS 冲突后可见报错且自动保存停止重试、
//   只读主机（writable=false）永不自动保存。
// 仅伪造：文档服务、watcher、原生 uplink 与 SessionPane/PreviewPane 外壳
//   （非本独占路径）；防抖调度、CAS 前置条件、草稿持久化全部走真实实现。
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
  documentPresentationKey,
  readDocumentDraft,
  writeDocumentPresentation,
  defaultDocumentPresentation,
  type DocumentPresentationState,
} from "./specDocumentPresentationState.js";

const pane = vi.hoisted(() => ({
  layer: null as unknown as ReturnType<typeof createPaneLayer>,
  sendCommand: null as unknown as (envelope: CommandEnvelope) => Promise<CommandAck>,
}));

/** 假数据层沿用 specDocumentPanePersistence.test.ts 的只读契约。 */
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
const BASE_CONTENT = "# Spec\n\nbase paragraph\n";
const BASE_SHA = "sha-u18-base-0001";
const WORKSPACE_PATH = "D:\\ws";
const AUTOSAVE_DELAY = 25;

interface SaveCall {
  path: string;
  content: string;
  expectedSha256: string;
}

/**
 * 可变磁盘 + 记录保存调用的文档服务；gate 可把单次 save 挂起（模拟慢磁盘），
 * 供「保存期间继续键入」断言。CAS 语义与 services 侧一致。
 */
function createDocumentsService(options: { writable: boolean; gate?: () => Promise<void> }) {
  const disk = new Map<string, { content: string; sha256: string }>([
    [DOC_PATH, { content: BASE_CONTENT, sha256: BASE_SHA }],
  ]);
  const saveCalls: SaveCall[] = [];
  let revision = 0;
  return {
    disk,
    saveCalls,
    mutateDisk(content: string) {
      revision += 1;
      disk.set(DOC_PATH, { content, sha256: `sha-u18-external-${revision}` });
    },
    service: {
      getWorkspace: async () => ({ root: "D:\\ws", writable: options.writable }),
      list: async () => [DOC_PATH],
      read: async ({ path }: { path: string }) => {
        const entry = disk.get(path);
        if (!entry) throw new Error(`ENOENT: no such file, open '${path}'`);
        return { path, content: entry.content, sha256: entry.sha256 };
      },
      save: async (params: { path: string; content: string; expectedSha256: string }) => {
        saveCalls.push({ ...params });
        const current = disk.get(params.path);
        if (!current || current.sha256 !== params.expectedSha256)
          throw new Error("Document changed on disk. Reload before saving.");
        const next = { content: params.content, sha256: `sha-u18-saved-${++revision}` };
        await options.gate?.();
        disk.set(params.path, next);
        return { path: params.path, ...next };
      },
    },
  };
}

function createWatcher() {
  let listener: ((event: { changedPath?: string }) => void) | null = null;
  return {
    fireExternalChange() {
      listener?.({ changedPath: "D:/ws/docs/spec.md" });
    },
    stub: {
      watch: async () => ({ id: "watch-u18" }),
      unwatch: async () => {},
      onDynamicChange: (_id: string) => (next: (event: { changedPath?: string }) => void) => {
        listener = next;
        return { dispose() {} };
      },
    },
  };
}

function renderDocumentPane(
  options: { identity: string; writable?: boolean; delay?: number },
  documents = createDocumentsService({ writable: options.writable ?? true }),
) {
  const key = documentPresentationKey(WORKSPACE_PATH, options.identity);
  const presentation: DocumentPresentationState = {
    ...defaultDocumentPresentation(),
    path: DOC_PATH,
    editing: true,
    discussionsVisible: false,
    activeThreadId: null,
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
        parentSessionId: null,
        onClose: () => {},
        autosaveDelayMs: options.delay ?? AUTOSAVE_DELAY,
      }),
    }),
  );
  return { view, documents, key };
}

async function openedEditor(expected = BASE_CONTENT) {
  const editor = (await screen.findByLabelText("Document source editor")) as HTMLTextAreaElement;
  await waitFor(() => expect(editor.value).toBe(expected));
  return editor;
}

describe("U-18 document tab autosaves manual edits to disk", () => {
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

  it("debounced autosave writes the buffer with the disk CAS hash and clears the draft slot", async () => {
    const { documents, key } = renderDocumentPane({ identity: "u18-autosave" });
    const editor = await openedEditor();

    fireEvent.change(editor, { target: { value: `${BASE_CONTENT}typed locally` } });

    // CAS 前置条件 = 当前磁盘 hash；磁盘与状态行反映落盘结果。
    await waitFor(() => expect(documents.saveCalls.length).toBe(1));
    expect(documents.saveCalls[0]).toMatchObject({
      path: DOC_PATH,
      content: `${BASE_CONTENT}typed locally`,
      expectedSha256: BASE_SHA,
    });
    await waitFor(() => expect(screen.getByText("Saved on disk")).toBeTruthy());
    expect(documents.disk.get(DOC_PATH)!.content).toBe(`${BASE_CONTENT}typed locally`);
    expect(readDocumentDraft(key, DOC_PATH)).toBeNull();
    // 干净缓冲：自动保存不再触发。
    await new Promise((resolve) => setTimeout(resolve, AUTOSAVE_DELAY * 4));
    expect(documents.saveCalls.length).toBe(1);
  });

  it("keystrokes typed during an in-flight save are kept and re-saved on the new hash", async () => {
    let releaseGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const { documents } = renderDocumentPane(
      {
        identity: "u18-inflight",
        writable: true,
        delay: AUTOSAVE_DELAY,
      },
      createDocumentsService({ writable: true, gate: () => gate }),
    );
    const editor = await openedEditor();

    fireEvent.change(editor, { target: { value: `${BASE_CONTENT}first save` } });
    await waitFor(() => expect(documents.saveCalls.length).toBe(1));

    // 保存挂起期间继续输入：新键入绝不能被完成的保存回退。
    fireEvent.change(editor, {
      target: { value: `${BASE_CONTENT}first save + more typing` },
    });
    releaseGate!();
    await waitFor(() =>
      expect(documents.disk.get(DOC_PATH)!.content).toBe(`${BASE_CONTENT}first save`),
    );
    await waitFor(() => expect(editor.value).toBe(`${BASE_CONTENT}first save + more typing`));

    // 完成后基于新 hash 重新防抖保存第二份缓冲。
    await waitFor(() => expect(documents.saveCalls.length).toBe(2));
    expect(documents.saveCalls[1]).toMatchObject({
      path: DOC_PATH,
      content: `${BASE_CONTENT}first save + more typing`,
      expectedSha256: "sha-u18-saved-1",
    });
    await waitFor(() =>
      expect(documents.disk.get(DOC_PATH)!.content).toBe(`${BASE_CONTENT}first save + more typing`),
    );
  });

  it("autosave halts with a visible error after a CAS conflict instead of retrying", async () => {
    const { documents } = renderDocumentPane({ identity: "u18-conflict" });
    const editor = await openedEditor();

    // 外部工具先行改写磁盘 → 自动保存按原始 hash 被拒。
    documents.mutateDisk("# Spec\n\nrewritten externally\n");
    fireEvent.change(editor, { target: { value: `${BASE_CONTENT}local edit` } });

    await waitFor(() => expect(documents.saveCalls.length).toBe(1));
    // 状态行在 dirty 时显示 Unsaved draft；失败细节走 alert（与手动 Save 同语义）。
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "Document changed on disk. Reload before saving.",
      ),
    );
    // 冲突未处理（错误态）时不自动重试打转。
    await new Promise((resolve) => setTimeout(resolve, AUTOSAVE_DELAY * 6));
    expect(documents.saveCalls.length).toBe(1);
    expect(documents.disk.get(DOC_PATH)!.content).toBe("# Spec\n\nrewritten externally\n");
  });

  it("a read-only host never autosaves and explains why", async () => {
    const { documents } = renderDocumentPane({ identity: "u18-readonly", writable: false });
    const editor = await openedEditor();

    fireEvent.change(editor, { target: { value: `${BASE_CONTENT}never written` } });
    await new Promise((resolve) => setTimeout(resolve, AUTOSAVE_DELAY * 6));

    expect(documents.saveCalls).toEqual([]);
    expect(documents.disk.get(DOC_PATH)!.content).toBe(BASE_CONTENT);
    expect(
      screen.getByText(
        "Saving and deleting are unavailable for this host; documents are read-only.",
      ),
    ).toBeTruthy();
  });
});
