// @vitest-environment jsdom
// MPS11 (2026-11-07 user ruling): the fork edit overlay textarea
// (nativeFileEditing sourceEditor) gains the floating selection toolbar that
// previously existed only in the markdown preview body.
// Pinned here: toolbar appears on a non-empty textarea selection and routes
// the selected text into the add-to-chat reference path (with the file path),
// dismissal on collapse/blur/Escape, the shared >8000-char single limit,
// the no-session workspace opener route for "Add in side chat", the
// draftScopeKey draft-scope landing, and the FileManagerPane cross-workspace
// guard. Rect technique (mirror div) is exercised through the measure helper.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServiceProvider } from "../hooks/useServices.js";
import { useNativeFileEditing } from "./nativeFileEditing.js";
import { measureTextareaSelectionRect } from "./editorSelectionToolbar.js";
import { FileManagerPane } from "../WorkspaceFileTree.js";
import {
  getConversationSelectionReferenceScope,
  setConversationSelectionReferenceScope,
  type MarkdownSelectionTarget,
} from "@/lib/conversationSelectionReference.js";
import {
  buildSelectionSideChatKey,
  registerSelectionSideChatOpener,
} from "@/lib/selectionSideChatRuntime.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { WORKSPACE_DOCUMENT_DISCUSS_EVENT } from "./workspaceFileEntryPoints.js";

// FileManagerPane-level coverage composes the pane with a passthrough preview;
// both the header actions and the sourceEditor surface must render.
vi.mock("@/PreviewPane.js", async () => {
  const { createElement } = await import("react");
  return {
    PreviewPane: ({
      documentActions,
      sourceEditor,
    }: {
      documentActions?: ReactNode;
      sourceEditor?: ReactNode;
    }) =>
      createElement(
        "div",
        { "data-preview-passthrough": "true" },
        documentActions ?? null,
        sourceEditor ?? null,
      ),
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

const WORKSPACE_PATH = "D:\\ws";
const WORKSPACE_KEY = WORKSPACE_PATH;
const DOCUMENT_PATH = "docs/note.md";
const draftScopeKey = JSON.stringify(["ns", "host", null]);
// Same literal retainedDocumentWindows.ts dispatches (import would drag the
// whole module graph; the contract is the event name).
const INDEPENDENT_DOCUMENT_OPEN_EVENT = "zcode:open-independent-document";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function createDocumentsService() {
  const disk = new Map<string, { content: string; sha256: string }>([
    // "# base\n": the selection used below (2..6) is exactly "base".
    [DOCUMENT_PATH, { content: "# base\n", sha256: "sha-editor-base" }],
  ]);
  return {
    disk,
    service: {
      getWorkspace: async () => ({ root: WORKSPACE_PATH, writable: true }),
      read: async ({ path }: { path: string }) => {
        const entry = disk.get(path);
        if (!entry) throw new Error(`ENOENT: ${path}`);
        return { path, content: entry.content, sha256: entry.sha256 };
      },
      save: async (params: { path: string; content: string; expectedSha256: string }) => {
        const current = disk.get(params.path);
        if (!current || current.sha256 !== params.expectedSha256)
          throw new Error("Document changed on disk. Reload before saving.");
        const next = { content: params.content, sha256: `sha-editor-saved-${params.content.length}` };
        disk.set(params.path, next);
        return { path: params.path, ...next };
      },
    },
  };
}

function renderEditor(
  selectionTarget?: MarkdownSelectionTarget | null,
  onDiscussFragment?: (quote: string) => void,
) {
  const documents = createDocumentsService();
  const Harness = () => {
    const editing = useNativeFileEditing({
      workspacePath: WORKSPACE_PATH,
      path: DOCUMENT_PATH,
      enabled: true,
      autosaveDelayMs: 25,
      selectionTarget:
        selectionTarget === undefined ? { sessionId: null, workspaceKey: WORKSPACE_KEY } : selectionTarget,
      onDiscussFragment,
    });
    return createElement("div", null, editing.documentActions, editing.sourceEditor);
  };
  const view = render(
    createElement(ZCodeIntlProvider, {
      initialLocale: "en-US",
      children: createElement(ServiceProvider, {
        services: { specDocumentService: documents.service } as unknown as Parameters<
          typeof ServiceProvider
        >[0]["services"],
        children: createElement(Harness),
      }),
    }),
  );
  return { view, documents };
}

function renderFileManagerPane(selectionTarget: MarkdownSelectionTarget, canOpenLocalFileManager = true) {
  const documents = createDocumentsService();
  const view = render(
    createElement(ZCodeIntlProvider, {
      initialLocale: "en-US",
      children: createElement(ServiceProvider, {
        services: { specDocumentService: documents.service } as unknown as Parameters<
          typeof ServiceProvider
        >[0]["services"],
        children: createElement(FileManagerPane, {
          source: { type: "file", title: "note.md", path: DOCUMENT_PATH },
          target: { workspacePath: WORKSPACE_PATH },
          mobileOverlay: false,
          canOpenLocalFileManager,
          onClose: () => {},
          onNavigate: () => {},
          markdownSelectionTarget: selectionTarget,
        }),
      }),
    }),
  );
  return { view, documents };
}

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(null)));

/** Enters edit mode and performs a textarea selection the way a browser reports it. */
async function editAndSelect(start = 2, end = 6) {
  fireEvent.click(screen.getByLabelText("Edit"));
  const textarea = (await screen.findByLabelText(
    "Document source editor",
  )) as HTMLTextAreaElement;
  await act(async () => {
    textarea.focus();
    textarea.setSelectionRange(start, end);
    document.dispatchEvent(new Event("selectionchange"));
    await nextFrame();
  });
  return textarea;
}

afterEach(() => {
  cleanup();
  setConversationSelectionReferenceScope(null, WORKSPACE_KEY, []);
  setConversationSelectionReferenceScope(null, WORKSPACE_KEY, [], draftScopeKey);
});

describe("measureTextareaSelectionRect (mirror div)", () => {
  it("returns null for a collapsed selection and a finite fallback rect without layout", () => {
    const textarea = document.createElement("textarea");
    textarea.value = "hello world";
    document.body.append(textarea);
    try {
      textarea.setSelectionRange(2, 2);
      expect(measureTextareaSelectionRect(textarea)).toBeNull();
      textarea.setSelectionRange(2, 5);
      const rect = measureTextareaSelectionRect(textarea)!;
      // jsdom has no layout: the mirror measurements degenerate but must stay
      // finite so the shared menu can render and viewport-clamp itself.
      expect(Number.isFinite(rect.top)).toBe(true);
      expect(Number.isFinite(rect.bottom)).toBe(true);
      expect(Number.isFinite(rect.center)).toBe(true);
      expect(rect.bottom).toBeGreaterThanOrEqual(rect.top);
    } finally {
      textarea.remove();
    }
  });
});

describe("edit-overlay selection toolbar (MPS11)", () => {
  beforeEach(() => {
    window.ResizeObserver =
      window.ResizeObserver ?? (ResizeObserverStub as unknown as typeof ResizeObserver);
  });

  it("appears on a textarea selection and routes the selected text into the add-to-chat draft scope with the file path", async () => {
    renderEditor();
    await editAndSelect();
    fireEvent.click(await screen.findByRole("button", { name: "Add to chat" }));
    expect(getConversationSelectionReferenceScope(null, WORKSPACE_KEY)).toMatchObject([
      {
        text: "base",
        contentType: "markdown",
        sourceKey: DOCUMENT_PATH,
        sourceTitle: DOCUMENT_PATH,
        path: DOCUMENT_PATH,
      },
    ]);
    // The menu closes after the action, mirroring the preview toolbar.
    expect(screen.queryByRole("button", { name: "Add to chat" })).toBeNull();
  });

  it("MPS12: Discuss fragment dispatches the selected text to the entry-point handler and closes the menu", async () => {
    const onDiscussFragment = vi.fn();
    renderEditor(undefined, onDiscussFragment);
    await editAndSelect();
    fireEvent.click(await screen.findByRole("button", { name: "Discuss fragment" }));
    // The CURRENT selection text is handed over verbatim; the entry point and
    // the document pane own everything downstream.
    expect(onDiscussFragment).toHaveBeenCalledTimes(1);
    expect(onDiscussFragment).toHaveBeenCalledWith("base");
    expect(screen.queryByRole("button", { name: "Discuss fragment" })).toBeNull();
  });

  it("MPS12: without a discuss handler the menu keeps only the two chat actions", async () => {
    renderEditor();
    await editAndSelect();
    expect(screen.getByRole("button", { name: "Add to chat" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Discuss fragment" })).toBeNull();
  });

  it("dismisses when the selection collapses, the textarea blurs, or Escape is pressed", async () => {
    renderEditor();
    const textarea = await editAndSelect();
    expect(screen.getByRole("button", { name: "Add to chat" })).toBeTruthy();

    await act(async () => {
      textarea.setSelectionRange(3, 3);
      document.dispatchEvent(new Event("selectionchange"));
    });
    expect(screen.queryByRole("button", { name: "Add to chat" })).toBeNull();

    await act(async () => {
      textarea.setSelectionRange(2, 6);
      document.dispatchEvent(new Event("selectionchange"));
      await nextFrame();
    });
    expect(screen.getByRole("button", { name: "Add to chat" })).toBeTruthy();
    fireEvent.blur(textarea);
    expect(screen.queryByRole("button", { name: "Add to chat" })).toBeNull();

    // Still in edit mode after the blur: re-select on the same textarea.
    await act(async () => {
      textarea.focus();
      textarea.setSelectionRange(2, 6);
      document.dispatchEvent(new Event("selectionchange"));
      await nextFrame();
    });
    expect(screen.getByRole("button", { name: "Add to chat" })).toBeTruthy();
    fireEvent.keyUp(textarea, { key: "Escape" });
    expect(screen.queryByRole("button", { name: "Add to chat" })).toBeNull();
  });

  it("shows the shared single-limit notice instead of actions above 8000 characters", async () => {
    renderEditor();
    fireEvent.click(screen.getByLabelText("Edit"));
    const textarea = (await screen.findByLabelText(
      "Document source editor",
    )) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "x".repeat(8001) } });
    await act(async () => {
      textarea.focus();
      textarea.setSelectionRange(0, 8001);
      document.dispatchEvent(new Event("selectionchange"));
      await nextFrame();
    });
    // Upstream v3.18 reworded chat.selections.limit.single (selections -> annotations).
    expect(screen.getByText("An annotation can quote at most 8,000 characters.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add to chat" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add in side chat" })).toBeNull();
  });

  it("no active session: side chat resolves the workspace opener (draft prewarm parent) with the file reference", async () => {
    const open = vi.fn(async () => {});
    const unregister = registerSelectionSideChatOpener(
      buildSelectionSideChatKey(WORKSPACE_KEY, "unpromoted-prewarm"),
      open,
      true,
    );
    try {
      renderEditor();
      await editAndSelect();
      const side = screen.getByRole("button", { name: "Add in side chat" }) as HTMLButtonElement;
      expect(side.disabled).toBe(false);
      fireEvent.click(side);
      await waitFor(() =>
        expect(open).toHaveBeenCalledWith(
          expect.objectContaining({
            contentType: "markdown",
            text: "base",
            path: DOCUMENT_PATH,
          }),
        ),
      );
      // The reference goes to the opener, not into any composer scope.
      expect(getConversationSelectionReferenceScope(null, WORKSPACE_KEY)).toEqual([]);
      expect(screen.queryByRole("button", { name: "Add in side chat" })).toBeNull();
    } finally {
      unregister();
    }
  });

  it("without any workspace opener the side action stays disabled with the unavailable title", async () => {
    renderEditor();
    await editAndSelect();
    const side = screen.getByRole("button", { name: "Add in side chat" }) as HTMLButtonElement;
    expect(side.disabled).toBe(true);
    expect(side.title).toBe("Use an editable main task that supports side conversations.");
  });

  it("draftScopeKey target lands the reference in exactly that workspace draft scope", async () => {
    renderEditor({ sessionId: null, workspaceKey: WORKSPACE_KEY, draftScopeKey });
    await editAndSelect();
    fireEvent.click(screen.getByRole("button", { name: "Add to chat" }));
    expect(getConversationSelectionReferenceScope(null, WORKSPACE_KEY, draftScopeKey)).toMatchObject([
      { text: "base", contentType: "markdown" },
    ]);
    expect(getConversationSelectionReferenceScope(null, WORKSPACE_KEY)).toEqual([]);
  });
});

describe("FileManagerPane edit-overlay target guard (MPS11)", () => {
  beforeEach(() => {
    window.ResizeObserver =
      window.ResizeObserver ?? (ResizeObserverStub as unknown as typeof ResizeObserver);
  });

  it("a cross-workspace markdown selection target provides no edit-overlay entry", async () => {
    renderFileManagerPane({ sessionId: null, workspaceKey: "ssh:other:/ws" });
    fireEvent.click(screen.getByLabelText("Edit"));
    const textarea = (await screen.findByLabelText(
      "Document source editor",
    )) as HTMLTextAreaElement;
    await act(async () => {
      textarea.focus();
      textarea.setSelectionRange(2, 6);
      document.dispatchEvent(new Event("selectionchange"));
      await nextFrame();
    });
    expect(screen.queryByRole("button", { name: "Add to chat" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add in side chat" })).toBeNull();
  });

  it("a matching workspace key surfaces the toolbar on the same selection", async () => {
    renderFileManagerPane({ sessionId: null, workspaceKey: WORKSPACE_KEY });
    await editAndSelect();
    expect(screen.getByRole("button", { name: "Add to chat" })).toBeTruthy();
  });
});

describe("FileManagerPane discuss-fragment routing (MPS12)", () => {
  beforeEach(() => {
    window.ResizeObserver =
      window.ResizeObserver ?? (ResizeObserverStub as unknown as typeof ResizeObserver);
    cleanup();
  });

  it("Discuss fragment from the edit toolbar dispatches the entry point with the selection quote", async () => {
    const openListener = vi.fn();
    const discussListener = vi.fn();
    window.addEventListener(INDEPENDENT_DOCUMENT_OPEN_EVENT, openListener);
    window.addEventListener(WORKSPACE_DOCUMENT_DISCUSS_EVENT, discussListener);
    try {
      renderFileManagerPane({ sessionId: null, workspaceKey: WORKSPACE_KEY });
      await editAndSelect();
      fireEvent.click(screen.getByRole("button", { name: "Discuss fragment" }));

      // The exact entry-point contract: window request + discuss event that
      // carries the CURRENT selection text as the quote.
      expect(openListener).toHaveBeenCalledTimes(1);
      expect(discussListener).toHaveBeenCalledTimes(1);
      expect((discussListener.mock.calls[0]![0] as CustomEvent).detail).toEqual({
        workspacePath: WORKSPACE_PATH,
        documentPath: DOCUMENT_PATH,
        quote: "base",
      });
      // The menu closes after routing through the entry point.
      expect(screen.queryByRole("button", { name: "Discuss fragment" })).toBeNull();
    } finally {
      window.removeEventListener(INDEPENDENT_DOCUMENT_OPEN_EVENT, openListener);
      window.removeEventListener(WORKSPACE_DOCUMENT_DISCUSS_EVENT, discussListener);
    }
  });

  it("without local file manager capability the edit menu shows no Discuss fragment entry", async () => {
    renderFileManagerPane({ sessionId: null, workspaceKey: WORKSPACE_KEY }, false);
    await editAndSelect();
    expect(screen.getByRole("button", { name: "Add to chat" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Discuss fragment" })).toBeNull();
  });
});
