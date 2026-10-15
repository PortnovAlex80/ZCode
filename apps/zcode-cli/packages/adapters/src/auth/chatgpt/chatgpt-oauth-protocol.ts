/**
 * Sign in with ChatGPT（OpenAI token sharing）协议常量与本地凭据键。
 *
 * 依据官方文档：
 * - https://developers.openai.com/siwc/token-sharing-open-source
 * - https://developers.openai.com/siwc/token-sharing-open-source/sign-in
 * - https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions
 * - https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery
 *
 * 授权 / 令牌端点、动态注册 client、PKCE S256、`ext_agent_host_id`、loopback 回调
 * 均为协议规定值，不得随意改写；仅允许通过 env 覆盖用于测试。
 *
 * 部分常量与键名沿袭自 nasone32/ZCode feat/chatgpt-oauth（commit bd5171cb，
 * docs/chatgpt-oauth.md），按计划 §3 做选择性移植并保留出处。
 */

export const CHATGPT_OAUTH_ISSUER = "https://auth.openai.com";
export const CHATGPT_OAUTH_AUTHORIZE_ENDPOINT = `${CHATGPT_OAUTH_ISSUER}/api/accounts/authorize`;
export const CHATGPT_OAUTH_TOKEN_ENDPOINT = `${CHATGPT_OAUTH_ISSUER}/api/accounts/oauth/token`;
export const CHATGPT_OAUTH_JWKS_URL = `${CHATGPT_OAUTH_ISSUER}/.well-known/jwks.json`;
export const CHATGPT_OAUTH_OPENID_CONFIGURATION_URL = `${CHATGPT_OAUTH_ISSUER}/.well-known/openid-configuration`;

/** 首次登录使用的动态注册入口 client；签发的 client_id 由回调返回并持久化。 */
export const CHATGPT_OAUTH_REGISTRATION_CLIENT_ID = "dynamic_agent_client";
/**
 * 注册时展示给用户的 agent 名称。官方要求为应用真实名称；按本仓库计划 §2，
 * 应用注册名为 `ZCode Harness`，不得冒充官方 Codex 或借用其标识。
 */
export const CHATGPT_OAUTH_AGENT_NAME_HINT = "ZCode Harness";

export const CHATGPT_OAUTH_RESOURCE = "https://api.openai.com/v1";
/** 官方 sign-in 文档要求的 scope 全集；顺序保持文档写法。 */
export const CHATGPT_OAUTH_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "resource.invoke",
  "chatgpt.tokens.use.direct",
] as const;
export const CHATGPT_OAUTH_SCOPE_STRING = CHATGPT_OAUTH_SCOPES.join(" ");
/** ChatGPT 计划用量必需的 scope；缺失时按官方 errors-and-recovery 禁止推理调用。 */
export const CHATGPT_TOKEN_SHARING_SCOPE = "chatgpt.tokens.use.direct";

/** 回调路径必须精确匹配（`/callback` ≠ `/auth/callback`）；host 固定 127.0.0.1。 */
export const CHATGPT_OAUTH_CALLBACK_PATH = "/auth/callback";

/** OpenAI 官方 /v1/models（Bearer OAuth access token）端点。 */
export const CHATGPT_API_BASE_URL = "https://api.openai.com/v1";

/** env 覆盖（测试 / 自托管环境）。 */
export const CHATGPT_OAUTH_ISSUER_ENV = "ZCODE_CHATGPT_OAUTH_ISSUER";
export const CHATGPT_API_BASE_URL_ENV = "ZCODE_CHATGPT_API_BASE_URL";

export function resolveChatGptOAuthIssuer(
  env: Readonly<Record<string, string | undefined>>,
): string {
  return env[CHATGPT_OAUTH_ISSUER_ENV]?.trim() || CHATGPT_OAUTH_ISSUER;
}

export function resolveChatGptApiBaseUrl(
  env: Readonly<Record<string, string | undefined>>,
): string {
  return env[CHATGPT_API_BASE_URL_ENV]?.trim().replace(/\/+$/u, "") || CHATGPT_API_BASE_URL;
}

/**
 * 加密凭据存储键（SharedZCodeCredentialStore，~/.zcode/v2/credentials.json）。
 * Token 只存在这里，绝不进入 Provider Config、日志、遥测或仓库。
 *
 * 与 nasone32 fork 不同，OAuth 会话状态收敛为**单个** `credentials` JSON 键：
 * 落盘是单键事务（save / saveIfValue），不存在多键 delete+write 的中间窗口，
 * 也不可能出现「半个记录」的部分写入状态。
 */
export const CHATGPT_CREDENTIAL_KEYS = {
  /** `urn:uuid:…` 稳定 host 标识；首次登录生成后永不重建。 */
  hostId: "oauth:chatgpt:ext_agent_host_id",
  /** 签发 client_id；logout 后保留，供按官方文档复用重登录。 */
  clientId: "oauth:chatgpt:client_id",
  /** 完整 OAuth 会话记录（单键 JSON，见 chatgpt-credential-record.ts）。 */
  credentials: "oauth:chatgpt:credentials",
  /** JSON：[{ slug, display_name }]——/v1/models 缓存。 */
  models: "oauth:chatgpt:models",
} as const;

/**
 * 提前刷新阈值：官方 token-reference 写明 access token 有效期 1 小时（expires_in: 3600），
 * 留 5 分钟缓冲，避免请求路径上撞 401。
 */
export const CHATGPT_REFRESH_THRESHOLD_MS = 5 * 60 * 1000;
