import { AssistantCodeCommentFeatureProvider } from "@/AssistantCodeCommentFeatureProvider.js";
import { flushSync } from "react-dom";
import { CodingPlanUpgradeDialogProvider } from "@/settings/CodingPlanUpgradeDialogProvider.js";
import { useTheme } from "@/useTheme.js";
import { Component, useEffect, useState, type ReactNode } from "react";
import type { IServiceAccessor } from "@zcode/services";
import type { IPlatformService } from "@zcode/shared";
import { ServiceProvider } from "@/hooks/useServices.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { StoreProvider } from "@/store/StoreProvider.js";
import { TabStoreProvider } from "@/store/TabStoreProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { DiffsWorkerPoolProvider } from "@/root/DiffsWorkerPoolProvider.js";
import { SessionPane } from "@/v4/SessionPane.js";
import { V4PaneConversationProvider } from "@/v4/V4ConversationContext.js";
import { SpecDocumentPane } from "./SpecDocumentPane.js";
import {
  afterPanelCleanup,
  observePanelComposition,
  specWindowBridge,
  type PanelTransfer,
  type SpecWindowBridge,
} from "./specWindowBridge.js";

class PanelFailureBoundary extends Component<
  { transferId: string; bridge?: SpecWindowBridge; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.bridge?.specPanelAck("failed", { transferId: this.props.transferId });
  }
  render() {
    return this.state.failed ? (
      <p role="alert">Panel failed; returning to the original window.</p>
    ) : (
      this.props.children
    );
  }
}

export function SpecDetachedPanelRoot({
  services,
  platform,
}: {
  services: IServiceAccessor;
  platform: IPlatformService;
}) {
  useTheme();
  useEffect(observePanelComposition, []);
  const [transfer, setTransfer] = useState<PanelTransfer | null>(null);
  const [quiescing, setQuiescing] = useState(false);
  const [committed, setCommitted] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const bridge = specWindowBridge(platform);
    if (!bridge) return;
    let live = true;
    const offs = [
      bridge.onSpecPanelEvent("reattach-prepare", (value) => {
        if (
          document.documentElement.dataset.specComposing === "true" ||
          document.querySelector('[data-spec-upload-pending="true"]')
        ) {
          setError("Finish text composition or remove attachments before returning this panel.");
          bridge.specPanelAck("failed", { transferId: value.transferId });
          return;
        }
        flushSync(() => setQuiescing(true));
        void afterPanelCleanup().then(() =>
          bridge.specPanelAck("reattach-quiesced", { transferId: value.transferId }),
        );
      }),
      bridge.onSpecPanelEvent("reattach-rollback", (value) => {
        setQuiescing(false);
        setError(value.reason || "Return failed.");
      }),
    ];
    void bridge
      .specPanelAction("state")
      .then((value) => {
        if (live) setTransfer(value as PanelTransfer);
      })
      .catch((cause) => setError(String(cause)));
    return () => {
      live = false;
      offs.forEach((off) => off());
    };
  }, [platform]);
  useEffect(() => {
    if (!transfer || quiescing) return;
    const bridge = specWindowBridge(platform);
    if (!bridge) return;
    let live = true;
    // Subscribe before ACK; one snapshot handles already committed state.
    const off = bridge.onSpecPanelEvent("detached", (value) => {
      if (value.transferId === transfer.transferId) setCommitted(true);
    });
    bridge.specPanelAck("ready", { transferId: transfer.transferId });
    // Subscribe before ACK; one snapshot handles already committed state.
    void bridge
      .specPanelAction("state")
      .then((value) => {
        if (live && (value as { phase?: string }).phase === "detached") setCommitted(true);
      })
      .catch((cause) => {
        if (live) setError(String(cause));
      });
    return () => {
      live = false;
      off();
    };
  }, [transfer, quiescing, platform]);
  const target = transfer?.target;
  const back = () => {
    if (transfer)
      void specWindowBridge(platform)
        ?.specPanelAction("reattach", { transferId: transfer.transferId })
        .catch((cause) => setError(String(cause)));
  };
  return (
    <ServiceProvider services={services}>
      <PlatformProvider platform={platform}>
        <StoreProvider broadcastService={services.broadcastService}>
          <TabStoreProvider>
            <TooltipProvider>
              <DiffsWorkerPoolProvider maxWorkers={2}>
                <AssistantCodeCommentFeatureProvider enabled>
                  <CodingPlanUpgradeDialogProvider>
                    <div className="flex h-screen min-h-0 flex-col bg-background text-foreground">
                      <header className="flex shrink-0 items-center gap-3 border-b border-border p-3">
                        <span className="min-w-0 flex-1 truncate">
                          {target
                            ? `${target.kind} · ${target.workspacePath.split(/[\\/]/).pop()}`
                            : "Preparing panel…"}
                        </span>
                        <button onClick={back} disabled={!transfer || quiescing}>
                          Return to original window
                        </button>
                      </header>
                      {error ? (
                        <p role="alert" className="p-3 text-destructive">
                          {error}
                        </p>
                      ) : null}
                      {target && transfer && committed && !quiescing ? (
                        <PanelFailureBoundary
                          transferId={transfer.transferId}
                          bridge={platform.specWindows}
                        >
                          <div className="flex min-h-0 flex-1 flex-col">
                            {target.kind === "document" ? (
                              <SpecDocumentPane
                                workspacePath={target.workspacePath}
                                workspaceIdentity={target.workspaceIdentity}
                                parentSessionId={target.sessionId || null}
                                initialPath={target.path}
                                onClose={back}
                              />
                            ) : target.sessionId ? (
                              <V4PaneConversationProvider
                                scope={{
                                  workspacePath: target.workspacePath,
                                  workspaceIdentity: target.workspaceIdentity,
                                }}
                              >
                                <SessionPane
                                  paneId={
                                    target.kind === "chat"
                                      ? "workspace-main"
                                      : typeof target.state?.paneId === "string"
                                        ? target.state.paneId
                                        : `selection-side-chat:${target.sessionId}`
                                  }
                                  sessionId={target.sessionId}
                                  workspacePath={target.workspacePath}
                                  workspaceIdentity={target.workspaceIdentity}
                                  isDesktop
                                  focused
                                  telemetryVisible
                                  interactionDialogsVisible
                                  selectionSideChat={target.kind === "side-chat"}
                                />
                              </V4PaneConversationProvider>
                            ) : (
                              <p role="alert">Choose an existing conversation before detaching.</p>
                            )}
                          </div>
                        </PanelFailureBoundary>
                      ) : null}
                    </div>
                  </CodingPlanUpgradeDialogProvider>
                </AssistantCodeCommentFeatureProvider>
              </DiffsWorkerPoolProvider>
            </TooltipProvider>
          </TabStoreProvider>
        </StoreProvider>
      </PlatformProvider>
    </ServiceProvider>
  );
}
