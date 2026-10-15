import { isZCodeFileLockTimeoutError } from "@zcode/shared";
import { withFileLock } from "@zcode/shared/node";
import type { SharedZCodeCredentialStore } from "../shared-credentials.js";
import { openUrlInBrowser, type BrowserOpenResult } from "../browser.js";
import {
  MCP_OAUTH_CALLBACK_DENIED_ERROR_CODE,
  createLocalhostOAuthCallbackServer,
} from "../localhost-callback.js";
import { CHATGPT_OAUTH_CALLBACK_PATH, CHATGPT_CREDENTIAL_KEYS } from "./chatgpt-oauth-protocol.js";
import { verifyChatGptIdToken } from "./chatgpt-id-token.js";
import { computePkceCodeChallenge, createPkceVerifier, createRandomToken } from "./pkce.js";
import {
  ChatGptOAuthError,
  buildChatGptAuthorizeUrl,
  exchangeChatGptAuthorizationCode,
  fetchChatGptModelList,
  hasChatGptTokenSharingScope,
  parseChatGptCallbackUrl,
  parseGrantedScopes,
  resolveChatGptOAuthEndpoints,
  revokeChatGptSession,
  type ChatGptModelListEntry,
  type ChatGptOAuthFetch,
} from "./chatgpt-oauth-client.js";
import {
  clearChatGptCredentialRecordIfUnchanged,
  deleteChatGptCachedModels,
  readChatGptClientId,
  readChatGptCredentialRecord,
  readChatGptCredentialSnapshot,
  resolveChatGptHostId,
  toChatGptCredentialRecord,
  writeChatGptCachedModels,
  writeChatGptCredentialRecord,
} from "./chatgpt-credential-record.js";
import {
  resolveChatGptRefreshLockPath,
  CHATGPT_REFRESH_LOCK_MAX_WAIT_MS,
} from "./chatgpt-refresh-coordinator.js";

/**
 * Sign in with ChatGPT 交互式登录 / 登出流程（官方 token-sharing 实现）。
 *
 * 流程（骨架移植自 nasone32/ZCode feat/chatgpt-oauth commit bd5171cb 的
 * chatgpt-login-flow.ts，按官方文档与计划 §3 复核调整）：
 *
 * 1. 读取/创建稳定 `ext_agent_host_id` 与已签发 client_id；
 * 2. 启动 127.0.0.1 loopback 监听（随机端口，路径精确 `/auth/callback`）；
 * 3. 打开系统浏览器完成授权（首次携带 `agent_name_hint` 动态注册）；
 * 4. 校验 state、回调 client_id 与已保存值一致；`error=access_denied` → 类型化拒绝；
 * 5. PKCE code 交换 → JWKS/RS256 校验 id_token（iss/aud/nonce/exp）；
 * 6. 持久化凭据（单键事务）+ best-effort 拉取 /v1/models。
 *
 * 与 fork 的差异：scope 缺失不再让登录失败——官方 errors-and-recovery 要求
 * 「id_token 有效但缺 chatgpt.tokens.use.direct：保留登录、标记计划用量禁用」，
 * 结果里的 `tokenSharingGranted` 交给上层 fail-closed 门禁。
 */

export interface ChatGptLoginOptions {
  readonly store: SharedZCodeCredentialStore;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetchImpl?: ChatGptOAuthFetch;
  readonly noBrowser?: boolean;
  readonly openBrowser?: (url: string) => Promise<BrowserOpenResult>;
  readonly timeoutMs?: number;
  readonly now?: () => number;
  readonly onAuthorizeUrl?: (url: string) => void;
}

export interface ChatGptLoginResult {
  readonly account: {
    readonly subject: string;
    readonly email?: string;
    readonly name?: string;
  };
  readonly clientId: string;
  readonly firstRegistration: boolean;
  /** 服务器授予的 scope 是否包含 chatgpt.tokens.use.direct（推理门禁输入）。 */
  readonly tokenSharingGranted: boolean;
  readonly grantedScopes: readonly string[];
  readonly models: readonly ChatGptModelListEntry[];
  readonly credentialsPath: string;
  readonly browser?: BrowserOpenResult;
}

const DEFAULT_LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const REVOCATION_RETRY_DELAYS_MS = [250] as const;

export async function runChatGptLogin(options: ChatGptLoginOptions): Promise<ChatGptLoginResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const endpoints = resolveChatGptOAuthEndpoints(options.env);
  const issuer = new URL(endpoints.authorizeUrl).origin;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;

  const [hostId, savedClientId, previousRecord] = await Promise.all([
    resolveChatGptHostId(options.store),
    readChatGptClientId(options.store),
    readChatGptCredentialRecord(options.store),
  ]);
  const firstRegistration = !savedClientId;

  const state = createRandomToken();
  const nonce = createRandomToken();
  const codeVerifier = createPkceVerifier();
  const codeChallenge = computePkceCodeChallenge(codeVerifier);

  const callbackServer = await createLocalhostOAuthCallbackServer({
    callbackPath: CHATGPT_OAUTH_CALLBACK_PATH,
    state,
  });
  const callbackWait = withTimeout(callbackServer.waitForCallback(), timeoutMs);
  callbackWait.promise.catch(() => undefined);
  try {
    const authorizeUrl = buildChatGptAuthorizeUrl(endpoints.authorizeUrl, {
      redirectUri: callbackServer.callbackUrl,
      state,
      nonce,
      codeChallenge,
      extAgentHostId: hostId,
      ...(savedClientId ? { clientId: savedClientId } : {}),
      ...(previousRecord?.account.email ? { loginHint: previousRecord.account.email } : {}),
      ...(previousRecord?.idToken ? { idTokenHint: previousRecord.idToken } : {}),
    });
    options.onAuthorizeUrl?.(authorizeUrl);

    // 先订阅回调再打开浏览器：浏览器侧「拒绝/回调先到达」时 rejection 必须已有
    // 处理者（否则 unhandled rejection），同时消除回调与订阅之间的竞态。
    // 立即附加 no-op catch 只用于消除「outer promise 已拒绝、await 尚未执行」的
    // 空窗；真正的错误仍由下方 await 传播。
    const callbackPromise = callbackWait.promise;

    let browser: BrowserOpenResult | undefined;
    if (!options.noBrowser) {
      const openBrowser = options.openBrowser ?? ((url: string) => openUrlInBrowser(url));
      browser = await openBrowser(authorizeUrl);
      if (!browser.opened) {
        throw new ChatGptOAuthError(
          "chatgpt_browser_open_failed",
          "Could not open the system browser. Check your default browser and try again.",
        );
      }
    }

    const callback = await callbackPromise;

    const query = parseChatGptCallbackUrl(callback.url);
    if (query.state !== state) {
      throw new ChatGptOAuthError(
        "chatgpt_callback_state_mismatch",
        "Invalid OAuth state returned by the authorization server.",
      );
    }
    const issuedClientId = query.clientId?.trim();
    if (!issuedClientId) {
      if (firstRegistration) {
        // 官方文档：新注册必须由回调返回签发 client_id，否则视为注册未完成。
        throw new ChatGptOAuthError(
          "chatgpt_registration_incomplete",
          "ChatGPT sign-in did not return an issued client_id; registration is incomplete.",
        );
      }
    } else if (savedClientId && issuedClientId !== savedClientId) {
      throw new ChatGptOAuthError(
        "chatgpt_client_mismatch",
        "ChatGPT returned a different client_id than the one saved on this host.",
      );
    }
    const clientId = issuedClientId ?? savedClientId;
    if (!clientId || !query.code) {
      throw new ChatGptOAuthError(
        "chatgpt_callback_missing_code",
        "Authorization callback is missing a code.",
      );
    }

    const tokenResponse = await exchangeChatGptAuthorizationCode(
      endpoints.tokenUrl,
      {
        clientId,
        code: query.code,
        codeVerifier,
        redirectUri: callbackServer.callbackUrl,
      },
      fetchImpl,
    );
    const scopes = parseGrantedScopes(tokenResponse);
    if (!tokenResponse.id_token) {
      throw new ChatGptOAuthError(
        "chatgpt_id_token_missing",
        "The token response has no id_token.",
      );
    }
    const verified = await verifyChatGptIdToken({
      idToken: tokenResponse.id_token,
      issuer,
      audience: clientId,
      nonce,
      now,
      fetchImpl,
      jwksUrl: endpoints.jwksUrl,
    });

    const record = toChatGptCredentialRecord({
      clientId,
      ...(previousRecord?.idToken ? { previousIdToken: previousRecord.idToken } : {}),
      tokenResponse,
      scopes,
      accountClaims: {
        subject: String(verified.claims.sub),
        ...(typeof verified.claims.email === "string" && verified.claims.email
          ? { email: verified.claims.email }
          : {}),
        ...(typeof verified.claims.name === "string" && verified.claims.name
          ? { name: verified.claims.name }
          : {}),
      },
      now,
    });
    // 先持久化签发 client_id（logout 后保留，官方要求重登录复用），再写会话记录；
    // 各自是独立原子事务，崩溃最多停留在「已登录 client、无会话」= 未登录状态。
    await options.store.save(CHATGPT_CREDENTIAL_KEYS.clientId, clientId);
    // 旧账号的目录不能授予新会话模型；无计划 scope 时不得请求目录。
    await deleteChatGptCachedModels(options.store);
    await writeChatGptCredentialRecord(options.store, record);
    const models = hasChatGptTokenSharingScope(scopes)
      ? await fetchAndCacheModels({
          endpoints,
          accessToken: record.accessToken,
          store: options.store,
          fetchImpl,
          fallback: null,
        })
      : [];

    return {
      account: {
        subject: record.account.subject,
        ...(record.account.email ? { email: record.account.email } : {}),
        ...(record.account.name ? { name: record.account.name } : {}),
      },
      clientId,
      firstRegistration,
      tokenSharingGranted: hasChatGptTokenSharingScope(scopes),
      grantedScopes: scopes,
      models,
      credentialsPath: options.store.filePath,
      ...(browser ? { browser } : {}),
    };
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code === MCP_OAUTH_CALLBACK_DENIED_ERROR_CODE
    ) {
      // 官方 errors-and-recovery：error=access_denied（用户拒绝 / 授权服务器拒绝）时
      // 校验 state 后**不得**继续交换 code；映射为 ChatGPT 类型化拒绝错误。
      const denied = error as { oauthError?: string; oauthErrorDescription?: string };
      throw new ChatGptOAuthError(
        "chatgpt_consent_denied",
        `ChatGPT authorization was rejected: ${denied.oauthError ?? "access_denied"}`,
        {
          oauthError: denied.oauthError ?? "access_denied",
          ...(denied.oauthErrorDescription
            ? { oauthErrorDescription: denied.oauthErrorDescription }
            : {}),
          cause: error,
        },
      );
    }
    throw error;
  } finally {
    callbackWait.dispose();
    await callbackServer.close().catch(() => undefined);
  }
}

export interface ChatGptLogoutOptions {
  readonly store: SharedZCodeCredentialStore;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetchImpl?: ChatGptOAuthFetch;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface ChatGptLogoutResult {
  readonly revoked: boolean;
  readonly credentialsPath: string;
}

/**
 * 撤销可续期会话并清空本机会话记录。
 *
 * 撤销在 refresh 文件锁内执行：与并发 refresh 串行化，避免「refresh 刚轮换出的新
 * token 被拿旧 token 的 logout 撤销 / refresh 拿被 logout 消费的 token 撞
 * invalid_grant」的交叉竞争。撤销端点来自 OpenID discovery（官方：空 200 即成功，
 * 对已失效 token 同样返回 200）；网络失败按官方建议做有界重试，重试仍失败不阻止
 * 本地登出（用户可在 ChatGPT 设置中断开应用）。client/host 标识保留供重登录复用。
 */
export async function runChatGptLogout(
  options: ChatGptLogoutOptions,
): Promise<ChatGptLogoutResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const endpoints = resolveChatGptOAuthEndpoints(options.env);

  const snapshotBeforeLock = await readChatGptCredentialSnapshot(options.store);
  if (!snapshotBeforeLock) {
    return { revoked: false, credentialsPath: options.store.filePath };
  }

  let logoutSnapshotRaw: string = snapshotBeforeLock.raw;
  const revoked = await withFileLock(
    resolveChatGptRefreshLockPath(options.store.filePath),
    async () => {
      // 锁内重读：等锁期间 refresh 可能已轮换，必须撤销最新的 refresh token。
      const snapshot = await readChatGptCredentialSnapshot(options.store);
      if (!snapshot) return false;
      logoutSnapshotRaw = snapshot.raw;
      if (!snapshot.record.refreshToken) return false;
      for (let attempt = 0; attempt <= REVOCATION_RETRY_DELAYS_MS.length; attempt += 1) {
        try {
          await revokeChatGptSession(
            endpoints.openidConfigurationUrl,
            { clientId: snapshot.record.clientId, refreshToken: snapshot.record.refreshToken },
            fetchImpl,
          );
          return true;
        } catch (error) {
          if (attempt >= REVOCATION_RETRY_DELAYS_MS.length) break;
          if (isRevocationRetryable(error)) {
            await sleep(REVOCATION_RETRY_DELAYS_MS[attempt]);
            continue;
          }
          break;
        }
      }
      return false;
    },
    { lockMaxWaitMs: CHATGPT_REFRESH_LOCK_MAX_WAIT_MS },
  ).catch((error: unknown) => {
    if (isZCodeFileLockTimeoutError(error)) {
      // refresh 长时间持锁（例如大网络延迟）：本地登出不应被无限阻塞。
      return false;
    }
    throw error;
  });

  // generation 守卫清空：只删除本进程观察到的会话版本；等锁期间被并行登录替换的
  // 新会话不受影响（logout 与 login 罕见并发时以用户最新动作获胜）。
  if (logoutSnapshotRaw) {
    const cleared = await clearChatGptCredentialRecordIfUnchanged(options.store, logoutSnapshotRaw);
    if (cleared) await deleteChatGptCachedModels(options.store).catch(() => undefined);
  }
  return { revoked, credentialsPath: options.store.filePath };
}

function isRevocationRetryable(error: unknown): boolean {
  if (!(error instanceof ChatGptOAuthError)) return false;
  // 官方：网络失败或 5xx 才重试；4xx 是确定性结果（已撤销 / 端点配置问题）。
  if (error.code === "chatgpt_discovery_failed" || error.code === "chatgpt_revocation_failed") {
    return error.httpStatus === undefined || error.httpStatus >= 500;
  }
  return error.code === "chatgpt_token_network_error";
}

async function fetchAndCacheModels(input: {
  readonly endpoints: ReturnType<typeof resolveChatGptOAuthEndpoints>;
  readonly accessToken: string;
  readonly store: SharedZCodeCredentialStore;
  readonly fetchImpl: ChatGptOAuthFetch;
  readonly fallback: readonly ChatGptModelListEntry[] | null;
}): Promise<readonly ChatGptModelListEntry[]> {
  try {
    const result = await fetchChatGptModelList(
      `${input.endpoints.apiBaseUrl}/models`,
      input.accessToken,
      input.fetchImpl,
    );
    await writeChatGptCachedModels(input.store, result.models);
    return result.models;
  } catch {
    // 模型列表拉取失败不阻断登录；使用既有缓存。空目录同样是有效结果，
    // 由 Registry 侧按「有效空目录」处理，不用 seed 模型顶替（计划 §3 备注 5）。
    return input.fallback ?? [];
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): { promise: Promise<T>; dispose(): void } {
  let timer: ReturnType<typeof setTimeout>;
  const result = new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(
        "ChatGPT sign-in timed out waiting for the authorization callback.",
      ) as Error & { code: string };
      error.code = "chatgpt_login_timeout";
      reject(error);
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
  return { promise: result, dispose: () => clearTimeout(timer) };
}
