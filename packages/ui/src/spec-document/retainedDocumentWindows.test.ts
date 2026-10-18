// @vitest-environment jsdom
import { beforeEach, expect, it } from "vitest";
import {
  activateRetainedDocument,
  readRetainedDocumentWindows,
  retainedDocumentPlacementKey,
  RETAINED_DOCUMENT_ACTIVATE_EVENT,
  writeRetainedDocumentWindows,
  type RetainedDocumentWindow,
} from "./retainedDocumentWindows.js";
import {
  defaultDocumentPresentation,
  documentPresentationKey,
  readDocumentPresentation,
  writeDocumentPresentation,
  readDocumentDraft,
  writeDocumentDraft,
} from "./specDocumentPresentationState.js";
import {
  clearTaskSidePaneMemoryStateForTest,
  getSidePaneActiveTabPreference,
  getSidePaneCollapsedPreference,
  readTaskSidePaneMemoryState,
  saveTaskSidePaneMemoryState,
} from "../lib/taskSidePaneMemory.js";
function owner(project: string, session: string, tabId = "doc-a"): RetainedDocumentWindow {
  return {
    workspacePath: project,
    parentSessionId: session,
    tab: {
      id: tabId,
      type: "code-viewer",
      ownerTaskId: session,
      workspaceKey: project,
      sourceKey: "file:docs/a.md",
      source: {
        type: "file",
        title: "a.md",
        workspacePath: project,
        path: project + "/docs/a.md",
        specDocument: true,
      },
    },
  };
}
beforeEach(() => {
  localStorage.clear();
  clearTaskSidePaneMemoryStateForTest();
});
it("restores independent exact document owners across projects and same-project conversations", () => {
  const windows = [
    owner("D:/a", "session-a"),
    owner("D:/b", "session-b", "doc-b"),
    owner("D:/a", "session-c", "doc-c"),
  ];
  writeRetainedDocumentWindows(windows);
  expect(readRetainedDocumentWindows()).toEqual(windows);
  expect(new Set(windows.map(retainedDocumentPlacementKey)).size).toBe(3);
  writeRetainedDocumentWindows(windows.slice(1));
  expect(readRetainedDocumentWindows()).toEqual(windows.slice(1));
});
it("rejects malformed and remote document window records", () => {
  localStorage.setItem(
    "spec-harness:open-document-windows:v1",
    JSON.stringify({
      version: 1,
      windows: [
        null,
        {},
        { ...owner("D:/a", "a"), parentSessionId: 5 },
        {
          ...owner("D:/b", "b"),
          tab: {
            ...owner("D:/b", "b").tab,
            source: {
              type: "file",
              specDocument: true,
              path: "docs/a.md",
              workspaceRemoteSessionId: "remote",
            },
          },
        },
      ],
    }),
  );
  expect(readRetainedDocumentWindows()).toEqual([]);
});
it("Return addresses the source project, parent conversation and exact tab", () => {
  const observed: unknown[] = [];
  const listener = (event: Event) => observed.push((event as CustomEvent).detail);
  window.addEventListener(RETAINED_DOCUMENT_ACTIVATE_EVENT, listener);
  try {
    activateRetainedDocument(owner("D:/a", "parent-a"));
  } finally {
    window.removeEventListener(RETAINED_DOCUMENT_ACTIVATE_EVENT, listener);
  }
  expect(observed).toEqual([
    { workspacePath: "D:/a", sessionId: "parent-a", tabId: "doc-a", workspaceIdentity: undefined },
  ]);
});
it("isolates document view state while retaining legacy project/file drafts", () => {
  const projectKey = documentPresentationKey("D:/a");
  writeDocumentPresentation(projectKey, {
    ...defaultDocumentPresentation(),
    path: "docs/a.md",
    scrollTop: 42,
  });
  const keyA = projectKey + ":pane:a",
    keyB = projectKey + ":pane:b";
  expect(readDocumentPresentation(keyA, undefined, projectKey).scrollTop).toBe(42);
  writeDocumentPresentation(keyA, {
    ...defaultDocumentPresentation(),
    path: "docs/a.md",
    scrollTop: 123,
  });
  writeDocumentPresentation(keyB, {
    ...defaultDocumentPresentation(),
    path: "docs/b.md",
    scrollTop: 456,
  });
  writeDocumentDraft(projectKey, "docs/a.md", { content: "unsaved", baseSha256: "original" });
  expect(readDocumentPresentation(keyA).scrollTop).toBe(123);
  expect(readDocumentPresentation(keyB).scrollTop).toBe(456);
  expect(readDocumentDraft(projectKey, "docs/a.md")).toEqual({
    content: "unsaved",
    baseSha256: "original",
  });
});
it("cold start restores per-conversation side-pane selection and collapse preferences", () => {
  const a = owner("D:/a", "parent-a", "tab-a").tab;
  const b = owner("D:/a", "parent-b", "tab-b").tab;
  saveTaskSidePaneMemoryState("D:/a", {
    sidePaneState: { tabs: [a, b], activeTabId: a.id },
    isSidePaneCollapsed: true,
    sidePaneCollapsedByOwner: { "parent-a": true, "parent-b": false },
  });
  saveTaskSidePaneMemoryState("D:/a", { sidePaneState: { tabs: [a, b], activeTabId: b.id } });
  clearTaskSidePaneMemoryStateForTest();
  const restored = readTaskSidePaneMemoryState("D:/a");
  expect(getSidePaneActiveTabPreference(restored, "parent-a")).toBe(a.id);
  expect(getSidePaneActiveTabPreference(restored, "parent-b")).toBe(b.id);
  expect(getSidePaneCollapsedPreference(restored, "parent-a")).toBe(true);
  expect(getSidePaneCollapsedPreference(restored, "parent-b")).toBe(false);
  expect(restored.isSidePaneCollapsed).toBe(true);
});
