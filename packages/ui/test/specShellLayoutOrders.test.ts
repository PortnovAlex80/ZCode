// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { applySpecShellLayoutSwapOrders } from "@/spec-document/specShellLayoutSwap.js";

/**
 * The U-01 side-swap arrangement was retired (user ruling 2026-11-07): the chat
 * column is order 1 and the tabs container order 3, permanently. What survives
 * of specShellLayoutSwap is the render-time order restatement — the U-03 guard
 * that keeps RRP's value-order registry aligned with the visual order after
 * window resizes re-register panels, so divider drag/keyboard direction never
 * flips.
 */
describe("applySpecShellLayoutSwapOrders (U-03 order restatement keep)", () => {
  it("pins the chat column to 1 and the tabs container to 3", () => {
    const conversation = document.createElement("div");
    const sidePane = document.createElement("div");
    expect(applySpecShellLayoutSwapOrders(conversation, sidePane)).toBe(true);
    expect(conversation.style.getPropertyValue("order")).toBe("1");
    expect(sidePane.style.getPropertyValue("order")).toBe("3");
  });

  it("is idempotent per element and reports readiness for both elements", () => {
    const conversation = document.createElement("div");
    const sidePane = document.createElement("div");
    expect(applySpecShellLayoutSwapOrders(conversation, sidePane)).toBe(true);
    conversation.style.setProperty("order", "1");
    sidePane.style.setProperty("order", "3");
    expect(applySpecShellLayoutSwapOrders(conversation, sidePane)).toBe(true);
    expect(conversation.style.getPropertyValue("order")).toBe("1");
    expect(sidePane.style.getPropertyValue("order")).toBe("3");
  });

  it("stays unsynced until both elements are ready", () => {
    const sidePane = document.createElement("div");
    expect(applySpecShellLayoutSwapOrders(null, sidePane)).toBe(false);
    expect(sidePane.style.getPropertyValue("order")).toBe("");
  });
});
