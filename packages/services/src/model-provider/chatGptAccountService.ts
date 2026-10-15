import {
  CHATGPT_CREDENTIAL_KEYS,
  CHATGPT_USAGE_SETTINGS_URL,
  chatGptAccountStatusSchema,
  parseChatGptSanitizedCredentialSnapshot,
  ServiceChannels,
  type ChatGptAccountStatus,
  type ChatGptAccountSummary,
} from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";
import { createServiceLogger } from "../logger/serviceLogger.js";

/**
 * ChatGPT（Sign in with ChatGPT）账号服务。
 *
 * 运行在 Host 进程，向 Renderer 提供计划 §4 的 sanitized 账号投影
 * （connected / plan-enabled / reconnect-required / restricted / quota-exhausted，
 * 外加 not-connected 初始态）与 begin/disconnect 操作。凭据本体只存在于
 * 加密 CredentialService；任何返回值不得携带 token、client secret 或原始 JSON
 * （由 chatGptAccountStatusSchema 的 strict 字段白名单约束，并有 no-secrets 测试）。
 *
 * 登录流程（loopback + PKCE + JWKS）在 agent 侧 adapters/chatgpt 实现；
 * Host 装配层通过 `loginBridge`/`logoutBridge` 注入进程内调用，未注入时
 * begin 返回 typed 不可用结果（fail-closed），不做任何网络请求。
 */
export interface IChatGptAccountService {
  /** 当前 sanitized 状态；无凭据时返回 not-connected。 */
  getStatus(): Promise<ChatGptAccountStatus>;

  /**
   * 发起交互式登录（系统浏览器 + loopback callback）。
   * 完成后凭据落盘，账号投影经 Registry 事件自动刷新，无需重启。
   */
  beginLogin(): Promise<ChatGptBeginLoginResult>;

  /** 断开本机会话：优先撤销远端会话（bridge 注入时），随后清空本地凭据与模型缓存。 */
  disconnect(): Promise<ChatGptDisconnectResult>;

  /** 账号状态变化（登录/登出/观测状态翻转）通知；与 Registry 事件独立。 */
  onDidChange(listener: (status: ChatGptAccountStatus) => void): {
    dispose(): void;
  };

  /**
   * 运行时观测口（Host 内部使用）：agent 进程的 SIWC 错误分类转发到这里，
   * 把 reconnect-required / restricted / quota-exhausted 升级为当前投影状态。
   * 不是 Renderer 契约的一部分。
   */
  reportRuntimeObservation(observation: ChatGptAccountRuntimeObservation): Promise<void>;
}

export const IChatGptAccountService = createServiceDescriptor<IChatGptAccountService>(
  ServiceChannels.ChatGptAccount,
);

export type ChatGptBeginLoginResult =
  | {
      readonly result: "completed";
      readonly status: ChatGptAccountStatus;
    }
  | {
      readonly result: "unavailable";
      readonly reason: "login-bridge-not-configured";
    }
  | {
      readonly result: "failed";
      readonly code: string;
      readonly message: string;
    };

export interface ChatGptDisconnectResult {
  readonly revoked: boolean;
  readonly status: ChatGptAccountStatus;
}

/** Host 内部观测：来自 agent SIWC 错误码的细粒度账号状态。 */
export type ChatGptAccountRuntimeObservation =
  | { readonly kind: "reconnect-required" }
  | { readonly kind: "restricted" }
  | { readonly kind: "quota-exhausted" }
  | { readonly kind: "session-recovered" };

type ChatGptRuntimeObservationKind = Exclude<
  ChatGptAccountRuntimeObservation,
  { readonly kind: "session-recovered" }
>["kind"];

/** Host 装配层注入的登录桥（adapters runChatGptLogin 的进程内代理）。 */
export type ChatGptAccountLoginBridge = () => Promise<void>;

/** Host 装配层注入的登出桥（adapters runChatGptLogout 的进程内代理）。 */
export type ChatGptAccountLogoutBridge = () => Promise<{
  readonly revoked: boolean;
}>;

export interface CreateChatGptAccountServiceOptions {
  readonly loadCredential: (key: string) => Promise<string | null>;
  readonly deleteCredential: (key: string) => Promise<void>;
  /** 登录/登出实现桥；缺省时 begin fail-closed，disconnect 仍可本地清空。 */
  readonly loginBridge?: ChatGptAccountLoginBridge;
  readonly logoutBridge?: ChatGptAccountLogoutBridge;
}

interface ChatGptAccountRuntimeState {
  readonly loggedIn: boolean;
  readonly account?: ChatGptAccountSummary;
  readonly planEnabled: boolean;
  /** 运行时观测的细粒度状态；凭据变化与 session-recovered 观测会重置。 */
  readonly observation?: ChatGptRuntimeObservationKind;
}

const OBSERVATION_STATUSES: Readonly<
  Record<ChatGptRuntimeObservationKind, ChatGptAccountStatus["status"]>
> = {
  "reconnect-required": "reconnect-required",
  restricted: "restricted",
  "quota-exhausted": "quota-exhausted",
};

export function createChatGptAccountService(
  options: CreateChatGptAccountServiceOptions,
): IChatGptAccountService & { dispose(): void } {
  const log = createServiceLogger("chatgpt-account");
  const listeners = new Set<(status: ChatGptAccountStatus) => void>();
  // 观测是 Host 进程内本服务实例的私有状态；凭据本体仍是唯一持久事实。
  let runtimeObservation: ChatGptRuntimeObservationKind | undefined;
  let disposed = false;
  let loginInFlight: Promise<ChatGptBeginLoginResult> | null = null;
  let operationTail: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const pending = operationTail.then(operation, operation);
    operationTail = pending;
    return pending;
  };

  const readCredentialSnapshot = () =>
    options
      .loadCredential(CHATGPT_CREDENTIAL_KEYS.credentials)
      .catch(() => null)
      .then((raw) => parseChatGptSanitizedCredentialSnapshot(raw));

  const readRuntimeState = async (): Promise<ChatGptAccountRuntimeState> => {
    const snapshot = await readCredentialSnapshot();
    if (!snapshot) {
      // 凭据消失（logout/清理）后观测不再有意义，避免 stale 状态卡住下一次登录展示。
      runtimeObservation = undefined;
      return { loggedIn: false, planEnabled: false };
    }
    return {
      loggedIn: true,
      account: snapshot.account,
      planEnabled: snapshot.planEnabled,
      ...(runtimeObservation ? { observation: runtimeObservation } : {}),
    };
  };

  const projectStatus = (state: ChatGptAccountRuntimeState): ChatGptAccountStatus => {
    let status: ChatGptAccountStatus["status"];
    if (!state.loggedIn) {
      status = "not-connected";
    } else if (state.observation) {
      status = OBSERVATION_STATUSES[state.observation];
    } else if (state.planEnabled) {
      status = "plan-enabled";
    } else {
      // 已登录但未授予计划用量 scope：官方要求保留登录、推理 fail-closed。
      status = "connected";
    }
    // 严格 schema 在出口再校验一次：新增字段必须显式过协议评审才能进 Renderer。
    return chatGptAccountStatusSchema.parse({
      status,
      ...(state.account?.email ? { email: state.account.email } : {}),
      ...(state.account?.name ? { name: state.account.name } : {}),
      ...(state.account?.plan ? { plan: state.account.plan } : {}),
      ...(status === "plan-enabled" || status === "quota-exhausted"
        ? { usageUrl: CHATGPT_USAGE_SETTINGS_URL }
        : {}),
    });
  };

  const readStatus = async (): Promise<ChatGptAccountStatus> =>
    projectStatus(await readRuntimeState());

  // 已持有状态的调用方直接同步发布；观测口等异步路径回读后再发布。
  const emit = (precomputed?: ChatGptAccountStatus): void => {
    if (disposed) return;
    if (precomputed) {
      for (const listener of listeners) listener(precomputed);
      return;
    }
    void readStatus().then(
      (status) => {
        if (disposed) return;
        for (const listener of listeners) listener(status);
      },
      (error: unknown) => {
        if (!disposed) log.warn(undefined, "ChatGPT 账号状态发布失败", { error });
      },
    );
  };

  return {
    async getStatus() {
      return readStatus();
    },

    async beginLogin() {
      if (!options.loginBridge) {
        return { result: "unavailable", reason: "login-bridge-not-configured" };
      }
      // 同一 Host 同时只允许一次交互式登录；并发 begin 复用同一次用户授权。
      if (loginInFlight) return loginInFlight;
      const inFlight = enqueue(async (): Promise<ChatGptBeginLoginResult> => {
        try {
          await options.loginBridge!();
          // 新登录即新会话：旧观测（quota/restricted）不携带到新 token。
          runtimeObservation = undefined;
          const status = await readStatus();
          emit(status);
          return { result: "completed", status };
        } catch (error) {
          const coded = error as { code?: unknown; message?: unknown };
          return {
            result: "failed",
            code: typeof coded.code === "string" ? coded.code : "chatgpt_login_failed",
            // message 只透传错误描述；adapters 的类型化错误不携带 token 值。
            message: typeof coded.message === "string" ? coded.message : "ChatGPT sign-in failed.",
          };
        }
      });
      loginInFlight = inFlight;
      try {
        return await inFlight;
      } finally {
        if (loginInFlight === inFlight) loginInFlight = null;
      }
    },

    async disconnect() {
      // 同一 owner 按用户操作顺序串行化：logout 后的新 login 不能复用旧尝试。
      loginInFlight = null;
      return enqueue(async () => {
        let revoked = false;
        let bridgeCompleted = false;
        if (options.logoutBridge) {
          try {
            revoked = (await options.logoutBridge()).revoked;
            bridgeCompleted = true;
          } catch (error: unknown) {
            // 撤销失败不阻止本地登出；用户可在 ChatGPT 设置中手动断开（官方建议路径）。
            log.warn(undefined, "ChatGPT 会话撤销失败，继续本地登出", { error });
          }
        }
        runtimeObservation = undefined;
        // Adapter 已按 generation 删除；不能无条件再删除另一个进程的新登录。
        if (!bridgeCompleted) {
          await options.deleteCredential(CHATGPT_CREDENTIAL_KEYS.credentials);
          await options.deleteCredential(CHATGPT_CREDENTIAL_KEYS.models);
        }
        const status = await readStatus();
        emit(status);
        return { revoked, status };
      });
    },

    onDidChange(listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },

    async reportRuntimeObservation(observation) {
      // 观测只影响投影状态，不写凭据；未登录时无处挂载，静默忽略。
      const snapshot = await readCredentialSnapshot();
      if (!snapshot) return;
      if (observation.kind === "session-recovered") {
        if (!runtimeObservation) return;
        runtimeObservation = undefined;
      } else {
        runtimeObservation = observation.kind;
      }
      emit();
    },

    dispose() {
      disposed = true;
      listeners.clear();
    },
  };
}
