// @vitest-environment jsdom
// 2026-11-07 用户裁决覆盖：原生文件预览叠加 fork 编辑（U-18 引擎）。
// 覆盖：可编辑判定（扩展名）、Edit 进入即读盘并显示缓冲、键入防抖自动落盘
//   （CAS 载荷）、外部改写后自动保存可见失败且不自动重试、markdown 视图请求。
// 2026-11-07 #3 (owner: fork): FileManagerPane-level coverage — tree "file"
//   sources gain Edit/Discuss/Open-in-window in the native preview header, and
//   the Discuss click dispatches exactly what the tree context menu dispatches.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ServiceProvider } from "../hooks/useServices.js";
import { useNativeFileEditing } from "./nativeFileEditing.js";
import { FileManagerPane } from "../WorkspaceFileTree.js";
import {
  discussWorkspaceFileDocument,
  type WorkspaceFileEntryPointRequest,
} from "./workspaceFileEntryPoints.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";

// FileManagerPane-level suite: the pane composes heavy native panels; only the
// documentActions cluster matters here, so PreviewPane is reduced to a passthrough.
vi.mock("@/PreviewPane.js", async () => {
  const { createElement } = await import("react");
  return {
    PreviewPane: ({ documentActions }: { documentActions?: ReactNode }) =>
      createElement("div", { "data-preview-actions": "true" }, documentActions ?? null),
  };
});
vi.mock("@/workspace-file-tree/WorkspaceFileTree.js", async () => {
  const { createElement } = await import("react");
  return { WorkspaceFileTree: () => createElement("div", null) };
});
vi.mock("react-resizable-panels", () => ({
  usePanelRef: () => ({ current: null }),
}));
vi.mock("@/components/ui/resizable.js", async () => {
  const { createElement } = await import("react");
  return {
    ResizablePanelGroup: ({ children }: { children?: ReactNode }) =>
      createElement("div", null, children),
    ResizablePanel: ({ children }: { children?: ReactNode }) =>
      createElement("div", null, children),
    ResizableHandle: () => null,
    WORKSPACE_VERTICAL_RESIZE_HANDLE_CLASS_NAME: "",
  };
});
vi.mock("@/store/StoreProvider.js", () => ({
  useZCodeStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      fileManagerNavigationOpenByWorkspace: {},
      setFileManagerNavigationOpen: () => {},
    }),
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));

const INDEPENDENT_DOCUMENT_OPEN_EVENT = "zcode:open-independent-document";

const WORKSPACE_PATH = "D:\\ws";

function createDocumentsService() {
  const disk = new Map<string, { content: string; sha256: string }>([
    ["docs/note.md", { content: "# base\n", sha256: "sha-native-base" }],
  ]);
  const saveCalls: { path: string; content: string; expectedSha256: string }[] = [];
  let revision = 0;
  return {
    disk,
    saveCalls,
    mutateDisk(path: string, content: string) {
      revision += 1;
      disk.set(path, { content, sha256: `sha-native-external-${revision}` });
    },
    service: {
      getWorkspace: async () => ({ root: WORKSPACE_PATH, writable: true }),
      read: async ({ path }: { path: string }) => {
        const entry = disk.get(path);
        if (!entry) throw new Error(`ENOENT: ${path}`);
        return { path, content: entry.content, sha256: entry.sha256 };
      },
      save: async (params: { path: string; content: string; expectedSha256: string }) => {
        saveCalls.push({ ...params });
        const current = disk.get(params.path);
        if (!current || current.sha256 !== params.expectedSha256)
          throw new Error("Document changed on disk. Reload before saving.");
        const next = { content: params.content, sha256: `sha-native-saved-${++revision}` };
        disk.set(params.path, next);
        return { path: params.path, ...next };
      },
    },
  };
}

function renderHost(options: { path: string | null; enabled?: boolean; delay?: number }) {
  const documents = createDocumentsService();
  const Harness = () => {
    const editing = useNativeFileEditing({
      workspacePath: WORKSPACE_PATH,
      path: options.path,
      enabled: options.enabled ?? true,
      autosaveDelayMs: options.delay ?? 25,
    });
    return createElement(
      "div",
      null,
      editing.documentActions,
      editing.sourceEditor,
      createElement("span", { "data-markdown-request": editing.requestMarkdownViewMode ?? "" }),
    );
  };
  const view = render(
    createElement(ServiceProvider, {
      services: { specDocumentService: documents.service } as unknown as Parameters<
        typeof ServiceProvider
      >[0]["services"],
      children: createElement(Harness),
    }),
  );
  return { view, documents };
}

describe("native file preview editing overlay (2026-11-07 ruling)", () => {
  beforeEach(() => {
    cleanup();
  });

  it("offers no editing affordance for non-text documents (code files stay native)", () => {
    const { view } = renderHost({ path: "config/.oxfmtrc.json" });
    expect(screen.queryByLabelText("Edit")).toBeNull();
    expect(view.container.textContent).toBe("");
  });

  it("Edit reads the disk snapshot, autosaves typed edits with the CAS hash and clears the draft", async () => {
    const { documents } = renderHost({ path: "docs/note.md" });
    fireEvent.click(screen.getByLabelText("Edit"));

    const editor = (await screen.findByLabelText("Document source editor")) as HTMLTextAreaElement;
    await waitFor(() => expect(editor.value).toBe("# base\n"));
    expect(screen.getByText("Editing · autosaves to disk")).toBeTruthy();

    fireEvent.change(editor, { target: { value: "# base\nlocal edit" } });
    expect(screen.getByText("Unsaved draft")).toBeTruthy();

    await waitFor(() => expect(documents.saveCalls.length).toBe(1));
    expect(documents.saveCalls[0]).toMatchObject({
      path: "docs/note.md",
      content: "# base\nlocal edit",
      expectedSha256: "sha-native-base",
    });
    await waitFor(() =>
      expect(documents.disk.get("docs/note.md")!.content).toBe("# base\nlocal edit"),
    );
    await waitFor(() => expect(screen.getByText("Saved on disk")).toBeTruthy());
  });

  it("autosave halts with a visible failure after an external change instead of retrying", async () => {
    const { documents } = renderHost({ path: "docs/note.md" });
    fireEvent.click(screen.getByLabelText("Edit"));
    const editor = (await screen.findByLabelText("Document source editor")) as HTMLTextAreaElement;

    documents.mutateDisk("docs/note.md", "# rewritten externally\n");
    fireEvent.change(editor, { target: { value: "# base\nconflicting local" } });

    await waitFor(() => expect(documents.saveCalls.length).toBe(1));
    expect(screen.getByText("Save failed · draft retained")).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(documents.saveCalls.length).toBe(1);
  });

  it("requests the Source view only while an edit session is active", async () => {
    const { view } = renderHost({ path: "docs/note.md" });
    const request = () =>
      view.container
        .querySelector("[data-markdown-request]")!
        .getAttribute("data-markdown-request");
    expect(request()).toBe("");
    fireEvent.click(screen.getByLabelText("Edit"));
    await screen.findByLabelText("Document source editor");
    expect(request()).toBe("code");
    fireEvent.click(screen.getByLabelText("View"));
    expect(request()).toBe("");
  });
});

// ============================================================================
// FileManagerPane level (2026-11-07 #3): tree "file" sources must surface the
// fork controls in the native preview header, and Discuss must dispatch exactly
// what the file tree context menu dispatches (CORR-1 entry-point contract).
// ============================================================================

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function renderFileManagerPane(options: {
  source: CodeViewerSource | null;
  canOpenLocalFileManager?: boolean;
}) {
  const documents = createDocumentsService();
  const view = render(
    createElement(ServiceProvider, {
      services: { specDocumentService: documents.service } as unknown as Parameters<
        typeof ServiceProvider
      >[0]["services"],
      children: createElement(FileManagerPane, {
        source: options.source,
        target: { workspacePath: WORKSPACE_PATH },
        mobileOverlay: false,
        canOpenLocalFileManager: options.canOpenLocalFileManager ?? true,
        onClose: () => {},
        onNavigate: () => {},
      }),
    }),
  );
  return { view, documents };
}

describe("FileManagerPane header fork controls (2026-11-07 #3)", () => {
  beforeEach(() => {
    window.ResizeObserver =
      window.ResizeObserver ?? (ResizeObserverStub as unknown as typeof ResizeObserver);
    cleanup();
  });

  it("shows Edit, Discuss and Open-in-window for a tree-opened text document", () => {
    renderFileManagerPane({
      source: { type: "file", title: "note.md", path: "docs/note.md" },
    });
    expect(screen.getByLabelText("Edit")).toBeTruthy();
    expect(screen.getByLabelText("Discuss document")).toBeTruthy();
    expect(screen.getByLabelText("Open document in window")).toBeTruthy();
  });

  it("keeps code files native-only: no Edit, Discuss or Open-in-window", () => {
    renderFileManagerPane({
      source: { type: "file", title: "settings.json", path: "config/settings.json" },
    });
    expect(screen.queryByLabelText("Edit")).toBeNull();
    expect(screen.queryByLabelText("Discuss document")).toBeNull();
    expect(screen.queryByLabelText("Open document in window")).toBeNull();
  });

  it("Discuss click dispatches the same events as the tree context menu entry", () => {
    // Absolute path mirrors the tree row: the row menu builds its request from
    // row.path, so the pane cluster must produce byte-identical payloads.
    const request: WorkspaceFileEntryPointRequest = {
      workspacePath: WORKSPACE_PATH,
      path: "D:\\ws\\docs\\note.md",
      name: "note.md",
    };
    const openListener = vi.fn();
    const discussListener = vi.fn();
    window.addEventListener(INDEPENDENT_DOCUMENT_OPEN_EVENT, openListener);
    window.addEventListener("zcode:workspace-document-discuss", discussListener);
    try {
      renderFileManagerPane({
        source: { type: "file", title: "note.md", path: request.path },
      });
      fireEvent.click(screen.getByLabelText("Discuss document"));

      // Reference dispatch: the exact call WorkspaceFileTreeRowView performs.
      discussWorkspaceFileDocument({ request, relativeDocumentPath: "docs/note.md" });

      expect(openListener).toHaveBeenCalledTimes(2);
      expect(discussListener).toHaveBeenCalledTimes(2);
      const paneOpenEvent = openListener.mock.calls[0]![0] as CustomEvent;
      const menuOpenEvent = openListener.mock.calls[1]![0] as CustomEvent;
      expect(paneOpenEvent.detail).toEqual(menuOpenEvent.detail);
      expect(paneOpenEvent.detail).toMatchObject({
        workspacePath: WORKSPACE_PATH,
        parentSessionId: null,
        source: { type: "file", specDocument: true, path: request.path, title: "note.md" },
      });
      const paneDiscussEvent = discussListener.mock.calls[0]![0] as CustomEvent;
      const menuDiscussEvent = discussListener.mock.calls[1]![0] as CustomEvent;
      expect(paneDiscussEvent.detail).toEqual(menuDiscussEvent.detail);
      expect(paneDiscussEvent.detail).toEqual({
        workspacePath: WORKSPACE_PATH,
        documentPath: "docs/note.md",
      });
    } finally {
      window.removeEventListener(INDEPENDENT_DOCUMENT_OPEN_EVENT, openListener);
      window.removeEventListener("zcode:workspace-document-discuss", discussListener);
    }
  });
});
