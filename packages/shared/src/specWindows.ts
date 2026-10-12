export type DetachedPanelTarget = {
  kind: "chat" | "document" | "side-chat";
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId?: string;
  path?: string;
  panelKey: string;
  state?: Record<string, unknown>;
};
export type PanelTransfer = { transferId: string; target: DetachedPanelTarget };
export interface SpecWindowBridge {
  specPanelAction(action: string, payload?: unknown): Promise<unknown>;
  specPanelAck(action: string, payload: unknown): void;
  onSpecPanelEvent(
    action: string,
    listener: (payload: PanelTransfer & { reason?: string }) => void,
  ): () => void;
  projectWindowState(): Promise<{
    role: string;
    target?: { workspacePath: string; taskId?: string };
    windows: {
      role: string;
      target?: { workspacePath: string; taskId?: string };
      visible: boolean;
    }[];
  }>;
  onProjectWindowsChanged(listener: () => void): () => void;
  labelProjectWindow(labels: { projectLabel?: string; sessionLabel?: string }): Promise<void>;
  returnToMainWindow(): Promise<void>;
  acknowledgeProjectWindowTarget(payload: {
    transactionId: string;
    ok: boolean;
    error?: string;
  }): void;
}
