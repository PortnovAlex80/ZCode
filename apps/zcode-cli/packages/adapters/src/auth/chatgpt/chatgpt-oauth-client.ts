import { withChatGptRequestDeadline } from "./chatgpt-request-deadline.js";
import {
  CHATGPT_OAUTH_AGENT_NAME_HINT,
  CHATGPT_OAUTH_REGISTRATION_CLIENT_ID,
  CHATGPT_OAUTH_RESOURCE,
  CHATGPT_OAUTH_SCOPE_STRING,
  CHATGPT_TOKEN_SHARING_SCOPE,
  resolveChatGptApiBaseUrl,
  resolveChatGptOAuthIssuer,
} from "./chatgpt-oauth-protocol.js";

/**
 * Sign in with ChatGPT OAuth 客户端：纯协议层，不含任何持久化。
 *
 * 覆盖：authorize URL（动态注册 + 重登录）、loopback 回调解析、PKCE code 交换、
 * refresh（不带 scope 以保留授权）、OpenID discovery 撤销、/v1/models 列表与
 * scope 门禁。id_token 的 JWKS/RS256 校验在 chatgpt-id-token.ts；凭据持久化由
 * chatgpt-credential-record / chatgpt-refresh-coordinator 负责；错误信息只含
 * 结构化 code 与被打码的字段，不回显 token。
 *
 * 骨架移植自 nasone32/ZCode feat/chatgpt-oauth（commit bd5171cb）
 * apps/zcode-cli/packages/adapters/src/auth/chatgpt/chatgpt-oauth-client.ts，
 * 端点与参数对照官方文档复核后调整。
 */

export type ChatGptOAuthFetch = typeof globalThis.fetch;

export interface ChatGptOAuthEndpoints {
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  readonly jwksUrl: string;
  readonly openidConfigurationUrl: string;
  readonly apiBaseUrl: string;
}

export function resolveChatGptOAuthEndpoints(
  env: Readonly<Record<string, string | undefined>>,
): ChatGptOAuthEndpoints {
  const issuer = resolveChatGptOAuthIssuer(env);
  return {
    authorizeUrl: `${issuer}/api/accounts/authorize`,
    tokenUrl: `${issuer}/api/accounts/oauth/token`,
    jwksUrl: `${issuer}/.well-known/jwks.json`,
    openidConfigurationUrl: `${issuer}/.well-known/openid-configuration`,
    apiBaseUrl: resolveChatGptApiBaseUrl(env),
  };
}

export class ChatGptOAuthError extends Error {
  readonly code: string;
  readonly oauthError?: string;
  readonly oauthErrorDescription?: string;
  readonly httpStatus?: number;

  constructor(
    code: string,
    message: string,
    options: {
      oauthError?: string;
      oauthErrorDescription?: string;
      httpStatus?: number;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ChatGptOAuthError";
    this.code = code;
    this.oauthError = options.oauthError;
    this.oauthErrorDescription = options.oauthErrorDescription;
    this.httpStatus = options.httpStatus;
  }
}

/**
 * 官方 errors-and-recovery「Refresh errors」列出的不可用 refresh token 错误码：
 * 清空令牌并用已保存 client_id 重走 OAuth。
 */
const UNUSABLE_REFRESH_TOKEN_OAUTH_ERRORS = new Set([
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
]);

export function isUnusableRefreshTokenError(error: unknown): error is ChatGptOAuthError {
  if (!(error instanceof ChatGptOAuthError)) return false;
  if (error.code === "chatgpt_refresh_token_unusable") return true;
  return error.oauthError !== undefined && UNUSABLE_REFRESH_TOKEN_OAUTH_ERRORS.has(error.oauthError);
}

export interface ChatGptAuthorizeUrlInput {
  readonly redirectUri: string;
  readonly state: string;
  readonly nonce: string;
  readonly codeChallenge: string;
  readonly extAgentHostId: string;
  /** 已签发 client_id；缺省表示首次动态注册。 */
  readonly clientId?: string;
  /** 已保存账号 email；作为 login_hint 提示登录服务器。 */
  readonly loginHint?: string;
  /** 重登时携带已保留 id_token，跳过会话选择器（可过期，仅标识账号）。 */
  readonly idTokenHint?: string;
  readonly agentNameHint?: string;
}

export function buildChatGptAuthorizeUrl(
  authorizeEndpoint: string,
  input: ChatGptAuthorizeUrlInput,
): string {
  const isFirstRegistration = !input.clientId;
  const url = new URL(authorizeEndpoint);
  url.searchParams.set("client_id", input.clientId ?? CHATGPT_OAUTH_REGISTRATION_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", CHATGPT_OAUTH_SCOPE_STRING);
  url.searchParams.set("resource", CHATGPT_OAUTH_RESOURCE);
  url.searchParams.set("state", input.state);
  url.searchParams.set("nonce", input.nonce);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("ext_agent_host_id", input.extAgentHostId);
  if (isFirstRegistration) {
    // 官方文档：agent_name_hint 只在首次动态注册时携带，且必须是应用真实名称。
    url.searchParams.set("agent_name_hint", input.agentNameHint ?? CHATGPT_OAUTH_AGENT_NAME_HINT);
  }
  if (input.loginHint) url.searchParams.set("login_hint", input.loginHint);
  if (input.idTokenHint) url.searchParams.set("id_token_hint", input.idTokenHint);
  return url.toString();
}

export interface ChatGptTokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  earliest_refresh_at?: number | string;
}

export interface ChatGptCallbackQuery {
  readonly code?: string;
  readonly state?: string;
  readonly clientId?: string;
  readonly oauthError?: string;
  readonly oauthErrorDescription?: string;
}

export function parseChatGptCallbackUrl(callbackUrl: string): ChatGptCallbackQuery {
  const url = new URL(callbackUrl);
  return {
    code: url.searchParams.get("code") ?? undefined,
    state: url.searchParams.get("state") ?? undefined,
    clientId: url.searchParams.get("client_id") ?? undefined,
    oauthError: url.searchParams.get("error") ?? undefined,
    oauthErrorDescription: url.searchParams.get("error_description") ?? undefined,
  };
}

async function postFormTokenRequest(
  tokenEndpoint: string,
  params: Record<string, string>,
  fetchImpl: ChatGptOAuthFetch,
): Promise<ChatGptTokenResponse> {
  return withChatGptRequestDeadline(async (signal) => {
    let response: Response;
    try {
      response = await fetchImpl(tokenEndpoint, {
        method: "POST",
        signal,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: new URLSearchParams(params).toString(),
      });
    } catch (error) {
      throw new ChatGptOAuthError(
        "chatgpt_token_network_error",
        "Unable to reach the OpenAI token endpoint.",
        { cause: error },
      );
    }
    const text = await response.text();
    let body: unknown = undefined;
    try {
      body = text ? (JSON.parse(text) as unknown) : undefined;
    } catch {
      body = undefined;
    }
    if (!response.ok || !isRecord(body)) {
      const oauthError = isRecord(body) ? readString(body.error) : undefined;
      const oauthErrorDescription = isRecord(body)
        ? readString(body.error_description) ?? readString(body.error_message)
        : undefined;
      throw new ChatGptOAuthError(
        "chatgpt_token_request_failed",
        `OpenAI token endpoint returned ${response.status}.`,
        { oauthError, oauthErrorDescription, httpStatus: response.status },
      );
    }
    return body as unknown as ChatGptTokenResponse;
  }, new ChatGptOAuthError("chatgpt_token_timeout", "OpenAI token request timed out."));
}

export interface ChatGptCodeExchangeInput {
  readonly clientId: string;
  readonly code: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
}

export async function exchangeChatGptAuthorizationCode(
  tokenEndpoint: string,
  input: ChatGptCodeExchangeInput,
  fetchImpl: ChatGptOAuthFetch,
): Promise<ChatGptTokenResponse> {
  // 官方 sign-in 文档：authorization_code 交换 form-encoded 携带签发 client_id、code、
  // code_verifier、同一 redirect_uri 与 resource；无 client secret。
  return postFormTokenRequest(
    tokenEndpoint,
    {
      grant_type: "authorization_code",
      client_id: input.clientId,
      code: input.code,
      code_verifier: input.codeVerifier,
      redirect_uri: input.redirectUri,
      resource: CHATGPT_OAUTH_RESOURCE,
    },
    fetchImpl,
  );
}

export interface ChatGptRefreshInput {
  readonly clientId: string;
  readonly refreshToken: string;
}

export async function refreshChatGptAccessToken(
  tokenEndpoint: string,
  input: ChatGptRefreshInput,
  fetchImpl: ChatGptOAuthFetch,
): Promise<ChatGptTokenResponse> {
  // 官方 profiles-and-sessions 文档：refresh 使用保存的签发 client_id（不是
  // dynamic_agent_client）、保存的 refresh_token 与 resource；**不带 scope** 以保留授权。
  return postFormTokenRequest(
    tokenEndpoint,
    {
      grant_type: "refresh_token",
      client_id: input.clientId,
      refresh_token: input.refreshToken,
      resource: CHATGPT_OAUTH_RESOURCE,
    },
    fetchImpl,
  );
}

/** 撤销可续期会话；官方文档：空 200 视为成功（对已失效 token 同样返回 200）。 */
export async function revokeChatGptSession(
  openidConfigurationUrl: string,
  input: { clientId: string; refreshToken: string },
  fetchImpl: ChatGptOAuthFetch,
): Promise<void> {
  const configurationResponse = await fetchImpl(openidConfigurationUrl, {
    headers: { accept: "application/json" },
  });
  if (!configurationResponse.ok) {
    throw new ChatGptOAuthError(
      "chatgpt_discovery_failed",
      `OpenID configuration request failed: ${configurationResponse.status}`,
      { httpStatus: configurationResponse.status },
    );
  }
  const configuration = (await configurationResponse.json()) as Record<string, unknown>;
  const revocationEndpoint = readString(configuration.revocation_endpoint);
  if (!revocationEndpoint) {
    throw new ChatGptOAuthError(
      "chatgpt_revocation_endpoint_missing",
      "OpenID configuration has no revocation_endpoint.",
    );
  }
  const response = await fetchImpl(revocationEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams({
      token: input.refreshToken,
      token_type_hint: "refresh_token",
      client_id: input.clientId,
    }).toString(),
  });
  if (!response.ok) {
    throw new ChatGptOAuthError(
      "chatgpt_revocation_failed",
      `Session revocation failed: ${response.status}`,
      { httpStatus: response.status },
    );
  }
}


export interface ChatGptModelListEntry {
  readonly slug: string;
  readonly display_name: string;
}

export interface ChatGptModelListResult {
  readonly models: readonly ChatGptModelListEntry[];
}

/** GET /v1/models（Bearer OAuth token）；按官方文档过滤 visibility == "list"。 */
export async function fetchChatGptModelList(
  modelsEndpoint: string,
  accessToken: string,
  fetchImpl: ChatGptOAuthFetch,
): Promise<ChatGptModelListResult> {
  return withChatGptRequestDeadline(
    async (signal) => {
      let response: Response;
      try {
        response = await fetchImpl(modelsEndpoint, {
          headers: {
            authorization: `Bearer ${accessToken}`,
            accept: "application/json",
          },
          signal,
        });
      } catch (error) {
        throw new ChatGptOAuthError(
          "chatgpt_models_network_error",
          "Unable to load the ChatGPT model list.",
          { cause: error },
        );
      }
      if (!response.ok) {
        throw new ChatGptOAuthError(
          "chatgpt_models_request_failed",
          `Model list request failed: ${response.status}`,
          { httpStatus: response.status },
        );
      }
      const body = (await response.json()) as unknown;
      const models =
        isRecord(body) && Array.isArray(body.models) ? body.models : [];
      const entries: ChatGptModelListEntry[] = [];
      for (const entry of models) {
        if (!isRecord(entry)) continue;
        const slug = readString(entry.slug);
        const displayName = readString(entry.display_name);
        if (!slug || !displayName) continue;
        // 文档：只暴露 visibility == "list" 且可在 API 使用的模型；空目录不上报为错误，
        // 由调用方按「有效空目录」处理（计划 §3 备注 5：不得用 seed 模型顶替）。
        if (readString(entry.visibility) !== "list") continue;
        if (entry.supported_in_api === false) continue;
        entries.push({ slug, display_name: displayName });
      }
      return { models: entries };
    },
    new ChatGptOAuthError(
      "chatgpt_models_timeout",
      "ChatGPT model discovery timed out. Sign-in credentials were preserved.",
    ),
  );
}

/** 解析 token 响应的 scope 字段为列表；缺省返回空数组（refresh 可能不带 scope）。 */
export function parseGrantedScopes(tokenResponse: ChatGptTokenResponse): readonly string[] {
  return (tokenResponse.scope ?? "")
    .split(/\s+/u)
    .filter((scope) => scope.length > 0);
}

/** 官方 scope 门禁：缺失 token-sharing scope 时禁止推理调用（errors-and-recovery）。 */
export function hasChatGptTokenSharingScope(scopes: readonly string[]): boolean {
  return scopes.includes(CHATGPT_TOKEN_SHARING_SCOPE);
}

/**
 * 解析 `earliest_refresh_at` 为 epoch ms。
 *
 * 官方 token-reference 只列出字段名，未公布编码；number 同时兼容 epoch 秒与 epoch ms
 * （以 10^12 为界：秒级时间戳 ≈ 1.7e9，ms 级 ≈ 1.7e12），string 走 RFC 3339 解析，
 * 失败再退回数字字面量。任何无法解析的值都返回 undefined（不阻塞刷新）。
 */
export function parseEarliestRefreshAt(value: number | string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value >= 1e12 ? value : value > 0 ? value * 1000 : undefined;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric >= 1e12 ? numeric : numeric * 1000;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
