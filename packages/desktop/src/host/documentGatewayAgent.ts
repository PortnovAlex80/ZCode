import { z } from "zod";
import { IMcpSyncService, type ServiceCollection } from "@zcode/services";
import {
  parseCommandEnvelope,
  commandPayloadSchemas,
  clientHelloSchema,
} from "@zcode/shared/zcode-protocol-v4";
import {
  boundedString,
  mergeDocumentMcpServers,
  type Binding,
  type Connection,
  type DocumentGatewayConfig,
} from "./documentGatewayProtocol.js";

interface AgentContext {
  current: Connection;
  config: DocumentGatewayConfig;
  services: ServiceCollection;
  send(connection: Connection, value: unknown): void;
  persist(): Promise<void>;
  ensureOpen(): void;
}

/** Constrains native CLI commands to the document binding; never starts a second agent core. */
export async function dispatchDocumentAgent(
  params: Record<string, unknown>,
  context: AgentContext,
) {
  const { current, config, services, send, persist, ensureOpen } = context;
  const requireBinding = (connection: Connection): Binding => {
    if (!connection.binding || !connection.document)
      throw new Error("Choose a project and document first");
    return connection.binding;
  };
  const requireSession = (connection: Connection, sessionId: unknown) => {
    if (typeof sessionId !== "string" || !requireBinding(connection).sessions.includes(sessionId))
      throw new Error("Session does not belong to this document binding");
  };
  const retractSession = async (sessionId: string) => {
    if (!binding.sessions.includes(sessionId)) return;
    binding.sessions = binding.sessions.filter((id) => id !== sessionId);
    await persist();
  };
  // 原因：会话可能在外部被删除（任务列表删除、存储清理），但 gateway 持久化的
  // binding.sessions 仍保留该 id，重开文档时会复活已删除的线程。修复依据：CLI 冷恢复
  // 对「内存注册表与 store 都没有」的会话抛结构化 fault.subscribe.sessionNotFound
  // （cold-session-resume.ts，reasonCode 内嵌在 message 中跨 RPC 透传），订阅失败时
  // 按该信号撤销绑定并持久化；错误仍原样抛出，失败对 pane 保持可见。
  const runtimeReportsSessionDeleted = (error: unknown) =>
    error instanceof Error && error.message.includes("fault.subscribe.sessionNotFound");
  const binding = requireBinding(current);
  const method = String(params.name);
  const input = z.record(z.string(), z.unknown()).parse(params.args ?? {});
  const agent = current.scope.service;
  const workspace = { workspacePath: binding.workspacePath };
  if (method === "helloConversationV4") return agent.helloConversationV4();
  if (method === "initializeConversationV4") {
    const hello = clientHelloSchema.parse(input);
    if (hello.clientKind !== "web")
      throw new Error("Document pane requires a web client handshake");
    if (current.clientId && current.clientId !== hello.clientId)
      throw new Error("Reconnect before changing client identity");
    current.clientId = hello.clientId;
    return agent.initializeConversationV4(hello);
  }
  if (method === "subscribeConversationV4") {
    requireSession(current, input.sessionId);
    if (current.listeners.length === 1)
      current.listeners.push(
        agent.onDynamicConversationFrame(workspace)((frame) =>
          send(current, { event: "frame", frame }),
        ),
      );
    try {
      const result = await agent.subscribeConversationV4({
        ...workspace,
        sessionId: String(input.sessionId),
        visibility: "foreground",
      });
      current.subscriptions.add(result.ack.subscriptionId);
      return result;
    } catch (error) {
      if (runtimeReportsSessionDeleted(error)) await retractSession(String(input.sessionId));
      throw error;
    }
  }
  if (method === "resyncConversationV4" || method === "unsubscribeConversationV4") {
    const subscriptionId = boundedString.parse(input.subscriptionId);
    if (!current.subscriptions.has(subscriptionId))
      throw new Error("Subscription is not owned by this document pane");
    if (method === "resyncConversationV4")
      return agent.resyncConversationV4({
        ...workspace,
        subscriptionId,
        base: null,
        forceSnapshot: true,
      });
    current.subscriptions.delete(subscriptionId);
    return agent.unsubscribeConversationV4({ ...workspace, subscriptionId });
  }
  if (method === "conversationRowsRangeV4") {
    requireSession(current, input.sessionId);
    return agent.conversationRowsRangeV4({
      ...workspace,
      sessionId: String(input.sessionId),
      ...(input.beforeRowId !== undefined
        ? { beforeRowId: z.number().int().nonnegative().parse(input.beforeRowId) }
        : {}),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .parse(input.limit ?? 200),
    });
  }
  if (method === "queryConversationCommandsV4") {
    const commands = z
      .array(z.object({ sessionId: z.string().nullable(), commandId: boundedString }).strict())
      .min(1)
      .max(64)
      .parse(input.commands);
    for (const command of commands) {
      if (command.sessionId) requireSession(current, command.sessionId);
      else if (!binding.creations.includes(command.commandId))
        throw new Error("Creation command is not owned by this document binding");
    }
    const result = await agent.queryConversationCommandsV4({ ...workspace, commands });
    for (const item of result.results) {
      if (
        item.result !== "unknown" &&
        item.result.result &&
        ["createSession", "createSelectionSideSession"].includes(item.result.result.type)
      ) {
        const created = item.result.result as { sessionId: string };
        if (!binding.sessions.includes(created.sessionId)) binding.sessions.push(created.sessionId);
      }
    }
    await persist();
    return result;
  }
  if (method !== "sendConversationCommandV4")
    throw new Error("Agent method unavailable in document pane");
  const parsed = parseCommandEnvelope(input.envelope);
  if (!parsed.ok) throw new Error("Invalid native command envelope");
  const envelope = parsed.envelope;
  if (envelope.clientId !== current.clientId) throw new Error("Client identity mismatch");
  if (
    ![
      "createSession",
      "createSelectionSideSession",
      "sendText",
      "stop",
      "resolveInteraction",
      "snoozeAskUserQuestionAutoResolution",
      "deleteSession",
      "renameSession",
      "switchModelConfig",
      "switchCollaborationMode",
    ].includes(envelope.type)
  )
    throw new Error("Command unavailable in document pane");
  if (envelope.type === "createSession") {
    const payload = commandPayloadSchemas.createSession.parse(envelope.payload);
    if (
      payload.workspaceId !== binding.workspacePath ||
      payload.firstInput ||
      payload.mcpServers ||
      envelope.sessionId !== null
    )
      throw new Error("Gateway alone configures document session startup");
    const sources = await services.get(IMcpSyncService).loadMcpFromUserDirectory(workspace);
    ensureOpen();
    const servers = mergeDocumentMcpServers(sources.servers);
    if (servers.some((item) => item.name === "spec_harness_document"))
      throw new Error("Document MCP name collision");
    payload.mcpServers = [
      ...servers,
      {
        name: "spec_harness_document",
        command: config.nodePath,
        args: [
          config.helperPath,
          "--endpoint",
          `https://localhost:${config.port}/tool`,
          "--binding",
          binding.id,
          "--ca",
          config.caPath,
        ],
        env: [
          { name: "ZCODE_DOCUMENT_BINDING_SECRET", value: binding.secret },
          { name: "ELECTRON_RUN_AS_NODE", value: "1" },
        ],
        isolation: "session",
        protocolVersion: "auto",
        timeoutMs: 30_000,
      },
    ];
    envelope.payload = payload;
  } else requireSession(current, envelope.sessionId);
  if (envelope.type === "createSession") {
    if (!binding.creations.includes(envelope.commandId)) binding.creations.push(envelope.commandId);
    binding.creations = binding.creations.slice(-512);
    await persist();
  }
  ensureOpen();
  const ack = await agent.sendConversationCommandV4({ ...workspace, envelope });
  if (
    ack.result &&
    (ack.result.type === "createSession" || ack.result.type === "createSelectionSideSession")
  ) {
    const sessionId = ack.result.sessionId;
    if (!binding.sessions.includes(sessionId)) binding.sessions.push(sessionId);
    await persist();
  }
  if (envelope.type === "deleteSession" && ack.status === "accepted" && envelope.sessionId !== null)
    await retractSession(envelope.sessionId);
  // 原因：会话被外部删除后，session 命令在 CLI inbox 裁决阶段即被拒
  // （status=rejected + reasonCode=proto.sessionNotFound，command-inbox.ts decide），
  // 旧逻辑会让持久化绑定残留死 id。修复依据：仅在该结构化信号下撤销并持久化；
  // 其它拒绝/失败（如 staleRevision、执行失败）不撤销，避免把仍持久存在的会话
  // 误判为已删除而搁浅（stranded）；rejected ACK 原样返回 pane，失败保持可见。
  if (
    envelope.sessionId !== null &&
    ack.status === "rejected" &&
    ack.reasonCode === "proto.sessionNotFound"
  )
    await retractSession(envelope.sessionId);
  return ack;
}
