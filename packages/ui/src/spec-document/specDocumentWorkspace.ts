import type { WorkspacePurpose } from "@zcode/shared";

/**
 * U-15（活体反馈 2026-10-14）：文档选择器的根必须是「对话所在项目」的 workspace，
 * 而不是 ZCODE 托管的对话后备 workspace（`~/.zcode/workspace/default`，用户视角的
 * 「ZCODE 启动目录」）。诊断结论：specDocumentService.list() 全链路收到的是外壳
 * 活跃 workspace tab 的路径；当桌面停在应用托管的对话 workspace（首次启动默认激活、
 * 恢复期 ensure 的那个）时，list/read/save 与 documentDisplayParts(workspaceRoot)
 * 都以该启动根为基准，而用户的项目在另一个文件夹——列表、展示与过滤全部指向错误
 * 的根。修复：在把 workspacePath 传下去之前，于宿主层解析一次「文档 workspace」——
 * 活跃 tab 本身是项目（或任何非 conversation 托管目录）时保持原值（现状语义不变，
 * 项目 tab 活跃时本来就正确）；只有活跃 tab 是 conversation 后备 workspace 时，才
 * 回落到同窗口里最近打开的本地项目 tab（tabs 顺序即侧栏顺序：新开的 workspace
 * 前插，最新在前）。没有本地项目 tab 时保持原值——不为「猜项目」发明新状态。
 *
 * 这是纯派生读取：workspace 事实的唯一所有者仍是 tab store；本模块不持有、不缓存
 * 任何状态，也不引入第二条写入路径。
 */
export interface SpecDocumentWorkspaceCandidate {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  remoteTarget?: unknown;
  workspacePurpose?: WorkspacePurpose;
  /** 恢复标记：目录已不存在（"unavailable-local-directory"）的项目不做候选。 */
  availability?: string;
}

export interface ResolvedSpecDocumentWorkspace {
  workspacePath: string;
  workspaceIdentity?: string;
}

function isLocalCandidate(tab: SpecDocumentWorkspaceCandidate): boolean {
  // spec 文档只存在于本地 host（服务端 desktopLocal 校验）；远程项目路径不能
  // 送给本机 specDocumentService，也不参与候选。目录已被移动/删除的恢复态 tab
  // 同样排除——根校验必然失败，不能让可用项目给它让位。
  return (
    !tab.workspaceIdentity?.trim() &&
    !tab.remoteSessionId?.trim() &&
    !tab.remoteTarget &&
    tab.availability !== "unavailable-local-directory"
  );
}

export function resolveSpecDocumentWorkspace({
  shellWorkspacePath,
  shellWorkspaceIdentity,
  workspaceTabs,
}: {
  shellWorkspacePath: string;
  shellWorkspaceIdentity?: string;
  workspaceTabs: readonly SpecDocumentWorkspaceCandidate[];
}): ResolvedSpecDocumentWorkspace {
  const shellTab = workspaceTabs.find((tab) => tab.workspacePath === shellWorkspacePath);
  // 活跃 workspace 本身不是应用托管的对话后备目录（项目 / 普通本地目录 / 远程）：
  // 文档根跟随活跃 workspace，保持既有语义与 identity 透传。
  if (shellTab?.workspacePurpose !== "conversation") {
    return {
      workspacePath: shellWorkspacePath,
      ...(shellWorkspaceIdentity?.trim() ? { workspaceIdentity: shellWorkspaceIdentity } : {}),
    };
  }
  // 活跃的是对话后备 workspace（启动根）：文档根改取同窗口最近打开的本地项目
  // workspace tab；找不到则维持启动根（显式降级，不猜、不造状态）。
  const projectTab = workspaceTabs.find(
    (tab) => isLocalCandidate(tab) && tab.workspacePurpose !== "conversation",
  );
  if (!projectTab) {
    return {
      workspacePath: shellWorkspacePath,
      ...(shellWorkspaceIdentity?.trim() ? { workspaceIdentity: shellWorkspaceIdentity } : {}),
    };
  }
  return {
    workspacePath: projectTab.workspacePath,
    ...(projectTab.workspaceIdentity?.trim()
      ? { workspaceIdentity: projectTab.workspaceIdentity }
      : {}),
  };
}
