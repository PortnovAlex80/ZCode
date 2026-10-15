import { CHATGPT_CREDENTIAL_KEYS } from "./chatgpt-oauth-protocol.js";
import { readChatGptCredentialSnapshot } from "./chatgpt-credential-record.js";
import {
  ChatGptOAuthError,
  fetchChatGptModelList,
  resolveChatGptOAuthEndpoints,
} from "./chatgpt-oauth-client.js";
import {
  createChatGptRequestAuthSource,
  type ChatGptRequestAuthSourceOptions,
} from "./chatgpt-request-auth.js";

export type ChatGptModelsRefreshResult =
  | { readonly result: "completed"; readonly modelCount: number }
  | {
      readonly result: "failed";
      readonly code: string;
      readonly httpStatus?: number;
    };

/** Refresh discovery without OAuth consent; never replace another account's catalog. */
export async function refreshChatGptModels(
  options: ChatGptRequestAuthSourceOptions,
): Promise<ChatGptModelsRefreshResult> {
  try {
    const auth = await createChatGptRequestAuthSource(options).resolve({
      attempt: 1,
      providerId: "account:chatgpt",
      modelId: "model-discovery",
    });
    const snapshot = await readChatGptCredentialSnapshot(options.store);
    if (!auth || !snapshot)
      return { result: "failed", code: "chatgpt_not_signed_in" };
    if (snapshot.record.accessToken !== auth.apiKey) {
      return { result: "failed", code: "chatgpt_account_changed" };
    }
    const { models } = await fetchChatGptModelList(
      `${resolveChatGptOAuthEndpoints(options.env).apiBaseUrl}/models`,
      auth.apiKey,
      options.fetchImpl ?? fetch,
    );
    const saved = await options.store.saveIfValue(
      CHATGPT_CREDENTIAL_KEYS.models,
      snapshot.raw,
      JSON.stringify(models),
      CHATGPT_CREDENTIAL_KEYS.credentials,
    );
    return saved
      ? { result: "completed", modelCount: models.length }
      : { result: "failed", code: "chatgpt_account_changed" };
  } catch (error) {
    return error instanceof ChatGptOAuthError
      ? {
          result: "failed",
          code: error.code,
          ...(error.httpStatus === undefined
            ? {}
            : { httpStatus: error.httpStatus }),
        }
      : { result: "failed", code: "chatgpt_models_refresh_failed" };
  }
}
