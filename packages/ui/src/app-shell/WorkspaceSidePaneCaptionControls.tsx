import { ArrowLeftRight } from "lucide-react";
import { DesktopWindowControls } from "@/DesktopWindowControls.js";
import { SidePaneFullViewToggleButton } from "@/side-pane-full-view/index.js";
import { WorkspaceSidePaneToggleButton } from "@/WorkspaceSidePaneToggleButton.js";
import { Button } from "@/components/ui/button.js";
import type { WorkspaceBodyRoleTogglePresentation } from "@/spec-document/workspacePanelRoles.js";

/**
 * U-04：tabs 容器 caption 右端的控制簇（紧邻窗口控件）。
 *
 * 修复原因：旧实现在此处并排三个语义随排列漂移的开关——方向随 documentCenter 切换的
 * 「恢复聊天」箭头、swap、固定右侧的面板开关（方向性开合图标）。用户 2026-10-14 反馈
 * 「тогглы панелей уже много и они сильно зависят от перемещения окон」。U-04 角色模型
 * 将它们收敛为两个与位置无关的控制：
 * - 角色开关（workspacePanelRoles.ts）：唯一入口，隐藏/恢复当前 AUXILIARY 区域，
 *   有区域被隐藏时优先恢复（U-05 restore-first）；
 * - swap：仅交换角色（ArrowLeftRight + 目标态标签），不改变任何显隐状态。
 * 文档头的 ⤢ 展开按钮与「恢复聊天」方向箭头均已并入角色开关。
 */
export function WorkspaceSidePaneCaptionControls({
  roleToggle,
  documentCenter,
  onToggleShellLayoutSwap,
  showWindowControls,
  fullViewToggle,
}: {
  roleToggle?: WorkspaceBodyRoleTogglePresentation | null;
  documentCenter: boolean;
  onToggleShellLayoutSwap?: () => void;
  showWindowControls?: boolean;
  /** Upstream 3.16.2 side-pane full view toggle; beside the role toggle. */
  fullViewToggle?: { active: boolean; onToggle: () => void; shortcutLabel?: string };
}) {
  if (!roleToggle && !onToggleShellLayoutSwap) return null;
  return (
    <div className="flex shrink-0 items-center gap-0.5 [app-region:no-drag]">
      {roleToggle ? (
        <WorkspaceSidePaneToggleButton
          isSidePaneOpen={!roleToggle.targetHidden}
          onToggleSidePane={roleToggle.onToggle}
          shortcutLabel={roleToggle.shortcutLabel}
          disabled={roleToggle.disabled}
        />
      ) : null}
      {onToggleShellLayoutSwap ? (
        <Button
          variant="ghost"
          size="icon-sm"
          data-spec-shell-layout-swap-toggle=""
          aria-pressed={documentCenter}
          aria-label={documentCenter ? "Чат в центре" : "Документ в центре"}
          title={documentCenter ? "Чат в центре" : "Документ в центре"}
          onClick={onToggleShellLayoutSwap}
        >
          <ArrowLeftRight className="size-4" />
        </Button>
      ) : null}
      {fullViewToggle ? (
        <SidePaneFullViewToggleButton
          active={fullViewToggle.active}
          onToggle={fullViewToggle.onToggle}
          shortcutLabel={fullViewToggle.shortcutLabel}
        />
      ) : null}
      {showWindowControls ? <DesktopWindowControls /> : null}
    </div>
  );
}
