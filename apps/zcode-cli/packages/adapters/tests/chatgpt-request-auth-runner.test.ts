import { describe, expect, it, vi } from "vitest";
import { ModelErrorCode, runWithModelInvocationContext } from "@zcode/contracts";
import {
  ModelConfig,
  ModelInputFormatConfig,
  ModelOptionSpecsConfig,
  ModelOutputFormatConfig,
  ModelPropertiesConfig,
  OpenAiOAuthAccessConfig,
  ProviderApiConfig,
  ProviderConfig,
  type RegistryModelConfig,
  type RegistryProviderConfig,
} from "@zcode/provider";
import { TestAiSdkModelAdapter } from "./test-provider-config.js";
import type { AiSdkModelRuntime } from "../src/model/runner-runtime.js";
import { createTestModelProperties } from "./test-model-format.js";

/**
 * ChatGPT 计划用量（openai-oauth）在 runner 层的 requestAuth 门禁：
 * - 与 off-peak/highspeed 一样消费执行作用域 Source，缺失时 fail-closed
 *   （model_request_auth_missing，且不发起任何网络请求）；
 * - 但绝不进入 zhipu-account 的 refreshOffPeakRequestAuth 分支——
 *   ChatGPT 的 Bearer 由凭据 store 的 Source 直接给出，不做账号 runtime-header 刷新。
 */

function chatGptTestProviderConfig(): RegistryProviderConfig {
  // 使用区 1 交付的真实 OpenAiOAuthAccessConfig，与线上 registry 投影一致。
  return new ProviderConfig({
    access: new OpenAiOAuthAccessConfig({ entitled: true }),
    api: new ProviderApiConfig({
      type: "openai-responses",
      baseUrl: "https://api.openai.test/v1",
    }),
  }) as RegistryProviderConfig;
}

function chatGptTestModelConfig(): RegistryModelConfig {
  const properties = createTestModelProperties();
  return new ModelConfig({
    enabled: true,
    properties: new ModelPropertiesConfig({
      requiresMfjsToolSchema: false,
      ...properties,
      inputFormat: new ModelInputFormatConfig(properties.inputFormat),
      outputFormat: new ModelOutputFormatConfig(properties.outputFormat),
    }),
    optionSpecs: new ModelOptionSpecsConfig({
      reasoningLevel: {
        values: ["disabled"],
        map: "{}",
      },
      maxOutputTokens: {
        max: 32_000,
        map: "{'max_output_tokens': maxOutputTokens}",
      },
    }),
  }) as RegistryModelConfig;
}

function createStubRuntime(headerSink: unknown[]): AiSdkModelRuntime {
  return {
    async generateText(options) {
      headerSink.push(options.headers);
      return {
        finishReason: "stop",
        text: "done",
        totalUsage: {},
        usage: {},
      } as never;
    },
    streamText() {
      throw new Error("not used");
    },
  };
}

describe("ChatGPT (openai-oauth) runner requestAuth gate", () => {
  it("applies the execution-scoped source and never enters the zhipu off-peak refresh branch", async () => {
    const resolve = vi.fn().mockResolvedValue({
      apiKey: "chatgpt-access-token",
      headers: { Authorization: "Bearer chatgpt-access-token" },
    });
    // 若 openai-oauth 误入 off-peak 分支，这个 zhipu 语义的 context 刷新会被调用。
    const contextRefresh = vi.fn();
    const receivedHeaders: unknown[] = [];
    const adapter = new TestAiSdkModelAdapter({ runtime: createStubRuntime(receivedHeaders) });
    const model = adapter.createModel({
      providerId: "account:chatgpt" as never,
      modelId: "gpt-6.1-sol" as never,
      providerConfig: chatGptTestProviderConfig(),
      modelConfig: chatGptTestModelConfig(),
      options: { maxOutputTokens: 1_000, reasoningLevel: "disabled" },
      requestDependencies: { requestAuth: { source: { resolve } } },
    });

    await runWithModelInvocationContext(
      { refreshRuntimeHeadersBeforeAttempt: contextRefresh },
      () => model.generateText({ messages: [{ role: "user", content: "hello" }] }),
    );

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(contextRefresh).not.toHaveBeenCalled();
    expect(receivedHeaders[0]).toMatchObject({
      Authorization: "Bearer chatgpt-access-token",
    });
  });

  it("fails closed before network when the ChatGPT request auth source is unavailable", async () => {
    const generateText = vi.fn();
    const streamText = vi.fn();
    const adapter = new TestAiSdkModelAdapter({
      runtime: { generateText, streamText } as unknown as AiSdkModelRuntime,
    });
    const model = adapter.createModel({
      providerId: "account:chatgpt" as never,
      modelId: "gpt-6.1-sol" as never,
      providerConfig: chatGptTestProviderConfig(),
      modelConfig: chatGptTestModelConfig(),
      options: { maxOutputTokens: 1_000, reasoningLevel: "disabled" },
      requestDependencies: { requestAuth: {} },
    });

    await expect(
      model.generateText({ messages: [{ role: "user", content: "hello" }] }),
    ).rejects.toMatchObject({ code: ModelErrorCode.ModelRequestAuthMissing });
    await expect(async () => {
      for await (const _event of model.streamText({
        messages: [{ role: "user", content: "hello" }],
      })) {
        // 请求必须在产生首个网络事件前 fail-closed。
      }
    }).rejects.toMatchObject({ code: ModelErrorCode.ModelRequestAuthMissing });
    expect(generateText).not.toHaveBeenCalled();
    expect(streamText).not.toHaveBeenCalled();
  });
});
