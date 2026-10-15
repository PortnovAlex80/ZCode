import { z } from "zod";

/**
 * Sign in with ChatGPT（openai-oauth / GPT 订阅）的共享常量与 UI 安全投影契约。
 *
 * OAuth 协议常量、token 交换与凭据记录的完整定义在 agent 侧
 * `apps/zcode-cli/packages/adapters/src/auth/chatgpt/`（SIWC 实现区域）；
 * 本文件只承载**跨进程稳定**的部分：credential store 键名、离线解析
 * （不返回 token 的 sanitized 视图）以及 Renderer 可见的账号状态 schema。
 *
 * 为什么键名放 shared：Host 进程（packages/services）不依赖 adapters，
 * 但账号投影要读同一个 `~/.zcode/v2/credentials.json`。键字面量必须与
 * adapters `chatgpt-oauth-protocol.ts` 的 `CHATGPT_CREDENTIAL_KEYS` 完全一致；
 * 漂移由 bootstrap 测试（同时 import 两端）守护。Token 值本身只存在于
 * 加密 store，绝不进入本模块的任何返回值、Provider Config、日志或 UI 协议。
 */

/** 与 provider-node 本地增补（GPT-00 路径 A）和 Built-in 规则里的 providerId 保持一致。 */
export const CHATGPT_PROVIDER_ID = "account:chatgpt";

/** ChatGPT 计划用量必需的 scope；缺失时登录保留但推理 fail-closed。 */
export const CHATGPT_TOKEN_SHARING_SCOPE = "chatgpt.tokens.use.direct";

/**
 * 加密凭据存储键（SharedZCodeCredentialStore / services CredentialService 共用同一文件）。
 * 与 adapters `chatgpt-oauth-protocol.ts` 保持字面量同步。
 */
export const CHATGPT_CREDENTIAL_KEYS = {
  /** `urn:uuid:…` 稳定 host 标识。 */
  hostId: "oauth:chatgpt:ext_agent_host_id",
  /** 签发 client_id；logout 后保留供重登录复用。 */
  clientId: "oauth:chatgpt:client_id",
  /** 完整 OAuth 会话记录（单键 JSON，见下方 sanitized 解析）。 */
  credentials: "oauth:chatgpt:credentials",
  /** JSON：[{ slug, display_name }]——/v1/models 缓存。 */
  models: "oauth:chatgpt:models",
} as const;

/** 管理计划用量的官方入口；quota-exhausted 时展示给用户。 */
export const CHATGPT_USAGE_SETTINGS_URL = "https://chatgpt.com/settings/usage";

export interface ChatGptCachedModel {
  readonly slug: string;
  readonly display_name: string;
}

/** 登录账号的展示元数据；只含 ID token claims 的非敏感子集，没有 token。 */
export interface ChatGptAccountSummary {
  readonly subject: string;
  readonly email?: string;
  readonly name?: string;
  readonly plan?: string;
  /** 服务器实际授予的 scope 列表。 */
  readonly scopes: readonly string[];
}

/**
 * Host/UI 侧的 ChatGPT 账号投影状态（计划 §4「状态所有者」表的 sanitized 版本）：
 *
 * - `not-connected`：本地无有效会话记录（含记录损坏的 fail-closed）。
 * - `connected`：已登录，但服务器未授予 `chatgpt.tokens.use.direct`
 *   （官方 errors-and-recovery：保留登录、推理禁用）。
 * - `plan-enabled`：已登录且计划用量 scope 已授予；可执行 GPT 推理。
 * - `reconnect-required`：运行时观察到 refresh 失效 / 会话被撤销，需要重新登录。
 * - `restricted`：运行时观察到 403 policy/region 拒绝；对应请求已停止。
 * - `quota-exhausted`：运行时观察到计划用量耗尽；暂停新的推理并给出用量入口。
 *
 * 后三个状态是运行时观测（agent 进程的 SIWC 错误码），不是本地静态事实；
 * 未接线观测通道时投影最多到达 plan-enabled。
 */
export const chatGptAccountConnectionStatusSchema = z.enum([
  "not-connected",
  "connected",
  "plan-enabled",
  "reconnect-required",
  "restricted",
  "quota-exhausted",
]);
export type ChatGptAccountConnectionStatus = z.infer<typeof chatGptAccountConnectionStatusSchema>;

/** Renderer 可见的账号状态 payload；字段白名单，新增字段必须先过协议评审。 */
export const chatGptAccountStatusSchema = z
  .object({
    status: chatGptAccountConnectionStatusSchema,
    email: z.string().optional(),
    name: z.string().optional(),
    plan: z.string().optional(),
    /** 计划用量管理入口；quota-exhausted / plan-enabled 时给出。 */
    usageUrl: z.string().optional(),
  })
  .strict();
export type ChatGptAccountStatus = z.infer<typeof chatGptAccountStatusSchema>;

/** sanitized 投影里唯一会跨进程走的非敏感视图。 */
export interface ChatGptSanitizedCredentialSnapshot {
  readonly account: ChatGptAccountSummary;
  /** scopes 是否包含计划用量 scope。 */
  readonly planEnabled: boolean;
}

const CHATGPT_CREDENTIAL_RECORD_SCHEMA_VERSION = 1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * 解析单键凭据记录的 sanitized 视图。
 *
 * 校验集合与 adapters `parseChatGptCredentialRecord` 的必需成员一致（schema_version、
 * generation、client_id、access/refresh/id token、account.subject、expires_at、issued_at），
 * 但**只返回**账号展示元数据与 planEnabled；token 字段仅参与「记录是否完整」的判定，
 * 值不离开本函数。任何成员缺失或损坏返回 null（视为未登录，Registry fail-closed）。
 */
export function parseChatGptSanitizedCredentialSnapshot(
  raw: string | null | undefined,
): ChatGptSanitizedCredentialSnapshot | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (parsed.schema_version !== CHATGPT_CREDENTIAL_RECORD_SCHEMA_VERSION) return null;
  const account = isRecord(parsed.account) ? parsed.account : undefined;
  const subject = account ? readNonEmptyString(account.subject) : undefined;
  if (
    !subject ||
    !readNonEmptyString(parsed.generation) ||
    !readNonEmptyString(parsed.client_id) ||
    // token 字段必须存在且非空，才把这条记录当作已登录；值本身不外传。
    !readNonEmptyString(parsed.access_token) ||
    !readNonEmptyString(parsed.refresh_token) ||
    !readNonEmptyString(parsed.id_token) ||
    readFiniteNumber(parsed.expires_at) === undefined ||
    readFiniteNumber(parsed.issued_at) === undefined
  ) {
    return null;
  }
  const scopes =
    account && Array.isArray(account.scopes)
      ? account.scopes.filter(
          (scope): scope is string => typeof scope === "string" && scope.length > 0,
        )
      : [];
  return {
    account: {
      subject,
      ...(readNonEmptyString(account!.email) ? { email: account!.email as string } : {}),
      ...(readNonEmptyString(account!.name) ? { name: account!.name as string } : {}),
      ...(readNonEmptyString(account!.plan) ? { plan: account!.plan as string } : {}),
      scopes,
    },
    planEnabled: scopes.includes(CHATGPT_TOKEN_SHARING_SCOPE),
  };
}

/** 解析 /v1/models 缓存 JSON；损坏或为空返回 null（空目录是合法结果，由上层表达）。 */
export function parseChatGptCachedModelsJson(
  raw: string | null | undefined,
): readonly ChatGptCachedModel[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    const models = parsed.filter(
      (entry): entry is ChatGptCachedModel =>
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
