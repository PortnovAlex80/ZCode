import { useCallback, useSyncExternalStore } from "react";

function documentFocused(document: Document | undefined): boolean {
  if (!document) return false;
  // Minimal non-browser renderers omit hasFocus, just as they omit visibilityState.
  return typeof document.hasFocus === "function" ? document.hasFocus() : true;
}

/** One-shot composer requests belong to the actual focused native document. */
export function usePresentationInteractionFocus(document: Document | undefined): boolean {
  const subscribe = useCallback(
    (listener: () => void) => {
      const view = document?.defaultView;
      view?.addEventListener("focus", listener);
      view?.addEventListener("blur", listener);
      return () => {
        view?.removeEventListener("focus", listener);
        view?.removeEventListener("blur", listener);
      };
    },
    [document],
  );
  const getSnapshot = useCallback(() => documentFocused(document), [document]);
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

/** Avoid routing keys from the main document into a portal in another OS window. */
export function subscribePresentationKeydown(
  document: Document | undefined,
  listener: (event: KeyboardEvent) => void,
): () => void {
  const view = document?.defaultView;
  const onKeyDown = (event: KeyboardEvent) => {
    // Check at dispatch too: React may not yet have committed the blur update.
    if (documentFocused(document)) listener(event);
  };
  view?.addEventListener("keydown", onKeyDown);
  return () => view?.removeEventListener("keydown", onKeyDown);
}
