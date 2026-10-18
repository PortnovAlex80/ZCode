import { useEffect, useMemo, useState } from "react";
import { useZCodeIntl as useIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { useServices } from "@/hooks/useServices.js";
import { V4PaneConversationProvider } from "@/v4/V4ConversationContext.js";
import { WorkbenchLeafPane, type WorkbenchShellBinding } from "@/v4/WorkbenchPane.js";
import { paneWorkspaceKey } from "@/v4/paneLayoutStore.js";
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
    void agent.listSessions({ ...entry.scope, sessionIds: [entry.sessionId], includeArchived: true, limit: 1 })
      .then(sessions => { if (!disposed) setAdmission(sessions.some(session => session.sessionId === entry.sessionId) ? "ready" : "missing"); })
      .catch((error: unknown) => {
        if (disposed) return;
        const message = error instanceof Error ? error.message : String(error);
        setAdmissionError(message);
        if (/session.*not.?found|session.*missing/i.test(message)) setAdmission("missing");
      });
    return () => { disposed = true; };
  }, [entry.scope, entry.sessionId, services, retry]);
  const binding = useMemo(
    () => ({ workspaceScope: entry.scope, sessionId: entry.sessionId, readOnly: entry.readOnly }),
    [entry.scope, entry.sessionId, entry.readOnly],
  );
  const shell = useMemo(
    () => ({
      ...entry.scope,
      sessionId: entry.sessionId,
      isDesktop: true,
      readOnly: entry.readOnly,
      ...(Object.fromEntries(
        ACTIONS.map((action) => [action, (...args: unknown[]) => routeAction(entry, action, args)]),
      ) as ConversationWindowActions),
      onSessionDeleted: () => closeConversationWindow(entry.id),
    }),
    [entry, routeAction],
  );
  if (admission !== "ready")
    return (
      <div role="status" className="flex flex-col gap-3 p-4 text-ui-sm">
        {admission === "missing"
          ? intl.formatMessage({ id: "conversation.window.unavailable" })
          : intl.formatMessage({ id: "conversation.window.connecting" })}
        {admissionError ? <><p>{admissionError}</p><Button variant="outline" onClick={() => setRetry(value => value + 1)}>{intl.formatMessage({ id: "conversation.window.retryConnection" })}</Button></> : null}
        <Button variant="outline" onClick={() => closeConversationWindow(entry.id)}>
          {intl.formatMessage({ id: "conversation.window.close" })}
        </Button>
      </div>
    );
  return (
    <WorkbenchLeafPane
      paneId={`floating-${entry.id}`}
      rect={RECT}
      focused
      telemetryVisible
      presentationVisible
      showFocusIndicator={false}
      canSplit={false}
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
          <Button onClick={region.open}>{intl.formatMessage({ id: "conversation.window.retryOpening" })}</Button>
          <Button onClick={() => { closeConversationWindow(entry.id); onReturn(entry); }}>{intl.formatMessage({ id: "conversation.window.return" })}</Button>
        </div>
      ) : null}
      <SpecPopoutRegionPortal region={region} title={entry.title}>
        <div
          className="relative flex min-h-0 flex-1 flex-col"
          data-floating-session={entry.sessionId}
          data-floating-workspace={entry.scope.workspacePath}
        >
          <V4PaneConversationProvider scope={entry.scope}>
            <AdmittedConversation entry={entry} routeAction={routeAction} />
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
