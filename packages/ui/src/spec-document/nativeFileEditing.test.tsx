// @vitest-environment jsdom
// 2026-11-07 user ruling coverage: the fork editing overlay (U-18 engine) on
// top of the native file preview.
// Covered: editability gate (binary denylist — json/.env editable, png not),
//   Edit reads the disk snapshot into the buffer, debounced autosave with the
//   CAS payload, visible autosave failure after an external rewrite (no silent
//   retry), markdown view request.
// 2026-11-07 #3 (owner: fork): FileManagerPane-level coverage — tree "file"
//   sources gain Edit/Discuss/Open-in-window in the native preview header, and
//   the Discuss click dispatches exactly what the tree context menu dispatches.
// 2026-11-07 #4 (UC-2): editability is any non-binary text file — json/yaml/
//   env/dotfiles gain the overlay; binaries stay native-only.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ServiceProvider } from "../hooks/useServices.js";
import {
  isTextCompatibleDocumentPath,
  useNativeFileEditing,
} from "./nativeFileEditing.js";
import { FileManagerPane } from "../WorkspaceFileTree.js";
import {
  discussWorkspaceFileDocument,
  type WorkspaceFileEntryPointRequest,
} from "./workspaceFileEntryPoints.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";

// FileManagerPane-level suite: the pane composes heavy native panels; only the
// documentActions cluster and the threaded selection-toolbar props matter here,
// so PreviewPane is reduced to a passthrough that records its props.
let lastPreviewProps: Record<string, unknown> | null = null;
vi.mock("@/PreviewPane.js", async () => {
  const { createElement } = await import("react");
  return {
    PreviewPane: (props: Record<string, unknown>) => {
      lastPreviewProps = props;
      return createElement(
        "div",
        { "data-preview-actions": "true" },
        (props.documentActions as ReactNode) ?? null,
      );
    },
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
    // UC-2: a dotfile seed for the extensionless-editability coverage below.
    [".env", { content: "# base\n", sha256: "sha-native-base" }],
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

  it("UC-2 denylist: dotfiles and extensionless names are text, known binaries are not", () => {
    // Text-compatible: config formats, dotfiles, extensionless names,
    // multi-dot dotfiles, absolute/backslash paths.
    for (const path of [
      "config/app.json",
      "deploy/values.yaml",
      "app.toml",
      "notes.csv",
      "server.log",
      ".env",
      ".gitignore",
      ".env.local",
      "LICENSE",
      "Makefile",
      "D:\\ws\\.env",
      "/srv/ws/config/app.json",
      "package-lock.json",
    ]) {
      expect(isTextCompatibleDocumentPath(path), path).toBe(true);
    }
    // Binary denylist (case-insensitive), including absolute paths.
    for (const path of [
      "assets/logo.png",
      "assets/photo.JPG",
      "media/track.mp3",
      "media/clip.MP4",
      "dist/bundle.zip",
      "tools/app.exe",
      "fonts/inter.woff2",
      "docs/report.pdf",
      "docs/report.docx",
      "db/data.sqlite",
      "raw/image.bin",
      "pkg/pkg.lock",
      "D:\\ws\\assets\\logo.png",
    ]) {
      expect(isTextCompatibleDocumentPath(path), path).toBe(false);
    }
  });

  it("offers no editing affordance for binary documents (denylist stays native)", () => {
    const { view } = renderHost({ path: "assets/logo.png" });
    expect(screen.queryByLabelText("Edit")).toBeNull();
    expect(view.container.textContent).toBe("");
  });

  it("UC-2: any text-compatible document gains the edit affordance (json, dotfiles)", () => {
    renderHost({ path: "config/app.json" });
    expect(screen.getByLabelText("Edit")).toBeTruthy();
    cleanup();
    renderHost({ path: ".env" });
    expect(screen.getByLabelText("Edit")).toBeTruthy();
  });

  it("UC-2: edits a dotfile end-to-end with the same CAS autosave payload", async () => {
    const { documents } = renderHost({ path: ".env" });
    fireEvent.click(screen.getByLabelText("Edit"));

    const editor = (await screen.findByLabelText("Document source editor")) as HTMLTextAreaElement;
    await waitFor(() => expect(editor.value).toBe("# base\n"));

    fireEvent.change(editor, { target: { value: "# base\nTOKEN=secret" } });
    await waitFor(() => expect(documents.saveCalls.length).toBe(1));
    expect(documents.saveCalls[0]).toMatchObject({
      path: ".env",
      content: "# base\nTOKEN=secret",
      expectedSha256: "sha-native-base",
    });
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
    lastPreviewProps = null;
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

  it("UC-2: json documents gain Edit, Discuss and Open-in-window", () => {
    renderFileManagerPane({
      source: { type: "file", title: "settings.json", path: "config/settings.json" },
    });
    expect(screen.getByLabelText("Edit")).toBeTruthy();
    expect(screen.getByLabelText("Discuss document")).toBeTruthy();
    expect(screen.getByLabelText("Open document in window")).toBeTruthy();
  });

  it("UC-2: binary documents stay native-only: no Edit, Discuss or Open-in-window", () => {
    renderFileManagerPane({
      source: { type: "file", title: "logo.png", path: "assets/logo.png" },
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

  // MPS12 (2026-11-08): the markdown PREVIEW selection toolbar inside the
  // native tab gains "Discuss fragment" too — FileManagerPane threads the same
  // handler it gives the edit-overlay toolbar down to PreviewPane.
  it("MPS12: the preview selection toolbar receives the discuss-fragment entry with the same fork gate", () => {
    renderFileManagerPane({
      source: { type: "file", title: "note.md", path: "docs/note.md" },
    });
    expect(typeof lastPreviewProps?.onDiscussFragment).toBe("function");

    // The preview toolbar's quote routes through the same entry point as the
    // header Discuss button: discuss event carries the CURRENT selection text.
    const openListener = vi.fn();
    const discussListener = vi.fn();
    window.addEventListener(INDEPENDENT_DOCUMENT_OPEN_EVENT, openListener);
    window.addEventListener("zcode:workspace-document-discuss", discussListener);
    try {
      (lastPreviewProps!.onDiscussFragment as (quote: string) => void)("chosen text");
      expect(openListener).toHaveBeenCalledTimes(1);
      expect(discussListener).toHaveBeenCalledTimes(1);
      expect((discussListener.mock.calls[0]![0] as CustomEvent).detail).toEqual({
        workspacePath: WORKSPACE_PATH,
        documentPath: "docs/note.md",
        quote: "chosen text",
      });
    } finally {
      window.removeEventListener(INDEPENDENT_DOCUMENT_OPEN_EVENT, openListener);
      window.removeEventListener("zcode:workspace-document-discuss", discussListener);
    }

    // Binary documents keep the preview menu fork-free (same gate as the
    // header buttons).
    renderFileManagerPane({
      source: { type: "file", title: "logo.png", path: "assets/logo.png" },
    });
    expect(lastPreviewProps?.onDiscussFragment).toBeUndefined();
  });
});
