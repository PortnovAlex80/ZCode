/** Opt-in document endpoint. CLI owns commands/history; this registry owns live document routing. */
import { createServer } from "node:https";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, rename, realpath } from "node:fs/promises";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import {
  createZCodeAgentConnectionScope,
  IZCodeAgentService,
  type ServiceCollection,
} from "@zcode/services";
import {
  boundedString,
  descriptorSchema,
  configSchema,
  messageSchema,
  documentTokenMatches,
  type Binding,
  type Connection,
  type PendingTool,
} from "./documentGatewayProtocol.js";
import { dispatchDocumentAgent } from "./documentGatewayAgent.js";
export { documentTokenMatches, mergeDocumentMcpServers } from "./documentGatewayProtocol.js";

export async function startDocumentGateway(services: ServiceCollection, configPath: string) {
  const config = configSchema.parse(
    JSON.parse((await readFile(configPath, "utf8")).replace(/^\uFEFF/, "")),
  );
  const allowedWorkspaces = await Promise.all(config.workspaces.map((item) => realpath(item)));
  const bindings = new Map<string, Binding>();
  const connections = new Set<Connection>();
  const pending = new Map<string, PendingTool>();
  let writeFlight = Promise.resolve();
  let disposing = false;
  let disposalFlight: Promise<void> | undefined;
  const cleanupFlights = new Set<Promise<void>>();
  try {
    const saved = JSON.parse(await readFile(config.statePath, "utf8"));
    const schema = z.array(
      z
        .object({
          id: boundedString,
          key: boundedString,
          secret: z.string().min(32),
          workspacePath: boundedString,
          documentId: boundedString,
          host: descriptorSchema.shape.host,
          sessions: z.array(boundedString),
          creations: z.array(boundedString).default([]),
        })
        .strict(),
    );
    for (const binding of schema.parse(saved)) bindings.set(binding.key, binding);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const persist = () => {
    writeFlight = writeFlight
      .catch(() => {})
      .then(async () => {
        await mkdir(path.dirname(config.statePath), { recursive: true });
        const temporary = `${config.statePath}.tmp`;
        await writeFile(temporary, JSON.stringify([...bindings.values()]), { mode: 0o600 });
        await rename(temporary, config.statePath);
      });
    return writeFlight;
  };
  const send = (connection: Connection, value: unknown) => {
    if (disposing || connection.closing || connection.socket.readyState !== WebSocket.OPEN) return;
    if (connection.socket.bufferedAmount > 4 * 1024 * 1024) {
      connection.socket.terminate();
      return;
    }
    connection.socket.send(JSON.stringify(value));
    if (connection.socket.bufferedAmount > 1024 * 1024 && !connection.saturated) {
      connection.saturated = true;
      void connection.scope
        .setTransportFlowState("saturated")
        .catch(() => connection.socket.terminate());
      connection.drainTimer = setInterval(() => {
        if (connection.socket.bufferedAmount > 4 * 1024 * 1024) {
          connection.socket.terminate();
          return;
        }
        if (connection.socket.bufferedAmount > 256 * 1024) return;
        clearInterval(connection.drainTimer);
        connection.drainTimer = undefined;
        connection.saturated = false;
        void connection.scope
          .setTransportFlowState("drained")
          .catch(() => connection.socket.terminate());
      }, 100);
    }
  };
  const tool = (
    connection: Connection,
    method: string,
    args: unknown,
    signal: AbortSignal,
  ): Promise<unknown> => {
    if (disposing || connection.closing || !connection.document || signal.aborted)
      return Promise.reject(new Error("Document unavailable"));
    if (
      pending.size >= 32 ||
      [...pending.values()].filter((job) => job.connection === connection).length >= 8
    )
      return Promise.reject(new Error("Document tool queue is full"));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const cancel = () => {
        const job = pending.get(requestId);
        if (!job) return;
        clearTimeout(job.timer);
        pending.delete(requestId);
        send(connection, { event: "documentCancel", requestId });
        reject(new Error("Document tool cancelled"));
      };
      signal.addEventListener("abort", cancel, { once: true });
      const finish = (action: () => void) => {
        signal.removeEventListener("abort", cancel);
        action();
      };
      const timer = setTimeout(() => {
        pending.delete(requestId);
        finish(() =>
          reject(
            new Error("Document operation result unknown; do not retry a write automatically"),
          ),
        );
      }, 25_000);
      pending.set(requestId, {
        connection,
        resolve: (value) => finish(() => resolve(value)),
        reject: (error) => finish(() => reject(error)),
        timer,
      });
      send(connection, {
        event: "documentTool",
        requestId,
        method,
        args,
        documentInstanceId: connection.document!.documentInstanceId,
        generation: connection.generation,
      });
    });
  };
  const server = createServer(
    { key: await readFile(config.keyPath), cert: await readFile(config.certPath) },
    async (request, response) => {
      response.setHeader("Cache-Control", "no-store");
      try {
        if (request.method !== "POST" || request.url !== "/tool" || request.headers.origin)
          throw new Error("Unavailable endpoint");
        if (disposing) throw new Error("Host shutting down");
        const chunks: Buffer[] = [];
        let byteLength = 0;
        for await (const chunk of request) {
          const buffer = Buffer.from(chunk);
          byteLength += buffer.length;
          chunks.push(buffer);
          if (byteLength > 128 * 1024) throw new Error("Tool request too large");
        }
        const input = z
          .object({
            binding: boundedString,
            method: z.enum(["readSelection", "readTarget", "locate", "proposeEdit", "editStatus"]),
            args: z.record(z.string(), z.unknown()).default({}),
          })
          .strict()
          .parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        const authorization = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
        const connection = [...connections].find(
          (item) =>
            item.binding?.id === input.binding &&
            documentTokenMatches(authorization, item.binding.secret),
        );
        if (!connection) throw new Error("Document unavailable or binding revoked");
        if (input.method !== "readSelection") {
          const expected = input.method === "proposeEdit" ? input.args.expected : input.args;
          if (
            !expected ||
            typeof expected !== "object" ||
            (expected as Record<string, unknown>).documentInstanceId !==
              connection.document?.documentInstanceId
          )
            throw new Error(
              "Capture a fresh document snapshot before targeting or proposing an edit",
            );
        }
        const abort = new AbortController();
        const cancel = () => {
          if (!response.writableEnded) abort.abort();
        };
        response.once("close", cancel);
        const result = await tool(connection, input.method, input.args ?? {}, abort.signal).finally(
          () => response.off("close", cancel),
        );
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ result, generation: connection.generation }));
      } catch (error) {
        if (response.destroyed) return;
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            error: error instanceof Error ? error.message : "Document tool failed",
          }),
        );
      }
    },
  );
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
  server.on("upgrade", (request, socket, head) => {
    if (
      disposing ||
      request.url !== "/document" ||
      !config.origins.includes(request.headers.origin ?? "")
    ) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws));
  });
  wss.on("connection", (socket) => {
    if (disposing) {
      socket.terminate();
      return;
    }
    let connection: Connection | undefined;
    let closed = false;
    let queued = 0;
    const ensureOpen = () => {
      if (closed || disposing || socket.readyState !== WebSocket.OPEN)
        throw new Error("Document connection closed");
    };
    const pairDeadline = setTimeout(() => socket.close(1008, "Pairing required"), 10_000);
    // Serialize only connection control requests. Document results must bypass this queue:
    // a read tool can otherwise wait on its own response behind an in-flight request.
    let controlFlight = Promise.resolve();
    const dispatch = async (message: z.infer<typeof messageSchema>) => {
      ensureOpen();
      const params = message.params;
      if (message.method === "pair") {
        if (connection || !documentTokenMatches(String(params.token ?? ""), config.token))
          throw new Error("Pairing rejected");
        clearTimeout(pairDeadline);
        connection = {
          socket,
          generation: randomUUID(),
          listeners: [],
          subscriptions: new Set(),
          scope: createZCodeAgentConnectionScope(services.get(IZCodeAgentService), {
            connectionId: `document-${randomUUID()}`,
            clientMode: "web-remote-replayable",
            role: "terminal-client",
          }),
        };
        connections.add(connection);
        connection.listeners.push(
          connection.scope.service.onAgentRuntimeRestarted((value) =>
            send(connection!, { event: "runtime", value }),
          ),
        );
        return { paired: true };
      }
      if (!connection) throw new Error("Pair first");
      const current = connection;
      if (message.method === "bind") {
        if (current.binding)
          throw new Error("Reconnect before changing the document or project binding");
        const document = descriptorSchema.parse(params.document);
        const workspacePath = await realpath(boundedString.parse(params.workspacePath));
        ensureOpen();
        if (
          !allowedWorkspaces.some((item) =>
            process.platform === "win32"
              ? item.toLowerCase() === workspacePath.toLowerCase()
              : item === workspacePath,
          )
        )
          throw new Error("Project is not enabled in document gateway config");
        const key = JSON.stringify([
          process.platform === "win32" ? workspacePath.toLowerCase() : workspacePath,
          document.host,
          document.documentId,
        ]);
        if ([...connections].some((item) => item !== current && item.binding?.key === key))
          throw new Error("This document already has an active pane");
        const binding = bindings.get(key) ?? {
          id: randomUUID(),
          key,
          secret: randomUUID() + randomUUID(),
          workspacePath,
          documentId: document.documentId,
          host: document.host,
          sessions: [],
          creations: [],
        };
        bindings.set(key, binding);
        current.binding = binding;
        current.document = document;
        await persist();
        return {
          bindingId: binding.id,
          generation: current.generation,
          sessions: binding.sessions,
          workspacePath,
        };
      }
      if (message.method === "documentResult") {
        const job = pending.get(String(params.requestId));
        if (!job || job.connection !== current || params.generation !== current.generation)
          throw new Error("Stale document result");
        clearTimeout(job.timer);
        pending.delete(String(params.requestId));
        if (params.error) job.reject(new Error(String(params.error)));
        else job.resolve(params.result);
        return { accepted: true };
      }
      if (message.method !== "agent") throw new Error("Unsupported gateway operation");
      return dispatchDocumentAgent(params, {
        current,
        config,
        services,
        send,
        persist,
        ensureOpen,
      });
    };
    socket.on("message", (bytes) => {
      let message: z.infer<typeof messageSchema>;
      try {
        message = messageSchema.parse(JSON.parse(bytes.toString()));
      } catch {
        socket.close(1008, "Invalid document message");
        return;
      }
      const run = async () => {
        try {
          const result = await dispatch(message);
          if (connection) send(connection, { id: message.id, result });
        } catch (error) {
          if (socket.readyState === WebSocket.OPEN)
            socket.send(
              JSON.stringify({
                id: message.id,
                error: error instanceof Error ? error.message : "Gateway request failed",
              }),
            );
        }
      };
      if (message.method === "documentResult") void run();
      else {
        if (++queued > 64) {
          socket.terminate();
          return;
        }
        controlFlight = controlFlight.then(run).finally(() => {
          queued--;
        });
      }
    });
    socket.on("close", () => {
      closed = true;
      clearTimeout(pairDeadline);
      if (!connection) return;
      connection.closing = true;
      clearInterval(connection.drainTimer);
      connections.delete(connection);
      for (const listener of connection.listeners) listener.dispose();
      for (const [id, job] of pending)
        if (job.connection === connection) {
          clearTimeout(job.timer);
          pending.delete(id);
          job.reject(new Error("Document pane disconnected"));
        }
      const cleanup = connection.scope
        .dispose()
        .catch(() => {})
        .finally(() => cleanupFlights.delete(cleanup));
      cleanupFlights.add(cleanup);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, "127.0.0.1", resolve);
  });
  return {
    dispose() {
      if (disposalFlight) return disposalFlight;
      disposing = true;
      disposalFlight = (async () => {
        for (const socket of wss.clients) socket.terminate();
        wss.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await Promise.all([...cleanupFlights, writeFlight]);
      })();
      return disposalFlight;
    },
  };
}
