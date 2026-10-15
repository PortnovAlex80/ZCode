import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OpenAiOAuthAccessConfig,
  ProviderConfig,
  ProviderConfigMap,
  createAccountProviderConfigSnapshot,
  type AccountProviderConfigSnapshot,
  type ProviderSource,
} from "@zcode/provider";
import {
  CHATGPT_CREDENTIAL_KEYS,
  CHATGPT_PROVIDER_ID,
  CHATGPT_TOKEN_SHARING_SCOPE,
  CHATGPT_USAGE_SETTINGS_URL,
  chatGptAccountStatusSchema,
} from "@zcode/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createChatGptAwareAccountProviderSource,
  readChatGptAccountProviderOverlay,
} from "../src/model-provider/chatGptAccountProjection.js";
import { createChatGptAccountService } from "../src/model-provider/chatGptAccountService.js";
import { createCredentialService } from "../src/credential/credentialService.js";
import { createProviderConfigRuntime } from "../src/model-provider/providerConfigRuntime.js";
import { createProviderRuntimeFromConfigRuntime } from "../src/model-provider/providerRuntime.js";
import { resolveCredentialFilePath } from "../src/model-provider/providerProvisioningSource.js";
import { getAppConfigDir, setDataBaseDir } from "../src/paths.js";

/**
 * Desktop Host 侧 ChatGPT（openai-oauth）投影：
 * 本机凭据（共享加密 store）→ Account Overlay → Host Registry / 模型选择 View；
 * 未登录 fail-closed；凭据文件变化经 watcher 热更新，不重启。
 */

const tempDirs: string[] = [];

afterEach(async () => {
  setDataBaseDir(null);
  await Promise.all(tempDirs.splice(0).map((dir) => rmDir(dir)));
});

async function rmDir(dir: string): Promise<void> {
  const { rm } = await import("node:fs/promises");
  await rm(dir, { recursive: true, force: true });
}

function createCredentialMap(initial: Record<string, string>) {
  const values = new Map(Object.entries(initial));
  return {
    loadCredential: vi.fn(async (key: string) => values.get(key) ?? null),
    deleteCredential: vi.fn(async (key: string) => {
      values.delete(key);
    }),
    replace(next: Record<string, string>): void {
      values.clear();
      for (const [key, value] of Object.entries(next)) values.set(key, value);
    },
    raw(): Record<string, string> {
      return Object.fromEntries(values.entries());
    },
  };
}

function chatGptCredentialRecord(input: {
  readonly scopes?: readonly string[];
  readonly email?: string;
  readonly plan?: string;
}): string {
  return JSON.stringify({
    schema_version: 1,
    generation: "gen-1",
    client_id: "oaiapp_test_client",
    access_token: "secret-access-token-value",
    refresh_token: "secret-refresh-token-value",
    id_token: "secret-id-token-value",
    account: {
      subject: "user-subject-1",
      ...(input.email ? { email: input.email } : {}),
      ...(input.plan ? { plan: input.plan } : {}),
      scopes: [...(input.scopes ?? [CHATGPT_TOKEN_SHARING_SCOPE])],
    },
    expires_at: Date.now() + 3_600_000,
    issued_at: Date.now(),
  });
}

function modelsCacheJson(models: readonly { slug: string; display_name: string }[]): string {
  return JSON.stringify(models);
}

describe("readChatGptAccountProviderOverlay", () => {
  it("does not grant model access without the plan scope even with a cached catalog", async () => {
    const overlay = await readChatGptAccountProviderOverlay(
      createCredentialMap({
        [CHATGPT_CREDENTIAL_KEYS.credentials]: chatGptCredentialRecord({ scopes: ["openid"] }),
        [CHATGPT_CREDENTIAL_KEYS.models]: modelsCacheJson([
          { slug: "gpt-test", display_name: "Test" },
        ]),
      }),
    );
    expect(overlay.toJSON().access).toEqual({ type: "openai-oauth", entitled: false });
  });
  it("未登录（无记录/损坏记录）fail-closed：entitled=false 且无模型", async () => {
    const store = createCredentialMap({});
    const overlay = await readChatGptAccountProviderOverlay(store);
    expect(overlay.toJSON()).toEqual({
      access: { type: "openai-oauth", entitled: false },
    });

    store.replace({
      [CHATGPT_CREDENTIAL_KEYS.credentials]: "{ not-json",
    });
    const corrupt = await readChatGptAccountProviderOverlay(store);
    expect(corrupt.toJSON()).toEqual({
      access: { type: "openai-oauth", entitled: false },
    });
  });

  it("已登录：entitled=true 并带 /v1/models 缓存 slug；空缓存是合法的空目录", async () => {
    const store = createCredentialMap({
      [CHATGPT_CREDENTIAL_KEYS.credentials]: chatGptCredentialRecord({}),
      [CHATGPT_CREDENTIAL_KEYS.models]: modelsCacheJson([
        { slug: "gpt-6.1-sol", display_name: "GPT 6.1" },
        { slug: "gpt-5.5-fast", display_name: "GPT 5.5 Fast" },
      ]),
    });
    const overlay = await readChatGptAccountProviderOverlay(store);
    expect(overlay.toJSON()).toEqual({
      access: { type: "openai-oauth", entitled: true },
      builtinModelIds: ["gpt-6.1-sol", "gpt-5.5-fast"],
    });

    const emptyCatalog = createCredentialMap({
      [CHATGPT_CREDENTIAL_KEYS.credentials]: chatGptCredentialRecord({}),
    });
    const empty = await readChatGptAccountProviderOverlay(emptyCatalog);
    expect(empty.toJSON()).toEqual({
      access: { type: "openai-oauth", entitled: true },
    });
  });

  it("缺 token 成员的记录视为未登录，不投影 entitlement", async () => {
    const partial = JSON.parse(chatGptCredentialRecord({})) as Record<string, unknown>;
    delete partial.refresh_token;
    const store = createCredentialMap({
      [CHATGPT_CREDENTIAL_KEYS.credentials]: JSON.stringify(partial),
    });
    const overlay = await readChatGptAccountProviderOverlay(store);
    expect(overlay.toJSON()).toEqual({
      access: { type: "openai-oauth", entitled: false },
    });
  });

  it("投影输出不含任何 token 值或凭据键名", async () => {
    const store = createCredentialMap({
      [CHATGPT_CREDENTIAL_KEYS.credentials]: chatGptCredentialRecord({
        email: "user@example.com",
        plan: "plus",
      }),
      [CHATGPT_CREDENTIAL_KEYS.models]: modelsCacheJson([
        { slug: "gpt-6.1-sol", display_name: "G" },
      ]),
    });
    const serialized = JSON.stringify((await readChatGptAccountProviderOverlay(store)).toJSON());
    expect(serialized).not.toContain("secret-access-token-value");
    expect(serialized).not.toContain("secret-refresh-token-value");
    expect(serialized).not.toContain("oauth:chatgpt:");
  });
});

describe("createChatGptAwareAccountProviderSource", () => {
  it("reprojects upstream events and local credential changes without upstream network refresh", async () => {
    const base = createAccountProviderConfigSnapshot("rev", ProviderConfigMap.empty(), {});
    let notify: (reason: string) => void = () => {};
    const upstream = {
      read: vi.fn(async () => base),
      refresh: vi.fn(async () => base),
      onDidChange: (listener: (reason: string) => void) => {
        notify = listener;
        return () => {};
      },
    };
    const source = createChatGptAwareAccountProviderSource({
      source: upstream,
      configSource: {
        read: async () => ({ revision: "rev", zcodeBuiltinProviders: ProviderConfigMap.empty() }),
        onDidChange: () => () => {},
      },
      loadCredential: async () => null,
      credentialFilePath: "unused",
      watchCredentials: false,
    });
    await source.read();
    notify("upstream-updated");
    await source.refresh("chatgpt-credentials-changed");
    expect(upstream.refresh).not.toHaveBeenCalled();
    await source.refresh("explicit");
    expect(upstream.refresh).toHaveBeenCalledOnce();
    source.dispose();
  });
  it("Built-in 未声明 ChatGPT Provider 时保持 Host 快照原样（guard）", async () => {
    const store = createCredentialMap({
      [CHATGPT_CREDENTIAL_KEYS.credentials]: chatGptCredentialRecord({}),
    });
    const base = createAccountProviderConfigSnapshot(
      "builtin-rev-1",
      ProviderConfigMap.empty(),
      {},
    );
    const configSource: ProviderSource<{
      revision: string;
      zcodeBuiltinProviders: ProviderConfigMap;
    }> = {
      read: async () => ({
        revision: "builtin-rev-1",
        zcodeBuiltinProviders: ProviderConfigMap.empty(),
      }),
      onDidChange: () => () => undefined,
    };
    const source = createChatGptAwareAccountProviderSource({
      source: staticSource(base),
      loadCredential: store.loadCredential,
      configSource,
      credentialFilePath: join(tmpdir(), "nowhere-credentials.json"),
      watchCredentials: false,
    });
    const snapshot = await source.read();
    expect(snapshot).toBe(base);
    expect(snapshot.providers.has(CHATGPT_PROVIDER_ID)).toBe(false);
  });

  it("凭据变化经 watcher 触发 refresh 与 onDidChange（Host Registry 热更新链）", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chatgpt-watch-"));
    tempDirs.push(directory);
    const credentialFilePath = join(directory, "credentials.json");
    const store = createCredentialMap({});
    const base = createAccountProviderConfigSnapshot(
      "builtin-rev-1",
      ProviderConfigMap.empty(),
      {},
    );
    const configSource: ProviderSource<{
      revision: string;
      zcodeBuiltinProviders: ProviderConfigMap;
    }> = {
      read: async () => ({
        revision: "builtin-rev-1",
        zcodeBuiltinProviders: new ProviderConfigMap([
          [
            CHATGPT_PROVIDER_ID,
            new ProviderConfig({
              access: new OpenAiOAuthAccessConfig(),
              api: {
                type: "openai-responses",
                baseUrl: "https://api.openai.com/v1",
              },
            }),
          ],
        ]),
      }),
      onDidChange: () => () => undefined,
    };
    const source = createChatGptAwareAccountProviderSource({
      source: staticSource(base),
      loadCredential: store.loadCredential,
      configSource,
      credentialFilePath,
    });
    const changes: string[] = [];
    const dispose = source.onDidChange((reason) => changes.push(reason));
    try {
      expect((await source.read()).providers.get(CHATGPT_PROVIDER_ID)?.toJSON()).toEqual({
        access: { type: "openai-oauth", entitled: false },
      });

      // 模拟 CLI/登录进程写入凭据（原子 rename 与内容等价于此处的直接写）。
      store.replace({
        [CHATGPT_CREDENTIAL_KEYS.credentials]: chatGptCredentialRecord({}),
        [CHATGPT_CREDENTIAL_KEYS.models]: modelsCacheJson([
          { slug: "gpt-6.1-sol", display_name: "GPT 6.1" },
        ]),
      });
      await writeFile(credentialFilePath, "{}\n", "utf-8");

      await vi.waitFor(
        () => {
          expect(changes).toContain("chatgpt-credentials-changed");
        },
        { timeout: 4_000, interval: 100 },
      );
      const snapshot = await source.read();
      expect(snapshot.providers.get(CHATGPT_PROVIDER_ID)?.toJSON()).toEqual({
        access: { type: "openai-oauth", entitled: true },
        builtinModelIds: ["gpt-6.1-sol"],
      });
      expect(snapshot.basedOnZCodeBuiltinRevision).toBe("builtin-rev-1");
    } finally {
      dispose();
      source.dispose();
    }
  });
});

describe("ChatGPT account projection end-to-end（Host Registry → ModelSelectionFacade）", () => {
  it("真实凭据文件写入 → watcher → Registry → 模型选择 View 出现 ChatGPT 组；全程无秘密泄漏", async () => {
    const root = await mkdtemp(join(tmpdir(), "chatgpt-e2e-"));
    tempDirs.push(root);
    setDataBaseDir(root);
    // Host 装配时 App 配置目录必须已存在（真实桌面由启动目录初始化），
    // 否则凭据目录 watch 会被降级为无热更新。
    await mkdir(join(root, ".zcode", "v2"), { recursive: true });
    const zcodeBuiltinFilePath = join(root, "zcode-builtin.json");
    await writeFile(
      zcodeBuiltinFilePath,
      JSON.stringify({
        schemaVersion: 1,
        revision: 7,
        config: {
          providerConfigRules: { providerRules: [], templateRules: [] },
          modelConfigRules: {
            modelRules: [
              {
                modelMatch: ".*",
                config: {
                  enabled: true,
                  properties: {
                    contextWindow: 200000,
                    inputFormat: {
                      supportsText: true,
                      supportsImage: false,
                      supportsVideo: false,
                      supportsAudio: false,
                      supportsPdf: false,
                    },
                    outputFormat: { supportsText: true },
                    supportsToolCall: true,
                    supportsJsonSchemaOutput: false,
                    supportsNativeWebSearch: false,
                    supportsMidConversationSystem: false,
                    requiresMfjsToolSchema: false,
                  },
                  optionSpecs: {
                    maxOutputTokens: { max: 32000 },
                    reasoningLevel: {
                      values: ["disabled", "enabled"],
                      map: "{}",
                    },
                  },
                },
              },
            ],
            modelApiRules: [
              {
                // 生产 Built-in 里 openai-responses 的 option map 由 API 层规则补齐；
                // 最小 fixture 复刻同一层，避免把「缺 map」误判为 Provider 不可执行。
                modelMatch: ".*",
                apiTypeMatch: "openai-responses",
                config: {
                  optionSpecs: {
                    reasoningLevel: {
                      map: '{ "reasoning": { "effort": reasoningLevel } }',
                    },
                    maxOutputTokens: {
                      map: "{'max_output_tokens': maxOutputTokens}",
                    },
                  },
                },
              },
            ],
            providerSiteRules: [],
            templateModelRules: [],
            builtinProviderModelRules: [],
          },
        },
      }),
      "utf-8",
    );

    const credentialService = createCredentialService();
    const configRuntime = createProviderConfigRuntime({
      zcodeBuiltinFilePath,
      watch: false,
    });
    // zhipu 账号事实在本场景恒为空，但 basedOnZCodeBuiltinRevision 必须跟随当前
    // Built-in（registry guard），否则 Host Registry 会拒收 account 层。
    const baseAccountSource: ProviderSource<AccountProviderConfigSnapshot> & {
      refresh(reason: string): Promise<AccountProviderConfigSnapshot>;
    } = {
      async read() {
        const config = await configRuntime.configService.read();
        return createAccountProviderConfigSnapshot(
          config.zcodeBuiltinRevision,
          ProviderConfigMap.empty(),
          {},
        );
      },
      async refresh() {
        return this.read();
      },
      onDidChange() {
        return () => undefined;
      },
      onDidRefreshError() {
        return () => undefined;
      },
      dispose() {},
    };
    const accountSource = createChatGptAwareAccountProviderSource({
      source: baseAccountSource,
      loadCredential: (key) => credentialService.load(key),
      configSource: configRuntime.configService,
      credentialFilePath: resolveCredentialFilePath(getAppConfigDir()),
    });
    const runtime = createProviderRuntimeFromConfigRuntime({
      configRuntime,
      accountSource,
      disposeAccountSource: () => accountSource.dispose(),
    });
    try {
      await runtime.registryService.start();

      // 登录前：GPT-00 路径 A 的增补让 Built-in 声明了 Provider，但空目录 +
      // entitled=false ⇒ 不进入模型选择 View（不出现假选择）。
      const before = await runtime.modelSelection.getView();
      expect(before.providers.some((provider) => provider.providerId === CHATGPT_PROVIDER_ID)).toBe(
        false,
      );

      const viewChanges: number[] = [];
      const disposeView = runtime.modelSelection.onDidChange((view) =>
        viewChanges.push(view.revision),
      );

      // 登录：真实加密凭据落盘（credentialService 与 CLI 共用同一文件格式/密钥派生）。
      await credentialService.save(
        CHATGPT_CREDENTIAL_KEYS.credentials,
        chatGptCredentialRecord({ email: "user@example.com", plan: "plus" }),
      );
      await credentialService.save(
        CHATGPT_CREDENTIAL_KEYS.models,
        modelsCacheJson([{ slug: "gpt-6.1-sol", display_name: "GPT 6.1" }]),
      );

      await vi.waitFor(
        async () => {
          const probe = await accountSource.read();
          expect(probe.providers.get(CHATGPT_PROVIDER_ID)?.toJSON()).toEqual({
            access: { type: "openai-oauth", entitled: true },
            builtinModelIds: ["gpt-6.1-sol"],
          });
        },
        { timeout: 5_000, interval: 100 },
      );
      await vi.waitFor(
        () => {
          expect(viewChanges.length).toBeGreaterThan(0);
        },
        { timeout: 5_000, interval: 100 },
      );
      const after = await runtime.modelSelection.getView();
      const chatGptProvider = after.providers.find(
        (provider) => provider.providerId === CHATGPT_PROVIDER_ID,
      );
      expect(chatGptProvider).toBeDefined();
      expect(chatGptProvider?.models.map((model) => model.modelId)).toEqual(["gpt-6.1-sol"]);
      expect(chatGptProvider?.config.access).toEqual({
        type: "openai-oauth",
        entitled: true,
      });

      // 渲染层可见 payload 不得包含任何凭据键或 token 值。
      const serializedView = JSON.stringify(after);
      expect(serializedView).not.toContain("oauth:chatgpt:");
      expect(serializedView).not.toContain("secret-access-token-value");
      expect(serializedView).not.toContain("secret-refresh-token-value");
      expect(serializedView).not.toContain("user@example.com");
      disposeView.dispose();

      // 目录服务不可用时，显式添加的 Personal 模型仍走同一 OAuth Provider；
      // 配置成员不等于账号授权，登出后必须从聊天选择器退出。
      await credentialService.delete(CHATGPT_CREDENTIAL_KEYS.models);
      await runtime.providerSettings.refresh("chatgpt-models");
      const emptySettings = await runtime.providerSettings.getView();
      expect(
        emptySettings.providers.find((provider) => provider.providerId === CHATGPT_PROVIDER_ID),
      ).toMatchObject({ executable: false, models: [] });
      await runtime.providerSettings.addPersonalModel(CHATGPT_PROVIDER_ID, "gpt-6-astra", {}, true);
      const personalView = await runtime.modelSelection.getView();
      expect(
        personalView.providers.find((provider) => provider.providerId === CHATGPT_PROVIDER_ID),
      ).toMatchObject({
        config: { access: { type: "openai-oauth", entitled: true } },
        models: [{ modelId: "gpt-6-astra" }],
      });
      expect(await credentialService.load(CHATGPT_CREDENTIAL_KEYS.models)).toBeNull();
      await runtime.providerSettings.setPersonalModelEnabled(
        CHATGPT_PROVIDER_ID,
        "gpt-6-astra",
        false,
      );
      expect(
        (await runtime.modelSelection.getView()).providers.some(
          (provider) => provider.providerId === CHATGPT_PROVIDER_ID,
        ),
      ).toBe(false);
      await runtime.providerSettings.setPersonalModelEnabled(
        CHATGPT_PROVIDER_ID,
        "gpt-6-astra",
        true,
      );
      expect(
        (await runtime.modelSelection.getView()).providers.find(
          (provider) => provider.providerId === CHATGPT_PROVIDER_ID,
        )?.models[0]?.modelId,
      ).toBe("gpt-6-astra");
      await credentialService.delete(CHATGPT_CREDENTIAL_KEYS.credentials);
      await runtime.providerSettings.refresh("chatgpt-credentials-changed");
      expect(
        (await runtime.modelSelection.getView()).providers.some(
          (provider) => provider.providerId === CHATGPT_PROVIDER_ID,
        ),
      ).toBe(false);
      expect(
        (await runtime.providerSettings.getView()).providers.find(
          (provider) => provider.providerId === CHATGPT_PROVIDER_ID,
        )?.models[0]?.modelId,
      ).toBe("gpt-6-astra");
    } finally {
      runtime.dispose();
    }
  });
});

describe("createChatGptAccountService", () => {
  it("serializes login, logout and a new login in user action order", async () => {
    const store = createCredentialMap({});
    const events: string[] = [];
    let releaseLogin!: () => void;
    const firstLogin = new Promise<void>((resolve) => {
      releaseLogin = resolve;
    });
    let logins = 0;
    const service = createChatGptAccountService({
      ...store,
      loginBridge: async () => {
        logins += 1;
        events.push(`login${logins}`);
        if (logins === 1) await firstLogin;
        store.replace({ [CHATGPT_CREDENTIAL_KEYS.credentials]: chatGptCredentialRecord({}) });
      },
      logoutBridge: async () => {
        events.push("logout");
        store.replace({});
        return { revoked: true };
      },
    });
    const login = service.beginLogin();
    const duplicate = service.beginLogin();
    const logout = service.disconnect();
    const nextLogin = service.beginLogin();
    releaseLogin();
    await Promise.all([login, duplicate, logout, nextLogin]);
    expect(events).toEqual(["login1", "logout", "login2"]);
    expect(await service.getStatus()).toMatchObject({ status: "plan-enabled" });
    expect(store.deleteCredential).not.toHaveBeenCalled();
    service.dispose();
  });
  it("状态映射：未连接 / 已登录无计划 scope / plan-enabled", async () => {
    const store = createCredentialMap({});
    const service = createChatGptAccountService({
      loadCredential: store.loadCredential,
      deleteCredential: store.deleteCredential,
    });
    expect(await service.getStatus()).toEqual({ status: "not-connected" });

    store.replace({
      [CHATGPT_CREDENTIAL_KEYS.credentials]: chatGptCredentialRecord({
        scopes: ["openid", "email"],
      }),
    });
    expect(await service.getStatus()).toEqual({ status: "connected" });

    store.replace({
      [CHATGPT_CREDENTIAL_KEYS.credentials]: chatGptCredentialRecord({
        email: "user@example.com",
        plan: "plus",
      }),
    });
    expect(await service.getStatus()).toEqual({
      status: "plan-enabled",
      email: "user@example.com",
      plan: "plus",
      usageUrl: CHATGPT_USAGE_SETTINGS_URL,
    });
    // 出口必须通过严格 schema（字段白名单，无 token 通道）。
    const planStatus = await service.getStatus();
    expect(() => chatGptAccountStatusSchema.parse(planStatus)).not.toThrow();
    service.dispose();
  });

  it("运行时观测升级状态；凭据消失或恢复观测会回落", async () => {
    const store = createCredentialMap({
      [CHATGPT_CREDENTIAL_KEYS.credentials]: chatGptCredentialRecord({}),
    });
    const service = createChatGptAccountService({
      loadCredential: store.loadCredential,
      deleteCredential: store.deleteCredential,
    });
    await service.reportRuntimeObservation({ kind: "quota-exhausted" });
    expect(await service.getStatus()).toMatchObject({
      status: "quota-exhausted",
    });

    await service.reportRuntimeObservation({ kind: "session-recovered" });
    expect(await service.getStatus()).toMatchObject({ status: "plan-enabled" });

    await service.reportRuntimeObservation({ kind: "restricted" });
    store.replace({});
    expect(await service.getStatus()).toEqual({ status: "not-connected" });
    service.dispose();
  });

  it("beginLogin：未注入登录桥 fail-closed；注入后完成并广播", async () => {
    const store = createCredentialMap({});
    const service = createChatGptAccountService({
      loadCredential: store.loadCredential,
      deleteCredential: store.deleteCredential,
    });
    await expect(service.beginLogin()).resolves.toEqual({
      result: "unavailable",
      reason: "login-bridge-not-configured",
    });
    service.dispose();

    const loginBridge = vi.fn(async () => {
      store.replace({
        [CHATGPT_CREDENTIAL_KEYS.credentials]: chatGptCredentialRecord({}),
      });
    });
    const withBridge = createChatGptAccountService({
      loadCredential: store.loadCredential,
      deleteCredential: store.deleteCredential,
      loginBridge,
    });
    const events: string[] = [];
    const subscription = withBridge.onDidChange((status) => events.push(status.status));
    const result = await withBridge.beginLogin();
    expect(result).toEqual({
      result: "completed",
      status: { status: "plan-enabled", usageUrl: CHATGPT_USAGE_SETTINGS_URL },
    });
    expect(loginBridge).toHaveBeenCalledTimes(1);
    expect(events).toContain("plan-enabled");
    subscription.dispose();
    withBridge.dispose();
  });

  it("disconnect：清空本地凭据（无桥时 revoked=false）并广播 not-connected", async () => {
    const store = createCredentialMap({
      [CHATGPT_CREDENTIAL_KEYS.credentials]: chatGptCredentialRecord({}),
      [CHATGPT_CREDENTIAL_KEYS.models]: modelsCacheJson([
        { slug: "gpt-6.1-sol", display_name: "G" },
      ]),
    });
    const service = createChatGptAccountService({
      loadCredential: store.loadCredential,
      deleteCredential: store.deleteCredential,
    });
    const events: string[] = [];
    const subscription = service.onDidChange((status) => events.push(status.status));
    const result = await service.disconnect();
    expect(result.revoked).toBe(false);
    expect(result.status).toEqual({ status: "not-connected" });
    expect(store.raw()[CHATGPT_CREDENTIAL_KEYS.credentials]).toBeUndefined();
    expect(events).toContain("not-connected");
    subscription.dispose();
    service.dispose();
  });
});

function staticSource(
  snapshot: AccountProviderConfigSnapshot,
): ProviderSource<AccountProviderConfigSnapshot> & {
  refresh(reason: string): Promise<AccountProviderConfigSnapshot>;
} {
  return {
    async read() {
      return snapshot;
    },
    async refresh() {
      return snapshot;
    },
    onDidChange() {
      return () => undefined;
    },
    onDidRefreshError() {
      return () => undefined;
    },
    dispose() {},
  };
}
