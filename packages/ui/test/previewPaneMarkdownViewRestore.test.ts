// @vitest-environment jsdom
// Root-fix regression test (fork UC-2, 2026-11-08): editing a markdown file
// from the file tree forces markdownViewMode to "code"; when editing ends the
// pane must restore the source-native "preview" instead of staying stuck in
// source view until the tab is reopened. Previously only SpecDocumentPane had
// a caller-side workaround (keying PreviewPane on the editing mode).
import { act, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { PreviewPane } from "@/PreviewPane.js";

vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({
    getInstalledEditors: async () => [],
    openInEditor: async () => ({ success: false }),
  }),
}));

vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useWorkspaceServices: () => ({
    fileService: {
      readFileRange: vi.fn(),
      readTextFile: vi.fn(async () => ({ content: "", truncated: false })),
      stat: vi.fn(),
    },
    fileWatcherService: {
      watch: vi.fn(async () => ({ id: "watch" })),
      unwatch: vi.fn(async () => undefined),
      disposeAll: vi.fn(),
      onDynamicChange: () => ({ event: vi.fn(), dispose: vi.fn() }),
    },
  }),
}));

vi.mock("@/hooks/useFileContextActions.js", () => ({
  useFileContextActions: () => ({
    copyAbsolutePath: vi.fn(),
    copyRelativePath: vi.fn(),
    canRevealInFileManager: vi.fn(() => false),
  }),
}));

vi.mock("@/hooks/useWorkspaceOpenInEditorTarget.js", () => ({
  useWorkspaceOpenInEditorTarget: () => ({
    isRemoteWorkspace: false,
    remoteTarget: null,
  }),
}));

vi.mock("@/store/StoreProvider.js", () => ({
  useZCodeStore: <T,>(selector: (state: Record<string, unknown>) => T) =>
    selector({
      codePreviewSettings: {
        darkTheme: "github-dark",
        fontSizePx: 12,
        lightTheme: "github-light",
        showLineNumbers: true,
        wrapLongLines: false,
      },
      theme: "dark",
    }),
}));

vi.mock("@/store/codeCommentPreviewStore.js", () => ({
  useCodeCommentPreviewStore: <T,>(selector: (state: Record<string, unknown>) => T) =>
    selector({
      addComment: vi.fn(),
      getComments: () => [],
      removeComment: vi.fn(),
    }),
}));

// Surface proxy: the mocked content renders the effective markdown view mode,
// exactly what PreviewPaneContent would branch on.
vi.mock("@/previewPaneContent.js", () => ({
  PreviewPaneContent: ({ markdownViewMode }: { markdownViewMode?: string }) =>
    createElement("div", { "data-testid": "md-mode" }, markdownViewMode ?? "unset"),
}));

const mdSource = {
  type: "file" as const,
  title: "README.md",
  path: "/workspace/README.md",
};

function renderWith(editor?: ReturnType<typeof createElement>) {
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(PreviewPane, {
        onClose: vi.fn(),
        source: mdSource,
        workspacePath: "/workspace",
        ...(editor !== undefined ? { sourceEditor: editor } : {}),
      }),
    ),
  );
}

describe("PreviewPane markdown view restore after editing", () => {
  it("returns to preview when the editing overlay unmounts", async () => {
    const view = renderWith();
    await waitFor(() => expect(screen.getByTestId("md-mode").textContent).toBe("preview"));

    // Enter editing: the editor surface mounts and forces the code view.
    view.rerender(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(PreviewPane, {
          onClose: vi.fn(),
          source: mdSource,
          workspacePath: "/workspace",
          sourceEditor: createElement("textarea", { "data-fake-editor": true }),
        }),
      ),
    );
    await waitFor(() => expect(screen.getByTestId("md-mode").textContent).toBe("code"));

    // Exit editing: back to the markdown preview rendering (the bug: stayed "code").
    await act(async () => {
      view.rerender(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "en-US" },
          createElement(PreviewPane, {
            onClose: vi.fn(),
            source: mdSource,
            workspacePath: "/workspace",
          }),
        ),
      );
    });
    await waitFor(() => expect(screen.getByTestId("md-mode").textContent).toBe("preview"));
    view.unmount();
  });
});
