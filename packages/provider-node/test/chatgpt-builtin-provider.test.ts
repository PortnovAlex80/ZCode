import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAccountProviderConfigSnapshot,
  createFailClosedAccountProviderConfigSnapshot,
  ModelConfigRules,
  MutableAccountProviderConfigSource,
  OpenAiOAuthAccessConfig,
  ProviderConfig,
  ProviderConfigMap,
  ProviderConfigResolver,
  ProviderTemplateMap,
  serializeRegistryProviderConfig,
} from "@zcode/provider";
import {
  CHATGPT_PROVIDER_ID,
  decodeZCodeBuiltinRelease,
  NodeProviderRegistryRuntime,
  NodeZCodeBuiltinProviderConfigSource,
} from "../src/index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function materializeBundledCopy(root: string): Promise<string> {
  // 指向仓库内置文件；拷贝到临时目录，避免测试写脏真实 Active/LKG 缓存。
  const bundledFile = new URL("../../../config/provider/zcode-builtin.json", import.meta.url);
  const bundled = join(root, "bundled.json");
  await writeFile(bundled, await readFile(bundledFile, "utf8"));
  return bundled;
}

async function readBundledDocument(): Promise<{ revision: number; config: unknown }> {
  const bundledFile = new URL("../../../config/provider/zcode-builtin.json", import.meta.url);
  return JSON.parse(await readFile(bundledFile, "utf8"));
}

describe("built-in ChatGPT (openai-oauth) provider — GPT-00 路径 A 本地增补", () => {
  it("在层快照中声明 account:chatgpt，但不动 Bundled JSON 与 revision", async () => {
    const root = await mkdtemp(join(tmpdir(), "chatgpt-builtin-"));
    tempDirs.push(root);
    const bundled = await materializeBundledCopy(root);

    const layered = await new NodeZCodeBuiltinProviderConfigSource({
      bundledFilePath: bundled,
      watch: false,
    }).read();

    const chatgpt = layered.providers.get(CHATGPT_PROVIDER_ID);
    expect(chatgpt).toBeDefined();
    expect(chatgpt?.group).toBe("openai-family");
    expect(chatgpt?.access?.type).toBe("openai-oauth");
    expect(chatgpt?.api?.type).toBe("openai-responses");
    expect(chatgpt?.api?.baseUrl).toBe("https://api.openai.com/v1");
    // 未登录前不允许 Seed 模型名单（计划 §3 备注 5）：成员只能来自登录后的 entitlement Overlay。
    expect(chatgpt?.builtinModelIds).toEqual([]);

    // 既有 Provider 不受影响。
    expect(layered.providers.get("account:zai-individual-coding-plan")).toBeDefined();

    // 增补指纹进入层 revision，Account 层 basedOnZCodeBuiltinRevision 才能保持一致。
    expect(layered.revision).toMatch(/^zcode-builtin:\d+:[0-9a-f]{64}:chatgpt-[0-9a-f]{12}$/);

    // 路径 A 的核心承诺：发布文件本身保持原样（revision 不抬高、无 Seed 声明）。
    const document = await readBundledDocument();
    expect(document.revision).toBe(31);
    expect(JSON.stringify(document)).not.toContain("account:chatgpt");
  });

  it("未登录 fail-closed 不进 Registry；entitled 后成员来自 Overlay 且规则补齐完整配置", async () => {
    const root = await mkdtemp(join(tmpdir(), "chatgpt-registry-"));
    tempDirs.push(root);
    const bundled = await materializeBundledCopy(root);
    const layered = await new NodeZCodeBuiltinProviderConfigSource({
      bundledFilePath: bundled,
      watch: false,
    }).read();

    const resolver = new ProviderConfigResolver();
    const emptyPersonal = ProviderConfigMap.empty();
    const base = {
      personalProviders: emptyPersonal,
      personalModels: ModelConfigRules.empty(),
      zcodeBuiltinProviders: layered.providers,
      zcodeBuiltinModelRules: layered.models,
      zcodeBuiltinProviderTemplates: layered.providerTemplates ?? ProviderTemplateMap.empty(),
    };
    const configSnapshot = {
      revision: JSON.stringify([layered.revision, "personal"]),
      zcodeBuiltinRevision: layered.revision,
      personalRevision: "personal",
      zcodeBuiltinProviders: layered.providers,
      zcodeBuiltinProviderTemplates: layered.providerTemplates ?? ProviderTemplateMap.empty(),
      personalProviders: emptyPersonal,
      zcodeBuiltinModelRules: layered.models,
      personalModels: ModelConfigRules.empty(),
    };

    // fail-closed（未登录）：chatgpt 不进入 Registry。
    const failClosed = createFailClosedAccountProviderConfigSnapshot(configSnapshot);
    expect(failClosed.basedOnZCodeBuiltinRevision).toBe(layered.revision);
    const anonymous = resolver.resolve({ ...base, accountProviders: failClosed.providers });
    expect(
      anonymous.registryProviders.find((provider) => provider.providerId === CHATGPT_PROVIDER_ID),
    ).toBeUndefined();

    // entitled：模型成员模拟登录后 /v1/models 投影的 slug。
    const entitled = resolver.resolve({
      ...base,
      accountProviders: new ProviderConfigMap([
        [
          CHATGPT_PROVIDER_ID,
          new ProviderConfig({
            access: new OpenAiOAuthAccessConfig({ entitled: true }),
            builtinModelIds: ["gpt-5.5", "gpt-5.5-fast", "gpt-7-unknown-nova"],
          }),
        ],
      ]),
    });
    const provider = entitled.registryProviders.find(
      (candidate) => candidate.providerId === CHATGPT_PROVIDER_ID,
    );
    expect(provider).toBeDefined();
    expect(provider!.models.map((model) => model.modelId)).toEqual([
      "gpt-5.5",
      "gpt-5.5-fast",
      "gpt-7-unknown-nova",
    ]);

    // 家族 Rule 提供已核实能力；fast 变体沿用更小窗口（后置规则覆盖）。
    const mainline = provider!.models.find((model) => model.modelId === "gpt-5.5")!;
    expect(mainline.config.properties.contextWindow).toBe(1_050_000);
    expect(mainline.config.properties.inputFormat.supportsImage).toBe(true);
    expect(mainline.config.optionSpecs.reasoningLevel.values).toContain("high");
    const fast = provider!.models.find((model) => model.modelId === "gpt-5.5-fast")!;
    expect(fast.config.properties.contextWindow).toBe(400_000);

    // 未知 slug 仍由全局 catch-all 兜底成完整可执行配置（GPT-00 wildcard 语义）。
    const unknown = provider!.models.find((model) => model.modelId === "gpt-7-unknown-nova")!;
    expect(unknown.config.properties.contextWindow).toBe(200_000);
    expect(unknown.config.validateComplete()).toEqual([]);

    // Renderer 可见序列化只携带 {type, entitled}，不出现任何令牌形状字段。
    const serialized = serializeRegistryProviderConfig(provider!.config);
    expect(Object.keys(serialized.access ?? {}).sort()).toEqual(["entitled", "type"]);
    expect(JSON.stringify(serialized)).not.toMatch(/apiKey|token|secret|bearer/i);
  });

  it("CDN Release revision 更大时正常更新，且不丢失 ChatGPT Provider（备注 3 回归）", async () => {
    const root = await mkdtemp(join(tmpdir(), "chatgpt-cdn-"));
    tempDirs.push(root);
    const bundled = await materializeBundledCopy(root);
    const active = join(root, "active.json");
    const source = new NodeZCodeBuiltinProviderConfigSource({
      bundledFilePath: bundled,
      activeFilePath: active,
      watch: false,
    });
    try {
      const initial = await source.read();
      expect(initial.revision).toMatch(/^zcode-builtin:31:/);

      const document = (await readBundledDocument()) as { revision: number; config: unknown };
      const release40 = decodeZCodeBuiltinRelease({
        ...document,
        revision: 40,
      });
      expect(await source.applyRemoteRelease(release40)).toBe("updated");
      const after40 = await source.read();
      expect(after40.revision).toMatch(/^zcode-builtin:40:/);
      expect(after40.providers.has(CHATGPT_PROVIDER_ID)).toBe(true);
      expect(after40.models.resolve({
        providerId: CHATGPT_PROVIDER_ID,
        modelId: "gpt-6.1-sol",
        apiType: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
      }).properties?.contextWindow).toBe(1_050_000);

      // 后续更大 revision 依旧可更新：本地没有 932 之类的 revision 天花板。
      const release41 = decodeZCodeBuiltinRelease({
        ...document,
        revision: 41,
      });
      expect(await source.applyRemoteRelease(release41)).toBe("updated");
      expect((await source.read()).revision).toMatch(/^zcode-builtin:41:/);

      // Active 缓存里仍是未增补的原始 Release（revision 41，无 account:chatgpt）。
      const activeDocument = JSON.parse(await readFile(active, "utf8"));
      expect(activeDocument.revision).toBe(41);
      expect(JSON.stringify(activeDocument)).not.toContain("account:chatgpt");
    } finally {
      source.dispose();
    }
  });

  it("未来 CDN Release 自带 account:chatgpt 时停用增补，避免重复声明", async () => {
    const root = await mkdtemp(join(tmpdir(), "chatgpt-native-"));
    tempDirs.push(root);
    const bundled = await materializeBundledCopy(root);
    const source = new NodeZCodeBuiltinProviderConfigSource({
      bundledFilePath: bundled,
      activeFilePath: join(root, "active.json"),
      watch: false,
    });
    try {
      const document = (await readBundledDocument()) as {
        revision: number;
        config: {
          providerConfigRules: {
            templateRules: unknown[];
            providerRules: unknown[];
          };
        };
      };
      const native = decodeZCodeBuiltinRelease({
        ...document,
        revision: 50,
        config: {
          ...document.config,
          providerConfigRules: {
            ...document.config.providerConfigRules,
            providerRules: [
              ...document.config.providerConfigRules.providerRules,
              {
                providerId: CHATGPT_PROVIDER_ID,
                providerName: "ChatGPT",
                config: {
                  group: "openai-family",
                  access: { type: "openai-oauth" },
                  api: { type: "openai-responses", baseUrl: "https://api.openai.com/v1" },
                  builtinModelIds: ["gpt-9-future"],
                },
              },
            ],
          },
        },
      });
      expect(await source.applyRemoteRelease(native)).toBe("updated");
      const snapshot = await source.read();
      expect(snapshot.providers.get(CHATGPT_PROVIDER_ID)?.builtinModelIds).toEqual([
        "gpt-9-future",
      ]);
      // 增补关闭后 revision 不再带 chatgpt 指纹。
      expect(snapshot.revision).not.toContain(":chatgpt-");
    } finally {
      source.dispose();
    }
  });

  it("NodeProviderRegistryRuntime 端到端：guard 一致、登录前后 Registry 行为正确", async () => {
    const root = await mkdtemp(join(tmpdir(), "chatgpt-runtime-"));
    tempDirs.push(root);
    const bundled = await materializeBundledCopy(root);
    const accountSource = new MutableAccountProviderConfigSource();
    const runtime = new NodeProviderRegistryRuntime({
      zcodeBuiltinFilePath: bundled,
      zcodeBuiltinActiveFilePath: join(root, "active.json"),
      personalFilePath: join(root, "personal.json"),
      personalPollingIntervalMs: false,
      accountSource,
    });
    try {
      await runtime.start();
      // 账号 Provider（含 chatgpt）默认 fail-closed，不向 Registry 发布模型。
      expect(
        runtime.registryService
          .listProviders()
          .some((provider) => provider.providerId === CHATGPT_PROVIDER_ID),
      ).toBe(false);

      // guard 一致性：fail-closed 基于同一份增补 revision 构建，Registry 没有被冻结在旧快照。
      const initialSnapshot = runtime.registryService.getSnapshot();
      expect(initialSnapshot).not.toBeNull();
      expect(initialSnapshot!.account.basedOnZCodeBuiltinRevision).toBe(
        initialSnapshot!.config.zcodeBuiltinRevision,
      );
      expect(initialSnapshot!.config.zcodeBuiltinRevision).toMatch(/:chatgpt-[0-9a-f]{12}$/);

      // 模拟登录：entitlement Overlay 基于 config.zcodeBuiltinRevision 构建。
      const config = await runtime.configService.read();
      accountSource.replace(
        createAccountProviderConfigSnapshot(
          config.zcodeBuiltinRevision,
          new ProviderConfigMap([
            [
              CHATGPT_PROVIDER_ID,
              new ProviderConfig({
                access: new OpenAiOAuthAccessConfig({ entitled: true }),
                builtinModelIds: ["gpt-5.5"],
              }),
            ],
          ]),
        ),
        "chatgpt-login",
      );
      await runtime.registryService.refresh("chatgpt-login");
      const provider = runtime.registryService.getProvider(CHATGPT_PROVIDER_ID);
      expect(provider).toBeDefined();
      expect(provider!.models.map((model) => model.modelId)).toEqual(["gpt-5.5"]);
      expect(Object.keys(serializeRegistryProviderConfig(provider!.config).access ?? {}).sort()).toEqual(
        ["entitled", "type"],
      );
    } finally {
      runtime.dispose();
    }
  });
});
