// @vitest-environment jsdom
/**
 * CORR-1/CORR-2 contract suite (user ruling 2026-11-07).
 *
 * The 2026-10-14 role model (U-04/U-05, workspacePanelRoles) and the side-swap
 * arrangement are retired: file opening is native-first, fork document
 * capabilities live in the file tree context menu, and the caption cluster is
 * the upstream a9fe401e composition again. Layers:
 * 1. Workspace file entry points (real dispatch + real presentation storage).
 * 2. Source contracts: native caption cluster, dismantled tab interception,
 *    context-menu entry points, i18n coverage.
 * 3. Chat caption restore affordances (real WorkspaceHeaderActionSection gate).
 * 4. Shortcut registration uniqueness (shared command table).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseShortcutBinding,
  serializeShortcutBinding,
  SHORTCUT_COMMANDS,
} from "@zcode/shared";
import {
  documentPresentationKey,
  readDocumentPresentation,
} from "@/spec-document/specDocumentPresentationState.js";
import {
  discussWorkspaceFileDocument,
  openWorkspaceFileDocumentWindow,
  requestWorkspaceFileSideConversation,
  WORKSPACE_FILE_SIDE_CONVERSATION_EVENT,
} from "@/spec-document/workspaceFileEntryPoints.js";

function readSource(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

const INDEPENDENT_DOCUMENT_OPEN_EVENT = "zcode:open-independent-document";

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

// ============================================================================
// 1. Workspace file entry points (CORR-1 context menu surface)
// ============================================================================

const ENTRY_REQUEST = {
  workspacePath: "D:\\ws",
  path: "D:\\ws\\docs\\note.md",
  name: "note.md",
};

describe("workspace file entry points (CORR-1)", () => {
  it("opens the retained document window and arms the discussion dock for Discuss document", () => {
    const listener = vi.fn();
    const discussListener = vi.fn();
    window.addEventListener(INDEPENDENT_DOCUMENT_OPEN_EVENT, listener);
    window.addEventListener("zcode:workspace-document-discuss", discussListener);
    try {
      discussWorkspaceFileDocument({
        request: ENTRY_REQUEST,
        relativeDocumentPath: "docs/note.md",
      });
      expect(listener).toHaveBeenCalledTimes(1);
      const event = listener.mock.calls[0][0] as CustomEvent;
      // The file tree does not know the active session; the host resolves it.
      expect(event.detail.parentSessionId).toBeNull();
      expect(event.detail.workspacePath).toBe("D:\\ws");
      expect(event.detail.source).toMatchObject({
        type: "file",
        specDocument: true,
        path: "D:\\ws\\docs\\note.md",
        title: "note.md",
      });
      // Live handoff for a pane that already holds this document.
      expect(discussListener).toHaveBeenCalledTimes(1);
      expect((discussListener.mock.calls[0][0] as CustomEvent).detail).toEqual({
        workspacePath: "D:\\ws",
        documentPath: "docs/note.md",
      });
      const presentation = readDocumentPresentation(
        documentPresentationKey("D:\\ws"),
      );
      expect(presentation).toMatchObject({
        path: "docs/note.md",
        discussionsVisible: true,
        activeThreadId: null,
      });
    } finally {
      window.removeEventListener(INDEPENDENT_DOCUMENT_OPEN_EVENT, listener);
      window.removeEventListener(
        "zcode:workspace-document-discuss",
        discussListener,
      );
    }
  });

  it("opens the retained window without touching the discussion dock for Open in separate window", () => {
    const listener = vi.fn();
    window.addEventListener(INDEPENDENT_DOCUMENT_OPEN_EVENT, listener);
    try {
      openWorkspaceFileDocumentWindow(ENTRY_REQUEST);
      expect(listener).toHaveBeenCalledTimes(1);
      const presentation = readDocumentPresentation(
        documentPresentationKey("D:\\ws"),
      );
      expect(presentation.discussionsVisible).toBe(false);
      expect(presentation.path).toBeNull();
    } finally {
      window.removeEventListener(INDEPENDENT_DOCUMENT_OPEN_EVENT, listener);
    }
  });

  it("routes Side conversation through the shell event with the file context", () => {
    const listener = vi.fn();
    window.addEventListener(WORKSPACE_FILE_SIDE_CONVERSATION_EVENT, listener);
    try {
      requestWorkspaceFileSideConversation(ENTRY_REQUEST);
      expect(listener).toHaveBeenCalledTimes(1);
      const event = listener.mock.calls[0][0] as CustomEvent;
      expect(event.detail).toMatchObject({
        workspacePath: "D:\\ws",
        path: "D:\\ws\\docs\\note.md",
        name: "note.md",
      });
    } finally {
      window.removeEventListener(WORKSPACE_FILE_SIDE_CONVERSATION_EVENT, listener);
    }
  });
});

// ============================================================================
// 2. Source contracts: native caption, no interception, context-menu entries
// ============================================================================

describe("native side-pane caption (CORR-2)", () => {
  it("restores the upstream toggle glyphs and drops the role-model disabled prop", () => {
    const toggleSource = readSource(
      "packages/ui/src/WorkspaceSidePaneToggleButton.tsx",
    );
    expect(toggleSource).toContain("PanelRightClose");
    expect(toggleSource).toContain("PanelRightOpen");
    expect(toggleSource).not.toContain("Columns2");
    expect(toggleSource).not.toContain("disabled");
  });

  it("renders the upstream inline cluster in the upstream order inside the panel caption", () => {
    const source = readSource(
      "packages/ui/src/app-shell/AnimatedSidePanePanel.tsx",
    );
    const cluster = source.substring(
      source.indexOf("const closeSidePaneButton"),
      source.indexOf("const openTabLauncher = ("),
    );
    expect(cluster).toContain("SidePaneFullViewToggleButton");
    expect(cluster).toContain("WorkspaceSidePaneToggleButton");
    expect(cluster).toContain("DesktopWindowControls");
    expect(
      cluster.indexOf("SidePaneFullViewToggleButton"),
    ).toBeLessThan(cluster.indexOf("WorkspaceSidePaneToggleButton"));
    expect(
      cluster.indexOf("WorkspaceSidePaneToggleButton"),
    ).toBeLessThan(cluster.indexOf("DesktopWindowControls"));
    // Native semantics: the toggle always addresses the side pane itself.
    expect(cluster).toContain("onToggleSidePane={onCloseSidePane}");
    expect(cluster).toContain("isSidePaneOpen");
    // No fork wrapper, no role model in the caption path.
    expect(source).not.toContain("WorkspaceSidePaneCaptionControls");
    expect(source).not.toContain('from "@/spec-document/workspacePanelRoles.js"');
    expect(source).not.toContain("sidePaneRoleToggle");
  });

  it("retires the role model module and its imports", () => {
    expect(
      existsSync(
        resolve(process.cwd(), "packages/ui/src/spec-document/workspacePanelRoles.ts"),
      ),
    ).toBe(false);
    expect(
      existsSync(
        resolve(
          process.cwd(),
          "packages/ui/src/app-shell/WorkspaceSidePaneCaptionControls.tsx",
        ),
      ),
    ).toBe(false);
    const layoutSource = readSource(
      "packages/ui/src/app-shell/WorkspaceShellLayout.tsx",
    );
    expect(layoutSource).not.toContain('from "@/spec-document/workspacePanelRoles.js"');
    expect(layoutSource).not.toContain("resolveWorkspaceBodyRoleState");
    expect(layoutSource).not.toContain("sidePaneRoleToggle");
  });

  it("keeps a dedicated restore affordance for the fork-only collapsed chat", () => {
    // specGeneralChatCollapse is a fork keep; with the role toggle gone the
    // caption must still expose the restore action while the chat is collapsed.
    const source = readSource(
      "packages/ui/src/app-shell/AnimatedSidePanePanel.tsx",
    );
    expect(source).toMatch(/generalChatCollapsed && onToggleGeneralChat/);
    expect(source).toContain("sidePane.restoreChat");
    const layoutSource = readSource(
      "packages/ui/src/app-shell/WorkspaceShellLayout.tsx",
    );
    expect(layoutSource).toContain("onToggleGeneralChat={handleToggleGeneralChat}");
    // Closing the side pane still self-restores the chat (collapse resolver guard).
    expect(layoutSource).toContain("resolveSpecGeneralChatCollapsed");
    expect(layoutSource).toContain("toggleSpecGeneralChatCollapse");
  });
});

describe("native-first file opening (CORR-1)", () => {
  it("never intercepts native code-viewer/file-manager tabs with the document pane", () => {
    const source = readSource(
      "packages/ui/src/app-shell/AnimatedSidePanePanel.tsx",
    );
    expect(source).not.toContain("canOpenSpecDocument");
    expect(source).not.toContain("buildSpecDocumentPickerSource");
    expect(source).not.toContain('id: "documents"');
    // Document rendering survives only for retained document windows/tabs.
    expect(source).toMatch(/documentContext\.tab\.source\.specDocument === true/);
  });

  it("adds the three fork entry points to the file tree context menu for local text documents", () => {
    const rowSource = readSource(
      "packages/ui/src/workspace-file-tree/WorkspaceFileTreeRowView.tsx",
    );
    expect(rowSource).toContain("discussWorkspaceFileDocument");
    expect(rowSource).toContain("openWorkspaceFileDocumentWindow");
    expect(rowSource).toContain("requestWorkspaceFileSideConversation");
    // Whitelist matches the document IO service (.md/.markdown/.txt/.rst).
    expect(rowSource).toMatch(/\\\.\(md\|markdown\|txt\|rst\)\$/);
    // Local desktop workspaces only.
    expect(rowSource).toMatch(
      /!isRemoteWorkspaceFileTree\s*&&\s*!workspaceRemoteSessionId\s*&&\s*canOpenLocalFileManager/,
    );
    for (const locale of [
      "packages/ui/src/i18n/locales/en-US.ts",
      "packages/ui/src/i18n/locales/zh-CN.ts",
    ]) {
      const localeSource = readSource(locale);
      expect(localeSource).toContain('"workspaceFileTree.discussDocument"');
      expect(localeSource).toContain('"workspaceFileTree.openDocumentWindow"');
      expect(localeSource).toContain('"workspaceFileTree.openSideConversation"');
      expect(localeSource).toContain('"sidePane.restoreChat"');
    }
  });
});

// ============================================================================
// 3. Chat caption restore affordances (real WorkspaceHeaderActionSection gate)
// ============================================================================

vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children: React.ReactNode }) => children,
  SidebarNativeTooltip: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: { formatMessage: ({ id }: { id: string }) => id },
  }),
}));

vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({}),
  useOptionalPlatform: () => undefined,
}));

vi.mock("@/WorkspaceHeaderSections/WorkspaceEditorButtonGroup.js", () => ({
  WorkspaceEditorButtonGroup: () => null,
}));

vi.mock("@/WorkspaceTerminalToggleButton.js", () => ({
  WorkspaceTerminalToggleButton: () => null,
}));

vi.mock("@/WorkspaceHelpMenuButton.js", () => ({
  WorkspaceHelpMenuButton: () => null,
}));

vi.mock("@/ConversationShareMenu.js", () => ({
  ConversationShareMenu: () => null,
}));

const { WorkspaceHeaderActionSection } = await import(
  "@/WorkspaceHeaderSections/WorkspaceHeaderActionSection.js"
);

function renderHeader(options: {
  isSidePaneOpen: boolean;
  showWindowControls: boolean;
}) {
  return renderToStaticMarkup(
    createElement(WorkspaceHeaderActionSection, {
      variant: "draft",
      isDesktop: true,
      isSidePaneOpen: options.isSidePaneOpen,
      onToggleSidePane: () => {},
      toggleSidePaneShortcutLabel: "Ctrl+Alt+B",
      showWindowControls: options.showWindowControls,
    }),
  );
}

describe("chat caption restore affordances", () => {
  it("shows the restore toggle and window controls only while the side pane is closed", () => {
    const openHtml = renderHeader({
      isSidePaneOpen: true,
      showWindowControls: true,
    });
    expect(openHtml).not.toContain('aria-label="sidePane.expand"');
    expect(openHtml).not.toContain("desktop-window-controls");
    const closedHtml = renderHeader({
      isSidePaneOpen: false,
      showWindowControls: true,
    });
    expect(closedHtml).toContain('aria-label="sidePane.expand"');
    expect(closedHtml).toContain("desktop-window-controls");
  });
});

// ============================================================================
// 4. Shortcut: command table uniqueness and single App dispatch
// ============================================================================

describe("side-pane toggle shortcut registration", () => {
  it("registers the side-pane toggle command exactly once in the shared command table", () => {
    const entries = SHORTCUT_COMMANDS.filter(
      (entry) => entry.id === "toggleSidePane",
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].defaultBindings.length).toBeGreaterThan(0);
  });

  it("has no default-binding collisions across the whole shortcut table", () => {
    const seen = new Map<string, string>();
    for (const entry of SHORTCUT_COMMANDS) {
      for (const binding of entry.defaultBindings) {
        const parsed = parseShortcutBinding(binding);
        expect(parsed, `binding must parse: ${binding}`).toBeTruthy();
        const canonical = serializeShortcutBinding(parsed);
        expect(canonical).toBe(binding);
        const owner = seen.get(canonical ?? binding);
        expect(
          owner,
          `default binding ${binding} of ${entry.id} collides with ${owner ?? "unknown"}`,
        ).toBeUndefined();
        seen.set(canonical ?? binding, entry.id);
      }
    }
  });

  it("dispatches the shortcut through the single App entry and hands the label to the caption toggle", () => {
    const appSource = readSource("packages/ui/src/App.tsx");
    expect(appSource.match(/toggleSidePane: \(\) =>/g)).toHaveLength(1);
    const panelSource = readSource(
      "packages/ui/src/app-shell/AnimatedSidePanePanel.tsx",
    );
    expect(panelSource).toMatch(
      /shortcutLabel=\{toggleSidePaneShortcutLabel\}/u,
    );
  });
});
