import { dirname, join } from "node:path";
import { isZCodeFileLockTimeoutError } from "@zcode/shared";
import { withFileLock } from "@zcode/shared/node";
import type { SharedZCodeCredentialStore } from "../shared-credentials.js";
import {
  CHATGPT_REFRESH_THRESHOLD_MS,
} from "./chatgpt-oauth-protocol.js";
import {
  hasChatGptTokenSharingScope,
  isUnusableRefreshTokenError,
  parseGrantedScopes,
  refreshChatGptAccessToken,
  resolveChatGptOAuthEndpoints,
  type ChatGptOAuthFetch,
} from "./chatgpt-oauth-client.js";
import {
  clearChatGptCredentialRecordIfUnchanged,
  isChatGptAccessTokenFresh,
  readChatGptCredentialSnapshot,
  saveRefreshedChatGptCredentialRecord,
  toChatGptCredentialRecord,
  type ChatGptCredentialRecord,
} from "./chatgpt-credential-record.js";

/**
 * ChatGPT access token 的跨进程 refresh 协调器。
 *
 * 官方 profiles-and-sessions 明确要求："Store and use the latest replacement, and
 * serialize refreshes for the same session so two processes do not race a rotating
 * token." nasone32 fork（commit bd5171cb）的实现是**先发 refresh 请求、后用
 * deleteIfValue 认领**——两个进程可以同时用同一个旧 refresh token 发请求，撞服务端
 * rotation reuse-detection 后整族 token 被撤销（本仓库计划 §3 code review 备注 1）。
 *
 * 本实现的顺序（与 mcp/oauth-refresh.ts 的 house pattern 一致）：
 *
 * ```text
 * 观察当前记录（generation 快照）
 *   → 获取跨进程 refresh 文件锁（withFileLock，owner-PID 死亡可回收）
 *   → 锁内重读：generation 已变 → 直接复用 winner 结果，零网络请求
 *   → earliest_refresh_at 未到且 token 仍有效 → 返回现值（不发请求、不久等）
 *   → earliest_refresh_at 未到且已过期 → 有界分片等待到时刻点，绝不提前发请求
 *   → POST /token grant_type=refresh_token（只有持锁者能到达这里）
 *       ├─ 不可用 refresh（invalid_grant/reused/…）→ generation 守卫清空 + 重登录错误
 *       └─ 成功 → 单键 CAS 持久化（saveIfValue，无 delete+write 窗口）
 *             └─ CAS 失败（被并发登录取代）→ 丢弃本会话轮换结果，回读现值
 *   → 释放锁
 * ```
 *
 * 等锁超时的 follower 不视为失败：winner 可能刚发布结果，先重读比较 generation，
 * 换代即复用；否则抛有界协调超时错误（保留凭据）。
 */

/**
 * refresh 锁的获取预算。
 *
 * 必须覆盖锁内的网络预算（一次 token 请求 + 一次单键落盘），否则等待者会在 winner
 * 还没发布结果时就超时。`withFileLock` 默认 8s 不够（同 mcp/oauth-refresh.ts）。
 */
export const CHATGPT_REFRESH_LOCK_MAX_WAIT_MS = 45_000;

/**
 * `earliest_refresh_at` 之前的最大总等待。到达上限仍未到时刻点时抛类型化错误，
 * **绝不提前发请求**（对比 fork：等 60s 后照发，违反字段语义——计划 §3 备注 2）。
 */
export const CHATGPT_MAX_EARLIEST_REFRESH_WAIT_MS = 5 * 60 * 1000;

/** earliest_refresh_at 等待的分片长度：保证 abort 及时生效。 */
const EARLIEST_REFRESH_WAIT_SLICE_MS = 100;

export class ChatGptReLoginRequiredError extends Error {
  readonly code = "chatgpt_relogin_required";
  constructor(
    message = "ChatGPT sign-in has expired or was revoked. Sign in with ChatGPT again.",
    options?: { cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ChatGptReLoginRequiredError";
  }
}

export class ChatGptRefreshTooEarlyError extends Error {
  readonly code = "chatgpt_refresh_too_early";
  constructor(message: string) {
    super(message);
    this.name = "ChatGptRefreshTooEarlyError";
  }
}

export class ChatGptRefreshCoordinationTimeoutError extends Error {
  readonly code = "chatgpt_refresh_coordination_timeout";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ChatGptRefreshCoordinationTimeoutError";
  }
}

export type ChatGptRefreshOutcome =
  | { status: "refreshed"; record: ChatGptCredentialRecord; tokenSharingGranted: boolean }
  | { status: "current"; record: ChatGptCredentialRecord; tokenSharingGranted: boolean }
  | { status: "not-signed-in" };

export interface ChatGptRefreshCoordinatorOptions {
  readonly store: SharedZCodeCredentialStore;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetchImpl?: ChatGptOAuthFetch;
  readonly now?: () => number;
  /** 供测试注入的睡眠实现。 */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly refreshThresholdMs?: number;
  readonly lockMaxWaitMs?: number;
  readonly maxEarliestRefreshWaitMs?: number;
}

export interface ChatGptRefreshCoordinator {
  /** 完整协调刷新；未登录返回 not-signed-in，绝不返回过期的旧 token。 */
  refresh(input?: { abortSignal?: AbortSignal }): Promise<ChatGptRefreshOutcome>;
  /** 当前 refresh 锁路径（logout 等需要与 refresh 串行化的路径复用）。 */
  readonly refreshLockPath: string;
}

/**
 * refresh 锁文件路径。
 *
 * 必须独立于 credentials 文件：锁内会调用 store 的 saveIfValue，后者自己对
 * credentials.json 加锁；同一路径会自重入死锁。basename 不含冒号（Windows 非法字符）。
 */
export function resolveChatGptRefreshLockPath(credentialsFilePath: string): string {
  return join(dirname(credentialsFilePath), "chatgpt-oauth-refresh");
}

export function createChatGptRefreshCoordinator(
  options: ChatGptRefreshCoordinatorOptions,
): ChatGptRefreshCoordinator {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const refreshThresholdMs = options.refreshThresholdMs ?? CHATGPT_REFRESH_THRESHOLD_MS;
  const lockMaxWaitMs = options.lockMaxWaitMs ?? CHATGPT_REFRESH_LOCK_MAX_WAIT_MS;
  const maxEarliestRefreshWaitMs =
    options.maxEarliestRefreshWaitMs ?? CHATGPT_MAX_EARLIEST_REFRESH_WAIT_MS;
  const endpoints = resolveChatGptOAuthEndpoints(options.env);
  const refreshLockPath = resolveChatGptRefreshLockPath(options.store.filePath);

  async function refresh(input?: {
    abortSignal?: AbortSignal;
  }): Promise<ChatGptRefreshOutcome> {
    input?.abortSignal?.throwIfAborted();
    // 拿锁前先观察 generation：等锁期间 winner 完成轮换时，follower 可零请求复用。
    const observed = await readChatGptCredentialSnapshot(options.store);
    const observedGeneration = observed?.record.generation;

    try {
      return await withFileLock(
        refreshLockPath,
        async () => await refreshLocked(input, observedGeneration),
        { lockMaxWaitMs },
      );
    } catch (error) {
      if (!isZCodeFileLockTimeoutError(error)) throw error;
      // 等锁超时 ≠ 刷新失败：winner 可能已发布结果。重读并比较 generation。
      const current = await readChatGptCredentialSnapshot(options.store);
      if (
        current &&
        current.record.generation !== observedGeneration &&
        isChatGptAccessTokenFresh(current.record, now(), refreshThresholdMs)
      ) {
        return {
          status: "current",
          record: current.record,
          tokenSharingGranted: hasChatGptTokenSharingScope(current.record.account.scopes),
        };
      }
      throw new ChatGptRefreshCoordinationTimeoutError(
        "Timed out waiting for another process to finish refreshing the ChatGPT session.",
        { cause: error },
      );
    }
  }

  /** 临界区：只有 refresh 锁持有者会进入；网络请求只发生在这里。 */
  async function refreshLocked(
    input: { abortSignal?: AbortSignal } | undefined,
    observedGeneration: string | undefined,
  ): Promise<ChatGptRefreshOutcome> {
    input?.abortSignal?.throwIfAborted();
    const snapshot = await readChatGptCredentialSnapshot(options.store);
    if (!snapshot) return { status: "not-signed-in" };

    // 合并：等锁期间别的进程已刷新过就直接复用（rotation reuse-detection 的关键）。
    if (snapshot.record.generation !== observedGeneration) {
      return {
        status: "current",
        record: snapshot.record,
        tokenSharingGranted: hasChatGptTokenSharingScope(snapshot.record.account.scopes),
      };
    }
    // 锁内二次确认新鲜度：等锁期间 winner 刷新、随后又到期的极端序列下避免无谓请求。
    if (isChatGptAccessTokenFresh(snapshot.record, now(), refreshThresholdMs)) {
      return {
        status: "current",
        record: snapshot.record,
        tokenSharingGranted: hasChatGptTokenSharingScope(snapshot.record.account.scopes),
      };
    }

    const wait = await waitForEarliestRefreshAt(snapshot.record, input?.abortSignal);
    if (wait === "deferred") {
      // earliest_refresh_at 未到且现 token 仍有效：用完当前窗口，本次不刷新。
      return {
        status: "current",
        record: snapshot.record,
        tokenSharingGranted: hasChatGptTokenSharingScope(snapshot.record.account.scopes),
      };
    }

    let tokenResponse;
    try {
      tokenResponse = await refreshChatGptAccessToken(
        endpoints.tokenUrl,
        { clientId: snapshot.record.clientId, refreshToken: snapshot.record.refreshToken },
        fetchImpl,
      );
    } catch (error) {
      if (isUnusableRefreshTokenError(error)) {
        // 确定性失效（官方 Refresh errors）：只在存储值仍是本次使用的记录时清空；
        // 并行进程刚轮换出的新会话不受影响。
        await clearChatGptCredentialRecordIfUnchanged(options.store, snapshot.raw);
        throw new ChatGptReLoginRequiredError(
          "The ChatGPT refresh token is no longer usable. Sign in with ChatGPT again.",
          { cause: error },
        );
      }
      // 网络失败 / 5xx / 429 是临时故障：保留凭据（官方 errors-and-recovery），可重试。
      throw error;
    }

    const scopes = parseGrantedScopes(tokenResponse);
    const nextRecord = toChatGptCredentialRecord({
      clientId: snapshot.record.clientId,
      previousIdToken: snapshot.record.idToken,
      tokenResponse,
      scopes: scopes.length > 0 ? scopes : snapshot.record.account.scopes,
      accountClaims: {
        subject: snapshot.record.account.subject,
        ...(snapshot.record.account.email ? { email: snapshot.record.account.email } : {}),
        ...(snapshot.record.account.name ? { name: snapshot.record.account.name } : {}),
        ...(snapshot.record.account.plan ? { plan: snapshot.record.account.plan } : {}),
      },
      now,
    });
    if (!nextRecord.refreshToken) {
      // refresh 响应缺 refresh_token：不落盘（会破坏可续期性），现记录保留待重试。
      throw new Error("ChatGPT refresh response is missing a refresh_token.");
    }

    // 单键 CAS 持久化：网络往返期间记录被并发登录替换时，丢弃本次轮换结果并回读现值。
    const persisted = await saveRefreshedChatGptCredentialRecord(
      options.store,
      nextRecord,
      snapshot.raw,
    );
    if (!persisted) {
      const current = await readChatGptCredentialSnapshot(options.store);
      if (!current) return { status: "not-signed-in" };
      return {
        status: "current",
        record: current.record,
        tokenSharingGranted: hasChatGptTokenSharingScope(current.record.account.scopes),
      };
    }
    return {
      status: "refreshed",
      record: nextRecord,
      tokenSharingGranted: hasChatGptTokenSharingScope(nextRecord.account.scopes),
    };
  }

  /**
   * 遵守 earliest_refresh_at（计划 §3 code review 备注 2）。
   *
   * - token 仍有效 → 返回 "deferred"（调用方回退现值，用完当前窗口），既不发请求也不久等；
   * - token 已过期且时刻点在未来 → 分片等待到 earliest_refresh_at（abort 可打断），
   *   超出总预算仍没到点则抛类型化错误——宁可让本次请求失败，也不违反字段语义
   *   提前触发服务端 reuse-detection。
   */
  async function waitForEarliestRefreshAt(
    record: ChatGptCredentialRecord,
    abortSignal: AbortSignal | undefined,
  ): Promise<"ready" | "deferred"> {
    if (record.earliestRefreshAt === undefined) return "ready";
    const waitMs = record.earliestRefreshAt - now();
    if (waitMs <= 0) return "ready";
    if (record.expiresAt > now()) return "deferred";
    const deadline = now() + Math.min(waitMs, maxEarliestRefreshWaitMs);
    while (now() < deadline) {
      abortSignal?.throwIfAborted();
      await sleep(Math.min(EARLIEST_REFRESH_WAIT_SLICE_MS, deadline - now()));
    }
    if (now() < record.earliestRefreshAt) {
      throw new ChatGptRefreshTooEarlyError(
        "The ChatGPT session cannot be refreshed before earliest_refresh_at.",
      );
    }
    return "ready";
  }

  return {
    refresh,
    refreshLockPath,
  };
}
