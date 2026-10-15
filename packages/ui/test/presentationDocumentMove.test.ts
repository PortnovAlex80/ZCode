// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { movePresentationHost, registerPresentationMoveParticipant } from "../src/lib/presentationDocumentMove.js";

describe("presentation editor document handoff", () => {
  it("removes old document listeners before adoption and restores after adoption", () => {
    const host = document.createElement("div");
    const input = document.createElement("div");
    host.appendChild(input);
    const child = document.implementation.createHTMLDocument("child");
    const events: Document[] = [];
    const dispose = registerPresentationMoveParticipant({
      root: () => input,
      isComposing: () => false,
      detach: () => {
        events.push(input.ownerDocument);
        return () => { events.push(input.ownerDocument); };
      },
    });
    try {
      expect(movePresentationHost(host, child.body)).toBe(true);
      expect(events).toEqual([document, child]);
      expect(movePresentationHost(host, document.body, true)).toBe(true);
      expect(events).toEqual([document, child, child, document]);
    } finally { dispose(); host.remove(); }
  });

  it("defers detachment during IME without changing the source editor", () => {
    const host = document.createElement("div");
    const input = document.createElement("div");
    host.appendChild(input);
    const detach = vi.fn(() => () => {});
    const dispose = registerPresentationMoveParticipant({ root: () => input, isComposing: () => true, detach });
    try {
      expect(movePresentationHost(host, document.implementation.createHTMLDocument().body)).toBe(false);
      expect(detach).not.toHaveBeenCalled();
      expect(input.ownerDocument).toBe(document);
    } finally { dispose(); }
  });
});
