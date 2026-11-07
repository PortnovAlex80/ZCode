import { memo, useCallback, useMemo } from "react";
import { AppWindow } from "lucide-react";
import type { MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import { Button } from "@/components/ui/button.js";
import { useOptionalZCodeIntl } from "@/i18n/IntlProvider.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import { getPathLeaf } from "@/lib/path.js";
import type { SelectionSideChatPaneTab } from "@/lib/workspaceSidePane.js";
import type { PaneWorkspaceScope } from "@/v4/paneLayoutStore.js";
import { SessionPane } from "@/v4/SessionPane.js";
import { V4PaneConversationProvider } from "@/v4/V4ConversationContext.js";
import {
  findConversationWindow,
  focusConversationWindow,
  openConversationWindow,
  useConversationWindows,
} from "@/spec-document/conversationWindows.js";

export const SelectionSideChatPane = memo(function SelectionSideChatPane({
  tab,
  focused,
  onOpenBrowserUrl,
  onOpenCodeViewer,
  onOpenFileLink,
  onUnavailable,
}: {
  tab: SelectionSideChatPaneTab;
  focused: boolean;
  onOpenBrowserUrl?: (url: string) => void;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onUnavailable: (tabId: string) => void;
}) {
  const platform = useOptionalPlatform();
  // Same optional-intl pattern as the discussion pane: hosts without a provider
  // get the en-US fallback instead of a crash.
  const intl = useOptionalZCodeIntl()?.intl;
  const message = (id: string, fallback: string) =>
    intl ? intl.formatMessage({ id }) : fallback;
  const rosterEntries = useConversationWindows();
  const scope = useMemo<PaneWorkspaceScope>(
    () => ({
      workspacePath: tab.workspacePath,
      ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
      ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
    }),
    [tab.remoteSessionId, tab.workspaceIdentity, tab.workspacePath],
  );
  // Detach-to-window (2026-11-07 #5 option C): while a conversation window hosts
  // this child session, the side tab yields to a focus guard instead of mounting
  // a second interactive composer on the same native session. Closing that
  // window removes the roster entry and the live pane returns.
  const detachedEntry = useMemo(
    () => findConversationWindow(scope, tab.childSessionId),
    [rosterEntries, scope, tab.childSessionId],
  );
  // 父级 tabs.map 原来为每个 memo pane 创建内联闭包，任意父级渲染都会
  // 破坏 onUnavailable 引用稳定性；由叶子按稳定 tab id 收口回调。
  const handleUnavailable = useCallback(() => onUnavailable(tab.id), [onUnavailable, tab.id]);
  const nativeWindows = Boolean(platform?.openConversationPopout);
  const openInWindow = () => {
    // Roster dedupe makes this idempotent: an existing window is focused.
    openConversationWindow(
      scope,
      tab.childSessionId,
      `${getPathLeaf(tab.workspacePath)} — ${message("sidePane.selectionChat", "Selection chat")}`,
    );
  };
  return (
    <V4PaneConversationProvider scope={scope}>
      <div className="relative flex min-h-0 flex-1 flex-col">
        {detachedEntry ? (
          <div
            className="flex flex-col items-start gap-3 p-4 text-ui-sm"
            data-detached-session-guard={tab.childSessionId}
          >
            <p>
              {message(
                "conversation.window.detached",
                "This conversation is open in a separate window.",
              )}
            </p>
            <Button
              variant="outline"
              onClick={() => focusConversationWindow(detachedEntry.id)}
            >
              {message("conversation.window.show", "Show conversation window")}
            </Button>
          </div>
        ) : (
          <SessionPane
            paneId={tab.id}
            sessionId={tab.childSessionId}
            rootSessionId={tab.parentSessionId}
            openTrigger="selection"
            selectionSideChat
            focused={focused}
            telemetryVisible={focused}
            /* force-mounted 侧栏 tab 的 focused = 「面板可见且本 tab 激活」，恰为展示可见性；
               与 SessionPane.focused（快捷键路由）数值相同但语义独立，Wave A 起显式分开传递。 */
            presentationVisible={focused}
            workspacePath={tab.workspacePath}
            workspaceIdentity={tab.workspaceIdentity}
            remoteSessionId={tab.remoteSessionId}
            onOpenBrowserUrl={onOpenBrowserUrl}
            onOpenCodeViewer={onOpenCodeViewer}
            onOpenFileLink={onOpenFileLink}
            onSelectionSideChatUnavailable={handleUnavailable}
          />
        )}
        {nativeWindows ? (
          <div className="absolute right-2 top-2 z-30 flex items-center">
            <Button
              variant="ghost"
              size="icon-sm"
              className="bg-background/80 backdrop-blur-sm"
              aria-label={message("sideChat.openInWindow", "Open side chat in window")}
              title={message("sideChat.openInWindow", "Open side chat in window")}
              data-selection-side-chat-window-control={tab.childSessionId}
              onClick={openInWindow}
            >
              <AppWindow />
            </Button>
          </div>
        ) : null}
      </div>
    </V4PaneConversationProvider>
  );
});
