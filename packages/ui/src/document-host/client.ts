import { DocumentEditReview } from "./review.js";
import type { DocumentAdapter, DocumentProposal } from "./types.js";
export type { DocumentAdapter, DocumentProposal } from "./types.js";
import { createAgentConversationTransport } from "@/v4/agentConversationTransport.js";
import { createCommandEnvelope } from "@/v4/commandFactory.js";
import { hasOlderRows } from "@/v4/conversationProjectionStore.js";
import { SessionDataLayer, type SessionLease } from "@/v4/sessionDataLayer.js";
import {
  COMMANDS_REQUIRING_BASE_REVISION,
  PROTOCOL_V4_LIMITS,
  type CommandPayloadMap,
  type CommandType,
} from "@zcode/shared/zcode-protocol-v4";
export { buildElicitationResponseContent } from "@/lib/elicitationResponse.js";

/** Uses the engine's transport, physical frame assembly and projection store, without workers or Electron Root. */
export class DocumentSessionClient {
  private socket: WebSocket | null = null;
  private pending = new Map<
    string,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private events = new Map<string, Set<(value: unknown) => void>>();
  private layer: SessionDataLayer | null = null;
  private lease: SessionLease | null = null;
  private offStore?: () => void;
  private generation = "";
  private workspacePath = "";
  private recoveryKey = "";
  private unresolved = new Map<
    string,
    { commandId: string; sessionId: string | null; type: CommandType }
  >();
  private cancelledTools = new Set<string>();
  private transport: ReturnType<typeof createAgentConversationTransport> | null = null;
  private review: DocumentEditReview;
  readonly proposals: Map<string, DocumentProposal>;
  constructor(
    private adapter: DocumentAdapter,
    private changed: () => void,
    private failed: (error: Error) => void,
  ) {
    this.review = new DocumentEditReview(
      adapter,
      () => this.generation,
      this.cancelledTools,
      changed,
      (method, params) => this.rpc(method, params),
    );
    this.proposals = this.review.proposals;
  }
  get snapshot() {
    return this.lease?.store.getState().snapshot ?? null;
  }
  get state() {
    return this.lease?.store.getState() ?? null;
  }
  get sessionId() {
    return this.lease?.sessionId ?? null;
  }
  get connected() {
    return this.socket?.readyState === WebSocket.OPEN && Boolean(this.generation);
  }
  get projectPath() {
    return this.workspacePath;
  }
  get unresolvedCommands() {
    return [...this.unresolved.values()];
  }
  get loadingOlder() {
    return this.lease?.store.getState().loadingOlder ?? false;
  }
  get hasOlderRows() {
    return hasOlderRows(this.snapshot);
  }
  /**
   * 旧历史分页（DOCUMENT-HOSTS 冻结契约）：文档面板与 desktop 走同一条原生游标路径
   * （store.loadOlder → transport.rowsRange → conversationRowsRangeV4），不在面板里
   * 维护第二份完整历史拷贝；未连接/未打开会话时是只读 no-op。
   */
  async loadOlder(limit: number = PROTOCOL_V4_LIMITS.snapshotTailWindowRows) {
    await this.lease?.store.loadOlder(limit);
  }
  private saveRecovery() {
    try {
      if (this.recoveryKey)
        localStorage.setItem(this.recoveryKey, JSON.stringify(this.unresolvedCommands));
    } catch {
      /* In-memory command identities still survive a reconnect in this pane. */
    }
    this.changed();
  }
  private listen(name: string, callback: (value: unknown) => void) {
    const listeners = this.events.get(name) ?? new Set();
    listeners.add(callback);
    this.events.set(name, listeners);
    return { dispose: () => listeners.delete(callback) };
  }
  private rpc(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error("Document gateway disconnected"));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Command result unknown; reconcile before resending"));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket!.send(JSON.stringify({ id, method, params }));
    });
  }
  async connect(url: string, token: string, workspacePath: string) {
    this.disconnect();
    const endpoint = new URL(url);
    if (endpoint.protocol !== "wss:" || !["localhost", "127.0.0.1"].includes(endpoint.hostname))
      throw new Error("Loopback WSS endpoint required");
    this.workspacePath = workspacePath;
    const socket = new WebSocket(endpoint);
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error("Document gateway connection timed out"));
      }, 10_000);
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error("Document gateway unavailable"));
        },
        { once: true },
      );
      socket.addEventListener(
        "close",
        () => {
          clearTimeout(timer);
          reject(new Error("Document gateway disconnected"));
        },
        { once: true },
      );
    });
    socket.addEventListener("message", (event) => {
      if (this.socket !== socket) return;
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        this.failed(new Error("Invalid gateway response"));
        socket.close();
        return;
      }
      if (message.id) {
        const request = this.pending.get(message.id);
        if (!request) return;
        clearTimeout(request.timer);
        this.pending.delete(message.id);
        if (message.error) request.reject(new Error(message.error));
        else request.resolve(message.result);
      } else if (message.event === "documentTool") void this.handleTool(message);
      else if (message.event === "documentCancel")
        this.cancelledTools.add(String(message.requestId));
      else
        for (const callback of this.events.get(message.event) ?? [])
          callback(message.frame ?? message.value);
    });
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error("Gateway disconnected; accepted commands are not resent"));
      }
      this.pending.clear();
      this.generation = "";
      this.changed();
    });
    await this.rpc("pair", { token });
    const binding = (await this.rpc("bind", {
      workspacePath,
      document: await this.adapter.descriptor(),
    })) as { bindingId: string; generation: string; sessions: string[]; workspacePath: string };
    this.generation = binding.generation;
    this.workspacePath = binding.workspacePath;
    const recoveryKey = `document-command-recovery:${binding.bindingId}`;
    if (this.recoveryKey !== recoveryKey) this.unresolved.clear();
    this.recoveryKey = recoveryKey;
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(recoveryKey) ?? "[]");
      if (Array.isArray(saved))
        for (const item of saved.slice(0, 64)) {
          if (
            item &&
            typeof item.commandId === "string" &&
            (typeof item.sessionId === "string" || item.sessionId === null) &&
            typeof item.type === "string"
          )
            this.unresolved.set(item.commandId, item);
        }
    } catch {
      /* Storage may be unavailable; retain in-memory unresolved keys. */
    }
    const proxy = new Proxy(
      {},
      {
        get: (_object, name) => {
          if (name === "onDynamicConversationFrame")
            return () => (callback: (value: unknown) => void) => this.listen("frame", callback);
          if (name === "onDynamicLocalTtftFacts") return () => () => ({ dispose() {} });
          if (name === "onAgentRuntimeLifecycle") return undefined;
          if (name === "onAgentRuntimeRestarted")
            return (callback: (value: unknown) => void) => this.listen("runtime", callback);
          return (args: Record<string, unknown> = {}) =>
            this.rpc("agent", {
              name: String(name),
              args:
                name === "initializeConversationV4"
                  ? {
                      ...args,
                      capabilities: {
                        ...(args.capabilities as object),
                        workspaceHookReviewUi: false,
                      },
                    }
                  : args,
            });
        },
      },
    ) as Parameters<typeof createAgentConversationTransport>[0];
    this.transport = createAgentConversationTransport(proxy, { workspacePath: this.workspacePath });
    this.layer = new SessionDataLayer({ transport: this.transport, keepWarmMs: 0 });
    const recovered = await this.reconcile().catch((error) => {
      this.failed(error);
      return [];
    });
    for (const ack of recovered)
      if (
        ack.result &&
        (ack.result.type === "createSession" || ack.result.type === "createSelectionSideSession") &&
        !binding.sessions.includes(ack.result.sessionId)
      )
        binding.sessions.push(ack.result.sessionId);
    this.changed();
    return binding.sessions;
  }
  private handleTool(message: Record<string, unknown>) {
    return this.review.handleTool(message);
  }
  apply(operationId: string) {
    return this.review.apply(operationId);
  }
  async open(sessionId: string) {
    this.offStore?.();
    this.lease?.release();
    if (!this.layer) throw new Error("Connect to the gateway first");
    this.lease = this.layer.acquire(sessionId);
    this.offStore = this.lease.store.subscribe(this.changed);
    this.changed();
  }
  async command<T extends CommandType>(
    type: T,
    payload: CommandPayloadMap[T],
    sessionId = this.sessionId,
  ) {
    if (!this.transport) throw new Error("Connect to ZCODE first");
    if (this.unresolved.size && type !== "stop")
      throw new Error("Reconcile the previous command before submitting another one");
    const envelope = createCommandEnvelope({
      type,
      payload,
      sessionId,
      ...(COMMANDS_REQUIRING_BASE_REVISION.has(type)
        ? { baseRevision: this.snapshot?.revision }
        : {}),
    });
    let ack;
    this.unresolved.set(envelope.commandId, { commandId: envelope.commandId, sessionId, type });
    this.saveRecovery();
    try {
      ack = await this.transport.sendCommand(envelope);
    } catch (error) {
      const result = await this.transport
        .queryCommands({ commands: [{ sessionId, commandId: envelope.commandId }] })
        .catch(() => null);
      const queried = result?.results[0]?.result;
      if (queried && queried !== "unknown") ack = queried;
      else {
        this.failed(
          new Error(
            `Command ${envelope.commandId}: result unknown; reconnect and reconcile before another submission`,
          ),
        );
        throw error;
      }
    }
    this.unresolved.delete(envelope.commandId);
    this.saveRecovery();
    if (!["accepted", "duplicate", "noop"].includes(ack.status)) {
      // 原因：rejected ACK 的 message 可能不含 reasonCode，旧的 `message ?? reasonCode`
      // 拼接会把唯一的结构化信号（如 proto.sessionNotFound——会话已被外部删除，gateway
      // 同时撤销绑定）藏进自然语言，面板无法据此显示「线程已不存在」。修复依据：
      // reasonCode 是协议规定 rejected/stale/noop/failed 必带的机器信号，固定前置
      // 输出，message 仅作补充，两者同时可见。
      const detail = [ack.reasonCode, ack.message].filter(Boolean).join(": ");
      throw new Error(detail || ack.status);
    }
    return ack;
  }
  async reconcile() {
    if (!this.transport || !this.unresolved.size) return [];
    const result = await this.transport.queryCommands({
      commands: this.unresolvedCommands.map(({ commandId, sessionId }) => ({
        commandId,
        sessionId,
      })),
    });
    const confirmed = [];
    for (const item of result.results)
      if (item.result !== "unknown") {
        this.unresolved.delete(item.key.commandId);
        confirmed.push(item.result);
      }
    this.saveRecovery();
    return confirmed;
  }
  acknowledgeUnknown(commandId: string) {
    // Explicit user action after inspecting the native conversation; never automatically resend.
    this.unresolved.delete(commandId);
    this.saveRecovery();
  }
  async create() {
    const ack = await this.command(
      "createSession",
      { workspaceId: this.workspacePath, config: { mode: "build" } },
      null,
    );
    if (ack.result?.type !== "createSession") throw new Error("Session creation not confirmed");
    await this.open(ack.result.sessionId);
    return ack.result.sessionId;
  }
  async side() {
    const ack = await this.command("createSelectionSideSession", {});
    if (ack.result?.type !== "createSelectionSideSession")
      throw new Error("Side session creation not confirmed");
    await this.open(ack.result.sessionId);
    return ack.result.sessionId;
  }
  disconnect() {
    this.offStore?.();
    this.offStore = undefined;
    this.lease?.release();
    this.lease = null;
    this.layer?.dispose();
    this.layer = null;
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.generation = "";
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("Document connection closed"));
    }
    this.pending.clear();
    this.events.clear();
    this.transport = null;
    this.cancelledTools.clear();
  }
}
