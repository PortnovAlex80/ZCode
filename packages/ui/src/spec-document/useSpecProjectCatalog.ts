import { useEffect } from "react";
import type { StoreApi } from "zustand";
import { isWorkspaceTab, type TabStoreState } from "@/store/tabStore.js";
import { readWorkspaceExpansionState } from "@/lib/workspaceExpansionPreference.js";

function localPaths(state: TabStoreState): string[] {
  return state.tabs
    .filter(isWorkspaceTab)
    .filter((tab) => !tab.remoteSessionId && !tab.remoteTarget)
    .map((tab) => tab.workspacePath);
}
/** Share project membership, while active chat, panel layout and focus remain window-local. */
export function useSpecProjectCatalog(store: StoreApi<TabStoreState>, enabled: boolean) {
  useEffect(() => {
    if (!enabled || typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel("spec-harness:project-catalog:v1");
    let previous = localPaths(store.getState());
    let applying = false;
    const unsubscribe = store.subscribe((state) => {
      const next = localPaths(state);
      if (!applying) {
        for (const path of next)
          if (!previous.includes(path)) channel.postMessage({ type: "add", path });
        for (const path of previous)
          if (!next.includes(path)) channel.postMessage({ type: "remove", path });
      }
      previous = next;
    });
    channel.onmessage = ({ data }) => {
      if (data?.type === "request") {
        channel.postMessage({ type: "snapshot", paths: localPaths(store.getState()) });
        return;
      }
      const paths =
        data?.type === "snapshot" && Array.isArray(data.paths)
          ? data.paths.slice(0, 100)
          : [data?.path];
      applying = true;
      try {
        for (const path of paths) {
          if (typeof path !== "string" || !/^(?:[a-z]:[\\/]|\/)/i.test(path) || path.length > 4096)
            continue;
          const state = store.getState();
          if (data.type === "add" || data.type === "snapshot") {
            // Catalog membership must not reopen a project the receiving window collapsed.
            if (localPaths(state).includes(path)) continue;
            const rememberedCollapsed = readWorkspaceExpansionState()[path] === false;
            state.ensureWorkspaceTab(path);
            // Native ensure expands new tabs; restore this project's saved choice only.
            if (rememberedCollapsed && store.getState().expandedWorkspacePaths.has(path)) {
              store.getState().toggleWorkspaceExpanded(path);
            }
          } else if (data.type === "remove") {
            const tab = state.tabs.find(
              (tab) => isWorkspaceTab(tab) && !tab.remoteTarget && tab.workspacePath === path,
            );
            if (tab) state.closeTab(tab.id);
          }
        }
      } finally {
        applying = false;
        previous = localPaths(store.getState());
      }
    };
    channel.postMessage({ type: "request" });
    return () => {
      unsubscribe();
      channel.close();
    };
  }, [store, enabled]);
}
