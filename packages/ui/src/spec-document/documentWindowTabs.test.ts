import { expect, it } from "vitest";
import type {
  CodeViewerSidePaneTab,
  WorkspaceSidePaneState,
} from "@/lib/workspaceSidePane.js";
import { upsertDocumentWindowTab } from "./documentWindowTabs.js";
const tab = (
  id: string,
  path: string,
  owner: string,
): CodeViewerSidePaneTab => ({
  id,
  ownerTaskId: owner,
  type: "code-viewer",
  sourceKey: `file:${path}`,
  source: { type: "file", title: path, path, specDocument: true },
});
it("replays the detached latest document path while preserving other conversations and tab order", () => {
  const original = tab("original", "a.md", "first");
  const other = tab("other", "other.md", "second");
  const memory: WorkspaceSidePaneState = {
    tabs: [original, other],
    activeTabId: other.id,
  };
  const edited = tab(original.id, "b.md", "first");
  const background = upsertDocumentWindowTab(memory, edited, false);
  expect(background.tabs).toEqual([edited, other]);
  expect(background.activeTabId).toBe(other.id);
  const returned = upsertDocumentWindowTab(background, edited);
  expect(returned.tabs).toEqual([edited, other]);
  expect(returned.activeTabId).toBe(original.id);
  expect(memory.tabs).toEqual([original, other]);
});
it("returns a standalone document into an empty owner registry without changing its identity", () => {
  const standalone = tab("native-document", "b.md", "parent");
  const first = upsertDocumentWindowTab(null, standalone);
  expect(first).toEqual({ tabs: [standalone], activeTabId: standalone.id });
  expect(upsertDocumentWindowTab(first, standalone)).toEqual(first);
});
