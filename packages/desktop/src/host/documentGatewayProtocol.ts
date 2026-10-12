import { timingSafeEqual } from "node:crypto";
import type { WebSocket } from "ws";
import { z } from "zod";
import type { createZCodeAgentConnectionScope } from "@zcode/services";
import {
  convertToZCodeAgentMcpServer,
  type ZCodeAgentMcpServer,
  type McpServerConfig,
} from "@zcode/shared";

export const boundedString = z.string().min(1).max(4096);
export const descriptorSchema = z
  .object({
    host: z.enum(["word", "excel", "autocad"]),
    documentId: boundedString,
    documentInstanceId: boundedString,
    name: boundedString,
    url: z.string().max(8192).optional(),
  })
  .strict();
export const configSchema = z
  .object({
    port: z.number().int().min(1024).max(65535).default(43485),
    token: z.string().min(32),
    keyPath: boundedString,
    certPath: boundedString,
    helperPath: boundedString,
    nodePath: boundedString,
    statePath: boundedString,
    workspaces: z.array(boundedString).min(1),
    origins: z.array(boundedString).min(1),
  })
  .strict();
export const messageSchema = z
  .object({
    id: z.string().min(1).max(128),
    method: z.string().min(1).max(128),
    params: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export type Descriptor = z.infer<typeof descriptorSchema>;
export interface Binding {
  id: string;
  key: string;
  secret: string;
  workspacePath: string;
  documentId: string;
  host: Descriptor["host"];
  sessions: string[];
  creations: string[];
}
export interface Connection {
  socket: WebSocket;
  scope: ReturnType<typeof createZCodeAgentConnectionScope>;
  binding?: Binding;
  document?: Descriptor;
  generation: string;
  clientId?: string;
  subscriptions: Set<string>;
  listeners: Array<{ dispose(): void }>;
  closing?: boolean;
  saturated?: boolean;
  drainTimer?: ReturnType<typeof setInterval>;
}
export interface PendingTool {
  connection: Connection;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export function documentTokenMatches(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function mergeDocumentMcpServers(
  records: Array<{ name: string; config: McpServerConfig; enabled?: boolean; scope: string }>,
): ZCodeAgentMcpServer[] {
  const byName = new Map<string, (typeof records)[number]>();
  for (const record of records) {
    const prior = byName.get(record.name);
    if (!prior || (prior.scope !== "workspace" && record.scope === "workspace"))
      byName.set(record.name, record);
  }
  return [...byName.values()]
    .filter((item) => item.enabled !== false)
    .map((item) => convertToZCodeAgentMcpServer(item.name, item.config))
    .filter((item): item is ZCodeAgentMcpServer => item !== null);
}

export type DocumentGatewayConfig = z.infer<typeof configSchema>;
