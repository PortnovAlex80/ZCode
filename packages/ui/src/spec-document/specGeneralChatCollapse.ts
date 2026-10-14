/** Local presentation state; native conversation/session ownership never changes. */
export interface SpecGeneralChatContext {
  workspaceKey: string;
  documentActive: boolean;
  sidePaneOpen: boolean;
  workspaceMainView: string;
}

export function canCollapseSpecGeneralChat(
  context: SpecGeneralChatContext,
): boolean {
  return (
    context.documentActive &&
    context.sidePaneOpen &&
    context.workspaceMainView === "chat"
  );
}

export function resolveSpecGeneralChatCollapsed(
  requestedWorkspaceKey: string | null,
  context: SpecGeneralChatContext,
): boolean {
  return (
    requestedWorkspaceKey === context.workspaceKey &&
    canCollapseSpecGeneralChat(context)
  );
}

export function toggleSpecGeneralChatCollapse(
  requestedWorkspaceKey: string | null,
  context: SpecGeneralChatContext,
): string | null {
  if (!canCollapseSpecGeneralChat(context)) return null;
  return requestedWorkspaceKey === context.workspaceKey
    ? null
    : context.workspaceKey;
}

/** Spec-only panel sizes never overwrite the ordinary ZCODE workspace layout preference. */
export function specGeneralChatLayoutId(
  workspaceKey: string,
  documentActive: boolean,
): string {
  return documentActive
    ? `spec-harness:workspace-body-layout:${encodeURIComponent(workspaceKey)}`
    : "workspace-body-layout";
}

export interface SpecGeneralChatLayoutMemory {
  workspaceKey: string | null;
  ordinaryLayout: Record<string, number> | null;
}

/** Restore before changing persistence namespace: Group keeps same-panel layouts internally. */
export function transitionSpecGeneralChatLayout(
  group: {
    getLayout(): Record<string, number>;
    setLayout(layout: Record<string, number>): unknown;
  } | null,
  activeWorkspaceKey: string | null,
  memory: SpecGeneralChatLayoutMemory,
  columnMemory: { expandedSize: number | null },
): void {
  if (memory.workspaceKey === activeWorkspaceKey) return;
  if (memory.ordinaryLayout && group) {
    group.setLayout(
      rekeyLayoutToCurrentPanelOrder(group, memory.ordinaryLayout),
    );
    columnMemory.expandedSize = null;
  }
  const ordinaryLayout = activeWorkspaceKey && group ? group.getLayout() : null;
  memory.ordinaryLayout =
    ordinaryLayout && Object.keys(ordinaryLayout).length
      ? { ...ordinaryLayout }
      : null;
  memory.workspaceKey = activeWorkspaceKey;
}

/**
 * 修复依据（U-03 5.2a 实机回归，用户 2026-10-14 报告：交换排列后中部分隔条
 * 方向颠倒）：react-resizable-panels 的布局对象虽然按 panelId 键控，但内部的
 * pivot/约束计算（adjustLayoutByDelta）按「值的顺序」（Object.values）取下标，
 * 该顺序必须与当前面板注册表（视觉顺序）一致。ordinaryLayout 是在旧排列下
 * 捕获的，用户可能在文档激活期间交换了排列（swap 控制就在 tabs 容器 caption
 * 上），恢复时的 key 顺序已与当前注册表相反；直接 setLayout 会把尺寸装进
 * 错误的槽位——此后拖拽、键盘与命令式 resize 的方向全部颠倒（wave-6 的
 * order 渲染期重申只保证注册表排序正确，救不了已错位的布局槽位）。
 * 恢复前先按当前布局的 key 顺序（== 当前注册表顺序）重排，保证
 * 「值的位置 == 当前面板顺序」。组尚不可见（defaultLayoutDeferred）时
 * getLayout 返回空对象且 setLayout 不会提交，原样返回即可。
 */
function rekeyLayoutToCurrentPanelOrder(
  group: { getLayout(): Record<string, number> },
  savedLayout: Record<string, number>,
): Record<string, number> {
  const currentKeyOrder = Object.keys(group.getLayout());
  if (
    !currentKeyOrder.length ||
    currentKeyOrder.length !== Object.keys(savedLayout).length
  ) {
    return savedLayout;
  }
  const rekeyed: Record<string, number> = {};
  for (const panelId of currentKeyOrder) {
    const size = savedLayout[panelId];
    // 键集合应当一致（同一组面板，只是顺序不同）；不一致时保守原样返回，不猜槽位。
    if (size === undefined) return savedLayout;
    rekeyed[panelId] = size;
  }
  return rekeyed;
}

export function specGeneralChatLeafPresentation(options: {
  selected: boolean;
  foregroundEnabled: boolean;
  interactionDialogsVisible: boolean;
  keepSpecExecutionSource: boolean;
}) {
  return {
    focused: options.selected && options.foregroundEnabled,
    telemetryVisible: options.foregroundEnabled,
    interactionDialogsVisible: options.interactionDialogsVisible,
    keepSpecExecutionSource:
      options.selected && options.keepSpecExecutionSource,
  };
}

export interface SpecGeneralChatColumn {
  collapse(): void;
  expand(): void;
  isCollapsed(): boolean;
  getSize(): { asPercentage: number };
  resize(size: string): void;
}

export function applySpecGeneralChatColumn(
  panel: SpecGeneralChatColumn,
  collapsed: boolean,
  memory: { expandedSize: number | null },
): void {
  if (collapsed) {
    if (!panel.isCollapsed()) {
      const size = panel.getSize().asPercentage;
      memory.expandedSize = Number.isFinite(size) && size > 0 ? size : null;
      panel.collapse();
    }
  } else if (memory.expandedSize !== null) {
    panel.resize(`${memory.expandedSize}%`);
    memory.expandedSize = null;
  } else if (panel.isCollapsed()) panel.expand();
}
