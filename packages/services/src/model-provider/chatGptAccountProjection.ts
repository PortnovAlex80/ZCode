import { watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import {
  OpenAiOAuthAccessConfig,
  ProviderConfig,
  createAccountProviderConfigSnapshot,
  type AccountProviderConfigSnapshot,
  type AccountProviderServiceRefreshErrorEvent,
  type ProviderConfigSnapshot,
  type ProviderSource,
} from "@zcode/provider";
import {
  CHATGPT_CREDENTIAL_KEYS,
  CHATGPT_PROVIDER_ID,
  parseChatGptCachedModelsJson,
  parseChatGptSanitizedCredentialSnapshot,
} from "@zcode/shared";

/**
 * Desktop Host 侧的 ChatGPT（Sign in with ChatGPT / openai-oauth）账号投影。
 *
 * ChatGPT 凭据是本机事实（共享加密 store `~/.zcode/v2/credentials.json`，单键
 * `oauth:chatgpt:credentials`），不是 Host 管理的 zhipu 账号态；这里把
 * entitlement + /v1/models 缓存投影为第三层 Account Overlay，让 Host Registry
 * （模型选择 View / 设置页）以及推送给 agent 的账号快照都包含 ChatGPT Provider。
 *
 * 移植自 nasone32/ZCode feat/chatgpt-oauth（commit bd5171cb）的
 * chatGptAccountProjection.ts，按本仓库计划 §3/§4 调整：
 * - 凭据格式跟随 SIWC 区域的单键记录（generation CAS），不是 fork 的多键布局；
 * - 解析只走 shared 的 sanitized 视图，本文件不接触 token 值；
 * - 内置 guard：Built-in 未声明 ChatGPT Provider 时保持 Host 快照原样
 *   （revision 不变），托管 Worker 的账号交付语义不受本机登录态影响。
 *
 * Token 本身绝不进入 Provider Config、日志或遥测；请求期 Bearer 由 agent 进程的
 * requestAuth source（adapters/chatgpt）从同一 store 解析并按需刷新。
 */

export interface ChatGptAccountCredentialReader {
  loadCredential(key: string): Promise<string | null>;
}

/** 读取 ChatGPT 投影：未登录 → entitled=false（fail-closed）；登录 → entitled+模型缓存。 */
export async function readChatGptAccountProviderOverlay(
  reader: ChatGptAccountCredentialReader,
): Promise<ProviderConfig> {
  const raw = await reader.loadCredential(CHATGPT_CREDENTIAL_KEYS.credentials).catch(() => null);
  const snapshot = parseChatGptSanitizedCredentialSnapshot(raw);
  if (!snapshot) {
    return new ProviderConfig({
      access: new OpenAiOAuthAccessConfig({ entitled: false }),
    });
  }
  const modelsRaw = await reader.loadCredential(CHATGPT_CREDENTIAL_KEYS.models).catch(() => null);
  const models = parseChatGptCachedModelsJson(modelsRaw);
  return new ProviderConfig({
    access: new OpenAiOAuthAccessConfig({ entitled: snapshot.planEnabled }),
    // 空目录是合法结果（计划 §3 备注 5）：没有模型时 Provider 从 Registry 退出，
    // 不用 seed 名单顶替；Settings 视图仍能展示 Provider 本身。
    ...(models ? { builtinModelIds: models.map((model) => model.slug) } : {}),
  });
}

export interface ChatGptAwareAccountProviderSource extends ProviderSource<AccountProviderConfigSnapshot> {
  refresh(reason?: string): Promise<AccountProviderConfigSnapshot>;
  onDidRefreshError(listener: (event: AccountProviderServiceRefreshErrorEvent) => void): () => void;
  dispose(): void;
}

export interface CreateChatGptAwareAccountProviderSourceOptions {
  /** zhipu 账号事实的既有 Source（createAccountProviderConfigSource 产物）。 */
  readonly source: ProviderSource<AccountProviderConfigSnapshot> & {
    refresh?(reason: string): Promise<AccountProviderConfigSnapshot>;
    onDidRefreshError?(
      listener: (event: AccountProviderServiceRefreshErrorEvent) => void,
    ): () => void;
    dispose?(): void;
  };
  readonly loadCredential: (key: string) => Promise<string | null>;
  /** 用于判断当前 Built-in 是否声明了 ChatGPT Provider；未声明时保持 Host 快照原样。 */
  readonly configSource: ProviderSource<ProviderConfigSnapshot>;
  /** 共享凭据文件路径；监听其变化以热更新（login/logout 后无需重启桌面）。 */
  readonly credentialFilePath: string;
  readonly watchCredentials?: boolean;
}

const CREDENTIAL_WATCH_DEBOUNCE_MS = 800;

export function createChatGptAwareAccountProviderSource(
  options: CreateChatGptAwareAccountProviderSourceOptions,
): ChatGptAwareAccountProviderSource {
  const listeners = new Set<(reason: string) => void>();
  let lastEmittedRevision: string | undefined;
  let watcher: FSWatcher | undefined;
  let watchTimer: NodeJS.Timeout | undefined;
  let disposed = false;

  const withChatGptOverlay = async (
    snapshot: AccountProviderConfigSnapshot,
  ): Promise<AccountProviderConfigSnapshot> => {
    let config: ProviderConfigSnapshot;
    try {
      config = await options.configSource.read();
    } catch {
      return snapshot;
    }
    if (!config.zcodeBuiltinProviders.has(CHATGPT_PROVIDER_ID)) return snapshot;
    const overlay = await readChatGptAccountProviderOverlay({
      loadCredential: options.loadCredential,
    });
    const providers = snapshot.providers.set(CHATGPT_PROVIDER_ID, overlay);
    return createAccountProviderConfigSnapshot(
      snapshot.basedOnZCodeBuiltinRevision,
      providers,
      snapshot.states,
    );
  };

  const emitIfChanged = (snapshot: AccountProviderConfigSnapshot, reason: string): boolean => {
    if (snapshot.revision === lastEmittedRevision) return false;
    lastEmittedRevision = snapshot.revision;
    for (const listener of listeners) listener(reason);
    return true;
  };

  const source: ChatGptAwareAccountProviderSource = {
    async read() {
      const snapshot = await withChatGptOverlay(await options.source.read());
      lastEmittedRevision ??= snapshot.revision;
      return snapshot;
    },
    async refresh(reason = "explicit") {
      // 本地 ChatGPT 变更/上游通知只需重投影；再次刷新上游会形成
      // onDidChange -> refresh -> onDidChange 回环，并触发无关 Z.ai 网络查询。
      const base = await (reason.startsWith("chatgpt-")
        ? options.source.read()
        : (options.source.refresh?.(reason) ?? options.source.read()));
      const snapshot = await withChatGptOverlay(base);
      emitIfChanged(snapshot, reason);
      return snapshot;
    },
    onDidChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onDidRefreshError(listener) {
      return options.source.onDidRefreshError?.(listener) ?? (() => undefined);
    },
    dispose() {
      disposed = true;
      if (watchTimer) clearTimeout(watchTimer);
      watcher?.close();
      watcher = undefined;
      listeners.clear();
      disposeBaseSubscription();
      options.source.dispose?.();
    },
  };

  // Host 侧订阅 base 变化（settings/config 驱动的 zhipu 刷新）→ 重投影并按需广播。
  const disposeBaseSubscription = options.source.onDidChange((reason) => {
    if (disposed) return;
    void source.refresh(`chatgpt-overlay:${reason}`).catch(() => undefined);
  });

  if (options.watchCredentials !== false) {
    // 凭据文件由 CLI/Host 进程原子写（rename）；监听目录并过滤文件名，避免监听不存在文件。
    const directory = dirname(options.credentialFilePath);
    const fileName = basename(options.credentialFilePath);
    try {
      watcher = watch(directory, { persistent: false }, (_event, changedFile) => {
        if (disposed || (changedFile && changedFile !== fileName)) return;
        if (watchTimer) clearTimeout(watchTimer);
        watchTimer = setTimeout(() => {
          if (disposed) return;
          void source.refresh("chatgpt-credentials-changed").catch(() => undefined);
        }, CREDENTIAL_WATCH_DEBOUNCE_MS);
        watchTimer.unref?.();
      });
      watcher.on("error", () => undefined);
      watcher.unref?.();
    } catch {
      // 监听不可用（权限/平台差异）时退化为无热更新；重启后仍然生效。
    }
  }

  return source;
}
