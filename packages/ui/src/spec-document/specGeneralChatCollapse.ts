/** Local presentation state; native conversation/session ownership never changes. */
export interface SpecGeneralChatContext {
  workspaceKey: string;
  documentActive: boolean;
  sidePaneOpen: boolean;
  workspaceMainView: string;
}

export function canCollapseSpecGeneralChat(context: SpecGeneralChatContext): boolean {
  return context.documentActive && context.sidePaneOpen && context.workspaceMainView === "chat";
}

export function resolveSpecGeneralChatCollapsed(
  requestedWorkspaceKey: string | null,
  context: SpecGeneralChatContext,
): boolean {
  return requestedWorkspaceKey === context.workspaceKey && canCollapseSpecGeneralChat(context);
}

export function toggleSpecGeneralChatCollapse(
  requestedWorkspaceKey: string | null,
  context: SpecGeneralChatContext,
): string | null {
  if (!canCollapseSpecGeneralChat(context)) return null;
  return requestedWorkspaceKey === context.workspaceKey ? null : context.workspaceKey;
}

/** Spec-only panel sizes never overwrite the ordinary ZCODE workspace layout preference. */
export function specGeneralChatLayoutId(workspaceKey: string, documentActive: boolean): string {
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
    group.setLayout(memory.ordinaryLayout);
    columnMemory.expandedSize = null;
  }
  const ordinaryLayout = activeWorkspaceKey && group ? group.getLayout() : null;
  memory.ordinaryLayout =
    ordinaryLayout && Object.keys(ordinaryLayout).length ? { ...ordinaryLayout } : null;
  memory.workspaceKey = activeWorkspaceKey;
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
    keepSpecExecutionSource: options.selected && options.keepSpecExecutionSource,
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
