import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { toast } from "@/components/ui/toast.js";
import { TaskActionMenuContent } from "@/TaskActionMenuContent.js";

export function TaskListItemContextMenu({
  intl,
  workspacePath,
  localProject = true,
  isPinned,
  fileManagerLabel,
  taskSessionFile,
  activeSessionId,
  taskNativeSessionLogFile,
  providerConfigFile,
  onTogglePinTask,
  onStartRenameTask,
  onArchiveTask,
  onMarkTaskAsUnread,
  onOpenInSplitPane,
  openInSplitPaneDisabled,
  onOpenTaskFeedback,
  onOpenTaskPathInFileManager,
  onCopyWorkspacePath,
  onCopyTaskPath,
  onCopyTaskLogPath,
  onCopySessionId,
  onViewModelTrajectory,
  onOpenProviderConfig,
  disableTaskActions = false,
  disabledReason,
}: {
  workspacePath?: string;
  localProject?: boolean;
  intl: {
    formatMessage: (desc: { id: string }, values?: Record<string, string>) => string;
  };
  isPinned: boolean;
  fileManagerLabel: string;
  taskSessionFile: { loading: boolean; path: string | null; exists: boolean };
  activeSessionId?: string | null;
  taskNativeSessionLogFile: {
    loading: boolean;
    path: string | null;
    exists: boolean;
  };
  providerConfigFile: { loading: boolean; path: string | null; exists: boolean };
  onTogglePinTask: () => void;
  onStartRenameTask: () => void;
  onArchiveTask: () => void;
  onMarkTaskAsUnread: () => void;
  /** 「在分屏打开」（仅桌面 shell 传入）。 */
  onOpenInSplitPane?: () => void;
  /** 叶子数达上限且该 session 未在任何 pane 时禁用。 */
  openInSplitPaneDisabled?: boolean;
  onOpenTaskFeedback: () => void;
  onOpenTaskPathInFileManager: () => void;
  onCopyWorkspacePath: () => void;
  onCopyTaskPath: () => void;
  onCopyTaskLogPath: () => void;
  onCopySessionId?: () => void;
  onViewModelTrajectory?: () => void;
  onOpenProviderConfig: () => void;
  disableTaskActions?: boolean;
  disabledReason?: string;
}) {
  const platform = usePlatform();
  return (
    <ContextMenuContent className="w-52">
      {platform.openProjectWindow && workspacePath && localProject && (
        <ContextMenuItem
          disabled={disableTaskActions || !activeSessionId}
          onSelect={() => {
            void platform.openProjectWindow!({
              workspacePath,
              taskId: activeSessionId || undefined,
            }).catch((error) => toast(String(error)));
          }}
        >
          Open conversation in window
        </ContextMenuItem>
      )}
      <TaskActionMenuContent
        intl={intl}
        isPinned={isPinned}
        fileManagerLabel={fileManagerLabel}
        taskSessionFile={taskSessionFile}
        activeSessionId={activeSessionId}
        taskNativeSessionLogFile={taskNativeSessionLogFile}
        providerConfigFile={providerConfigFile}
        Item={ContextMenuItem}
        Separator={ContextMenuSeparator}
        onTogglePinTask={onTogglePinTask}
        onStartRenameTask={onStartRenameTask}
        onArchiveTask={onArchiveTask}
        onMarkTaskAsUnread={onMarkTaskAsUnread}
        onOpenInSplitPane={onOpenInSplitPane}
        openInSplitPaneDisabled={openInSplitPaneDisabled}
        onOpenTaskFeedback={onOpenTaskFeedback}
        onOpenTaskPathInFileManager={onOpenTaskPathInFileManager}
        onCopyWorkspacePath={onCopyWorkspacePath}
        onCopyTaskPath={onCopyTaskPath}
        onCopyTaskLogPath={onCopyTaskLogPath}
        onCopySessionId={onCopySessionId}
        onViewModelTrajectory={onViewModelTrajectory}
        onOpenProviderConfig={onOpenProviderConfig}
        disableTaskActions={disableTaskActions}
        disabledReason={disabledReason}
      />
    </ContextMenuContent>
  );
}
