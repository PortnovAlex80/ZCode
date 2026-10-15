import { createHash } from "node:crypto";
import {
  ModelConfigRules,
  OpenAiOAuthAccessConfig,
  ProviderApiConfig,
  ProviderConfig,
  ProviderConfigMap,
  parseModelConfig,
  parseZCodeBuiltinProviderConfigRules,
  type ModelConfigRule,
} from "@zcode/provider";

export const CHATGPT_PROVIDER_ID = "account:chatgpt";
export const CHATGPT_API_BASE_URL = "https://api.openai.com/v1";

/**
 * GPT-00 路径 A：ChatGPT 订阅 Provider 通过本地 Runtime 增补进入 Built-in 层，
 * 不修改 zcode-builtin.json、不抬高 revision（抬高会让真实 CDN Release 永远 stale，
 * 同 revision 不同内容还会直接抛错）。CDN 比较始终基于未增补的原始 Release；
 * 增补内容的指纹并入层快照 revision，保证 Account 层 basedOnZCodeBuiltinRevision
 * 与 Registry guard（registry-service）不会静默失配。
 *
 * builtinModelIds 保持为空：登录前 Provider 没有 Seed 模型（计划 §3 备注 5），
 * 登录后由 entitlement Overlay 写入 /v1/models 返回的 slug。
 * 能力 Rule 不是 Seed 名单，只按模型家族补齐未知 slug 的完整配置；
 * 匹配范围用 provider-site（openai-responses + 官方 Responses 端点）收紧，
 * 避免影响其他站点同名模型；既有全局 catch-all `.*` 规则仍是最终兜底。
 */
const CHATGPT_SITE_MATCH = {
  apiTypeMatch: "openai-responses",
  baseUrlMatch: "https://api\\.openai\\.com/v1",
} as const;

/** 家族能力取自 2026-10-15 官方文档核对过的 fork 数据；fast 变体沿用更小窗口。 */
const CHATGPT_PROVIDER_MODEL_RULES: readonly ModelConfigRule[] = [
  {
    type: "provider-site",
    modelMatch: ".*gpt-6\\.1-sol(?:[.\\-:/\\[].*)?",
    ...CHATGPT_SITE_MATCH,
    config: parseModelConfig({
      properties: {
        contextWindow: 1_050_000,
        inputFormat: { supportsImage: true, supportsVideo: false, supportsAudio: false, supportsPdf: true },
        supportsJsonSchemaOutput: true,
      },
      optionSpecs: {
        reasoningLevel: { values: ["low", "medium", "high", "xhigh", "max"] },
        maxOutputTokens: { max: 128_000 },
      },
    }),
  },
  {
    type: "provider-site",
    modelMatch: ".*gpt-6\\.1-sol-fast(?:[.\\-:/\\[].*)?",
    ...CHATGPT_SITE_MATCH,
    config: parseModelConfig({ properties: { contextWindow: 400_000 } }),
  },
  {
    type: "provider-site",
    modelMatch: ".*gpt-6-(?:sol|luna)(?:[.\\-:/\\[].*)?",
    ...CHATGPT_SITE_MATCH,
    config: parseModelConfig({
      properties: {
        contextWindow: 1_050_000,
        inputFormat: { supportsImage: true, supportsVideo: false, supportsAudio: false, supportsPdf: true },
        supportsJsonSchemaOutput: true,
      },
      optionSpecs: {
        reasoningLevel: { values: ["low", "medium", "high", "xhigh", "max"] },
        maxOutputTokens: { max: 128_000 },
      },
    }),
  },
  {
    type: "provider-site",
    modelMatch: ".*gpt-5\\.5(?:[.\\-:/\\[].*)?",
    ...CHATGPT_SITE_MATCH,
    config: parseModelConfig({
      properties: {
        contextWindow: 1_050_000,
        inputFormat: { supportsImage: true, supportsVideo: false, supportsAudio: false, supportsPdf: true },
        supportsJsonSchemaOutput: true,
      },
      optionSpecs: {
        reasoningLevel: { values: ["none", "low", "medium", "high", "xhigh"] },
        maxOutputTokens: { max: 128_000 },
      },
    }),
  },
  {
    type: "provider-site",
    modelMatch: ".*gpt-5\\.5-fast(?:[.\\-:/\\[].*)?",
    ...CHATGPT_SITE_MATCH,
    config: parseModelConfig({ properties: { contextWindow: 400_000 } }),
  },
];

function createChatGptProviderRule(): { providerId: string; providerName: string; config: ProviderConfig } {
  return {
    providerId: CHATGPT_PROVIDER_ID,
    providerName: "ChatGPT",
    config: new ProviderConfig({
      group: "openai-family",
      logo: { type: "builtin", key: "openai" },
      access: new OpenAiOAuthAccessConfig(),
      api: new ProviderApiConfig({ type: "openai-responses", baseUrl: CHATGPT_API_BASE_URL }),
      builtinModelIds: [],
    }),
  };
}

/** 增补内容在模块加载时校验一次；schema 漂移会让这里直接失败，而不是悄悄产出无效配置。 */
parseZCodeBuiltinProviderConfigRules({
  templateRules: [],
  providerRules: [createChatGptProviderRule()].map(({ config, ...rule }) => ({
    ...rule,
    config: config.toJSON(),
  })),
});
new ModelConfigRules([...CHATGPT_PROVIDER_MODEL_RULES]).toZCodeBuiltinJSON();

const CHATGPT_AUGMENTATION_FINGERPRINT = createHash("sha256")
  .update(
    JSON.stringify([
      createChatGptProviderRule().config.toJSON(),
      new ModelConfigRules([...CHATGPT_PROVIDER_MODEL_RULES]).toZCodeBuiltinJSON().providerSiteRules,
    ]),
  )
  .digest("hex")
  .slice(0, 12);

export interface ChatGptBuiltinAugmentation {
  readonly providers: ProviderConfigMap;
  readonly models: ModelConfigRules;
  /** null 表示 Release 自身已声明该 Provider（未来 CDN 接管），无需增补。 */
  readonly revisionFingerprint: string | null;
}

export function augmentZCodeBuiltinLayer(
  providers: ProviderConfigMap,
  models: ModelConfigRules,
): ChatGptBuiltinAugmentation {
  if (providers.has(CHATGPT_PROVIDER_ID)) {
    return { providers, models, revisionFingerprint: null };
  }
  return {
    providers: providers.setRule(createChatGptProviderRule()),
    models: new ModelConfigRules(insertProviderSiteRules(models.rules(), CHATGPT_PROVIDER_MODEL_RULES)),
    revisionFingerprint: CHATGPT_AUGMENTATION_FINGERPRINT,
  };
}

/**
 * Site 规则在扁平执行顺序里位于 model/model-api 之后、template/exact 之前；
 * 增补规则插入同组末尾，保持与 Release 自带 Site 规则相同的层次语义。
 */
function insertProviderSiteRules(
  rules: readonly ModelConfigRule[],
  additions: readonly ModelConfigRule[],
): readonly ModelConfigRule[] {
  let insertIndex = 0;
  for (let index = 0; index < rules.length; index += 1) {
    const type = rules[index]!.type;
    if (type === "model" || type === "model-api" || type === "provider-site") {
      insertIndex = index + 1;
    }
  }
  return [...rules.slice(0, insertIndex), ...additions, ...rules.slice(insertIndex)];
}
