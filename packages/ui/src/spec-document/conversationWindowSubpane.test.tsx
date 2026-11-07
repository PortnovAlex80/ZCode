// @vitest-environment jsdom
// VER-1 (2026-11-08 #7): clicking a subagent affordance inside a detached
// conversation window must open the subagent transcript as a secondary
// read-only leaf in the SAME window. Only fakes here: the pane shell
// (WorkbenchLeafPane), both subagent side-pane compositions, services, i18n
// and the roster store — the interception logic itself runs for real.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { act, useSyncExternalStore, type ReactNode } from "react";
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationWindows } from "./ConversationWindowHost.js";

type FakeEntry = {
  id: string;
  scope: { workspacePath: string };
  sessionId: string;
  title: string;
};

const roster = vi.hoisted(() => {
  const state = {
    seq: 0,
    entries: [] as FakeEntry[],
    listeners: new Set<() => void>(),
    publish() {
      for (const listener of state.listeners) listener();
    },
    open(scope: { workspacePath: string }, sessionId: string, title: string): FakeEntry {
      // Monotonic ids mirror the real roster's crypto.randomUUID: a reopened
      // window always mounts fresh (new React key).
      const entry: FakeEntry = {
        id: `win-${++state.seq}`,
        scope,
        sessionId,
        title,
      };
      state.entries = [...state.entries, entry];
      state.publish();
      return entry;
    },
    close(id: string) {
      state.entries = state.entries.filter((entry) => entry.id !== id);
      state.publish();
    },
  };
  return state;
});

const requests = vi.hoisted(() => ({
  // Fixture requests the fake primary pane emits when its shell callbacks fire.
  child(childSessionId: string) {
    return {
      workspacePath: "D:/source",
      rootSessionId: "parent-1",
      parentSessionId: "parent-1",
      childSessionId,
      subagentType: "explore",
      title: `agent ${childSessionId}`,
    };
  },
  nested: {
    workspacePath: "D:/source",
    rootSessionId: "parent-1",
    parentSessionId: "child-1",
    childSessionId: "child-1-nested",
    subagentType: "explore",
    title: "agent nested",
  },
  directory: {
    workspacePath: "D:/source",
    rootSessionId: "parent-1",
    parentSessionId: "parent-1",
  },
  sync(validChildSessionIds: string[]) {
    return { rootSessionId: "parent-1", parentSessionId: "parent-1", validChildSessionIds };
  },
}));

vi.mock("./conversationWindows.js", () => ({
  useConversationWindows: () =>
    useSyncExternalStore(
      (listener) => {
        roster.listeners.add(listener);
        return () => roster.listeners.delete(listener);
      },
      () => roster.entries,
      () => roster.entries,
    ),
  findConversationWindow: () => undefined,
  openConversationWindow: roster.open,
  closeConversationWindow: roster.close,
  bindConversationWindow: () => {},
  registerConversationWindowFocus: () => () => {},
  conversationWindowKey: (scope: { workspacePath: string }, sessionId: string) =>
    `${scope.workspacePath}:${sessionId}`,
}));

// Stable services identity: the admission effect re-runs whenever `services`
// changes, so a per-render mock would reset admission in an endless loop.
const services = vi.hoisted(() => ({
  zcodeAgentService: {
    listSessions: vi.fn(async () => [{ sessionId: "parent-1" }]),
  },
}));

vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => services,
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));

vi.mock("@/v4/WorkbenchPane.js", () => ({
  // Fake primary leaf: exposes the shell binding's action callbacks as buttons.
  WorkbenchLeafPane: ({
    paneId,
    rect,
    shell,
  }: {
    paneId: string;
    rect: Record<string, string>;
    shell: {
      onOpenSubagentSession?: (request: unknown) => void;
      onOpenSubagentDirectory?: (request: unknown) => void;
      onOpenBrowserUrl?: (url: string) => void;
      onSyncSubagentSessionTabs?: (request: unknown) => void;
    };
  }) => (
    <div data-fake-primary-pane={paneId} data-primary-rect={JSON.stringify(rect)}>
      <button
        data-testid="primary-open-subagent"
        onClick={() => shell.onOpenSubagentSession?.(requests.child("child-1"))}
      />
      <button
        data-testid="primary-open-subagent-2"
        onClick={() => shell.onOpenSubagentSession?.(requests.child("child-2"))}
      />
      <button
        data-testid="primary-open-directory"
        onClick={() => shell.onOpenSubagentDirectory?.(requests.directory)}
      />
      <button data-testid="primary-open-browser" onClick={() => shell.onOpenBrowserUrl?.("https://example.com")} />
      <button
        data-testid="primary-sync-valid"
        onClick={() => shell.onSyncSubagentSessionTabs?.(requests.sync(["child-1", "child-2"]))}
      />
      <button
        data-testid="primary-sync-stale"
        onClick={() => shell.onSyncSubagentSessionTabs?.(requests.sync(["child-2"]))}
      />
    </div>
  ),
}));

vi.mock("@/app-shell/SubagentSessionSidePane.js", () => ({
  SubagentSessionSidePane: ({
    tab,
    onOpenSubagentSession,
  }: {
    tab: { id: string; childSessionId: string; title: string };
    onOpenSubagentSession: (request: unknown) => void;
  }) => (
    <div
      data-fake-subagent-session-pane={tab.childSessionId}
      data-pane-id={tab.id}
      data-title={tab.title}
      data-readonly="true"
    >
      <button
        data-testid="subpane-nested-open"
        onClick={() => onOpenSubagentSession(requests.nested)}
      />
    </div>
  ),
}));

vi.mock("@/app-shell/SubagentDirectorySidePane.js", () => ({
  SubagentDirectorySidePane: ({
    tab,
    onOpenSubagentSession,
  }: {
    tab: { id: string; parentSessionId: string };
    onOpenSubagentSession: (request: unknown) => void;
  }) => (
    <div data-fake-subagent-directory-pane={tab.parentSessionId} data-pane-id={tab.id}>
      <button
        data-testid="directory-open-subagent"
        onClick={() => onOpenSubagentSession(requests.child("child-1"))}
      />
    </div>
  ),
}));

vi.mock("@/v4/V4ConversationContext.js", () => ({
  V4PaneConversationProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("./specPopoutRegion.js", () => ({
  useSpecPopoutRegion: () => ({
    focus: vi.fn(),
    open: vi.fn(),
    anchorRef: { current: null },
    lastError: null,
  }),
  SpecPopoutRegionPortal: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

let routeAction: Mock<(...args: unknown[]) => void>;

function renderWindows() {
  return render(<ConversationWindows onReturn={() => {}} routeAction={routeAction} />);
}

async function waitForAdmission(container: HTMLElement) {
  await waitFor(() =>
    expect(container.querySelector("[data-fake-primary-pane='floating-win-1']")).toBeTruthy(),
  );
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  roster.entries = [];
  roster.seq = 0;
  routeAction = vi.fn();
  roster.open({ workspacePath: "D:/source" }, "parent-1", "Parent");
});
afterEach(cleanup);

describe("subagent secondary leaf inside detached conversation windows", () => {
  it("opens a closable read-only secondary pane for the clicked child session", async () => {
    const { container } = renderWindows();
    await waitForAdmission(container);

    fireEvent.click(screen.getByTestId("primary-open-subagent"));

    const pane = container.querySelector("[data-fake-subagent-session-pane='child-1']");
    expect(pane).toBeTruthy();
    expect(pane?.getAttribute("data-pane-id")).toBe("floating-subagent-win-1");
    expect(pane?.getAttribute("data-readonly")).toBe("true");
    expect(pane?.getAttribute("data-title")).toBe("agent child-1");
    // Intercepted locally: the main-window route is never invoked.
    expect(routeAction).not.toHaveBeenCalled();
    // The primary conversation shrinks to the 60% split while the leaf is open.
    expect(JSON.parse(container.querySelector("[data-fake-primary-pane]")!.getAttribute("data-primary-rect")!)).toEqual(
      expect.objectContaining({ width: "60%" }),
    );

    // The mocked popout portal renders inline inside the `hidden` window anchor,
    // so role queries cannot see the close control here; assert on the label.
    fireEvent.click(
      container.querySelector('button[aria-label="conversation.window.subagentPane.close"]')!,
    );
    expect(container.querySelector("[data-fake-subagent-session-pane]")).toBeNull();
    expect(JSON.parse(container.querySelector("[data-fake-primary-pane]")!.getAttribute("data-primary-rect")!)).toEqual(
      expect.objectContaining({ width: "100%" }),
    );
  });

  it("replaces the secondary pane instead of stacking on further clicks", async () => {
    const { container } = renderWindows();
    await waitForAdmission(container);

    fireEvent.click(screen.getByTestId("primary-open-subagent"));
    fireEvent.click(screen.getByTestId("primary-open-subagent-2"));

    const panes = container.querySelectorAll("[data-fake-subagent-session-pane]");
    expect(panes).toHaveLength(1);
    expect(panes[0]!.getAttribute("data-fake-subagent-session-pane")).toBe("child-2");

    // A nested subagent affordance inside the transcript replaces the leaf too.
    fireEvent.click(screen.getByTestId("subpane-nested-open"));
    const nested = container.querySelectorAll("[data-fake-subagent-session-pane]");
    expect(nested).toHaveLength(1);
    expect(nested[0]!.getAttribute("data-fake-subagent-session-pane")).toBe("child-1-nested");
  });

  it("other shell actions still route through routeAction", async () => {
    const { container } = renderWindows();
    await waitForAdmission(container);

    fireEvent.click(screen.getByTestId("primary-open-browser"));

    expect(routeAction).toHaveBeenCalledTimes(1);
    expect(routeAction).toHaveBeenCalledWith(
      expect.objectContaining({ id: "win-1" }),
      "onOpenBrowserUrl",
      ["https://example.com"],
    );
    expect(container.querySelector("[data-fake-subagent-session-pane]")).toBeNull();
  });

  it("parent projection sync prunes a stale transcript but keeps a valid one", async () => {
    const { container } = renderWindows();
    await waitForAdmission(container);

    fireEvent.click(screen.getByTestId("primary-open-subagent"));
    fireEvent.click(screen.getByTestId("primary-sync-valid"));
    expect(container.querySelector("[data-fake-subagent-session-pane='child-1']")).toBeTruthy();

    fireEvent.click(screen.getByTestId("primary-sync-stale"));
    expect(container.querySelector("[data-fake-subagent-session-pane]")).toBeNull();
  });

  it("the subagent directory opens in the leaf and a click replaces it with a transcript", async () => {
    const { container } = renderWindows();
    await waitForAdmission(container);

    fireEvent.click(screen.getByTestId("primary-open-directory"));
    expect(
      container.querySelector("[data-fake-subagent-directory-pane='parent-1']"),
    ).toBeTruthy();
    expect(container.querySelector("[data-fake-subagent-session-pane]")).toBeNull();

    fireEvent.click(screen.getByTestId("directory-open-subagent"));
    expect(container.querySelector("[data-fake-subagent-directory-pane]")).toBeNull();
    expect(container.querySelector("[data-fake-subagent-session-pane='child-1']")).toBeTruthy();
  });

  it("closing the roster entry clears the secondary state for good", async () => {
    const { container } = renderWindows();
    await waitForAdmission(container);

    fireEvent.click(screen.getByTestId("primary-open-subagent"));
    expect(container.querySelector("[data-fake-subagent-session-pane='child-1']")).toBeTruthy();

    await act(async () => {
      roster.close("win-1");
    });
    expect(container.querySelector("[data-fake-primary-pane]")).toBeNull();
    expect(container.querySelector("[data-fake-subagent-session-pane]")).toBeNull();

    // A fresh roster window never inherits the previous window's leaf.
    await act(async () => {
      roster.open({ workspacePath: "D:/source" }, "parent-1", "Parent");
    });
    await waitFor(() =>
      expect(container.querySelector("[data-fake-primary-pane='floating-win-2']")).toBeTruthy(),
    );
    expect(container.querySelector("[data-fake-subagent-session-pane]")).toBeNull();
  });
});
