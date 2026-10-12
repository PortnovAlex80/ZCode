import test from "node:test";
import assert from "node:assert/strict";
import { createDocumentMcpHandler } from "./mcp-server.mjs";
test("MCP cancellation and stdio disposal abort outstanding document calls", async () => {
  const handle = createDocumentMcpHandler(
    (_method, _args, signal) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true }),
      ),
  );
  const first = handle({ id: 1, method: "tools/call", params: { name: "read_selection" } });
  await handle({ method: "notifications/cancelled", params: { requestId: 1 } });
  assert.equal((await first).result.isError, true);
  const second = handle({ id: 2, method: "tools/call", params: { name: "read_selection" } });
  handle.dispose();
  assert.match((await second).result.content[0].text, /Cancelled/);
});

test("MCP initializes and publishes operations without opening another agent", async () => {
  let calls = 0;
  const handle = createDocumentMcpHandler(() => {
    calls++;
  });
  assert.equal(
    (await handle({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }))
      .result.protocolVersion,
    "2025-06-18",
  );
  assert.equal(await handle({ method: "notifications/initialized" }), null);
  const tools = (await handle({ id: 2, method: "tools/list" })).result.tools;
  assert.deepEqual(
    tools.map((item) => item.name),
    ["read_selection", "read_target", "locate", "propose_edit", "edit_status"],
  );
  assert.ok(tools.every((item) => !Object.hasOwn(item, "operation")));
  assert.equal(calls, 0);
});
test("MCP proposed edits return pending; tool errors remain explicit", async () => {
  const calls = [];
  const handle = createDocumentMcpHandler((method, args) => {
    calls.push([method, args]);
    return { operationId: "proposal-1", status: "pending" };
  });
  const args = {
    expected: { documentInstanceId: "open-1" },
    patch: { kind: "comment", text: "Review" },
  };
  const result = await handle({
    id: 1,
    method: "tools/call",
    params: { name: "propose_edit", arguments: args },
  });
  assert.equal(JSON.parse(result.result.content[0].text).status, "pending");
  assert.equal(calls[0][0], "proposeEdit");
  const invalid = await handle({
    id: 2,
    method: "tools/call",
    params: { name: "read_target", arguments: { target: {} } },
  });
  assert.equal(invalid.result.isError, true);
  assert.equal(calls.length, 1);
  const unknown = await handle({
    id: 3,
    method: "tools/call",
    params: { name: "run_vba", arguments: {} },
  });
  assert.equal(unknown.error.code, -32602);
});
test("MCP refuses arbitrary executable fields and reports unavailable document", async () => {
  const handle = createDocumentMcpHandler(() => {
    throw new Error("Document closed");
  });
  const bad = await handle({
    id: 1,
    method: "tools/call",
    params: { name: "read_selection", arguments: { command: "shell" } },
  });
  assert.match(bad.result.content[0].text, /Invalid/);
  const closed = await handle({ id: 2, method: "tools/call", params: { name: "read_selection" } });
  assert.equal(closed.result.isError, true);
  assert.equal(closed.result.content[0].text, "Document closed");
});
