import type { IPlatformService } from "@zcode/shared";
export type { DetachedPanelTarget, PanelTransfer, SpecWindowBridge } from "@zcode/shared";
export function specWindowBridge(platform: IPlatformService | null | undefined) {
  return platform?.specWindows;
}
export function afterPanelCleanup(): Promise<void> {
  // React passive unmount cleanup flushes composer drafts before the next host admission.
  return new Promise((resolve) => setTimeout(resolve, 50));
}

export function observePanelComposition(): () => void {
  const start = () => {
    document.documentElement.dataset.specComposing = "true";
  };
  const end = () => {
    delete document.documentElement.dataset.specComposing;
  };
  document.addEventListener("compositionstart", start, true);
  document.addEventListener("compositionend", end, true);
  return () => {
    document.removeEventListener("compositionstart", start, true);
    document.removeEventListener("compositionend", end, true);
    end();
  };
}
