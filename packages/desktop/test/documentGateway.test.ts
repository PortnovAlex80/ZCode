import { EventEmitter } from "node:events";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { V4_WIRE_PROTOCOL_VERSION } from "@zcode/shared/zcode-protocol-v4";

const state = vi.hoisted(() => ({
  handler: undefined as any,
  server: undefined as any,
  wss: undefined as any,
  agent: undefined as any,
  mcp: undefined as any,
  frame: undefined as any,
  restarts: new Set<(event: any) => void>(),
}));
vi.mock("node:https", async () => {
  const { EventEmitter: Emitter } = await import("node:events");
  return {
    createServer: (_tls: unknown, handler: unknown) => {
      state.handler = handler;
      state.server = new Emitter() as any;
      state.server.listen = (_port: number, _host: string, ready: () => void) => ready();
      state.server.close = (done: () => void) => done();
      return state.server;
    },
  };
});
vi.mock("ws", async () => {
  const { EventEmitter: Emitter } = await import("node:events");
  return {
    WebSocket: { OPEN: 1 },
    WebSocketServer: class extends Emitter {
      clients = new Set<any>();
      override emit(name: string, ...args: any[]) {
        if (name === "connection") this.clients.add(args[0]);
        return super.emit(name, ...args);
      }
      constructor() {
        super();
        state.wss = this;
      }
      close() {}
    },
  };
});
vi.mock("@zcode/services", async (importOriginal) => {
  const original = await importOriginal<typeof import("@zcode/services")>();
  return {
    IZCodeAgentService: "agent",
    IMcpSyncService: "mcp",
    createZCodeAgentConnectionScope: original.createZCodeAgentConnectionScope,
  };
});
import {
  startDocumentGateway,
  mergeDocumentMcpServers,
  documentTokenMatches,
} from "../src/host/documentGateway.js";

class Socket extends EventEmitter {
  readyState = 1;
  replies: any[] = [];
  bufferedAmount = 0;
  send(json: string) {
    this.replies.push(JSON.parse(json));
  }
  close() {
    this.readyState = 3;
    this.emit("close");
  }
  terminate() {
    this.close();
  }
}
let root = "";
let gateway: Awaited<ReturnType<typeof startDocumentGateway>> | undefined;
afterEach(async () => {
  await gateway?.dispose();
  gateway = undefined;
  if (root) await rm(root, { recursive: true, force: true });
  root = "";
  vi.clearAllMocks();
});

async function fixture() {
  root = await mkdtemp(path.join(tmpdir(), "document-gateway-test-"));
  await writeFile(path.join(root, "tls"), "fixture bytes; mock network only");
  state.agent = {
    onAgentRuntimeRestarted: (callback: (event: any) => void) => {
      state.restarts.add(callback);
      return { dispose: () => state.restarts.delete(callback) };
    },
    onDynamicConversationFrame: () => (callback: (frame: any) => void) => {
      state.frame = callback;
      return { dispose() {} };
    },
    setConnectionFlowStateV4: vi.fn(async () => {}),
    unsubscribeConversationV4: vi.fn(async () => {}),
    subscribeConversationV4: vi.fn(async () => ({
      ack: { subscriptionId: "owned-sub", mode: "snapshot", logEpoch: "test-epoch" },
    })),
    helloConversationV4: vi.fn(async () => ({})),
    initializeConversationV4: vi.fn(async () => ({})),
    sendConversationCommandV4: vi.fn(async ({ envelope }: any) => ({
      commandId: envelope.commandId,
      status: "accepted",
      revisionAtDecision: 0,
      ...(envelope.type === "createSession"
        ? { result: { type: "createSession", sessionId: "new-session" } }
        : {}),
    })),
    queryConversationCommandsV4: vi.fn(async ({ commands }: any) => ({
      results: commands.map((key: any) => ({
        key,
        result: {
          status: "accepted",
          result: { type: "createSession", sessionId: "recovered-session" },
        },
      })),
    })),
  };
  state.mcp = {
    loadMcpFromUserDirectory: vi.fn(async () => ({
      servers: [
        {
          name: "existing",
          scope: "user",
          config: { type: "stdio", command: "existing.exe", args: [] },
        },
      ],
    })),
  };
  const config = {
    port: 43485,
    token: "fixture-token-that-is-longer-than-32",
    keyPath: path.join(root, "tls"),
    certPath: path.join(root, "tls"),
    caPath: path.join(root, "root-ca.crt"),
    helperPath: "pinned-helper.mjs",
    nodePath: "pinned-node.exe",
    statePath: path.join(root, "state.json"),
    workspaces: [root],
    origins: ["https://pane.invalid"],
  };
  await writeFile(path.join(root, "config.json"), JSON.stringify(config));
  gateway = await startDocumentGateway(
    { get: (key: string) => (key === "agent" ? state.agent : state.mcp) } as any,
    path.join(root, "config.json"),
  );
  const socket = new Socket();
  state.wss.emit("connection", socket);
  const rpc = async (method: string, params: any = {}) => {
    const id = crypto.randomUUID();
    socket.emit("message", Buffer.from(JSON.stringify({ id, method, params })));
    await vi.waitFor(() => expect(socket.replies.some((item) => item.id === id)).toBe(true));
    return socket.replies.find((item) => item.id === id);
  };
  await rpc("pair", { token: config.token });
  const binding = await rpc("bind", {
    workspacePath: root,
    document: {
      host: "word",
      documentId: "document-1",
      documentInstanceId: "instance-1",
      name: "Sample.docx",
    },
  });
  await rpc("agent", { name: "helloConversationV4" });
  await rpc("agent", {
    name: "initializeConversationV4",
    args: {
      kind: "clientHello",
      protocolVersion: V4_WIRE_PROTOCOL_VERSION,
      clientId: "test-client",
      clientKind: "web",
      appVersion: "test",
    },
  });
  const command = (commandId: string, payload: any) =>
    rpc("agent", {
      name: "sendConversationCommandV4",
      args: {
        envelope: {
          type: "createSession",
          commandId,
          clientId: "test-client",
          sessionId: null,
          payload,
          issuedAt: Date.now(),
        },
      },
    });
  return { socket, rpc, command, binding, config };
}
describe("document gateway routing, no live CLI", () => {
  it("does not admit a queued command after its socket closes", async () => {
    const { socket } = await fixture();
    let release!: () => void;
    state.mcp.loadMcpFromUserDirectory.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ servers: [] });
        }),
    );
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          id: "closed",
          method: "agent",
          params: {
            name: "sendConversationCommandV4",
            args: {
              envelope: {
                type: "createSession",
                commandId: "closed-create",
                clientId: "test-client",
                sessionId: null,
                payload: { workspaceId: root },
                issuedAt: Date.now(),
              },
            },
          },
        }),
      ),
    );
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    socket.close();
    release();
    await Promise.all([gateway!.dispose(), gateway!.dispose()]);
    gateway = undefined;
    expect(state.agent.sendConversationCommandV4).not.toHaveBeenCalled();
  });
  it("enforces real hello ordering, routes early frames and forwards runtime restarts", async () => {
    const { command, rpc, socket, config } = await fixture();
    await command("scope-create", { workspaceId: root });
    const unpaired = new Socket();
    state.wss.emit("connection", unpaired);
    const emit = (id: string, method: string, params: any) =>
      unpaired.emit("message", Buffer.from(JSON.stringify({ id, method, params })));
    emit("pair", "pair", { token: config.token });
    emit("bind", "bind", {
      workspacePath: root,
      document: { host: "word", documentId: "another", documentInstanceId: "i2", name: "Other" },
    });
    emit("hello-missing", "agent", {
      name: "initializeConversationV4",
      args: {
        kind: "clientHello",
        protocolVersion: V4_WIRE_PROTOCOL_VERSION,
        clientId: "another",
        clientKind: "web",
        appVersion: "test",
      },
    });
    await vi.waitFor(() =>
      expect(unpaired.replies.find((item) => item.id === "hello-missing")?.error).toMatch(
        /helloRequired/,
      ),
    );
    state.agent.subscribeConversationV4.mockImplementationOnce(async () => {
      state.frame({
        wireVersion: 3,
        kind: "complete",
        logicalFrameId: "early",
        logicalFrameOrdinal: 1,
        topic: "conversation/new-session",
        subscriptionId: "owned-sub",
        frame: {
          topic: "conversation/new-session",
          subscriptionId: "owned-sub",
          fromSeq: 1,
          toSeq: 1,
          sentAt: 1,
          payload: { kind: "deltas", deltas: [] },
        },
      });
      return { ack: { subscriptionId: "owned-sub", mode: "snapshot", logEpoch: "test-epoch" } };
    });
    expect(
      (await rpc("agent", { name: "subscribeConversationV4", args: { sessionId: "new-session" } }))
        .error,
    ).toBeUndefined();
    expect(socket.replies.some((value) => value.event === "frame")).toBe(true);
    expect(
      (
        await rpc("agent", {
          name: "resyncConversationV4",
          args: { subscriptionId: "foreign-sub" },
        })
      ).error,
    ).toMatch(/owned/);
    for (const restart of state.restarts) restart({ workspaceKey: root });
    expect(socket.replies.some((value) => value.event === "runtime")).toBe(true);
    await rpc("agent", { name: "subscribeConversationV4", args: { sessionId: "new-session" } });
    await gateway!.dispose();
    gateway = undefined;
    expect(unpaired.readyState).toBe(3);
    expect(state.agent.setConnectionFlowStateV4).toHaveBeenCalled();
  });
  it("merges workspace MCP overrides including disabled entries", () => {
    const servers = mergeDocumentMcpServers([
      { name: "same", scope: "user", config: { type: "stdio", command: "user.exe" } },
      { name: "same", scope: "workspace", config: { type: "stdio", command: "workspace.exe" } },
      { name: "disabled", scope: "user", config: { type: "stdio", command: "keep.exe" } },
      {
        name: "disabled",
        scope: "workspace",
        enabled: false,
        config: { type: "stdio", command: "disable.exe" },
      },
    ]);
    expect(servers).toHaveLength(1);
    expect(servers[0].command).toBe("workspace.exe");
    expect(documentTokenMatches("a", "aa")).toBe(false);
    expect(documentTokenMatches("same", "same")).toBe(true);
  });
  it("pins helper startup while preserving configured MCP and restoring bindings", async () => {
    const { command, rpc } = await fixture();
    expect((await command("create-1", { workspaceId: root })).error).toBeUndefined();
    const request = state.agent.sendConversationCommandV4.mock.calls[0][0];
    expect(request.envelope.payload.firstInput).toBeUndefined();
    expect(request.envelope.payload.mcpServers.map((item: any) => item.name)).toEqual([
      "existing",
      "spec_harness_document",
    ]);
    expect(request.envelope.payload.mcpServers[1]).toMatchObject({
      command: "pinned-node.exe",
      isolation: "session",
    });
    expect(request.envelope.payload.mcpServers[1].args.slice(-2)).toEqual([
      "--ca",
      path.join(root, "root-ca.crt"),
    ]);
    const saved = JSON.parse(await readFile(path.join(root, "state.json"), "utf8"));
    expect(saved[0].sessions).toEqual(["new-session"]);
    expect((await rpc("bind", { workspacePath: root, document: {} })).error).toMatch(/Reconnect/);
  });
  it("refuses foreign sessions, executable injection and unowned creation queries", async () => {
    const { rpc, command } = await fixture();
    expect((await command("evil", { workspaceId: root, mcpServers: [] })).error).toMatch(
      /Gateway alone/,
    );
    const foreign = await rpc("agent", {
      name: "sendConversationCommandV4",
      args: {
        envelope: {
          type: "stop",
          commandId: "stop",
          clientId: "test-client",
          sessionId: "foreign",
          payload: {},
          issuedAt: Date.now(),
        },
      },
    });
    expect(foreign.error).toMatch(/does not belong/);
    expect(
      (
        await rpc("agent", {
          name: "queryConversationCommandsV4",
          args: { commands: [{ sessionId: null, commandId: "unknown" }] },
        })
      ).error,
    ).toMatch(/not owned/);
    expect(state.agent.sendConversationCommandV4).not.toHaveBeenCalled();
  });
  it("queries the same command after lost ACK and recovers its binding without re-admission", async () => {
    const { command, rpc } = await fixture();
    state.agent.sendConversationCommandV4.mockRejectedValueOnce(
      new Error("transport lost after admission"),
    );
    expect((await command("lost-create", { workspaceId: root })).error).toMatch(/transport lost/);
    await rpc("agent", {
      name: "queryConversationCommandsV4",
      args: { commands: [{ sessionId: null, commandId: "lost-create" }] },
    });
    expect(state.agent.sendConversationCommandV4).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(path.join(root, "state.json"), "utf8"))[0].sessions).toEqual([
      "recovered-session",
    ]);
  });
  it("checks document instance before tool dispatch and handles result outside the control queue", async () => {
    const { socket, rpc, binding } = await fixture();
    const saved = JSON.parse(await readFile(path.join(root, "state.json"), "utf8"))[0];
    const call = async (args: any) => {
      let value = "";
      const request = {
        method: "POST",
        url: "/tool",
        headers: { authorization: `Bearer ${saved.secret}` },
        async *[Symbol.asyncIterator]() {
          yield Buffer.from(
            JSON.stringify({ binding: binding.result.bindingId, method: "readTarget", args }),
          );
        },
      };
      const response = Object.assign(new EventEmitter(), {
        setHeader() {},
        writeHead() {},
        end(body: string) {
          value = body;
        },
      });
      await state.handler(request, response);
      return JSON.parse(value);
    };
    expect((await call({ documentInstanceId: "old", target: {} })).error).toMatch(/fresh/);
    const flight = call({ documentInstanceId: "instance-1", target: { quote: "Selection" } });
    await vi.waitFor(() =>
      expect(socket.replies.some((item) => item.event === "documentTool")).toBe(true),
    );
    const tool = socket.replies.find((item) => item.event === "documentTool");
    await rpc("documentResult", {
      requestId: tool.requestId,
      generation: tool.generation,
      result: { text: "Selection" },
    });
    expect((await flight).result.text).toBe("Selection");
  });
  it("retracts a binding session on the runtime not-found signal, persists and does not resurrect on reopen", async () => {
    const { command, rpc, config } = await fixture();
    await command("retract-create", { workspaceId: root });
    state.agent.subscribeConversationV4.mockRejectedValueOnce(
      new Error(
        "Session is not active and not persisted: new-session (fault.subscribe.sessionNotFound)",
      ),
    );
    const subscribe = await rpc("agent", {
      name: "subscribeConversationV4",
      args: { sessionId: "new-session" },
    });
    expect(subscribe.error).toMatch(/fault\.subscribe\.sessionNotFound/);
    expect(JSON.parse(await readFile(path.join(root, "state.json"), "utf8"))[0].sessions).toEqual(
      [],
    );
    await gateway!.dispose();
    gateway = undefined;
    gateway = await startDocumentGateway(
      { get: (key: string) => (key === "agent" ? state.agent : state.mcp) } as any,
      path.join(root, "config.json"),
    );
    const reopened = new Socket();
    state.wss.emit("connection", reopened);
    const rpc2 = async (method: string, params: any = {}) => {
      const id = crypto.randomUUID();
      reopened.emit("message", Buffer.from(JSON.stringify({ id, method, params })));
      await vi.waitFor(() => expect(reopened.replies.some((item) => item.id === id)).toBe(true));
      return reopened.replies.find((item) => item.id === id);
    };
    await rpc2("pair", { token: config.token });
    const bind = await rpc2("bind", {
      workspacePath: root,
      document: {
        host: "word",
        documentId: "document-1",
        documentInstanceId: "instance-2",
        name: "Sample.docx",
      },
    });
    expect(bind.result.sessions).toEqual([]);
  });
  it("retracts a binding session when a session-scoped command is rejected with the runtime not-found signal", async () => {
    const { command, rpc } = await fixture();
    await command("gone-create", { workspaceId: root });
    state.agent.sendConversationCommandV4.mockResolvedValueOnce({
      commandId: "stop-gone",
      status: "rejected",
      reasonCode: "proto.sessionNotFound",
      revisionAtDecision: 0,
    });
    const reply = await rpc("agent", {
      name: "sendConversationCommandV4",
      args: {
        envelope: {
          type: "stop",
          commandId: "stop-gone",
          clientId: "test-client",
          sessionId: "new-session",
          payload: {},
          issuedAt: Date.now(),
        },
      },
    });
    expect(reply.result).toMatchObject({
      status: "rejected",
      reasonCode: "proto.sessionNotFound",
    });
    expect(JSON.parse(await readFile(path.join(root, "state.json"), "utf8"))[0].sessions).toEqual(
      [],
    );
  });
  it("removes the binding session when deleteSession is accepted and persists", async () => {
    const { command, rpc } = await fixture();
    await command("delete-create", { workspaceId: root });
    const reply = await rpc("agent", {
      name: "sendConversationCommandV4",
      args: {
        envelope: {
          type: "deleteSession",
          commandId: "delete-1",
          clientId: "test-client",
          sessionId: "new-session",
          payload: {},
          issuedAt: Date.now(),
        },
      },
    });
    expect(reply.result).toMatchObject({ status: "accepted" });
    expect(JSON.parse(await readFile(path.join(root, "state.json"), "utf8"))[0].sessions).toEqual(
      [],
    );
  });
  it("keeps the binding session when deleteSession is not accepted", async () => {
    const { command, rpc } = await fixture();
    await command("keep-create", { workspaceId: root });
    state.agent.sendConversationCommandV4.mockResolvedValueOnce({
      commandId: "delete-2",
      status: "rejected",
      reasonCode: "proto.staleRevision",
      revisionAtDecision: 3,
    });
    const reply = await rpc("agent", {
      name: "sendConversationCommandV4",
      args: {
        envelope: {
          type: "deleteSession",
          commandId: "delete-2",
          clientId: "test-client",
          sessionId: "new-session",
          payload: {},
          issuedAt: Date.now(),
        },
      },
    });
    expect(reply.result).toMatchObject({ status: "rejected", reasonCode: "proto.staleRevision" });
    expect(JSON.parse(await readFile(path.join(root, "state.json"), "utf8"))[0].sessions).toEqual([
      "new-session",
    ]);
  });
});
