import { describe, expect, it, vi } from "vitest";
import { DocumentSessionClient } from "./client.js";

function fixture() {
  const adapter = {
    descriptor: async () => ({
      host: "word" as const,
      documentId: "doc",
      documentInstanceId: "open-1",
      name: "Fixture",
    }),
    execute: vi.fn(async () => ({ status: "applied" })),
  };
  const client = new DocumentSessionClient(
    adapter,
    () => {},
    () => {},
  );
  const internal = client as any;
  return { client, internal };
}

describe("document pane old-history pagination through the native rows-range target", () => {
  it("delegates load-older to the projection store cursor with the protocol tail-window default", async () => {
    const { client, internal } = fixture();
    const loadOlder = vi.fn(async () => {});
    let loadingOlder = false;
    internal.lease = {
      sessionId: "s-1",
      store: { loadOlder, getState: () => ({ loadingOlder }) },
      release: () => {},
    };
    await client.loadOlder();
    expect(loadOlder).toHaveBeenCalledTimes(1);
    expect(loadOlder).toHaveBeenLastCalledWith(60);
    await client.loadOlder(25);
    expect(loadOlder).toHaveBeenLastCalledWith(25);
    loadingOlder = true;
    expect(client.loadingOlder).toBe(true);
  });
  it("is a read-only no-op before a session lease exists", async () => {
    const { client } = fixture();
    await expect(client.loadOlder()).resolves.toBeUndefined();
    expect(client.loadingOlder).toBe(false);
    expect(client.hasOlderRows).toBe(false);
  });
  it("reports has-older from the window head versus the conversation-wide first row", () => {
    const { client, internal } = fixture();
    const leaseWithSnapshot = (snapshot: unknown) => ({
      store: { getState: () => ({ snapshot, loadingOlder: false }) },
    });
    internal.lease = leaseWithSnapshot(null);
    expect(client.hasOlderRows).toBe(false);
    internal.lease = leaseWithSnapshot({
      rows: { firstRowId: null, window: [{ rowId: 5 }] },
    });
    expect(client.hasOlderRows).toBe(false);
    internal.lease = leaseWithSnapshot({
      rows: { firstRowId: 5, window: [{ rowId: 5 }] },
    });
    expect(client.hasOlderRows).toBe(false);
    internal.lease = leaseWithSnapshot({
      rows: { firstRowId: 2, window: [{ rowId: 5 }] },
    });
    expect(client.hasOlderRows).toBe(true);
  });
});

describe("document client keeps structured rejection reasons visible", () => {
  it("throws rejected acks with reasonCode first so a retracted session stays detectable", async () => {
    const { client, internal } = fixture();
    internal.transport = {
      sendCommand: vi.fn(async () => ({
        commandId: "cmd-gone",
        status: "rejected",
        reasonCode: "proto.sessionNotFound",
        message: "Session was deleted",
        revisionAtDecision: 3,
      })),
    };
    await expect(
      client.command("sendText", { text: "hi", mode: "build" }, "s-gone"),
    ).rejects.toThrow(/^proto\.sessionNotFound: Session was deleted$/);
  });
  it("falls back to the bare status when neither reasonCode nor message exists", async () => {
    const { client, internal } = fixture();
    internal.transport = {
      sendCommand: vi.fn(async () => ({
        commandId: "cmd-stale",
        status: "stale",
        revisionAtDecision: 7,
      })),
    };
    await expect(client.command("sendText", { text: "hi", mode: "build" }, "s-1")).rejects.toThrow(
      "stale",
    );
  });
  it("still resolves accepted acks unchanged", async () => {
    const { client, internal } = fixture();
    const ack = {
      commandId: "cmd-ok",
      status: "accepted",
      revisionAtDecision: 9,
    };
    internal.transport = { sendCommand: vi.fn(async () => ack) };
    await expect(client.command("stop", {}, "s-1")).resolves.toBe(ack);
  });
});
