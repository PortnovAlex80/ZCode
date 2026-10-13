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
      state.server.listening = false;
      state.server.idleCloses = 0;
      state.server.allCloses = 0;
      state.server.listen = (_port: number, _host: string, ready: () => void) => {
        state.server.listening = true;
        ready();
      };
      state.server.close = (done: () => void) => {
        state.server.listening = false;
        done();
      };
      state.server.closeIdleConnections = () => {
        state.server.idleCloses += 1;
      };
      state.server.closeAllConnections = () => {
        state.server.allCloses += 1;
      };
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
      // T-05 allowed-origin half: the real server upgrades a request only after the
      // gateway origin check passed; the mock hands the same socket to the connection path.
      handleUpgrade(_request: unknown, socket: any, _head: unknown, done: (socket: any) => void) {
        done(socket);
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
// T-05/T-04 reopen pattern: issue gateway RPCs over an arbitrary pane socket.
const socketRpc =
  (socket: Socket) =>
  async (method: string, params: any = {}) => {
    const id = crypto.randomUUID();
    socket.emit("message", Buffer.from(JSON.stringify({ id, method, params })));
    await vi.waitFor(() => expect(socket.replies.some((item) => item.id === id)).toBe(true));
    return socket.replies.find((item) => item.id === id);
  };
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
  it("sets, persists and restores the document session marker across a gateway restart", async () => {
    const { command, config } = await fixture();
    await command("marker-create", { workspaceId: root });
    const saved = JSON.parse(await readFile(path.join(root, "state.json"), "utf8"))[0];
    expect(saved.sessions).toEqual(["new-session"]);
    expect(saved.creations).toEqual(["marker-create"]);
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
    expect(bind.result.sessions).toEqual(["new-session"]);
    await rpc2("agent", { name: "helloConversationV4" });
    await rpc2("agent", {
      name: "initializeConversationV4",
      args: {
        kind: "clientHello",
        protocolVersion: V4_WIRE_PROTOCOL_VERSION,
        clientId: "test-client",
        clientKind: "web",
        appVersion: "test",
      },
    });
    const rename = (commandId: string, sessionId: string) =>
      rpc2("agent", {
        name: "sendConversationCommandV4",
        args: {
          envelope: {
            type: "renameSession",
            commandId,
            clientId: "test-client",
            sessionId,
            payload: { title: "Doc thread" },
            issuedAt: Date.now(),
          },
        },
      });
    expect((await rename("rename-restored", "new-session")).error).toBeUndefined();
    expect((await rename("rename-foreign", "desktop-made-session")).error).toMatch(
      /does not belong/,
    );
    expect(
      (
        await rpc2("agent", {
          name: "queryConversationCommandsV4",
          args: { commands: [{ sessionId: null, commandId: "marker-create" }] },
        })
      ).error,
    ).toBeUndefined();
    expect(JSON.parse(await readFile(path.join(root, "state.json"), "utf8"))[0].sessions).toEqual([
      "new-session",
      "recovered-session",
    ]);
  });
  it("marks side sessions created through the pane and recovers a lost ACK via the creations ring", async () => {
    const { command, rpc } = await fixture();
    await command("side-parent", { workspaceId: root });
    const sideSession = (commandId: string) =>
      rpc("agent", {
        name: "sendConversationCommandV4",
        args: {
          envelope: {
            type: "createSelectionSideSession",
            commandId,
            clientId: "test-client",
            sessionId: "new-session",
            payload: {},
            issuedAt: Date.now(),
          },
        },
      });
    state.agent.sendConversationCommandV4.mockResolvedValueOnce({
      commandId: "side-ok",
      status: "accepted",
      revisionAtDecision: 0,
      result: { type: "createSelectionSideSession", sessionId: "side-child" },
    });
    expect((await sideSession("side-ok")).error).toBeUndefined();
    let saved = JSON.parse(await readFile(path.join(root, "state.json"), "utf8"))[0];
    expect(saved.sessions).toEqual(["new-session", "side-child"]);
    state.agent.sendConversationCommandV4.mockRejectedValueOnce(
      new Error("transport lost after admission"),
    );
    expect((await sideSession("side-lost")).error).toMatch(/transport lost/);
    saved = JSON.parse(await readFile(path.join(root, "state.json"), "utf8"))[0];
    expect(saved.creations).toEqual(["side-parent", "side-ok", "side-lost"]);
    state.agent.queryConversationCommandsV4.mockResolvedValueOnce({
      results: [
        {
          key: { sessionId: null, commandId: "side-lost" },
          result: {
            status: "accepted",
            result: { type: "createSelectionSideSession", sessionId: "side-recovered" },
          },
        },
      ],
    });
    expect(
      (
        await rpc("agent", {
          name: "queryConversationCommandsV4",
          args: { commands: [{ sessionId: null, commandId: "side-lost" }] },
        })
      ).error,
    ).toBeUndefined();
    saved = JSON.parse(await readFile(path.join(root, "state.json"), "utf8"))[0];
    expect(saved.sessions).toEqual(["new-session", "side-child", "side-recovered"]);
    expect(state.agent.sendConversationCommandV4).toHaveBeenCalledTimes(3);
  });
  it("refuses marker spoofing through command payloads: binding membership is gateway-owned", async () => {
    const { command, rpc } = await fixture();
    await command("spoof-create", { workspaceId: root });
    const envelope = (type: string, commandId: string, sessionId: string | null, payload: any) =>
      rpc("agent", {
        name: "sendConversationCommandV4",
        args: {
          envelope: {
            type,
            commandId,
            clientId: "test-client",
            sessionId,
            payload,
            issuedAt: Date.now(),
          },
        },
      });
    expect(
      (await envelope("createSession", "adopt-1", "desktop-session", { workspaceId: root })).error,
    ).toMatch(/Gateway alone/);
    expect(
      (
        await envelope("sendText", "spoof-foreign", "desktop-session", {
          text: "hello",
          documentBinding: true,
          surface: "document",
        })
      ).error,
    ).toMatch(/does not belong/);
    state.agent.sendConversationCommandV4.mockClear();
    expect(
      (
        await envelope("sendText", "spoof-bound", "new-session", {
          text: "hello",
          surface: "desktop",
          documentMarker: true,
        })
      ).error,
    ).toBeUndefined();
    expect(state.agent.sendConversationCommandV4.mock.calls[0][0].envelope.payload).toEqual({
      text: "hello",
    });
    expect(JSON.parse(await readFile(path.join(root, "state.json"), "utf8"))[0].sessions).toEqual([
      "new-session",
    ]);
    expect(state.agent.sendConversationCommandV4).toHaveBeenCalledTimes(1);
  });
  it("keeps surface attribution observational and never injects MCP retroactively into active sessions", async () => {
    const { command, rpc } = await fixture();
    expect(
      (
        await rpc("agent", {
          name: "initializeConversationV4",
          args: {
            kind: "clientHello",
            protocolVersion: V4_WIRE_PROTOCOL_VERSION,
            clientId: "test-client",
            clientKind: "desktop",
            appVersion: "test",
          },
        })
      ).error,
    ).toMatch(/web client handshake/);
    await command("attr-create", { workspaceId: root });
    state.agent.sendConversationCommandV4.mockClear();
    expect(
      (
        await rpc("agent", {
          name: "sendConversationCommandV4",
          args: {
            envelope: {
              type: "sendText",
              commandId: "attr-send",
              clientId: "test-client",
              sessionId: "new-session",
              payload: { text: "hi" },
              issuedAt: Date.now(),
            },
          },
        })
      ).error,
    ).toBeUndefined();
    expect(state.agent.sendConversationCommandV4.mock.calls[0][0].envelope.payload).toEqual({
      text: "hi",
    });
    state.agent.sendConversationCommandV4.mockClear();
    expect(
      (
        await rpc("agent", {
          name: "sendConversationCommandV4",
          args: {
            envelope: {
              type: "createSelectionSideSession",
              commandId: "attr-side",
              clientId: "test-client",
              sessionId: "new-session",
              payload: {},
              issuedAt: Date.now(),
            },
          },
        })
      ).error,
    ).toBeUndefined();
    const side = state.agent.sendConversationCommandV4.mock.calls[0][0].envelope;
    expect(side.type).toBe("createSelectionSideSession");
    expect(side.payload).toEqual({});
    expect(
      (
        await rpc("agent", {
          name: "sendConversationCommandV4",
          args: {
            envelope: {
              type: "sendText",
              commandId: "attr-impersonate",
              clientId: "desktop-main-window",
              sessionId: "new-session",
              payload: { text: "hi" },
              issuedAt: Date.now(),
            },
          },
        })
      ).error,
    ).toMatch(/Client identity mismatch/);
    expect(JSON.parse(await readFile(path.join(root, "state.json"), "utf8"))[0].sessions).toEqual([
      "new-session",
    ]);
  });
});

describe("document gateway shutdown phase", () => {
  // helper 侧的 /tool HTTP 回调：与现有 tool 分发用例相同的请求/响应 mock。
  const toolCall = async (bindingId: string, secret: string, args: any) => {
    let value = "";
    const request = {
      method: "POST",
      url: "/tool",
      headers: { authorization: `Bearer ${secret}` },
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(JSON.stringify({ binding: bindingId, method: "readTarget", args }));
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
  it("shutdown with an active pane connection fails in-flight operations with a visible closed error, not a hang", async () => {
    const { socket, binding } = await fixture();
    const saved = JSON.parse(await readFile(path.join(root, "state.json"), "utf8"))[0];
    // 在飞 pane 工具调用：documentTool 已发给 pane，pane 永不回结果。
    // vi.waitFor 默认 1s 上限即「不得挂起」的判定；旧实现依赖 terminate 后的异步 close 事件。
    const flight = toolCall(binding.result.bindingId, saved.secret, {
      documentInstanceId: "instance-1",
      target: { quote: "Selection" },
    });
    await vi.waitFor(() =>
      expect(socket.replies.some((item) => item.event === "documentTool")).toBe(true),
    );
    // 模拟真实 ws 语义：terminate 只销毁底层连接，close 事件异步派发。
    // 旧实现依赖 close 事件善后在飞操作，在此桩下会挂起；dispose 必须自行有界地失败它们。
    socket.terminate = () => {
      socket.readyState = 3;
    };
    const disposal = gateway!.dispose();
    const settled = await vi.waitFor(() => flight);
    expect(settled.error).toMatch(/gateway closed/i);
    await vi.waitFor(() => expect(socket.readyState).toBe(3));
    await disposal;
    gateway = undefined;
    // shutdown 之后新操作立即被拒，同样不挂起。
    expect(
      (
        await toolCall(binding.result.bindingId, saved.secret, {
          documentInstanceId: "instance-1",
          target: {},
        })
      ).error,
    ).toMatch(/Host shutting down/);
  });
  it("terminates the session-isolated MCP helper callback channel during the bounded shutdown phase", async () => {
    const { socket, binding } = await fixture();
    const saved = JSON.parse(await readFile(path.join(root, "state.json"), "utf8"))[0];
    const listener = state.server;
    const flight = toolCall(binding.result.bindingId, saved.secret, {
      documentInstanceId: "instance-1",
      target: { quote: "Selection" },
    });
    await vi.waitFor(() =>
      expect(socket.replies.some((item) => item.event === "documentTool")).toBe(true),
    );
    await gateway!.dispose();
    gateway = undefined;
    // 在飞回调收到可见错误（MCP cancellation 语义：HTTP callback 终止，不等待 pane）。
    expect((await vi.waitFor(() => flight)).error).toMatch(/gateway closed/i);
    // helper 的回调通道被显式销毁（closeAllConnections），listener 不再持有 helper 句柄。
    expect(listener.allCloses).toBe(1);
    // helper 进程随后由 CLI session runtime 随 service-dispose 阶段终止（进程归属不在 gateway）。
    expect(
      (
        await toolCall(binding.result.bindingId, saved.secret, {
          documentInstanceId: "instance-1",
          target: {},
        })
      ).error,
    ).toMatch(/Host shutting down/);
  });
  it("releases the listener port during shutdown so a subsequent host can bind", async () => {
    const { command, config } = await fixture();
    await command("port-create", { workspaceId: root });
    const first = state.server;
    expect(first.listening).toBe(true);
    await gateway!.dispose();
    expect(first.listening).toBe(false);
    expect(first.allCloses).toBeGreaterThanOrEqual(1);
    gateway = undefined;
    gateway = await startDocumentGateway(
      { get: (key: string) => (key === "agent" ? state.agent : state.mcp) } as any,
      path.join(root, "config.json"),
    );
    expect(state.server).not.toBe(first);
    expect(state.server.listening).toBe(true);
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
    // 绑定已在 shutdown 阶段持久化，后续 Host 恢复同一文档绑定。
    expect(bind.result.sessions).toEqual(["new-session"]);
    await gateway!.dispose();
    expect(state.server.listening).toBe(false);
  });
});

describe("document gateway non-live boundaries (T-05/O-07 fixture halves)", () => {
  const httpRequest = async (headers: Record<string, string>, body: unknown) => {
    let value = "";
    const request = {
      method: "POST",
      url: "/tool",
      headers,
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(JSON.stringify(body));
      },
    };
    const response = Object.assign(new EventEmitter(), {
      setHeader() {},
      writeHead() {},
      end(payload: string) {
        value = payload;
      },
    });
    await state.handler(request, response);
    return JSON.parse(value);
  };
  const documentTool = (bindingId: string, secret: string, args: any) =>
    httpRequest(
      { authorization: `Bearer ${secret}` },
      { binding: bindingId, method: "readTarget", args },
    );
  const refusingUpgradeSocket = () => {
    const socket = {
      destroyed: false,
      destroy() {
        socket.destroyed = true;
      },
    };
    return socket;
  };
  const bindParams = (instanceId: string) => ({
    workspacePath: root,
    document: {
      host: "word",
      documentId: "document-1",
      documentInstanceId: instanceId,
      name: "Sample.docx",
    },
  });

  it("rejects upgrades outside the allowed origin/path, browser origins on /tool and pairing without the config token", async () => {
    const { config } = await fixture();
    const wrongOrigin = refusingUpgradeSocket();
    state.server.emit(
      "upgrade",
      { url: "/document", headers: { origin: "https://evil.invalid" } },
      wrongOrigin,
      Buffer.alloc(0),
    );
    expect(wrongOrigin.destroyed).toBe(true);
    const wrongPath = refusingUpgradeSocket();
    state.server.emit(
      "upgrade",
      { url: "/other", headers: { origin: "https://pane.invalid" } },
      wrongPath,
      Buffer.alloc(0),
    );
    expect(wrongPath.destroyed).toBe(true);
    // The /tool endpoint serves the session-isolated MCP helper, not browsers: any
    // Origin header (even the pane origin) is refused before the body is read.
    expect(
      (
        await httpRequest(
          { origin: "https://pane.invalid", authorization: "Bearer whatever" },
          { binding: "none", method: "readSelection", args: {} },
        )
      ).error,
    ).toMatch(/Unavailable endpoint/);
    // Unpaired sockets never reach binding or agent operations, and a wrong token
    // never pairs; a successful pair is once-per-connection.
    const fresh = new Socket();
    state.wss.emit("connection", fresh);
    const rpc0 = socketRpc(fresh);
    expect((await rpc0("bind", bindParams("instance-x"))).error).toMatch(/Pair first/);
    expect((await rpc0("pair", { token: "wrong-token-that-also-has-length" })).error).toMatch(
      /Pairing rejected/,
    );
    expect((await rpc0("bind", bindParams("instance-x"))).error).toMatch(/Pair first/);
    expect((await rpc0("pair", { token: config.token })).error).toBeUndefined();
    expect((await rpc0("pair", { token: config.token })).error).toMatch(/Pairing rejected/);
    // The allowed origin upgrades into a real pane connection.
    const upgraded = new Socket();
    state.server.emit(
      "upgrade",
      { url: "/document", headers: { origin: "https://pane.invalid" } },
      upgraded,
      Buffer.alloc(0),
    );
    await vi.waitFor(() => expect(state.wss.clients.has(upgraded)).toBe(true));
    const rpcUp = socketRpc(upgraded);
    expect((await rpcUp("pair", { token: config.token })).error).toBeUndefined();
    expect((await rpcUp("bind", bindParams("instance-y"))).error).toMatch(
      /already has an active pane/,
    );
    fresh.close();
    upgraded.close();
  });

  it("canonicalizes the workspace key: one binding per document across spellings, restarts and reopen (O-07 half)", async () => {
    const { binding, command, config } = await fixture();
    await command("canonical-create", { workspaceId: root });
    expect(JSON.parse(await readFile(path.join(root, "state.json"), "utf8"))).toHaveLength(1);
    // A second pane binding the same document through a differently-cased spelling of
    // the same workspace must collide on the canonical key, not fork a second binding.
    const second = new Socket();
    state.wss.emit("connection", second);
    const rpc2 = socketRpc(second);
    await rpc2("pair", { token: config.token });
    const clash = await rpc2("bind", {
      ...bindParams("instance-b"),
      workspacePath: root.toUpperCase(),
    });
    expect(clash.error).toMatch(/already has an active pane/);
    expect(JSON.parse(await readFile(path.join(root, "state.json"), "utf8"))).toHaveLength(1);
    await gateway!.dispose();
    gateway = undefined;
    gateway = await startDocumentGateway(
      { get: (key: string) => (key === "agent" ? state.agent : state.mcp) } as any,
      path.join(root, "config.json"),
    );
    const reopened = new Socket();
    state.wss.emit("connection", reopened);
    const rpc3 = socketRpc(reopened);
    await rpc3("pair", { token: config.token });
    const reopenedBind = await rpc3("bind", {
      ...bindParams("instance-2"),
      workspacePath: root.toUpperCase(),
    });
    // Same document identity (Office-settings documentId) → same canonical key → the
    // persisted binding id and its sessions round-trip across the reopen (O-07).
    expect(reopenedBind.error).toBeUndefined();
    expect(reopenedBind.result.bindingId).toBe(binding.result.bindingId);
    expect(reopenedBind.result.sessions).toEqual(["new-session"]);
    expect(JSON.parse(await readFile(path.join(root, "state.json"), "utf8"))).toHaveLength(1);
  });

  it("narrows capability after disconnect: tools refuse without a live pane and stale generations cannot answer", async () => {
    const { socket, rpc, command, binding, config } = await fixture();
    const saved = JSON.parse(await readFile(path.join(root, "state.json"), "utf8"))[0];
    await command("cap-create", { workspaceId: root });
    await rpc("agent", { name: "subscribeConversationV4", args: { sessionId: "new-session" } });
    socket.close();
    // Transport-level narrowing: the pane scope reports the connection closed to the
    // runtime instead of leaving a phantom live surface.
    await vi.waitFor(() =>
      expect(
        state.agent.setConnectionFlowStateV4.mock.calls.some(
          (call: any) => call[0]?.state === "closed",
        ),
      ).toBe(true),
    );
    // Document tools are refused while no live pane connection owns the binding.
    expect(
      (
        await documentTool(binding.result.bindingId, saved.secret, {
          documentInstanceId: "instance-1",
          target: {},
        })
      ).error,
    ).toMatch(/Document unavailable or binding revoked/);
    const reopened = new Socket();
    state.wss.emit("connection", reopened);
    const rpc2 = socketRpc(reopened);
    await rpc2("pair", { token: config.token });
    const rebind = await rpc2("bind", bindParams("instance-2"));
    expect(rebind.result.generation).not.toBe(binding.result.generation);
    const flight = documentTool(binding.result.bindingId, saved.secret, {
      documentInstanceId: "instance-2",
      target: { quote: "Selection" },
    });
    await vi.waitFor(() =>
      expect(reopened.replies.some((item) => item.event === "documentTool")).toBe(true),
    );
    const tool = reopened.replies.find((item) => item.event === "documentTool");
    // A result framed with the previous connection generation cannot satisfy a
    // new-generation tool call; only the current generation can.
    expect(
      (
        await rpc2("documentResult", {
          requestId: tool.requestId,
          generation: binding.result.generation,
          result: { text: "Stale" },
        })
      ).error,
    ).toMatch(/Stale document result/);
    await rpc2("documentResult", {
      requestId: tool.requestId,
      generation: tool.generation,
      result: { text: "Fresh" },
    });
    expect((await flight).result).toEqual({ text: "Fresh" });
  });

  it("signals saturation and drain through the native transport flow and terminates runaway buffers", async () => {
    const { socket, rpc, command } = await fixture();
    await command("flow-create", { workspaceId: root });
    await rpc("agent", { name: "subscribeConversationV4", args: { sessionId: "new-session" } });
    const flowStates = () =>
      state.agent.setConnectionFlowStateV4.mock.calls.map((call: any) => call[0]?.state);
    // A pane socket backing up beyond 1 MiB flips the connection to saturated; the
    // state is reported to the native runtime, not silently buffered.
    socket.bufferedAmount = 2 * 1024 * 1024;
    await rpc("agent", { name: "helloConversationV4" });
    await vi.waitFor(() => expect(flowStates()).toContain("saturated"));
    // Draining below the 256 KiB probe restores the connection to drained.
    socket.bufferedAmount = 1024;
    await vi.waitFor(() => expect(flowStates()).toContain("drained"), { timeout: 5000 });
    // A runaway buffer beyond 4 MiB terminates the connection instead of growing.
    socket.bufferedAmount = 5 * 1024 * 1024;
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({ id: "burst", method: "agent", params: { name: "helloConversationV4" } }),
      ),
    );
    await vi.waitFor(() => expect(socket.readyState).toBe(3));
  });

  it("keeps acknowledged session deletion durable across a gateway restart and reopen", async () => {
    const { command, rpc, binding, config } = await fixture();
    await command("delete-durable-create", { workspaceId: root });
    const reply = await rpc("agent", {
      name: "sendConversationCommandV4",
      args: {
        envelope: {
          type: "deleteSession",
          commandId: "delete-durable-1",
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
    await gateway!.dispose();
    gateway = undefined;
    gateway = await startDocumentGateway(
      { get: (key: string) => (key === "agent" ? state.agent : state.mcp) } as any,
      path.join(root, "config.json"),
    );
    const reopened = new Socket();
    state.wss.emit("connection", reopened);
    const rpc2 = socketRpc(reopened);
    await rpc2("pair", { token: config.token });
    const bind = await rpc2("bind", bindParams("instance-2"));
    // The deleted session is not resurrected by reopen and the binding identity is stable.
    expect(bind.result.bindingId).toBe(binding.result.bindingId);
    expect(bind.result.sessions).toEqual([]);
  });
});
