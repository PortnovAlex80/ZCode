import type {
  CodeViewerSidePaneTab,
  WorkspaceSidePaneState,
} from "@/lib/workspaceSidePane.js";

/** Return/replay replaces one addressed descriptor without reordering other owners. */
export function upsertDocumentWindowTab(
  current: WorkspaceSidePaneState | null,
  tab: CodeViewerSidePaneTab,
  activate = true,
): WorkspaceSidePaneState {
  const exists = current?.tabs.some((candidate) => candidate.id === tab.id);
  return {
    tabs: exists
      ? current!.tabs.map((candidate) =>
          candidate.id === tab.id ? tab : candidate,
        )
      : [...(current?.tabs ?? []), tab],
    activeTabId: activate ? tab.id : (current?.activeTabId ?? tab.id),
  };
}
