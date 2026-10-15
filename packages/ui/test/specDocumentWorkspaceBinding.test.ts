// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useSpecDocumentWorkspace } from "../src/spec-document/useSpecDocumentWorkspace.js";
import { usePaneLayoutStore, V4_PRIMARY_PANE_ID } from "../src/v4/paneLayoutStore.js";
import {
  INITIAL_WORKBENCH_GROUP_STATE,
  useWorkbenchGroupStore,
} from "../src/v4/workbenchGroupStore.js";

afterEach(() => {
  cleanup();
  usePaneLayoutStore.getState().resetToPrimaryPane();
  useWorkbenchGroupStore.setState(INITIAL_WORKBENCH_GROUP_STATE);
});

it("keeps primary draft session null when the shell session belongs to a split", () => {
  const input = {
    shellWorkspacePath: "D:/A",
    workspaceTabs: [{ workspacePath: "D:/A" }],
    activeTaskId: "a",
    activeTaskMeta: { taskId: "a", workspacePath: "D:/A" },
  };
  const hook = renderHook(() => useSpecDocumentWorkspace(input));
  act(() => {
    usePaneLayoutStore.getState().splitPane(V4_PRIMARY_PANE_ID, "row", { workspacePath: "D:/A" });
    const state = usePaneLayoutStore.getState();
    state.bindPaneSession(state.focusedPaneId, "a");
    state.focusPane(V4_PRIMARY_PANE_ID);
  });
  expect(hook.result.current).toEqual({ workspacePath: "D:/A", sessionId: null });
});

it("does not enumerate a managed conversation draft through a focused group", () => {
  useWorkbenchGroupStore.setState({
    activeGroupId: "g",
    groups: {
      g: {
        id: "g",
        primaryBinding: { sessionId: null, workspaceScope: { workspacePath: "D:/ZCode" } },
        root: { type: "leaf", paneId: V4_PRIMARY_PANE_ID },
        panes: {},
        focusedPaneId: V4_PRIMARY_PANE_ID,
        updatedAt: 1,
      },
    },
  });
  const { result } = renderHook(() =>
    useSpecDocumentWorkspace({
      shellWorkspacePath: "D:/ZCode",
      workspaceTabs: [{ workspacePath: "D:/ZCode", workspacePurpose: "conversation" }],
      activeTaskId: "unrelated",
      activeTaskMeta: { taskId: "unrelated", workspacePath: "D:/B" },
    }),
  );
  expect(result.current).toBeNull();
});

it("tracks active session A/B and focused pane scope through actual stores, independently of app cwd", () => {
  const input = {
    shellWorkspacePath: "D:/ZCode",
    workspaceTabs: [
      { workspacePath: "D:/ZCode" },
      { workspacePath: "D:/B" },
      { workspacePath: "D:/A" },
    ],
    activeTaskId: "a",
    activeTaskMeta: { taskId: "a", workspacePath: "D:/A" },
  };
  const hook = renderHook((props) => useSpecDocumentWorkspace(props), { initialProps: input });
  expect(hook.result.current).toEqual({ workspacePath: "D:/A", sessionId: "a" });
  hook.rerender({ ...input, activeTaskId: "b" });
  expect(hook.result.current).toBeNull(); // Old A metadata must never expose launch-root files.
  hook.rerender({
    ...input,
    activeTaskId: "b",
    activeTaskMeta: { taskId: "b", workspacePath: "D:/B" },
  });
  expect(hook.result.current).toEqual({ workspacePath: "D:/B", sessionId: "b" });
  act(() => {
    usePaneLayoutStore.getState().splitPane(V4_PRIMARY_PANE_ID, "row", { workspacePath: "D:/A" });
    const state = usePaneLayoutStore.getState();
    state.bindPaneSession(state.focusedPaneId, "a-secondary");
  });
  expect(hook.result.current).toEqual({ workspacePath: "D:/A", sessionId: "a-secondary" });
  act(() => usePaneLayoutStore.getState().focusPane(V4_PRIMARY_PANE_ID));
  expect(hook.result.current).toEqual({ workspacePath: "D:/B", sessionId: "b" });
});

it("uses the active group primary binding instead of stale shell metadata or legacy split focus", () => {
  const { result } = renderHook(() =>
    useSpecDocumentWorkspace({
      shellWorkspacePath: "D:/ZCode",
      workspaceTabs: [],
      activeTaskId: "old",
      activeTaskMeta: { taskId: "old", workspacePath: "D:/ZCode" },
    }),
  );
  act(() =>
    useWorkbenchGroupStore.setState({
      activeGroupId: "g",
      groups: {
        g: {
          id: "g",
          primaryBinding: { sessionId: "a", workspaceScope: { workspacePath: "D:/A" } },
          root: { type: "leaf", paneId: V4_PRIMARY_PANE_ID },
          panes: {},
          focusedPaneId: V4_PRIMARY_PANE_ID,
          updatedAt: 1,
        },
      },
    }),
  );
  expect(result.current).toEqual({ workspacePath: "D:/A", sessionId: "a" });
});
