import { useMemo } from "react";
import { effectiveFocusedPaneId, usePaneLayoutStore } from "@/v4/paneLayoutStore.js";
import { paneWorkspaceKey } from "@/v4/paneLayoutTree.js";
import {
  selectWorkbenchGroupActiveBinding,
  useWorkbenchGroupStore,
} from "@/v4/workbenchGroupStore.js";
import { resolveSpecDocumentWorkspace } from "./specDocumentWorkspace.js";

/** Read the same focused binding as V4WorkspaceChatArea, without another scope owner. */
export function useSpecDocumentWorkspace(
  input: Omit<Parameters<typeof resolveSpecDocumentWorkspace>[0], "focusedBinding">,
  compactForRemoteControl = false,
) {
  const groupBinding = useWorkbenchGroupStore((state) => {
    const group =
      !compactForRemoteControl && state.activeGroupId ? state.groups[state.activeGroupId] : null;
    return group ? selectWorkbenchGroupActiveBinding(group) : null;
  });
  const panes = usePaneLayoutStore((state) => state.panes);
  const focusedPaneId = usePaneLayoutStore(effectiveFocusedPaneId);
  const {
    shellWorkspacePath,
    shellWorkspaceIdentity,
    activeTaskId,
    activeTaskMeta,
    workspaceTabs,
  } = input;
  return useMemo(() => {
    const shellScope = {
      workspacePath: shellWorkspacePath,
      workspaceIdentity: shellWorkspaceIdentity,
    };
    const splitBinding = compactForRemoteControl ? null : (panes[focusedPaneId] ?? null);
    // Match V4WorkspaceChatArea: a session moved to a split leaves a primary draft.
    const primaryIsDraft =
      !compactForRemoteControl &&
      !groupBinding &&
      !splitBinding &&
      activeTaskId &&
      Object.values(panes).some(
        (binding) =>
          binding.sessionId === activeTaskId &&
          paneWorkspaceKey(binding.workspaceScope) === paneWorkspaceKey(shellScope),
      );
    return resolveSpecDocumentWorkspace({
      shellWorkspacePath,
      shellWorkspaceIdentity,
      activeTaskId,
      activeTaskMeta,
      workspaceTabs,
      focusedBinding:
        groupBinding ??
        splitBinding ??
        (primaryIsDraft ? { workspaceScope: shellScope, sessionId: null } : null),
    });
  }, [
    shellWorkspacePath,
    shellWorkspaceIdentity,
    activeTaskId,
    activeTaskMeta,
    workspaceTabs,
    groupBinding,
    panes,
    focusedPaneId,
    compactForRemoteControl,
  ]);
}
