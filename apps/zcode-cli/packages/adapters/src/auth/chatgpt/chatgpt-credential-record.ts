import { randomBytes, randomUUID } from "node:crypto";
import type { SharedZCodeCredentialStore } from "../shared-credentials.js";
import {
  CHATGPT_CREDENTIAL_KEYS,
  CHATGPT_REFRESH_THRESHOLD_MS,
} from "./chatgpt-oauth-protocol.js";
import {
  parseEarliestRefreshAt,
  type ChatGptModelListEntry,
  type ChatGptTokenResponse,
} from "./chatgpt-oauth-client.js";

/**
 * ChatGPT OAuth 凭据记录：只存在于加密 SharedZCodeCredentialStore
 * （~/.zcode/v2/credentials.json，AES-256-GCM，0600 原子写 + 文件锁），
 * 不得进入 Provider Config、日志、遥测或仓库。
 *
 * 与 nasone32 fork（commit bd5171cb，多键 access/refresh/id/… 各自读写）不同，
 * 这里把整个 OAuth 会话收敛为**单键 JSON**：
 * - 持久化 = 单键 `save`（登录，用户显式替换）/ 单键 `saveIfValue` CAS（refresh 轮换），
 *   都是 store 内一个文件锁事务；不存在 delete+write 序列，kill 不产生半记录；
 * - 失效 = 单键 `deleteIfValue`（generation 守卫），不会删掉并行进程刚写的新会话；
 * - `generation` 为每次发布的新随机 id（同 mcp/oauth-credentials 的 house pattern），
 *   follower 用它观察「换代」，refresh 用它做 CAS 与 stale-run 防护。
 */

export const CHATGPT_CREDENTIAL_RECORD_SCHEMA_VERSION = 1;

export interface ChatGptAccountSummary {
  readonly subject: string;
  readonly email?: string;
  readonly name?: string;
  readonly plan?: string;
  /** 服务器实际授予的 scope 列表；缺 chatgpt.tokens.use.direct 时推理 fail-closed。 */
  readonly scopes: readonly string[];
}

export interface ChatGptCredentialRecord {
  /** 每次发布唯一的随机 id；跨进程观察换代与 CAS 失效的依据。 */
  readonly generation: string;
  readonly clientId: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly idToken: string;
  readonly account: ChatGptAccountSummary;
  /** epoch ms；access token 过期时间。 */
  readonly expiresAt: number;
  /** epoch ms；官方 earliest_refresh_at——refresh 请求不得早于该时刻发出。 */
  readonly earliestRefreshAt?: number;
  /** epoch ms；本组 token 的获取时间。 */
  readonly issuedAt: number;
}

/** 序列化为确定性 JSON（固定键序），作为 store 的单键值与 CAS 比较基准。 */
export function serializeChatGptCredentialRecord(record: ChatGptCredentialRecord): string {
  const stored: Record<string, unknown> = {
    schema_version: CHATGPT_CREDENTIAL_RECORD_SCHEMA_VERSION,
    generation: record.generation,
    client_id: record.clientId,
    access_token: record.accessToken,
    refresh_token: record.refreshToken,
    id_token: record.idToken,
    account: {
      subject: record.account.subject,
      ...(record.account.email ? { email: record.account.email } : {}),
      ...(record.account.name ? { name: record.account.name } : {}),
      ...(record.account.plan ? { plan: record.account.plan } : {}),
      scopes: [...record.account.scopes],
    },
    expires_at: record.expiresAt,
    ...(record.earliestRefreshAt !== undefined
      ? { earliest_refresh_at: record.earliestRefreshAt }
      : {}),
    issued_at: record.issuedAt,
  };
  return JSON.stringify(stored);
}

export function parseChatGptCredentialRecord(raw: string | null): ChatGptCredentialRecord | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (parsed.schema_version !== CHATGPT_CREDENTIAL_RECORD_SCHEMA_VERSION) return null;
  const generation = readNonEmptyString(parsed.generation);
  const clientId = readNonEmptyString(parsed.client_id);
  const accessToken = readNonEmptyString(parsed.access_token);
  const refreshToken = readNonEmptyString(parsed.refresh_token);
  const idToken = readNonEmptyString(parsed.id_token);
  const expiresAt = readFiniteNumber(parsed.expires_at);
  const issuedAt = readFiniteNumber(parsed.issued_at);
  const account = isRecord(parsed.account) ? parsed.account : undefined;
  const subject = account ? readNonEmptyString(account.subject) : undefined;
  const scopes =
    account && Array.isArray(account.scopes)
      ? account.scopes.filter((scope): scope is string => typeof scope === "string" && scope.length > 0)
      : [];
  if (
    !generation ||
    !clientId ||
    !accessToken ||
    !refreshToken ||
    !idToken ||
    !subject ||
    expiresAt === undefined ||
    issuedAt === undefined
  ) {
    // 任一必需成员缺失或损坏即视为未登录（fail-closed），不抛出。
    return null;
  }
  const earliestRefreshAt = readFiniteNumber(parsed.earliest_refresh_at);
  return {
    generation,
    clientId,
    accessToken,
    refreshToken,
    idToken,
    account: {
      subject,
      ...(readNonEmptyString(account!.email) ? { email: readNonEmptyString(account!.email) } : {}),
      ...(readNonEmptyString(account!.name) ? { name: readNonEmptyString(account!.name) } : {}),
      ...(readNonEmptyString(account!.plan) ? { plan: readNonEmptyString(account!.plan) } : {}),
      scopes,
    },
    expiresAt,
    ...(earliestRefreshAt !== undefined ? { earliestRefreshAt } : {}),
    issuedAt,
  };
}

export interface ChatGptCredentialSnapshot {
  readonly record: ChatGptCredentialRecord;
  /** 原始 JSON，供 saveIfValue / deleteIfValue 的 generation CAS 使用。 */
  readonly raw: string;
}

/** 读取完整凭据快照；未登录或记录损坏返回 null。 */
export async function readChatGptCredentialSnapshot(
  store: Pick<SharedZCodeCredentialStore, "load">,
): Promise<ChatGptCredentialSnapshot | null> {
  const raw = await store.load(CHATGPT_CREDENTIAL_KEYS.credentials);
  const record = parseChatGptCredentialRecord(raw);
  return record ? { record, raw: raw! } : null;
}

export async function readChatGptCredentialRecord(
  store: Pick<SharedZCodeCredentialStore, "load">,
): Promise<ChatGptCredentialRecord | null> {
  return (await readChatGptCredentialSnapshot(store))?.record ?? null;
}

/** 稳定 ext_agent_host_id：首次生成 `urn:uuid:…`，此后跨登录复用（官方推荐格式）。 */
export async function resolveChatGptHostId(
  store: Pick<SharedZCodeCredentialStore, "load" | "save">,
): Promise<string> {
  const existing = (await store.load(CHATGPT_CREDENTIAL_KEYS.hostId))?.trim();
  if (existing) return existing;
  const hostId = `urn:uuid:${randomUUID()}`;
  await store.save(CHATGPT_CREDENTIAL_KEYS.hostId, hostId);
  return hostId;
}

export async function readChatGptClientId(
  store: Pick<SharedZCodeCredentialStore, "load">,
): Promise<string | undefined> {
  return (await store.load(CHATGPT_CREDENTIAL_KEYS.clientId))?.trim() || undefined;
}

export function createChatGptCredentialGeneration(): string {
  return randomBytes(16).toString("hex");
}

/** token 端点响应 + 校验产物 → 新凭据记录（新 generation；不落盘，由调用方写入）。 */
export function toChatGptCredentialRecord(input: {
  readonly clientId: string;
  readonly previousIdToken?: string;
  readonly tokenResponse: ChatGptTokenResponse;
  readonly scopes: readonly string[];
  readonly accountClaims: {
    readonly subject: string;
    readonly email?: string;
    readonly name?: string;
    readonly plan?: string;
  };
  readonly now?: () => number;
}): ChatGptCredentialRecord {
  const now = input.now ?? Date.now;
  return {
    generation: createChatGptCredentialGeneration(),
    clientId: input.clientId,
    accessToken: input.tokenResponse.access_token,
    refreshToken: input.tokenResponse.refresh_token ?? "",
    idToken: input.tokenResponse.id_token ?? input.previousIdToken ?? "",
    account: {
      subject: input.accountClaims.subject,
      ...(input.accountClaims.email ? { email: input.accountClaims.email } : {}),
      ...(input.accountClaims.name ? { name: input.accountClaims.name } : {}),
      ...(input.accountClaims.plan ? { plan: input.accountClaims.plan } : {}),
      scopes: [...input.scopes],
    },
    expiresAt: now() + (input.tokenResponse.expires_in ?? 3600) * 1000,
    earliestRefreshAt: parseEarliestRefreshAt(input.tokenResponse.earliest_refresh_at),
    issuedAt: now(),
  };
}

/**
 * 登录路径的全量写入：无条件替换单键（用户显式完成新授权，last-writer-wins）。
 * 必须存在 refresh token；缺 refresh token 的会话无法续期，直接拒绝落盘。
 */
export async function writeChatGptCredentialRecord(
  store: Pick<SharedZCodeCredentialStore, "save">,
  record: ChatGptCredentialRecord,
): Promise<void> {
  if (!record.refreshToken) {
    throw new Error("ChatGPT credential record requires a refresh token.");
  }
  await store.save(CHATGPT_CREDENTIAL_KEYS.credentials, serializeChatGptCredentialRecord(record));
}

/**
 * refresh 轮换的 CAS 持久化：存储值仍是本次刷新捕获的原始 JSON 才写入新记录。
 *
 * 返回 false 表示等锁/网络期间记录已被替换（例如并发重新登录）：本次轮换结果属于
 * 已被取代的会话，必须丢弃并回读现值——不得用旧会话覆盖新登录（stale-run 防护）。
 */
export async function saveRefreshedChatGptCredentialRecord(
  store: Pick<SharedZCodeCredentialStore, "saveIfValue">,
  next: ChatGptCredentialRecord,
  expectedRaw: string,
): Promise<boolean> {
  if (!next.refreshToken) {
    throw new Error("ChatGPT credential record requires a refresh token.");
  }
  return store.saveIfValue(
    CHATGPT_CREDENTIAL_KEYS.credentials,
    expectedRaw,
    serializeChatGptCredentialRecord(next),
  );
}

/**
 * 条件清空 ChatGPT 会话记录（generation 守卫的单键 deleteIfValue）。
 *
 * 仅当存储值仍等于 `expectedRaw`（本次使用的记录）才删除：不可用 refresh token 的
 * 清理不会误删并行进程刚轮换出的新会话。host/client 标识保留在独立键中，
 * 供按官方文档用已保存 client_id 重走 OAuth。
 */
export async function clearChatGptCredentialRecordIfUnchanged(
  store: Pick<SharedZCodeCredentialStore, "deleteIfValue">,
  expectedRaw: string,
): Promise<boolean> {
  return store.deleteIfValue(CHATGPT_CREDENTIAL_KEYS.credentials, expectedRaw);
}

/** token 是否仍在提前刷新阈值之内（无需网络请求即可直接使用）。 */
export function isChatGptAccessTokenFresh(
  record: ChatGptCredentialRecord,
  now: number,
  thresholdMs: number = CHATGPT_REFRESH_THRESHOLD_MS,
): boolean {
  return now + thresholdMs < record.expiresAt;
}

export async function readChatGptCachedModels(
  store: Pick<SharedZCodeCredentialStore, "load">,
): Promise<readonly ChatGptModelListEntry[] | null> {
  const raw = await store.load(CHATGPT_CREDENTIAL_KEYS.models);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    const models = parsed.filter(
      (entry): entry is ChatGptModelListEntry =>
        isRecord(entry) &&
        typeof entry.slug === "string" &&
        entry.slug.trim().length > 0 &&
        typeof entry.display_name === "string" &&
        entry.display_name.trim().length > 0,
    );
    return models.length > 0 ? models : null;
  } catch {
    return null;
  }
}

export async function writeChatGptCachedModels(
  store: Pick<SharedZCodeCredentialStore, "save">,
  models: readonly ChatGptModelListEntry[],
): Promise<void> {
  await store.save(
    CHATGPT_CREDENTIAL_KEYS.models,
    JSON.stringify(
      models.map((model) => ({ slug: model.slug, display_name: model.display_name })),
    ),
  );
}

export async function deleteChatGptCachedModels(
  store: Pick<SharedZCodeCredentialStore, "delete">,
): Promise<void> {
  await store.delete(CHATGPT_CREDENTIAL_KEYS.models);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
