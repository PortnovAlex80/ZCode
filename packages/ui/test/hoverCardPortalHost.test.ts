// @vitest-environment jsdom
import { createElement } from "react";
import { createPortal } from "react-dom";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "../src/components/ui/hover-card.js";
import { PortalHostContext } from "../src/components/ui/portal-host.js";

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class {
    observe() {} unobserve() {} disconnect() {}
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function usageCard() {
  return createElement(HoverCard, { open: true },
    createElement(HoverCardTrigger, { "data-testid": "usage-anchor" }, "Context usage"),
    createElement(HoverCardContent, { forceMount: true, side: "top" }, "Context window: 50%"));
}

it("keeps the context usage hover card in its detached anchor's actual document", async () => {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  try {
    const detached = frame.contentDocument!;
    render(createPortal(createElement(PortalHostContext.Provider, { value: detached.body }, usageCard()), detached.body));
    await waitFor(() => expect(detached.querySelector("[data-slot='hover-card-content']")).not.toBeNull());
    const anchor = detached.querySelector("[data-testid='usage-anchor']")!;
    const popup = detached.querySelector("[data-slot='hover-card-content']")!;
    expect(popup.ownerDocument).toBe(anchor.ownerDocument);
    expect(popup.textContent).toContain("50%");
    expect(document.querySelector("[data-slot='hover-card-content']")).toBeNull();
  } finally { cleanup(); frame.remove(); }
});

it("retains the normal main-document portal when no detached host is supplied", async () => {
  render(usageCard());
  await waitFor(() => expect(document.querySelector("[data-slot='hover-card-content']")).not.toBeNull());
  expect(document.querySelector("[data-slot='hover-card-content']")!.ownerDocument)
    .toBe(document.querySelector("[data-testid='usage-anchor']")!.ownerDocument);
});
