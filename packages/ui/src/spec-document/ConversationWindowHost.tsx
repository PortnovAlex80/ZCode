import { useCallback, useEffect, useMemo, useState } from "react";
import { XIcon } from "lucide-react";
import { useZCodeIntl as useIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { SubagentSessionSidePane } from "@/app-shell/SubagentSessionSidePane.js";
import { SubagentDirectorySidePane } from "@/app-shell/SubagentDirectorySidePane.js";
import { useServices } from "@/hooks/useServices.js";
import {
  createSubagentDirectorySidePaneTab,
  createSubagentSessionSidePaneTab,
  type OpenScopedSubagentDirectorySideTabRequest,
  type OpenScopedSubagentSideTabRequest,
  type SyncSubagentSessionTabsRequest,
} from "@/lib/workspaceSidePane.js";
import { V4PaneConversationProvider } from "@/v4/V4ConversationContext.js";
import { WorkbenchLeafPane, type WorkbenchShellBinding } from "@/v4/WorkbenchPane.js";
import { paneWorkspaceKey } from "@/v4/paneLayoutStore.js";
import { rectStyle } from "@/v4/workbenchLayout.js";
import { SpecPopoutRegionPortal, useSpecPopoutRegion } from "./specPopoutRegion.js";
import {
  bindConversationWindow,
  closeConversationWindow,
  registerConversationWindowFocus,
  useConversationWindows,
  type ConversationWindowEntry,
  conversationWindowKey,
} from "./conversationWindows.js";

const ACTIONS = [
  "onOpenBrowserUrl",
  "onOpenCodeViewer",
  "onOpenFileLink",
  "onOpenSelectionSideChat",
  "onOpenSubagentSession",
  "onOpenSubagentDirectory",
  "onOpenBackgroundBash",
  "onSyncSubagentSessionTabs",
  "onOpenPlanDetail",
  "onOpenWorkflowRun",
  "onOpenWorkflowArtifact",
  "onOpenWorkflowRunDirectory",
  "onOpenWorkflowActorSession",
  "onOpenWorkflowWorkspace",
  "onOpenAutomationsMain",
  "onAutoOpenAssistantPptx",
] as const;
export type ConversationWindowActions = Pick<WorkbenchShellBinding, (typeof ACTIONS)[number]>;
type RouteAction = (
  entry: ConversationWindowEntry,
  action: keyof ConversationWindowActions,
  args: unknown[],
) => void;

const RECT = { left: "0%", top: "0%", width: "100%", height: "100%" };
// VER-1 (2026-11-08 #7): while a subagent transcript leaf is open the primary
// conversation shrinks to a fixed 60/40 split. Percent rects keep the split
// intact at the window's 320x240 minimum size, so no resizable handle for v1.
const PRIMARY_WITH_SUBPANE_RECT = { left: "0%", top: "0%", width: "60%", height: "100%" };
const SUBPANE_RECT = { left: "60%", top: "0%", width: "40%", height: "100%" };

/**
 * Secondary leaf inside a detached conversation window. Opened by clicking a
 * subagent affordance (timeline agent row / status-panel running pill) in the
 * primary conversation; at most one leaf exists per window, so opening another
 * subagent (or the directory) replaces the content instead of stacking.
 */
type FloatingSubpaneState =
  | { kind: "session"; request: OpenScopedSubagentSideTabRequest }
  | { kind: "directory"; request: OpenScopedSubagentDirectorySideTabRequest };

export function AdmittedConversation({
  entry,
  routeAction,
}: {
  entry: ConversationWindowEntry;
  routeAction: RouteAction;
}) {
  const services = useServices();
  const { intl } = useIntl();
  const [admission, setAdmission] = useState<"waiting" | "ready" | "missing">("waiting");
  const [admissionError, setAdmissionError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    setAdmission("waiting");
    setAdmissionError(null);
    const agent = services.zcodeAgentService;
    if (!agent) return;
    let disposed = false;
    // Saved open windows are explicit history views. Passive sessions-index uses
    // existing-only and cannot bootstrap a cold runtime; a filtered durable list can, with
    // no create/resume command or model request, before mounting the composer.
    void agent
      .listSessions({
        ...entry.scope,
        sessionIds: [entry.sessionId],
        limit: 1,
      })
      .then((sessions) => {
        if (!disposed)
          setAdmission(
            sessions.some((session) => session.sessionId === entry.sessionId) ? "ready" : "missing",
          );
      })
      .catch((error: unknown) => {
        if (disposed) return;
        const message = error instanceof Error ? error.message : String(error);
        setAdmissionError(message);
        if (/session.*not.?found|session.*missing/i.test(message)) setAdmission("missing");
      });
    return () => {
      disposed = true;
    };
  }, [entry.scope, entry.sessionId, services, retry]);
  const binding = useMemo(
    () => ({ workspaceScope: entry.scope, sessionId: entry.sessionId, readOnly: entry.readOnly }),
    [entry.scope, entry.sessionId, entry.readOnly],
  );
  // VER-1 (2026-11-08 #7): subagent affordances stay inside this window. Routing
  // them to the main window used to hijack the active task and dead-end on the
  // detached-conversation guard screen.
  const [subpane, setSubpane] = useState<FloatingSubpaneState | null>(null);
  useEffect(() => {
    // A re-bound roster entry (draft -> first real session) invalidates every
    // transcript opened for the previous primary conversation.
    setSubpane(null);
  }, [entry.sessionId]);
  const handleOpenSubpaneSession = useCallback((request: OpenScopedSubagentSideTabRequest) => {
    setSubpane({ kind: "session", request });
  }, []);
  const handleWindowAction: RouteAction = useCallback(
    (entry, action, args) => {
      if (action === "onOpenSubagentSession") {
        handleOpenSubpaneSession(args[0] as OpenScopedSubagentSideTabRequest);
        return;
      }
      if (action === "onOpenSubagentDirectory") {
        setSubpane({
          kind: "directory",
          request: args[0] as OpenScopedSubagentDirectorySideTabRequest,
        });
        return;
      }
      if (action === "onSyncSubagentSessionTabs") {
        const request = args[0] as SyncSubagentSessionTabsRequest;
        // Mirror syncSubagentSessionSidePaneTabs: when the parent projection no
        // longer lists the displayed child (edit/retry invalidated it), the
        // transcript is stale and the leaf closes instead of showing dead content.
        setSubpane((current) =>
          current?.kind === "session" &&
          current.request.parentSessionId === request.parentSessionId &&
          (current.request.rootSessionId ?? current.request.parentSessionId) ===
            request.rootSessionId &&
          !request.validChildSessionIds.includes(current.request.childSessionId)
            ? null
            : current,
        );
        return;
      }
      routeAction(entry, action, args);
    },
    [handleOpenSubpaneSession, routeAction],
  );
  const shell = useMemo(
    () => ({
      ...entry.scope,
      sessionId: entry.sessionId,
      isDesktop: true,
      readOnly: entry.readOnly,
      ...(Object.fromEntries(
        ACTIONS.map((action) => [
          action,
          (...args: unknown[]) => handleWindowAction(entry, action, args),
        ]),
      ) as ConversationWindowActions),
      onSessionDeleted: () => closeConversationWindow(entry.id),
    }),
    [entry, handleWindowAction],
  );
  if (admission !== "ready")
    return (
      <div role="status" className="flex flex-col gap-3 p-4 text-ui-sm">
        {admission === "missing"
          ? intl.formatMessage({ id: "conversation.window.unavailable" })
          : intl.formatMessage({ id: "conversation.window.connecting" })}
        {admissionError ? (
          <>
            <p>{admissionError}</p>
            <Button variant="outline" onClick={() => setRetry((value) => value + 1)}>
              {intl.formatMessage({ id: "conversation.window.retryConnection" })}
            </Button>
          </>
        ) : null}
        <Button variant="outline" onClick={() => closeConversationWindow(entry.id)}>
          {intl.formatMessage({ id: "conversation.window.close" })}
        </Button>
      </div>
    );
  return (
    <>
      <WorkbenchLeafPane
        paneId={`floating-${entry.id}`}
        rect={subpane ? PRIMARY_WITH_SUBPANE_RECT : RECT}
        focused
        telemetryVisible
        presentationVisible
        showFocusIndicator={false}
        shellWorkspaceKey={paneWorkspaceKey(entry.scope)}
        binding={binding}
        shell={shell}
        onFocusRequest={() => {}}
        onClosePane={() => closeConversationWindow(entry.id)}
        onConfirmRestoredSession={() => {}}
        onBindSession={(_paneId, sessionId) => {
          bindConversationWindow(entry.id, sessionId);
          return false;
        }}
      />
      {subpane ? (
        <FloatingSubpaneLeaf
          entry={entry}
          subpane={subpane}
          onClose={() => setSubpane(null)}
          onOpenSubagentSession={handleOpenSubpaneSession}
          routeAction={routeAction}
        />
      ) : null}
    </>
  );
}

/**
 * Secondary read-only leaf rendered beside the primary conversation leaf.
 * Reuses the main-window side-pane compositions: SubagentSessionSidePane for a
 * subagent transcript, SubagentDirectorySidePane for the subagent directory.
 * Both are scope-only, so no main-window context is required.
 */
function FloatingSubpaneLeaf({
  entry,
  subpane,
  onClose,
  onOpenSubagentSession,
  routeAction,
}: {
  entry: ConversationWindowEntry;
  subpane: FloatingSubpaneState;
  onClose: () => void;
  onOpenSubagentSession: (request: OpenScopedSubagentSideTabRequest) => void;
  routeAction: RouteAction;
}) {
  const { intl } = useIntl();
  const workspaceKey =
    subpane.request.workspaceIdentity?.trim() || subpane.request.workspacePath;
  const sessionTab = useMemo(() => {
    if (subpane.kind !== "session") return null;
    const request = subpane.request;
    // Stable `floating-` pane id per window (keeps WorkbenchPane guards off);
    // the child identity lives in the React key, so replacing the session
    // remounts the pane with clean state instead of stacking panes.
    const tab = createSubagentSessionSidePaneTab({
      workspaceKey,
      workspacePath: request.workspacePath,
      ...(request.workspaceIdentity ? { workspaceIdentity: request.workspaceIdentity } : {}),
      ...(request.remoteSessionId ? { remoteSessionId: request.remoteSessionId } : {}),
      rootSessionId: request.rootSessionId,
      parentSessionId: request.parentSessionId,
      childSessionId: request.childSessionId,
      subagentType: request.subagentType,
      title: request.title,
    });
    return { ...tab, id: `floating-subagent-${entry.id}` };
  }, [entry.id, subpane, workspaceKey]);
  const directoryTab = useMemo(() => {
    if (subpane.kind !== "directory") return null;
    const request = subpane.request;
    const tab = createSubagentDirectorySidePaneTab({
      workspaceKey,
      workspacePath: request.workspacePath,
      ...(request.workspaceIdentity ? { workspaceIdentity: request.workspaceIdentity } : {}),
      ...(request.remoteSessionId ? { remoteSessionId: request.remoteSessionId } : {}),
      rootSessionId: request.rootSessionId,
      parentSessionId: request.parentSessionId,
    });
    return { ...tab, id: `floating-subagent-${entry.id}` };
  }, [entry.id, subpane, workspaceKey]);
  const title =
    subpane.kind === "session"
      ? sessionTab?.title
      : intl.formatMessage({ id: "subagentDirectory.title" });
  return (
    <div
      className="absolute inset-y-0 flex min-h-0 min-w-0 flex-col border-l border-border bg-background"
      style={rectStyle(SUBPANE_RECT)}
      data-floating-subagent-pane={entry.id}
    >
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border py-1 pl-3 pr-1.5">
        <span className="min-w-0 flex-1 truncate text-ui-sm font-medium text-foreground" title={title ?? undefined}>
          {title}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={intl.formatMessage({ id: "conversation.window.subagentPane.close" })}
          onClick={onClose}
        >
          <XIcon aria-hidden />
        </Button>
      </div>
      <div className="relative min-h-0 flex-1">
        {subpane.kind === "session" && sessionTab ? (
          <SubagentSessionSidePane
            key={subpane.request.childSessionId}
            tab={sessionTab}
            focused
            onOpenBrowserUrl={(url) => routeAction(entry, "onOpenBrowserUrl", [url])}
            onOpenCodeViewer={(source) => routeAction(entry, "onOpenCodeViewer", [source])}
            onOpenFileLink={(target) => routeAction(entry, "onOpenFileLink", [target])}
            onOpenBackgroundBash={(bashRequest) =>
              routeAction(entry, "onOpenBackgroundBash", [bashRequest])
            }
            onOpenSubagentSession={onOpenSubagentSession}
          />
        ) : subpane.kind === "directory" && directoryTab ? (
          <SubagentDirectorySidePane
            tab={directoryTab}
            onOpenSubagentSession={onOpenSubagentSession}
          />
        ) : null}
      </div>
    </div>
  );
}

function ConversationWindow({
  entry,
  onReturn,
  routeAction,
}: {
  entry: ConversationWindowEntry;
  onReturn: (entry: ConversationWindowEntry) => void;
  routeAction: RouteAction;
}) {
  const { intl } = useIntl();
  const region = useSpecPopoutRegion({
    regionId: `conversation-${entry.id}`,
    workspaceKey: paneWorkspaceKey(entry.scope),
    persistenceKey: `conversation:${entry.placementKey ?? conversationWindowKey(entry.scope, entry.sessionId)}`,
    title: entry.title,
    onReturn: () => {
      closeConversationWindow(entry.id);
      onReturn(entry);
    },
  });
  useEffect(
    () => registerConversationWindowFocus(entry.id, region.focus),
    [entry.id, region.focus],
  );
  useEffect(() => {
    region.open();
  }, [entry.id]); // Roster is the durable desired-open set.
  return (
    <div data-conversation-window={entry.sessionId} hidden={!region.lastError}>
      <div ref={region.anchorRef} />
      {region.lastError ? (
        <div role="alert" className="flex gap-2 p-2 text-ui-sm">
          {entry.title}: {region.lastError}
          <Button onClick={region.open}>
            {intl.formatMessage({ id: "conversation.window.retryOpening" })}
          </Button>
          <Button
            onClick={() => {
              closeConversationWindow(entry.id);
              onReturn(entry);
            }}
          >
            {intl.formatMessage({ id: "conversation.window.return" })}
          </Button>
        </div>
      ) : null}
      <SpecPopoutRegionPortal region={region} title={entry.title}>
        <div
          className="relative flex min-h-0 flex-1 flex-col"
          data-floating-session={entry.sessionId}
          data-floating-workspace={entry.scope.workspacePath}
        >
          <V4PaneConversationProvider scope={entry.scope}>
            <div className="relative min-h-0 flex-1">
              <AdmittedConversation entry={entry} routeAction={routeAction} />
            </div>
          </V4PaneConversationProvider>
        </div>
      </SpecPopoutRegionPortal>
    </div>
  );
}

export function ConversationWindows({
  onReturn,
  routeAction,
}: {
  onReturn: (entry: ConversationWindowEntry) => void;
  routeAction: RouteAction;
}) {
  const entries = useConversationWindows();
  return (
    <>
      {entries.map((entry) => (
        <ConversationWindow
          key={entry.id}
          entry={entry}
          onReturn={onReturn}
          routeAction={routeAction}
        />
      ))}
    </>
  );
}
