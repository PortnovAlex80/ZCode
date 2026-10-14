/**
 * 渲染性能复核 #2 发现 2：讨论可见性的结构化判定。
 *
 * 规则（防回归的形态约束）：「激活线程身份」只能出现在合取（AND）里，绝不与
 * 放置方式（popout/PiP/inline）做或（OR）——owner 侧曾经写成
 * `popout || (visible && discussionsVisible && isActiveThread)`，导致 popout 打开时
 * 所有保留线程（含隐藏的未发送草稿）都被判为可见，进而误触发展示派生、
 * foreground telemetry、interactionDialogsVisible 与 useSpecDiscussion 的可见期
 * 原生准备（会为隐藏草稿建 session）。
 *
 * 调用方约定：
 * - hostVisible 必须取自「实际承载讨论的宿主」的可见性：inline 布局取文档面板
 *   可见性；popout/PiP 取该独立窗口文档的可见性（per-realm document）。
 * - 放置方式只决定 hostVisible 的来源，不参与 OR；切线程/返回（popout 关闭回
 *   inline）只是输入变化，本函数保持纯判定。
 */
export interface SpecDiscussionThreadPresentationInput {
  /** 实际承载该讨论的宿主（文档面板或 popout 文档）当前可见。 */
  hostVisible: boolean;
  /** 讨论分区展开。 */
  discussionsVisible: boolean;
  /** 该线程是当前选中（激活）线程；只有激活线程可能被展示。 */
  isActiveThread: boolean;
}

export function isSpecDiscussionThreadPresented(
  input: SpecDiscussionThreadPresentationInput,
): boolean {
  if (!input.hostVisible) return false;
  if (!input.discussionsVisible) return false;
  return input.isActiveThread;
}
