/**
 * U-04 角色模型（用户 2026-10-14 精化）：工作区主体的两个区域——聊天列（general-chat）
 * 与 tabs 容器（side-pane）——在任一排列下各自承担一个「角色」：
 *
 * | 排列            | PRIMARY（中心、宽） | AUXILIARY（右侧、窄） |
 * | --------------- | -------------------- | ---------------------- |
 * | chat-center     | 聊天列               | tabs 容器              |
 * | document-center | tabs 容器            | 聊天列                 |
 *
 * 交换（swap）交换的是「角色」而不是可见性：区域在角色互换时保留自己的显隐状态
 * （generalChatCollapsed 与 side pane 可见性各自仍是唯一事实来源）。
 * 唯一的角色切换按钮「Скрыть/Показать боковую панель」隐藏/恢复的是「当前处于
 * AUXILIARY 角色的区域」；AUXILIARY 被隐藏时 PRIMARY 铺满整宽（与角色无关的统一规则）。
 *
 * U-05（无死布局）：某个区域被隐藏时，角色按钮优先承担「恢复被隐藏区域」的职责
 * （restore-first）。这是因为 PRIMARY 自身也可能处于隐藏态（交换保留可见性所致，
 * 例如 document-center 隐藏聊天后 swap 回 chat-center），此时 PRIMARY 的 caption
 * 已不可达，若按钮仍指向（可见的）AUXILIARY 并把它也藏掉，就需要再靠 swap 两步
 * 才能找回界面。restore-first 保证任意可达组合下每个被隐藏区域都有一键恢复入口，
 * 且窗口控件永远落在可见区域的 caption 上。
 *
 * 注意：聊天与 tabs 容器不可能同时隐藏——resolveSpecGeneralChatCollapsed 在
 * side pane 关闭时强制还原聊天（specGeneralChatCollapse.ts），本模块对同时隐藏的
 * 输入同样以聊天为准恢复，保持确定性。
 */

/** 工作区主体的两个区域。 */
export type WorkspaceBodyRegion = "general-chat" | "side-pane";

export interface WorkspaceBodyRoleStateInput {
  /** 当前排列是否为 «Документ в центре»（swap 已交换角色）。 */
  documentCenter: boolean;
  /** tabs 容器（右侧面板）逻辑可见性。 */
  sidePaneVisible: boolean;
  /** 聊天列逻辑可见性（generalChatCollapsed 取反）。 */
  generalChatCollapsed: boolean;
}

export interface WorkspaceBodyRoleState {
  primary: WorkspaceBodyRegion;
  auxiliary: WorkspaceBodyRegion;
  /** 当前被隐藏的区域；两者不可能同时隐藏（见文件头注释）。 */
  hiddenRegion: WorkspaceBodyRegion | null;
  /** 角色按钮的目标区域：有隐藏区域时优先恢复它（U-05），否则指向 AUXILIARY。 */
  roleToggleTarget: WorkspaceBodyRegion;
  /** 角色按钮目标是否处于隐藏态（决定 «Показать» / «Скрыть» 标签分支）。 */
  roleToggleTargetHidden: boolean;
  /** PRIMARY 自身是否被隐藏（此时其 caption 不可达，恢复入口由存活 caption 承担）。 */
  primaryHidden: boolean;
}

export function resolveWorkspaceBodyRoleState(
  input: WorkspaceBodyRoleStateInput,
): WorkspaceBodyRoleState {
  const primary: WorkspaceBodyRegion = input.documentCenter
    ? "side-pane"
    : "general-chat";
  const auxiliary: WorkspaceBodyRegion = input.documentCenter
    ? "general-chat"
    : "side-pane";
  const hiddenRegion: WorkspaceBodyRegion | null = input.generalChatCollapsed
    ? "general-chat"
    : input.sidePaneVisible
      ? null
      : "side-pane";
  const roleToggleTarget = hiddenRegion ?? auxiliary;
  return {
    primary,
    auxiliary,
    hiddenRegion,
    roleToggleTarget,
    roleToggleTargetHidden: hiddenRegion !== null,
    primaryHidden: hiddenRegion === primary,
  };
}

/** tabs 容器 caption 上角色按钮的呈现契约（宿主 WorkspaceShellLayout 计算并下发）。 */
export interface WorkspaceBodyRoleTogglePresentation {
  /** 目标区域当前可见 ⇒ 按钮标签为 «Скрыть»；隐藏 ⇒ «Показать»。 */
  targetHidden: boolean;
  /** 角色正确的动作：指向当前 AUXILIARY（或恢复被隐藏区域）的唯一入口。 */
  onToggle: () => void;
  /** 目标为聊天且当前无可折叠条件（无活动文档）时禁用，避免点击无反馈的假开关。 */
  disabled: boolean;
  /** 仅当动作等价于 side pane 快捷键入口时透出快捷键提示，防止提示与行为漂移。 */
  shortcutLabel?: string;
}
