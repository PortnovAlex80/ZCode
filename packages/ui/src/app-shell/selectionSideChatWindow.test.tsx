// @vitest-environment jsdom
// Detach-to-window (2026-11-07 #5 option C): the selection side chat tab gains
// an "open in window" affordance backed by the conversation roster. Fakes:
// SessionPane shell, platform, i18n and the roster store; dedupe belongs to the
// real roster and is pinned in conversationWindows.test.ts.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { act, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SelectionSideChatPane } from "./SelectionSideChatPane.js";
import type { SelectionSideChatPaneTab } from "@/lib/workspaceSidePane.js";

const roster = vi.hoisted(() => {
  type Entry = {
    id: string;
    scope: { workspacePath: string };
    sessionId: string;
    title: string;
  };
  const state = {
    entries: [] as Entry[],
    listeners: new Set<() => void>(),
    focus: vi.fn(),
    open: vi.fn((scope: { workspacePath: string }, sessionId: string, title: string) => {
      const existing = state.find(scope, sessionId);
      if (existing) {
        state.focus(existing.id);
        return existing;
      }
      const entry: Entry = {
        id: `w-${state.entries.length + 1}`,
        scope,
        sessionId,
        title,
      };
      state.entries = [...state.entries, entry];
      for (const listener of state.listeners) listener();
      return entry;
    }),
    close: vi.fn((id: string) => {
      state.entries = state.entries.filter((entry) => entry.id !== id);
      for (const listener of state.listeners) listener();
    }),
    find: (scope: { workspacePath: string }, sessionId: string | null) =>
      sessionId
        ? state.entries.find(
            (entry) =>
              entry.scope.workspacePath === scope.workspacePath && entry.sessionId === sessionId,
          )
        : undefined,
    focusById: (id: string) => {
      state.focus(id);
    },
  };
  return state;
});

vi.mock("@/spec-document/conversationWindows.js", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useConversationWindows: () =>
      useSyncExternalStore(
        (listener) => {
          roster.listeners.add(listener);
          return () => roster.listeners.delete(listener);
        },
        () => roster.entries,
        () => roster.entries,
      ),
    findConversationWindow: roster.find,
    openConversationWindow: roster.open,
    closeConversationWindow: roster.close,
    focusConversationWindow: roster.focusById,
  };
});

vi.mock("@/hooks/usePlatform.js", () => ({
  useOptionalPlatform: () => ({ openConversationPopout: vi.fn() }),
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useOptionalZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));

vi.mock("@/v4/SessionPane.js", () => ({
  SessionPane: ({
    sessionId,
    rootSessionId,
  }: {
    sessionId: string | null;
    rootSessionId?: string;
  }) => (
    <div
      data-fake-session-pane={sessionId}
      data-root-session={rootSessionId}
    />
  ),
}));

vi.mock("@/v4/V4ConversationContext.js", () => ({
  V4PaneConversationProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const tab: SelectionSideChatPaneTab = {
  id: "selection-side-chat:tab",
  type: "selection-side-chat",
  workspaceKey: "D:/source",
  workspacePath: "D:/source",
  parentSessionId: "parent-1",
  childSessionId: "child-1",
  ordinal: 0,
};

function renderPane() {
  return render(
    <SelectionSideChatPane
      tab={tab}
      focused
      onUnavailable={() => {}}
    />,
  );
}

beforeEach(() => {
  roster.entries = [];
  roster.open.mockClear();
  roster.close.mockClear();
  roster.focus.mockClear();
});
afterEach(cleanup);

describe("selection side chat detach to window", () => {
  it("opens a roster window for the child session and focuses an existing one", async () => {
    const { container, unmount } = renderPane();
    expect(container.querySelector("[data-fake-session-pane='child-1']")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "sideChat.openInWindow" }));
    expect(roster.open).toHaveBeenCalledOnce();
    expect(roster.open).toHaveBeenCalledWith(
      { workspacePath: "D:/source" },
      "child-1",
      "source — sidePane.selectionChat",
    );

    // Detached: the tab yields to the focus guard instead of a second composer.
    await waitFor(() =>
      expect(container.querySelector("[data-detached-session-guard='child-1']")).toBeTruthy(),
    );
    expect(container.querySelector("[data-fake-session-pane='child-1']")).toBeNull();
    expect(roster.entries).toHaveLength(1);
    const entry = roster.entries[0];
    if (!entry) throw new Error("roster entry missing");

    // Reopening (or returning to the tab) focuses the existing window: dedupe.
    fireEvent.click(screen.getByRole("button", { name: "sideChat.openInWindow" }));
    expect(roster.open).toHaveBeenCalledTimes(2);
    expect(roster.focus).toHaveBeenCalledWith(entry.id);

    // Closing the roster window leaves the tab in place; the live pane returns.
    await act(async () => {
      roster.close(entry.id);
    });
    await waitFor(() =>
      expect(container.querySelector("[data-fake-session-pane='child-1']")).toBeTruthy(),
    );
    unmount();
  });
});
