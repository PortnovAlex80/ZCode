import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  createSharedZCodeCredentialStore,
  createChatGptRequestAuthSource,
  toChatGptCredentialRecord,
  writeChatGptCredentialRecord,
} from "@zcode/adapters/auth";
import { AiSdkModelAdapter } from "@zcode/adapters/model";
import { ModelErrorCode } from "@zcode/contracts";
import {
  ModelConfig,
  ModelOptionSpecsConfig,
  ModelPropertiesConfig,
  OpenAiOAuthAccessConfig,
  ProviderApiConfig,
  ProviderConfig,
  ProviderRegistry,
} from "@zcode/provider";
import { ApiProviderModelRuntime } from "../src/app/provider-registry-model-runtime.js";

it("delivers saved OAuth auth through registry factory and real runner to local HTTP, failing closed when missing", async () => {
  const requests: Array<{ authorization?: string; url?: string; body: Record<string, unknown> }> =
    [];
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += String(chunk);
    requests.push({
      authorization: request.headers.authorization,
      url: request.url,
      body: JSON.parse(raw),
    });
    response.writeHead(200, { "content-type": "text/event-stream" });
    const send = (event: Record<string, unknown>) =>
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    send({
      type: "response.created",
      response: { id: "local-response", model: "model-a", created_at: 1 },
    });
    send({
      type: "response.output_item.added",
      output_index: 0,
      item: { id: "msg_1", type: "message", role: "assistant", content: [] },
    });
    send({
      type: "response.output_text.delta",
      item_id: "msg_1",
      output_index: 0,
      content_index: 0,
      delta: "local success",
    });
    send({
      type: "response.completed",
      response: {
        id: "local-response",
        status: "completed",
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    });
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing local test server");
  const dir = await mkdtemp(join(tmpdir(), "chatgpt-factory-"));
  try {
    const store = createSharedZCodeCredentialStore({ filePath: join(dir, "credentials.json") });
    const scopes = ["chatgpt.tokens.use.direct"];
    await writeChatGptCredentialRecord(
      store,
      toChatGptCredentialRecord({
        clientId: "test-client",
        scopes,
        accountClaims: { subject: "local-test" },
        tokenResponse: {
          access_token: "saved-oauth-token",
          refresh_token: "local-refresh",
          id_token: "local-id",
          token_type: "Bearer",
          expires_in: 3600,
        },
        now: Date.now,
      }),
    );
    const registry = new ProviderRegistry([
      {
        providerId: "account:chatgpt",
        config: new ProviderConfig({
          access: new OpenAiOAuthAccessConfig({ entitled: true }),
          api: new ProviderApiConfig({
            type: "openai-responses",
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
          }),
          builtinModelIds: ["model-a"],
        }),
        models: [
          {
            modelId: "model-a",
            config: new ModelConfig({
              enabled: true,
              visibility: "visible",
              properties: new ModelPropertiesConfig({
                requiresMfjsToolSchema: false,
                contextWindow: 10000,
                inputFormat: { supportsText: true },
                outputFormat: { supportsText: true },
                supportsToolCall: true,
                supportsJsonSchemaOutput: false,
                supportsNativeWebSearch: false,
                supportsMidConversationSystem: true,
              }),
              optionSpecs: new ModelOptionSpecsConfig({
                reasoningLevel: { values: ["low"], map: "{}" },
                maxOutputTokens: { max: 1000, map: "{}" },
              }),
            }),
          },
        ],
      },
    ]);
    const adapter = new AiSdkModelAdapter({
      env: { OPENAI_API_KEY: "must-not-use-api-key" },
      retry: { maxRetries: 0 },
    });
    const source = createChatGptRequestAuthSource({ store, env: {} });
    for (const connected of [true, false]) {
      const runtime = new ApiProviderModelRuntime({
        registry,
        modelAdapter: adapter,
        ...(connected ? { chatGptRequestAuthSource: source } : {}),
      });
      runtime.start();
      const model = runtime.modelFactory({
        selection: {
          providerId: "account:chatgpt",
          modelId: "model-a",
          options: { reasoningLevel: "low" },
        },
      });
      const run = async () => {
        for await (const _event of model.streamText({
          options: { maxOutputTokens: 100 },
          messages: [{ role: "user", content: "local test" }],
        })) {
          /* drain actual runner */
        }
      };
      if (connected) await run();
      else
        await expect(run()).rejects.toMatchObject({ code: ModelErrorCode.ModelRequestAuthMissing });
      runtime.dispose();
    }
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      authorization: "Bearer saved-oauth-token",
      url: "/v1/responses",
      body: { model: "model-a", stream: true, store: false },
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
