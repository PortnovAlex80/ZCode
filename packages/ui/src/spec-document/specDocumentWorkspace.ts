import type { ZCodeTaskMeta, WorkspacePurpose } from "@zcode/shared";
import type { PaneBinding } from "@/v4/paneLayoutTree.js";

export interface SpecDocumentWorkspaceCandidate {
  workspacePath: string;
  workspaceIdentity?: string;
  workspacePurpose?: WorkspacePurpose;
}
export interface ResolvedSpecDocumentWorkspace {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId?: string | null;
}

/** U-15: document IO follows the selected conversation, never tab order or app cwd.
 * Layout bindings and task metadata remain the owners; this function only reads them.
 * Unknown/stale session metadata and remote scopes fail closed until resolved.
 */
export function resolveSpecDocumentWorkspace({
  shellWorkspacePath,
  shellWorkspaceIdentity,
  activeTaskId,
  activeTaskMeta,
  focusedBinding,
  workspaceTabs,
}: {
  shellWorkspacePath: string;
  shellWorkspaceIdentity?: string;
  activeTaskId: string | null;
  activeTaskMeta?: Pick<ZCodeTaskMeta, "taskId" | "workspacePath" | "workspaceIdentity"> | null;
  focusedBinding?: PaneBinding | null;
  workspaceTabs: readonly SpecDocumentWorkspaceCandidate[];
}): ResolvedSpecDocumentWorkspace | null {
  // 修复根因：最近打开的项目不代表当前会话；焦点 pane 的绑定优先于外壳选择。
  if (focusedBinding) {
    const scope = focusedBinding.workspaceScope;
    if (
      focusedBinding.restoredUnvalidated ||
      scope.remoteSessionId ||
      scope.workspaceIdentity?.trim()
    )
      return null;
    if (
      !focusedBinding.sessionId &&
      workspaceTabs.find((tab) => tab.workspacePath === scope.workspacePath)?.workspacePurpose ===
        "conversation"
    )
      return null;
    return scope.workspacePath.trim()
      ? { workspacePath: scope.workspacePath, sessionId: focusedBinding.sessionId }
      : null;
  }
  if (activeTaskId) {
    if (activeTaskMeta?.taskId !== activeTaskId || activeTaskMeta.workspaceIdentity?.trim())
      return null;
    return activeTaskMeta.workspacePath.trim()
      ? { workspacePath: activeTaskMeta.workspacePath, sessionId: activeTaskId }
      : null;
  }
  // A draft has no session metadata yet. Only its explicitly selected local project
  // may supply files; a managed conversation/scratch root is not a project fallback.
  const shellTab = workspaceTabs.find((tab) => tab.workspacePath === shellWorkspacePath);
  if (shellWorkspaceIdentity?.trim() || shellTab?.workspacePurpose === "conversation") return null;
  return shellWorkspacePath.trim() ? { workspacePath: shellWorkspacePath, sessionId: null } : null;
}
