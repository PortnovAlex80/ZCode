// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useAppPanels } from "@/hooks/useAppPanels.js";
import {
  activateManagedNativeDiscussionOwner,
  claimNativeDiscussionOwner,
  releaseNativeDiscussionOwner,
  specThreadStorageKey,
  useManagedNativeDiscussionThread,
  MANAGED_NATIVE_DISCUSSION_OPEN_EVENT,
  type ManagedNativeDiscussionOpenRequest,
} from "@/spec-document/nativeDiscussionHandoff.js";
import { getVisibleSidePaneTabs, buildSpecDocumentPickerSource } from "@/lib/workspaceSidePane.js";
import { getSpecThreadStore, type SpecThread } from "@/spec-document/specThread.js";
import {
  readDocumentPresentation,
  documentPresentationKey,
} from "@/spec-document/specDocumentPresentationState.js";
import { persistV4ComposerDraft, readV4ComposerDraft } from "@/v4/composer/composerDraftStore.js";

vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => ({ zcodeSessionService: { closeSession: vi.fn() } }),
}));
vi.mock("@/hooks/useInterfaceMode.js", () => ({
  useIsOfficeMode: () => false,
}));
afterEach(cleanup);

it("waits for a resolved local document workspace and ignores remote or draft sessions", () => {
  const { result, rerender } = renderHook(
    ({ path, session }: { path: string; session: string | null }) =>
      useManagedNativeDiscussionThread(path, undefined, session),
    { initialProps: { path: "", session: "waiting-child" as string | null } },
  );
  expect(result.current).toBeNull();
  rerender({ path: "D:/remote-disabled", session: null });
  expect(result.current).toBeNull();
  rerender({ path: "D:/draft-disabled", session: "__draft__" });
  expect(result.current).toBeNull();
});

it("selecting a saved child restores its parent's document tabs and activates a hidden owner", () => {
  const workspacePath = "D:/recovery-mounted";
  const thread: SpecThread = {
    id: "mounted-thread",
    documentPath: "docs/a.md",
    parentSessionId: "parent",
    sessionId: "child",
    anchor: { start: 0, quote: "a", prefix: "", suffix: "", sha256: "hash" },
  };
  localStorage.setItem(specThreadStorageKey(workspacePath, undefined), JSON.stringify([thread]));
  const { result, rerender } = renderHook(
    ({ selected }: { selected: string }) => {
      const managed = useManagedNativeDiscussionThread(workspacePath, undefined, selected);
      const owner = managed?.parentSessionId ?? selected;
      return {
        managed,
        owner,
        panels: useAppPanels({
          workspaceAbsPath: workspacePath,
          activeTaskId: selected,
          sidePaneOwnerId: owner,
          isDesktop: true,
          defaultWhiteboardNamePrefix: "Board",
        }),
      };
    },
    { initialProps: { selected: "parent" } },
  );
  act(() =>
    result.current.panels.handleOpenCodeViewer(buildSpecDocumentPickerSource({ workspacePath })),
  );
  const tabId = result.current.panels.sidePaneState!.activeTabId;
  act(() => result.current.panels.handleSpecDocumentPathChange(tabId, "docs/a.md"));
  expect(
    JSON.parse(localStorage.getItem("spec-harness:side-pane:v1:" + workspacePath)!).state
      .sidePaneState.tabs[0].source.path,
  ).toBe("D:/recovery-mounted/docs/a.md");
  const scope = { workspacePath, threadId: thread.id, sessionId: "child" };
  const token = Symbol("mounted-document");
  try {
    claimNativeDiscussionOwner(scope, token, () =>
      result.current.panels.handleActivateSidePaneTab(tabId),
    );
    rerender({ selected: "child" });
    expect(result.current.managed?.id).toBe(thread.id);
    expect(result.current.owner).toBe("parent");
    expect(
      getVisibleSidePaneTabs(result.current.panels.sidePaneState!.tabs, {
        workspaceKey: workspacePath,
        ownerTaskId: result.current.owner,
      }).map((tab) => tab.id),
    ).toEqual([tabId]);
    act(() => {
      activateManagedNativeDiscussionOwner(workspacePath, undefined, "child");
    });
    expect(result.current.panels.isSidePaneCollapsed).toBe(false);
    expect(result.current.panels.sidePaneState!.activeTabId).toBe(tabId);
    rerender({ selected: "ordinary" });
    expect(result.current.managed).toBeNull();
    expect(result.current.owner).toBe("ordinary");
    expect(
      getVisibleSidePaneTabs(result.current.panels.sidePaneState!.tabs, {
        workspaceKey: workspacePath,
        ownerTaskId: "ordinary",
      }),
    ).toEqual([]);
    rerender({ selected: "parent" });
    expect(result.current.panels.sidePaneState!.tabs).toHaveLength(1);
  } finally {
    releaseNativeDiscussionOwner(scope, token);
  }
});

it("closed discussion recovers the exact persisted document/thread and preserves the native draft", () => {
  const workspacePath = "D:/recovery-closed";
  const thread: SpecThread = {
    id: "closed-thread",
    documentPath: "docs/closed.md",
    parentSessionId: "original-parent",
    sessionId: "closed-child",
    anchor: { start: 0, quote: "a", prefix: "", suffix: "", sha256: "hash" },
  };
  localStorage.setItem(specThreadStorageKey(workspacePath, undefined), JSON.stringify([thread]));
  persistV4ComposerDraft(workspacePath, undefined, "closed-child", {
    text: "unsent question",
  });
  const draft = readV4ComposerDraft(workspacePath, undefined, "closed-child");
  const { result } = renderHook(() =>
    useManagedNativeDiscussionThread(workspacePath, undefined, "closed-child"),
  );
  expect(result.current?.parentSessionId).toBe("original-parent");
  const requests: ManagedNativeDiscussionOpenRequest[] = [];
  const listener = (event: Event) =>
    requests.push((event as CustomEvent<ManagedNativeDiscussionOpenRequest>).detail);
  window.addEventListener(MANAGED_NATIVE_DISCUSSION_OPEN_EVENT, listener);
  try {
    act(() => {
      expect(activateManagedNativeDiscussionOwner(workspacePath, undefined, "closed-child")).toBe(
        true,
      );
    });
    expect(requests).toEqual([
      { workspacePath, documentPath: thread.documentPath, threadId: thread.id },
    ]);
    expect(readDocumentPresentation(documentPresentationKey(workspacePath))).toMatchObject({
      path: thread.documentPath,
      activeThreadId: thread.id,
      discussionsVisible: true,
    });
    expect(readV4ComposerDraft(workspacePath, undefined, "closed-child")).toEqual(draft);
    expect(
      getSpecThreadStore(specThreadStorageKey(workspacePath, undefined), workspacePath).get()[0]
        ?.sessionId,
    ).toBe("closed-child");
  } finally {
    window.removeEventListener(MANAGED_NATIVE_DISCUSSION_OPEN_EVENT, listener);
  }
});
