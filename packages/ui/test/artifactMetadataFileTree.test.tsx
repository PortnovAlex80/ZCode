// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { IProjectMetadataService } from "@zcode/services";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { WorkspaceFileTreeRowView } from "@/workspace-file-tree/WorkspaceFileTreeRowView.js";
import type { WorkspaceFileTreeRow } from "@/workspace-file-tree/model.js";

const host = vi.hoisted(() => ({ service: undefined as IProjectMetadataService | undefined }));
vi.mock("@/hooks/useServices.js", () => ({
  useOptionalServices: () => ({ projectMetadataService: host.service }),
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
vi.mock("@/hooks/usePlatform.js", () => ({ usePlatform: () => ({ openInEditor: vi.fn() }) }));
vi.mock("@/hooks/useFileContextActions.js", () => ({
  useFileContextActions: () => ({
    canRevealInFileManager: () => false,
    copyAbsolutePath: vi.fn(),
    copyRelativePath: vi.fn(),
    revealInFileManager: vi.fn(),
  }),
}));
beforeAll(() => {
  if (!window.PointerEvent) window.PointerEvent = MouseEvent as typeof PointerEvent;
  HTMLElement.prototype.hasPointerCapture ??= () => false;
  HTMLElement.prototype.setPointerCapture ??= () => {};
  HTMLElement.prototype.releasePointerCapture ??= () => {};
  HTMLElement.prototype.scrollIntoView ??= () => {};
});
beforeEach(() => {
  host.service = {
    read: vi.fn(async () => ({})),
    save: vi.fn(async () => ({})),
    remove: vi.fn(async () => ({})),
    resolve: vi.fn(async () => ({ path: ".", revision: "unused", entries: [], text: "" })),
  };
});
afterEach(cleanup);

const workspacePath = "D:/ODN-pilot";
function props(type: WorkspaceFileTreeRow["type"] = "file") {
  const relativePath = type === "directory" ? "documents" : "documents/title.md";
  return {
    row: {
      path: `${workspacePath}/${relativePath}`,
      name: relativePath.split("/").at(-1)!,
      type,
      depth: 0,
      expanded: false,
      loaded: true,
      loading: false,
      error: null,
    },
    selected: false,
    gitStatus: null,
    directoryGitStatuses: [],
    gitStatusLabelByStatus: {
      added: "Added",
      modified: "Modified",
      deleted: "Deleted",
      renamed: "Renamed",
      untracked: "Untracked",
      ignored: "Ignored",
    },
    contextMenuLabels: {
      open: "Open",
      openWith: "Open with",
      openInBrowser: "Open browser",
      reveal: "Reveal",
      copyAbsolutePath: "Copy absolute",
      copyRelativePath: "Copy relative",
      addToChat: "Add to chat",
      openFailed: "Open failed",
    },
    canOpenLocalFileManager: false,
    installedEditors: [],
    isRemoteWorkspaceFileTree: false,
    workspacePath,
    style: {},
    onSelect: vi.fn(),
    onToggleDirectory: vi.fn(),
    onOpenPreview: vi.fn(),
    onKeyDown: vi.fn(),
  };
}

describe("file tree artifact metadata action", () => {
  it.each(["file", "directory"] as const)(
    "opens a persistent editor for a local %s with the correct relative path and kind",
    async (type) => {
      render(<WorkspaceFileTreeRowView {...props(type)} />, { wrapper: TooltipProvider });
      expect(host.service!.read).not.toHaveBeenCalled();
      fireEvent.contextMenu(screen.getByRole("treeitem"));
      expect(host.service!.read).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("menuitem", { name: "artifactMetadata.edit" }));
      await waitFor(() =>
        expect(
          (screen.getByRole("button", { name: "common.save" }) as HTMLButtonElement).disabled,
        ).toBe(false),
      );
      expect(screen.queryByRole("menu")).toBeNull();
      expect(screen.getByRole("dialog")).toBeTruthy();
      fireEvent.change(screen.getByLabelText("artifactMetadata.field.purpose"), {
        target: { value: "ODN passport" },
      });
      fireEvent.click(screen.getByRole("button", { name: "common.save" }));
      await waitFor(() =>
        expect(host.service!.save).toHaveBeenCalledWith(
          expect.objectContaining({
            workspacePath,
            path: type === "directory" ? "documents" : "documents/title.md",
            entry: expect.objectContaining({
              kind: type === "directory" ? "folder" : "document",
              purpose: "ODN passport",
            }),
          }),
        ),
      );
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(host.service!.resolve).not.toHaveBeenCalled();
    },
  );

  it.each(["remote", "deleted", "unavailable"] as const)(
    "does not offer metadata for an %s target",
    (reason) => {
      const current = props();
      if (reason === "unavailable") host.service = undefined;
      render(
        <WorkspaceFileTreeRowView
          {...current}
          isRemoteWorkspaceFileTree={reason === "remote"}
          gitStatus={reason === "deleted" ? "deleted" : null}
        />,
        { wrapper: TooltipProvider },
      );
      fireEvent.contextMenu(screen.getByRole("treeitem"));
      expect(screen.queryByRole("menuitem", { name: "artifactMetadata.edit" })).toBeNull();
      if (host.service) expect(host.service.read).not.toHaveBeenCalled();
    },
  );
});
