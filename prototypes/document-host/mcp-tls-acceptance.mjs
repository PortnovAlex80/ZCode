/** Isolated MCP/TLS fixture; never starts ZCODE, Office, AutoCAD or a model. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:https";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";

const config = JSON.parse(
  (
    await readFile(
      path.join(process.env.LOCALAPPDATA, "SpecHarness/document-host/gateway.json"),
      "utf8",
    )
  ).replace(/^\uFEFF/, ""),
);
assert.ok(config.caPath, "Prepare the document gateway first; its CA path must be explicit");
const fixtureSecret = "isolated-tls-fixture-secret";
const snapshot = {
  host: "word",
  documentInstanceId: "tls-fixture",
  data: { text: "TLS: Привет ☃" },
};
let received;
const server = createServer(
  { key: await readFile(config.keyPath), cert: await readFile(config.certPath) },
  async (request, response) => {
    try {
      assert.equal(request.headers.authorization, `Bearer ${fixtureSecret}`);
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      received = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "Content-Type": "application/json" });
      const bytes = Buffer.from(JSON.stringify({ result: snapshot, generation: "tls-fixture" }));
      const split = bytes.indexOf(Buffer.from("☃")) + 1;
      response.write(bytes.subarray(0, split));
      response.end(bytes.subarray(split));
    } catch (error) {
      response.writeHead(400);
      response.end(JSON.stringify({ error: error.message }));
    }
  },
);
let child;
const pending = new Map();
let reader;
try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  child = spawn(
    config.nodePath,
    [
      config.helperPath,
      "--endpoint",
      `https://localhost:${server.address().port}/tool`,
      "--binding",
      "tls-fixture",
      "--ca",
      config.caPath,
    ],
    {
      windowsHide: true,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        ZCODE_DOCUMENT_BINDING_SECRET: fixtureSecret,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const fail = (error) => {
    for (const job of pending.values()) job.reject(error);
  };
  child.once("error", fail);
  child.once("exit", (code) => {
    if (pending.size) fail(new Error(`MCP fixture exited early: ${code}`));
  });
  reader = createInterface({ input: child.stdout });
  reader.on("line", (line) => {
    try {
      const message = JSON.parse(line);
      const job = pending.get(message.id);
      if (job) {
        pending.delete(message.id);
        clearTimeout(job.timer);
        job.resolve(message);
      }
    } catch (error) {
      fail(error);
    }
  });
  const rpc = (id, method, params) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("MCP/TLS fixture timed out"));
      }, 10000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  assert.equal(
    (await rpc(1, "initialize", { protocolVersion: "2025-06-18" })).result.serverInfo.name,
    "spec-harness-document",
  );
  const result = await rpc(2, "tools/call", { name: "read_selection", arguments: {} });
  assert.equal(result.result.isError, undefined, result.result.content[0].text);
  assert.deepEqual(JSON.parse(result.result.content[0].text), snapshot);
  assert.deepEqual(received, { binding: "tls-fixture", method: "readSelection", args: {} });
  console.info(
    "Native MCP stdio + strict CA TLS + UTF-8 response: passed; no ZCODE or model started",
  );
} finally {
  for (const job of pending.values()) clearTimeout(job.timer);
  reader?.close();
  child?.stdin.end();
  if (child && child.exitCode === null) {
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill();
        resolve();
      }, 2000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
