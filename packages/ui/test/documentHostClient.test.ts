import { describe, it, expect, vi } from "vitest";
import { DocumentSessionClient } from "../src/document-host/client.js";
import { DocumentEditReview } from "../src/document-host/review.js";

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
  const transport = { sendCommand: vi.fn(), queryCommands: vi.fn() };
  const internal = client as any;
  internal.transport = transport;
  internal.generation = "connection-1";
  return { adapter, client, transport, internal };
}
describe("document client failure boundaries without a live runtime", () => {
  it("retains an unresolved command across disconnect and reconciles its original key without resending", async () => {
    const { client, transport, internal } = fixture();
    transport.sendCommand.mockRejectedValueOnce(new Error("ACK lost after acceptance"));
    transport.queryCommands.mockImplementation(async ({ commands }) => ({
      results: commands.map((key: any) => ({ key, result: "unknown" })),
    }));
    await expect(
      client.command("sendText", { text: "A proposal", mode: "build" }, "session-1"),
    ).rejects.toThrow("ACK lost");
    const key = client.unresolvedCommands[0];
    expect(key.sessionId).toBe("session-1");
    expect(key.type).toBe("sendText");
    client.disconnect();
    internal.transport = transport;
    await expect(
      client.command("sendText", { text: "A proposal", mode: "build" }, "session-1"),
    ).rejects.toThrow("Reconcile");
    transport.queryCommands.mockResolvedValue({
      results: [
        { key, result: { commandId: key.commandId, status: "accepted", revisionAtDecision: 1 } },
      ],
    });
    await client.reconcile();
    expect(client.unresolvedCommands).toEqual([]);
    expect(transport.sendCommand).toHaveBeenCalledTimes(1);
    expect(transport.queryCommands.mock.calls.at(-1)![0].commands[0].commandId).toBe(key.commandId);
  });
  it("does not retry a native edit after losing its receipt and refuses proposals from an old connection", async () => {
    const { client, adapter, internal } = fixture();
    const proposal = {
      operationId: "op-1",
      generation: "connection-1",
      documentInstanceId: "open-1",
      expected: {},
      patch: {},
      explanation: "",
      status: "pending" as const,
    };
    client.proposals.set("op-1", proposal);
    adapter.execute.mockRejectedValueOnce(new Error("Receipt lost after sync"));
    await expect(client.apply("op-1")).rejects.toThrow("Receipt lost");
    await expect(client.apply("op-1")).rejects.toThrow("already been attempted");
    expect(client.proposals.get("op-1")!.status).toBe("unknown");
    expect(adapter.execute).toHaveBeenCalledTimes(1);
    client.proposals.set("op-2", { ...proposal, operationId: "op-2", status: "pending" });
    internal.generation = "connection-2";
    await expect(client.apply("op-2")).rejects.toThrow("old document connection");
    expect(adapter.execute).toHaveBeenCalledTimes(1);
  });
  it("bounds terminal receipts independently so completed proposals do not block new reviews", async () => {
    const { adapter } = fixture();
    let generation = "connection-1";
    const reply = vi.fn(async () => undefined);
    const client = new DocumentEditReview(
      adapter,
      () => generation,
      new Set(),
      () => {},
      reply,
    );
    for (let i = 0; i < 120; i++)
      client.proposals.set(String(i), {
        operationId: String(i),
        generation: "connection-1",
        documentInstanceId: "open-1",
        expected: {},
        patch: {},
        explanation: "",
        status: "applied",
      });
    client.proposals.set("pending", {
      operationId: "pending",
      generation: "connection-1",
      documentInstanceId: "open-1",
      expected: {},
      patch: {},
      explanation: "",
      status: "pending",
    });
    const propose = () =>
      client.handleTool({
        requestId: "read-proposal",
        method: "proposeEdit",
        documentInstanceId: "open-1",
        generation,
        args: {
          expected: { host: "word", documentInstanceId: "open-1", target: {}, data: {} },
          patch: { kind: "comment", text: "Review this fragment" },
        },
      });
    await propose();
    expect(reply).toHaveBeenLastCalledWith(
      "documentResult",
      expect.objectContaining({
        result: expect.objectContaining({ status: "pending" }),
      }),
    );
    expect(client.proposals.size).toBe(102);
    expect(client.proposals.get("pending")!.status).toBe("pending");
    generation = "connection-2";
    await propose();
    expect(client.proposals.size).toBe(1);
  });
});
