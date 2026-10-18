// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  subscribePresentationKeydown,
  usePresentationInteractionFocus,
} from "@/v4/presentationInteractionFocus.js";

afterEach(cleanup);

function nativeDocument() {
  const view = new EventTarget();
  let focused = false;
  const document = {
    defaultView: view,
    hasFocus: () => focused,
  } as unknown as Document;
  return {
    document,
    view,
    focus(value: boolean) {
      focused = value;
      view.dispatchEvent(new Event(value ? "focus" : "blur"));
    },
    key() {
      view.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    },
  };
}

it("routes Escape only to the focused presentation window and removes old listeners", () => {
  const main = nativeDocument();
  const popup = nativeDocument();
  const mainStop = vi.fn();
  const popupStop = vi.fn();
  const offMain = subscribePresentationKeydown(main.document, mainStop);
  const offPopup = subscribePresentationKeydown(popup.document, popupStop);

  main.focus(true);
  main.key();
  expect(mainStop).toHaveBeenCalledTimes(1);
  expect(popupStop).not.toHaveBeenCalled();

  main.focus(false);
  popup.focus(true);
  // A stale main-window key must never stop a running floating conversation.
  main.key();
  expect(mainStop).toHaveBeenCalledTimes(1);
  expect(popupStop).not.toHaveBeenCalled();
  popup.key();
  expect(popupStop).toHaveBeenCalledTimes(1);

  offMain();
  offPopup();
  popup.key();
  expect(popupStop).toHaveBeenCalledTimes(1);
});

it("moves one-shot request admission between documents as their native windows focus", () => {
  const main = nativeDocument();
  const popup = nativeDocument();
  main.focus(true);
  const mainHook = renderHook(() => usePresentationInteractionFocus(main.document));
  const popupHook = renderHook(() => usePresentationInteractionFocus(popup.document));
  expect(mainHook.result.current).toBe(true);
  expect(popupHook.result.current).toBe(false);

  act(() => {
    main.focus(false);
    popup.focus(true);
  });
  expect(mainHook.result.current).toBe(false);
  expect(popupHook.result.current).toBe(true);
});

it("rebinds focus subscription when a stable portal returns to the main document", () => {
  const main = nativeDocument();
  const popup = nativeDocument();
  popup.focus(true);
  const hook = renderHook(({ document }) => usePresentationInteractionFocus(document), {
    initialProps: { document: popup.document },
  });
  expect(hook.result.current).toBe(true);
  hook.rerender({ document: main.document });
  expect(hook.result.current).toBe(false);
  act(() => popup.focus(false));
  expect(hook.result.current).toBe(false);
  act(() => main.focus(true));
  expect(hook.result.current).toBe(true);
});

it("does not claim focus or attach key listeners without a presentation document", () => {
  const listener = vi.fn();
  const hook = renderHook(() => usePresentationInteractionFocus(undefined));
  expect(hook.result.current).toBe(false);
  subscribePresentationKeydown(undefined, listener)();
  expect(listener).not.toHaveBeenCalled();
});
