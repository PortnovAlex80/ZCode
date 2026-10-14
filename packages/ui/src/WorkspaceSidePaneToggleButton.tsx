import { TID_SIDE_PANE_TOGGLE } from "@zcode/shared";
import { Columns2 } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { WINDOWS_CAPTION_CONTROL_CLASS } from "@/windowCaptionControls.js";

/**
 * U-04 统一的角色切换按钮（«Скрыть/Показать боковую панель»）。
 *
 * 修复原因（用户 2026-10-14：「тогглы панелей уже много и они сильно зависят от
 * перемещения окон」）：旧实现用方向性开合图标（左/右开、左/右合四态）表达「右侧
 * 面板的开/关」，但交换排列（«Документ в центре»）会把聊天与 tabs 容器换位，固定
 * 右侧的图标语义随之失真。新模型按「角色」而不是「位置」表达：按钮永远作用于当前
 * 处于 AUXILIARY（右侧窄区）角色的区域（workspacePanelRoles.ts），因此这里改用与
 * 方向无关的 Columns2 图标——开/关状态只由 aria-label（sidePane.collapse/expand）
 * 表达，不再由图标形状或所在位置表达。
 *
 * 该组件同时服务两个 caption：tabs 容器 caption（角色开关本体）与聊天列 Header
 * （tabs 容器被隐藏时的常驻恢复入口，U-05）。
 */
export function WorkspaceSidePaneToggleButton({
  isSidePaneOpen,
  onToggleSidePane,
  shortcutLabel,
  useWindowsCaptionSpacing = false,
  disabled = false,
}: {
  isSidePaneOpen: boolean;
  onToggleSidePane: () => void;
  shortcutLabel?: string;
  useWindowsCaptionSpacing?: boolean;
  /** 目标区域当前无可隐藏/恢复动作时禁用（例如无活动文档时不能隐藏聊天列）。 */
  disabled?: boolean;
}) {
  const { intl } = useZCodeIntl();

  return (
    <ControlHintTooltip
      title={intl.formatMessage({ id: "sidePane.togglePanel" })}
      side="bottom"
      shortcut={shortcutLabel}
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-md"
        data-testid={TID_SIDE_PANE_TOGGLE}
        disabled={disabled}
        className={cn(
          "text-foreground hover:bg-hover hover:text-foreground [app-region:no-drag]",
          useWindowsCaptionSpacing && WINDOWS_CAPTION_CONTROL_CLASS,
          !disabled && isSidePaneOpen && "!bg-selected text-foreground",
        )}
        aria-label={intl.formatMessage({
          id: isSidePaneOpen ? "sidePane.collapse" : "sidePane.expand",
        })}
        onClick={onToggleSidePane}
      >
        {/* U-04：单一中性图标；开/关语义只走 aria-label，不随排列换位改变形状。 */}
        <Columns2 className="size-4" />
      </Button>
    </ControlHintTooltip>
  );
}
