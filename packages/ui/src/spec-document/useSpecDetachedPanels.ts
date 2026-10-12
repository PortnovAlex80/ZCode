import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { flushSync } from "react-dom";
import { useEffect, useRef, useState } from "react";
import {
  afterPanelCleanup,
  observePanelComposition,
  specWindowBridge,
  type DetachedPanelTarget,
  type PanelTransfer,
} from "./specWindowBridge.js";

/** Presentation only: execution remains in the originating Host. One pane at a time is editable. */
export function useSpecDetachedPanels(
  workspacePath: string,
  onRestore?: (target: DetachedPanelTarget) => void,
) {
  const platform = useOptionalPlatform();
  const onRestoreRef = useRef(onRestore);
  onRestoreRef.current = onRestore;
  useEffect(observePanelComposition, []);
  const [transfers, setTransfers] = useState<Record<string, PanelTransfer>>({});
  const [error, setError] = useState("");
  useEffect(() => {
    const bridge = specWindowBridge(platform);
    if (!bridge) return;
    const owns = (transfer: PanelTransfer) =>
      transfer.target.workspacePath.replaceAll("\\", "/").toLowerCase() ===
      workspacePath.replaceAll("\\", "/").toLowerCase();
    const dispose = [
      bridge.onSpecPanelEvent("detach-prepare", (transfer) => {
        if (!owns(transfer)) return;
        flushSync(() =>
          setTransfers((current) => ({ ...current, [transfer.target.panelKey]: transfer })),
        );
        void afterPanelCleanup().then(() =>
          bridge.specPanelAck("detach-prepared", { transferId: transfer.transferId }),
        );
      }),
      bridge.onSpecPanelEvent("detach-rollback", (transfer) => {
        if (!owns(transfer)) return;
        flushSync(() =>
          setTransfers((current) => {
            const next = { ...current };
            delete next[transfer.target.panelKey];
            return next;
          }),
        );
        setError(transfer.reason || "Panel transfer failed; the original panel is available.");
      }),
      bridge.onSpecPanelEvent("reattach-rollback", (transfer) => {
        if (!owns(transfer)) return;
        flushSync(() =>
          setTransfers((current) => ({ ...current, [transfer.target.panelKey]: transfer })),
        );
        setError(transfer.reason || "Return failed; the detached panel remains available.");
      }),
      bridge.onSpecPanelEvent("reattach-prepare", (transfer) => {
        if (!owns(transfer)) return;
        try {
          flushSync(() => onRestoreRef.current?.(transfer.target));
        } catch (cause) {
          setError(String(cause));
          bridge.specPanelAck("failed", { transferId: transfer.transferId });
          return;
        }
        flushSync(() =>
          setTransfers((current) => {
            const next = { ...current };
            delete next[transfer.target.panelKey];
            return next;
          }),
        );
        void afterPanelCleanup().then(() =>
          bridge.specPanelAck("reattach-prepared", { transferId: transfer.transferId }),
        );
      }),
    ];
    return () => {
      dispose.forEach((off) => off());
    };
  }, [workspacePath, platform]);
  const detach = async (target: DetachedPanelTarget) => {
    const bridge = specWindowBridge(platform);
    if (!bridge) return;
    setError("");
    try {
      // An unsent attachment has renderer-owned upload/preview resources. Never discard it on transfer.
      if (
        document.documentElement.dataset.specComposing === "true" ||
        document.querySelector('[data-spec-upload-pending="true"]')
      )
        throw new Error("Finish text composition or remove attachments before moving this panel.");
      await bridge.specPanelAction("detach", target);
    } catch (cause) {
      setError(String(cause));
    }
  };
  const restore = async (transfer: PanelTransfer) => {
    try {
      await specWindowBridge(platform)?.specPanelAction("reattach", {
        transferId: transfer.transferId,
      });
    } catch (cause) {
      setError(String(cause));
    }
  };
  return { transfers, error, detach, restore };
}
