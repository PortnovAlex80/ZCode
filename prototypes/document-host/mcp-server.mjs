import { createInterface } from "node:readline";
import { readFile } from "node:fs/promises";
import https from "node:https";
import { pathToFileURL } from "node:url";

export const documentTools = [
  ["read_selection", "Read the current explicit selection in the open document", "readSelection"],
  [
    "read_target",
    "Read a bounded target from read_selection. Pass that snapshot's documentInstanceId and target unchanged.",
    "readTarget",
  ],
  [
    "locate",
    "Select a target from a fresh read_selection snapshot; pass documentInstanceId and target unchanged.",
    "locate",
  ],
  [
    "propose_edit",
    "Return a pending proposal, never write. expected must be the full fresh snapshot. Word patch: {kind: replaceText|comment, text: string}; Excel: {kind: values|formulas, data: rectangular array matching rows/columns}; AutoCAD: {kind: setLayer, layer: existing layer name}. User applies in the pane. A pending proposal is not an applied change.",
    "proposeEdit",
  ],
  [
    "edit_status",
    "Read the status/receipt of a proposal from this document connection. Do not poll while waiting for user approval.",
    "editStatus",
  ],
].map(([name, description, operation]) => ({
  name,
  description,
  operation,
  inputSchema: {
    type: "object",
    properties:
      name === "propose_edit"
        ? {
            expected: { type: "object" },
            patch: { type: "object" },
            explanation: { type: "string", maxLength: 2000 },
          }
        : name === "edit_status"
          ? { documentInstanceId: { type: "string" }, operationId: { type: "string" } }
          : name === "read_selection"
            ? {}
            : { documentInstanceId: { type: "string" }, target: { type: "object" } },
    required:
      name === "propose_edit"
        ? ["expected", "patch"]
        : name === "read_selection"
          ? []
          : name === "edit_status"
            ? ["documentInstanceId", "operationId"]
            : ["documentInstanceId", "target"],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: name !== "propose_edit",
  },
}));

export function createDocumentMcpHandler(callDocument) {
  const active = new Map();
  const handler = async (request) => {
    if (request.id === undefined) {
      if (request.method === "notifications/cancelled")
        active.get(request.params?.requestId)?.abort();
      return null;
    }
    const reply = (result) => ({ jsonrpc: "2.0", id: request.id, result });
    if (request.method === "initialize")
      return reply({
        protocolVersion: request.params?.protocolVersion ?? "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "spec-harness-document", version: "1.0.0" },
      });
    if (request.method === "ping") return reply({});
    if (request.method === "tools/list")
      return reply({ tools: documentTools.map(({ operation: _operation, ...tool }) => tool) });
    if (request.method === "tools/call") {
      const descriptor = documentTools.find((item) => item.name === request.params?.name);
      if (!descriptor)
        return {
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32602, message: "Unknown document tool" },
        };
      const abort = new AbortController();
      active.set(request.id, abort);
      try {
        const args = request.params.arguments ?? {};
        if (
          !args ||
          typeof args !== "object" ||
          Array.isArray(args) ||
          Object.keys(args).some((key) => !Object.hasOwn(descriptor.inputSchema.properties, key)) ||
          descriptor.inputSchema.required.some((key) => !Object.hasOwn(args, key))
        )
          throw new Error("Invalid document tool arguments");
        for (const [key, value] of Object.entries(args)) {
          const schema = descriptor.inputSchema.properties[key];
          if (
            schema.type === "object"
              ? !value || typeof value !== "object" || Array.isArray(value)
              : typeof value !== schema.type
          )
            throw new Error("Invalid document tool argument type");
          if (schema.maxLength && value.length > schema.maxLength)
            throw new Error("Document argument too long");
        }
        const result = await callDocument(descriptor.operation, args, abort.signal);
        return reply({ content: [{ type: "text", text: JSON.stringify(result) }] });
      } catch (error) {
        return reply({ isError: true, content: [{ type: "text", text: error.message }] });
      } finally {
        active.delete(request.id);
      }
    }
    return { jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } };
  };
  handler.dispose = () => {
    for (const abort of active.values()) abort.abort();
  };
  return handler;
}

async function main() {
  const option = (name) => {
    const offset = process.argv.indexOf(name);
    if (offset < 0 || !process.argv[offset + 1] || process.argv[offset + 1].startsWith("--"))
      throw new Error(`Missing ${name}`);
    return process.argv[offset + 1];
  };
  const endpoint = new URL(option("--endpoint"));
  if (endpoint.protocol !== "https:" || !["localhost", "127.0.0.1"].includes(endpoint.hostname))
    throw new Error("Loopback HTTPS endpoint required");
  const binding = option("--binding");
  const secret = process.env.ZCODE_DOCUMENT_BINDING_SECRET;
  if (!secret || !binding) throw new Error("Document binding unavailable");
  const ca = await readFile(option("--ca"));
  const handler = createDocumentMcpHandler(
    (method, args, signal) =>
      new Promise((resolve, reject) => {
        const body = JSON.stringify({ binding, method, args });
        const request = https.request(
          endpoint,
          {
            method: "POST",
            ca,
            signal,
            headers: {
              Authorization: `Bearer ${secret}`,
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(body),
            },
          },
          (response) => {
            const chunks = [];
            let size = 0;
            response.on("data", (chunk) => {
              chunks.push(chunk);
              size += chunk.length;
              if (size > 2 * 1024 * 1024) response.destroy(new Error("Document result too large"));
            });
            response.on("error", reject);
            response.on("end", () => {
              try {
                const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                if (value.error) throw new Error(value.error);
                resolve(value.result);
              } catch (error) {
                reject(error);
              }
            });
          },
        );
        request.setTimeout(28_000, () => request.destroy(new Error("Document tool unavailable")));
        request.on("error", reject);
        request.end(body);
      }),
  );
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("close", () => handler.dispose());
  input.on("line", (line) => {
    if (line.length > 128 * 1024) return;
    void (async () => {
      try {
        const response = await handler(JSON.parse(line));
        if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
      } catch {
        process.stdout.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid MCP input" } })}\n`,
        );
      }
    })();
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
