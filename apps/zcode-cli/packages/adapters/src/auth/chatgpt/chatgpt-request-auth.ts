import type { ModelRequestAuth, ModelRequestAuthSource } from "@zcode/contracts";
import type { SharedZCodeCredentialStore } from "../shared-credentials.js";
import { ChatGptOAuthError, hasChatGptTokenSharingScope } from "./chatgpt-oauth-client.js";
import { CHATGPT_REFRESH_THRESHOLD_MS } from "./chatgpt-oauth-protocol.js";
import {
  isChatGptAccessTokenFresh,
  readChatGptCredentialRecord,
} from "./chatgpt-credential-record.js";
import {
  createChatGptRefreshCoordinator,
  type ChatGptRefreshCoordinatorOptions,
  type ChatGptRefreshOutcome,
} from "./chatgpt-refresh-coordinator.js";

/**
 * ChatGPT 请求级鉴权 Source：把 OAuth access token 作为 `apiKey` 交付
 * （openai-responses SDK 路径将其发送为 `Authorization: Bearer …`）。
 *
 * 与 nasone32 fork（commit bd5171cb）的差异：
 * - 跨进程串行化在**网络请求之前**完成（官方 "serialize refreshes … so two processes
 *   do not race a rotating token"），详见 chatgpt-refresh-coordinator.ts；
 * - scope 门禁 fail-closed：官方 errors-and-recovery 要求 id_token 有效但缺
 *   `chatgpt.tokens.use.direct` 时「保留登录、禁用计划用量、绝不推理」——登录不报错，
 *   交付 token 前在这里拒绝（类型化错误，UI 可解释），而不是登录时抛异常丢掉身份。
 */

export interface ChatGptRequestAuthSourceOptions extends ChatGptRefreshCoordinatorOptions {
  readonly store: SharedZCodeCredentialStore;
}

export interface ChatGptRequestAuthSource extends ModelRequestAuthSource {
  /** 立即刷新（登录后预热 / 测试）；语义与 resolve 的刷新路径一致。 */
  refreshNow(input?: { abortSignal?: AbortSignal }): Promise<ModelRequestAuth | undefined>;
  /** 是否已登录（存在完整凭据记录；不代表计划用量已授权）。 */
  isLoggedIn(): Promise<boolean>;
}

export function createChatGptTokenSharingScopeError(): ChatGptOAuthError {
  return new ChatGptOAuthError(
    "chatgpt_token_sharing_scope_missing",
    "The ChatGPT account did not grant token sharing. Sign in again and allow it, or use an OpenAI API key.",
  );
}

export function createChatGptRequestAuthSource(
  options: ChatGptRequestAuthSourceOptions,
): ChatGptRequestAuthSource {
  const now = options.now ?? Date.now;
  const refreshThresholdMs = options.refreshThresholdMs ?? CHATGPT_REFRESH_THRESHOLD_MS;
  const coordinator = createChatGptRefreshCoordinator(options);

  // 进程内 single-flight：同实例并发 attempt 共享同一次协调刷新；
  // 跨实例 / 跨进程由 refresh 文件锁串行化。
  let refreshInFlight: Promise<ChatGptRefreshOutcome> | null = null;

  function refreshWithSingleFlight(input?: {
    abortSignal?: AbortSignal;
  }): Promise<ChatGptRefreshOutcome> {
    refreshInFlight ??= coordinator.refresh(input).finally(() => {
      refreshInFlight = null;
    });
    return refreshInFlight;
  }

  function toRequestAuth(outcome: ChatGptRefreshOutcome): ModelRequestAuth | undefined {
    if (outcome.status === "not-signed-in") return undefined;
    if (!outcome.tokenSharingGranted) {
      // 服务器侧 scope 已不覆盖计划用量：身份仍在，但推理必须 fail-closed。
      throw createChatGptTokenSharingScopeError();
    }
    return { apiKey: outcome.record.accessToken };
  }

  const resolve: ChatGptRequestAuthSource["resolve"] = async (input) => {
    input?.abortSignal?.throwIfAborted();
    const record = await readChatGptCredentialRecord(options.store);
    if (!record) return undefined;
    if (!hasChatGptTokenSharingScope(record.account.scopes)) {
      throw createChatGptTokenSharingScopeError();
    }
    if (isChatGptAccessTokenFresh(record, now(), refreshThresholdMs)) {
      return { apiKey: record.accessToken };
    }
    const outcome = await refreshWithSingleFlight(input);
    input?.abortSignal?.throwIfAborted();
    return toRequestAuth(outcome);
  };

  return {
    resolve,
    async refreshNow(input) {
      const outcome = await refreshWithSingleFlight(input);
      input?.abortSignal?.throwIfAborted();
      return toRequestAuth(outcome);
    },
    async isLoggedIn() {
      return (await readChatGptCredentialRecord(options.store)) !== null;
    },
  };
}
