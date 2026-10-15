import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OpenAiOAuthAccessConfig,
  ProviderConfig,
  ProviderConfigMap,
  createAccountProviderConfigSnapshot,
} from "@zcode/provider";
import {
  ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV,
  ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV,
} from "@zcode/provider-node";
import { CHATGPT_PROVIDER_ID, zcodeProtocolMethods } from "@zcode/shared";
import {
  startProcessProviderRegistryRuntime,
  parseProcessAccountProviderConfigSnapshot,
} from "../src/app/process-provider-registry-runtime.js";
import { ZCodeProtocolAgentServer } from "../src/zcode-protocol/server.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function startRuntime() {
  const directory = await mkdtemp(join(tmpdir(), "account-delivery-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const started = await startProcessProviderRegistryRuntime({
    [ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: fileURLToPath(
      new URL("../../../../../config/provider/zcode-builtin.json", import.meta.url),
    ),
    [ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: join(directory, "personal.json"),
    // 隔离本机凭据存储：ChatGPT 本地投影在测试里稳定为 fail-closed。
    ZCODE_DATA_BASE_DIR: directory,
  });
  cleanups.unshift(async () => started.dispose());
  return started;
}

describe("托管 Worker 账号交付", () => {
  it("Account B 先到时接收 B、仍使用 A；配套配置到后才整体应用 B", async () => {
    const started = await startRuntime();
    const registry = started.runtime.registryService;
    const previous = registry.getSnapshot();
    const next = createAccountProviderConfigSnapshot("builtin-B", ProviderConfigMap.empty(), {});
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp() {
        throw new Error("账号交付不得创建会话");
      },
      syncAccountProviderConfig: started.syncAccountProviderConfig,
    });
    expect(
      await server.handleMessage({
        id: 1,
        method: zcodeProtocolMethods.providerUpdateAccountConfig,
        params: {
          ...next,
          providers: Object.fromEntries(
            [...next.providers.entries()].map(([id, config]) => [id, config.toJSON()]),
          ),
        },
      }),
    ).toMatchObject({
      result: { receivedRevision: next.revision, providerCount: 0, status: "received" },
    });
    // Host 快照会被附加本机 ChatGPT（openai-oauth）fail-closed 投影后再入 Source。
    const storedAccount = await started.accountSource.read();
    expect(storedAccount.providers.get(CHATGPT_PROVIDER_ID)?.toJSON()).toEqual({
      access: { type: "openai-oauth", entitled: false },
    });
    expect(storedAccount.revision).toBe(
      createAccountProviderConfigSnapshot(
        next.basedOnZCodeBuiltinRevision,
        next.providers.set(
          CHATGPT_PROVIDER_ID,
          new ProviderConfig({ access: new OpenAiOAuthAccessConfig({ entitled: false }) }),
        ),
        next.states,
      ).revision,
    );
    expect(registry.getSnapshot()).toBe(previous);

    const config = await started.runtime.configService.read();
    vi.spyOn(started.runtime.configService, "read").mockResolvedValue({
      ...config,
      revision: "config-B",
      zcodeBuiltinRevision: "builtin-B",
    });
    await registry.refresh("配套配置到达");
    expect(registry.getSnapshot()?.account.revision).toBe(
      createAccountProviderConfigSnapshot(
        next.basedOnZCodeBuiltinRevision,
        next.providers.set(
          CHATGPT_PROVIDER_ID,
          new ProviderConfig({ access: new OpenAiOAuthAccessConfig({ entitled: false }) }),
        ),
        next.states,
      ).revision,
    );
    expect(registry.getSnapshot()?.config.zcodeBuiltinRevision).toBe("builtin-B");
  });

  it("刷新失败后同一份快照重交仍刷新，不能因 Source 已收过而跳过", async () => {
    const started = await startRuntime();
    const next = createAccountProviderConfigSnapshot(
      started.snapshot.config.zcodeBuiltinRevision,
      ProviderConfigMap.empty(),
      {},
    );
    const refresh = vi
      .spyOn(started.runtime.registryService, "refresh")
      .mockRejectedValueOnce(new Error("refresh failed"));
    await expect(started.syncAccountProviderConfig(next)).rejects.toThrow("refresh failed");
    await expect(started.syncAccountProviderConfig(next)).resolves.toBe(false);
    expect(refresh).toHaveBeenCalledTimes(2);
    const snapshot = started.runtime.registryService.getSnapshot();
    // 与上面同理：Registry 内的 account 快照含 ChatGPT fail-closed 投影。
    expect(snapshot?.account.providers.get(CHATGPT_PROVIDER_ID)?.toJSON()).toEqual({
      access: { type: "openai-oauth", entitled: false },
    });
    expect(snapshot?.account.revision).toBe(
      createAccountProviderConfigSnapshot(
        next.basedOnZCodeBuiltinRevision,
        next.providers.set(
          CHATGPT_PROVIDER_ID,
          new ProviderConfig({ access: new OpenAiOAuthAccessConfig({ entitled: false }) }),
        ),
        next.states,
      ).revision,
    );
  });

  it("普通账号有权益却缺 current 时拒绝交付，不能宽松放行", () => {
    expect(() =>
      parseProcessAccountProviderConfigSnapshot({
        revision: "incomplete",
        basedOnZCodeBuiltinRevision: "builtin-A",
        providers: {
          "account:bigmodel-individual-coding-plan": {
            access: { type: "zhipu-account", entitled: true },
          },
        },
        states: {},
      }),
    ).toThrow("current");
  });

  it.each([
    { providerId: "account:bigmodel-individual-coding-plan", entitled: false },
    { providerId: "account:bigmodel-offpeak-idle-plan", entitled: true },
  ])("初始 fail-closed 和闲时不被强加 current：$providerId", ({ providerId, entitled }) => {
    expect(() =>
      parseProcessAccountProviderConfigSnapshot({
        revision: "allowed",
        basedOnZCodeBuiltinRevision: "builtin-A",
        states: {},
        providers: { [providerId]: { access: { type: "zhipu-account", entitled } } },
      }),
    ).not.toThrow();
  });
});
