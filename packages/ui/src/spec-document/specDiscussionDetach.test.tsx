// @vitest-environment jsdom
// Detach-to-window (2026-11-07 #5 option B): a document discussion moves into a
// conversation roster window. Only fakes here: native discussion controller,
// SessionPane shell, platform, services and the roster store. Owner claim,
// release and re-claim run through the real handoff module.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { act, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpecDiscussionPane } from "./SpecDiscussionPane.js";
import type { SpecThread } from "./specThread.js";
import {
  readNativeDiscussionOwner,
  registerManagedNativeDiscussion,
} from "./nativeDiscussionHandoff.js";

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
    open: vi.fn((scope: { workspacePath: string }, sessionId: string, title: string) => {
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
  };
  return state;
});

vi.mock("./conversationWindows.js", async () => {
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
  };
});

vi.mock("@/hooks/useServices.js", () => ({
  useOptionalServices: () => null,
}));

vi.mock("@/hooks/usePlatform.js", () => ({
  useOptionalPlatform: () => ({ openConversationPopout: vi.fn() }),
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useOptionalZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));

vi.mock("@/v4/SessionPane.js", () => ({
  SessionPane: ({
    sessionId,
    readOnly,
  }: {
    sessionId: string | null;
    readOnly?: boolean;
  }) => (
    <div
      data-fake-session-pane={sessionId}
      data-readonly={String(Boolean(readOnly))}
    />
  ),
}));

const discussion = vi.hoisted(() => ({
  snapshotSessionId: "sess-detach",
}));

vi.mock("./useSpecDiscussion.js", () => ({
  useSpecDiscussion: () => ({
    configurationReady: true,
    projection: { status: "live", lastError: null },
    snapshot: { sessionId: discussion.snapshotSessionId },
    dispatching: false,
    canRemove: true,
    removeBlockedReason: null,
    error: "",
    reconcile: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
  }),
}));

vi.mock("@/v4/usePresentationVisibility.js", () => ({
  useCombinedPresentationVisibility: () => true,
}));

vi.mock("@/v4/V4ConversationContext.js", () => ({
  V4PaneConversationProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

function threadFixture(id: string, sessionId: string): SpecThread {
  return {
    id,
    documentPath: "D:/source/docs/guide.md",
    parentSessionId: "parent-1",
    anchor: { quote: "quoted text", prefix: "", suffix: "", start: 0, sha256: "sha" },
    sessionId,
    discussionStartRowId: 1,
    scope: "document",
  };
}

function renderPane(thread: SpecThread) {
  return render(
    <SpecDiscussionPane
      thread={thread}
      update={() => {}}
      updateQuestionDraft={() => {}}
      workspacePath="D:/source"
      anchorCurrent
      visible
    />,
  );
}

beforeEach(() => {
  localStorage.clear();
  roster.entries = [];
  roster.open.mockClear();
  roster.close.mockClear();
  discussion.snapshotSessionId = "sess-detach";
});
afterEach(cleanup);

describe("detach document discussion into a conversation window", () => {
  it("releases the document claim, opens the roster window and re-claims on close", async () => {
    const thread = threadFixture("thread-live", "sess-detach");
    const { container } = renderPane(thread);
    await waitFor(() =>
      expect(container.querySelector("[data-native-discussion-owner='sess-detach']")).toBeTruthy(),
    );
    expect(
      container.querySelector("[data-fake-session-pane='sess-detach']")?.getAttribute("data-readonly"),
    ).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: "specDiscussion.detachToWindow" }));

    expect(roster.open).toHaveBeenCalledOnce();
    expect(roster.open).toHaveBeenCalledWith(
      { workspacePath: "D:/source" },
      "sess-detach",
      "guide.md — specDiscussion.windowTitle",
    );
    // Ownership left the document: the identity stays managed, the token is free.
    expect(
      readNativeDiscussionOwner({
        workspacePath: "D:/source",
        threadId: "thread-live",
        sessionId: "sess-detach",
      }),
    ).toBeNull();
    await waitFor(() =>
      expect(
        container.querySelector("[data-fake-session-pane='sess-detach']")?.getAttribute("data-readonly"),
      ).toBe("true"),
    );
    expect(screen.getByText("conversation.window.detached")).toBeTruthy();
    expect(roster.entries).toHaveLength(1);
    const entry = roster.entries[0];
    if (!entry) throw new Error("roster entry missing");

    // The roster window closes: the discussion returns to this document through
    // the same claim path, so the composer becomes interactive again.
    await act(async () => {
      roster.close(entry.id);
    });
    await waitFor(() =>
      expect(
        container.querySelector("[data-fake-session-pane='sess-detach']")?.getAttribute("data-readonly"),
      ).toBe("false"),
    );
    expect(
      readNativeDiscussionOwner({
        workspacePath: "D:/source",
        threadId: "thread-live",
        sessionId: "sess-detach",
      }),
    ).not.toBeNull();
    expect(roster.open).toHaveBeenCalledOnce();
  });

  it("a document that lost the claim cannot detach the session", async () => {
    const thread = threadFixture("thread-guarded", "sess-guarded");
    discussion.snapshotSessionId = "sess-guarded";
    registerManagedNativeDiscussion({
      workspacePath: "D:/source",
      threadId: "thread-guarded",
      sessionId: "sess-guarded",
    });
    // Another surface owns the discussion before this pane mounts.
    const foreignToken = Symbol("foreign-owner");
    const { claimNativeDiscussionOwner } = await import("./nativeDiscussionHandoff.js");
    expect(
      claimNativeDiscussionOwner(
        { workspacePath: "D:/source", threadId: "thread-guarded", sessionId: "sess-guarded" },
        foreignToken,
        () => {},
      ),
    ).toBe(true);

    const { container } = renderPane(thread);
    await waitFor(() =>
      expect(screen.getByText("This discussion is already open in another document tab.")).toBeTruthy(),
    );
    const detach = container.querySelector("[data-discussion-detach-control]");
    expect(detach).toBeTruthy();
    expect((detach as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(detach as HTMLButtonElement);
    expect(roster.open).not.toHaveBeenCalled();
  });
});
