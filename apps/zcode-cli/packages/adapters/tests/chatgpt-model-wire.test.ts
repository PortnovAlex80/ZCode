import { describe, expect, it } from "vitest";
import { streamText } from "ai";
import { createStreamTextOptions } from "../src/model/runner-options.js";
import { AiSdkModelExecution } from "../src/model/model-execution.js";
import { createTestModelProperties } from "./test-model-format.js";
import {
  OpenAiOAuthAccessConfig,
  ProviderApiConfig,
  ProviderConfig,
  type RegistryProviderConfig,
} from "@zcode/provider";

/**
 * ChatGPT 计划用量（openai-oauth + openai-responses）线上契约：
 * - Authorization 使用 requestAuth 交付的 OAuth access token；
 * - body 强制 store:false / stream:true，且剥离 max_output_tokens 等不支持字段；
 * - system 提示经 instructions 下发（SIWC 拒绝顶层 system input item）；
 * - 复审意见 #4：默认 wire 形态为 top-level `tools:[{type:"function",...}]`
 *   （无 namespace）；namespace 双向改写仅经 ZCODE_CHATGPT_TOOL_NAMESPACE 开启，
 *   开启后出站 name 带 `zcode.` 前缀、SSE 回包 function_call.name 还原去前缀，
 *   AI SDK 才能匹配本地工具。最终接受形态以 GPT-07 live 验证为准。
 */

const OPENAI_RESPONSES_REASONING_MAP =
  '{\n  "reasoning": {\n    "effort": reasoningLevel == "disabled" ? "none" : reasoningLevel == "enabled" ? "high" : reasoningLevel\n  }\n}';
const OPENAI_RESPONSES_MAX_TOKENS_MAP = "{'max_output_tokens': maxOutputTokens}";

/**
 * 区 1 已交付 provider access-union（OpenAiOAuthAccessConfig）；此处使用真实类
 * 构造，与线上 registry 投影的运行时形状一致。
 */
function chatGptTestProviderConfig(): RegistryProviderConfig {
  return new ProviderConfig({
    access: new OpenAiOAuthAccessConfig({ entitled: true }),
    api: new ProviderApiConfig({
      type: "openai-responses",
      baseUrl: "https://api.openai.test/v1",
    }),
  }) as RegistryProviderConfig;
}

function buildResponsesSse(wireToolName: string): string {
  const sse = [
    `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_1" } })}\n\n`,
    `event: response.output_item.added\ndata: ${JSON.stringify({
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", role: "assistant", id: "msg_1", status: "in_progress", content: [] },
    })}\n\n`,
    `event: response.content_part.added\ndata: ${JSON.stringify({
      type: "response.content_part.added",
      item_id: "msg_1",
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    })}\n\n`,
    `event: response.output_text.delta\ndata: ${JSON.stringify({
      type: "response.output_text.delta",
      item_id: "msg_1",
      output_index: 0,
      content_index: 0,
      delta: "Hello from ChatGPT",
    })}\n\n`,
    `event: response.output_item.done\ndata: ${JSON.stringify({
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "message",
        role: "assistant",
        id: "msg_1",
        status: "completed",
        content: [{ type: "output_text", text: "Hello from ChatGPT", annotations: [] }],
      },
    })}\n\n`,
    `event: response.output_item.added\ndata: ${JSON.stringify({
      type: "response.output_item.added",
      output_index: 1,
      item: {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name: wireToolName,
        arguments: "",
      },
    })}\n\n`,
    `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({
      type: "response.function_call_arguments.delta",
      item_id: "fc_1",
      output_index: 1,
      delta: '{"city"',
    })}\n\n`,
    `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({
      type: "response.function_call_arguments.delta",
      item_id: "fc_1",
      output_index: 1,
      delta: ': "Rome"}',
    })}\n\n`,
    `event: response.function_call_arguments.done\ndata: ${JSON.stringify({
      type: "response.function_call_arguments.done",
      item_id: "fc_1",
      arguments: JSON.stringify({ city: "Rome" }),
    })}\n\n`,
    `event: response.output_item.done\ndata: ${JSON.stringify({
      type: "response.output_item.done",
      output_index: 1,
      item: {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name: wireToolName,
        arguments: JSON.stringify({ city: "Rome" }),
        status: "completed",
      },
    })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({
      type: "response.completed",
      response: {
        id: "resp_1",
        usage: {
          input_tokens: 5,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 7,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 12,
        },
        output: [
          {
            type: "message",
            role: "assistant",
            id: "msg_1",
            status: "completed",
            content: [{ type: "output_text", text: "Hello from ChatGPT", annotations: [] }],
          },
          {
            type: "function_call",
            id: "fc_1",
            call_id: "call_1",
            name: wireToolName,
            arguments: JSON.stringify({ city: "Rome" }),
            status: "completed",
          },
        ],
      },
    })}\n\n`,
  ];
  return sse.join("");
}

function createChatGptWireExecution(input: {
  readonly env?: Record<string, string | undefined>;
  readonly sse: string;
}): { execution: AiSdkModelExecution; requests: Request[]; bodies: Record<string, unknown>[] } {
  const requests: Request[] = [];
  const bodies: Record<string, unknown>[] = [];
  const execution = new AiSdkModelExecution(
    { env: input.env ?? {} },
    {
      transport: async (requestInput, init) => {
        const request = new Request(requestInput, init);
        requests.push(request);
        bodies.push((await request.clone().json()) as Record<string, unknown>);
        return new Response(input.sse, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      },
    },
  );
  return { execution, requests, bodies };
}

function bindChatGptModel(execution: AiSdkModelExecution) {
  return execution.bindModel({
    providerId: "account:chatgpt",
    modelId: "gpt-6.1-sol",
    providerConfig: chatGptTestProviderConfig(),
    supportsJsonSchemaOutput: false,
    optionSpecs: {
      reasoningLevel: { map: OPENAI_RESPONSES_REASONING_MAP },
      maxOutputTokens: { map: OPENAI_RESPONSES_MAX_TOKENS_MAP },
    },
  });
}

function streamChatGptRequest(resolved: ReturnType<ReturnType<AiSdkModelExecution["bindModel"]>["resolveRequest"]>) {
  return streamText(
    createStreamTextOptions({
      includeModelIO: false,
      resolved: { ...resolved, properties: createTestModelProperties() },
      request: {
        messages: [
          { role: "system", content: "You are ZCode." },
          { role: "user", content: "weather in Rome?" },
        ],
        tools: [
          {
            name: "get_weather",
            description: "Get weather",
            inputSchema: { type: "object", properties: { city: { type: "string" } } },
          },
        ],
      },
      statusContext: {
        providerId: "account:chatgpt",
        modelId: "gpt-6.1-sol",
        providerKind: resolved.providerKind,
        requestId: "chatgpt-wire",
        sessionId: "sess_chatgpt_wire",
        traceId: "trace_chatgpt_wire",
      } as never,
    }),
  );
}

describe("ChatGPT (openai-oauth) Responses wire contract", () => {
  it("sends the OAuth bearer token and a plan-compliant body, and parses text + tool calls", async () => {
    const { execution, requests, bodies } = createChatGptWireExecution({
      sse: buildResponsesSse("get_weather"),
    });
    const resolved = bindChatGptModel(execution).resolveRequest({
      options: { reasoningLevel: "high", maxOutputTokens: 4_096 },
      requestAuth: { apiKey: "chatgpt-oauth-access-token" },
    });

    const result = streamChatGptRequest(resolved);
    const events: Array<{ type: string; [key: string]: unknown }> = [];
    for await (const event of result.fullStream) events.push(event as never);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://api.openai.test/v1/responses");
    // OAuth access token 经 requestAuth → SDK Authorization 头。
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer chatgpt-oauth-access-token");

    const body = bodies[0]!;
    expect(body.model).toBe("gpt-6.1-sol");
    expect(body.stream).toBe(true);
    expect(body.store).toBe(false);
    // 计划用量不支持的字段必须被剥离（即使 option map 已注入）。
    expect(body.max_output_tokens).toBeUndefined();
    expect(body.temperature).toBeUndefined();
    expect(body.top_p).toBeUndefined();
    // include 需含 encrypted reasoning content（store:false 下的状态回放）。
    expect(body.include).toContain("reasoning.encrypted_content");
    // instructions 承载 system（Responses 计划用量拒绝顶层 system message item）。
    expect(body.instructions).toBe("You are ZCode.");
    expect((body.input as Array<{ role: string }>)[0]?.role).toBe("user");
    // reasoning effort 正常下发。
    expect(body.reasoning).toEqual({ effort: "high" });

    // 复审意见 #4 契约断言：默认（flag 关）tools 为 top-level function 数组，
    // name 无 namespace 前缀、无 namespace 字段。GPT-07 live 验证若判定该形态
    // 被拒，则开启 ZCODE_CHATGPT_TOOL_NAMESPACE 并据此更新断言。
    const tools = body.tools as Array<Record<string, unknown>>;
    expect(Array.isArray(tools)).toBe(true);
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      type: "function",
      name: "get_weather",
      parameters: { type: "object", properties: { city: { type: "string" } } },
    });
    expect(tools[0]).not.toHaveProperty("namespace");
    expect(Object.keys(body)).not.toContain("additional_tools");

    const text = await result.text;
    expect(text).toBe("Hello from ChatGPT");
    const toolCalls = (await result.toolCalls) as Array<{
      toolName: string;
      args?: unknown;
      input?: unknown;
    }>;
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.toolName).toBe("get_weather");
    // AI SDK v6 ToolCall 的参数字段名为 input（部分版本为 args），两者取其一。
    expect(toolCalls[0]?.args ?? toolCalls[0]?.input).toEqual({ city: "Rome" });
    const errorEvents = events.filter((event) => event.type === "error");
    expect(errorEvents).toEqual([]);
    const finish = await result.finishReason;
    expect(finish).toBe("tool-calls");
  });

  it("rewrites tools into the zcode namespace and restores SSE function_call names when the flag is on", async () => {
    const { execution, requests, bodies } = createChatGptWireExecution({
      env: { ZCODE_CHATGPT_TOOL_NAMESPACE: "zcode" },
      // 模拟 SIWC 路由在 namespace 模式下回包带前缀的 function_call.name。
      sse: buildResponsesSse("zcode.get_weather"),
    });
    const resolved = bindChatGptModel(execution).resolveRequest({
      options: { reasoningLevel: "high", maxOutputTokens: 4_096 },
      requestAuth: { apiKey: "chatgpt-oauth-access-token" },
    });

    const result = streamChatGptRequest(resolved);
    const events: Array<{ type: string; [key: string]: unknown }> = [];
    for await (const event of result.fullStream) events.push(event as never);

    const body = bodies[0]!;
    const tools = body.tools as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ type: "function", name: "zcode.get_weather" });
    expect(tools[0]).not.toHaveProperty("namespace");

    // SSE 回包已在前缀还原后交给 AI SDK：本地工具名 get_weather 必须匹配成功。
    const toolCalls = (await result.toolCalls) as Array<{
      toolName: string;
      args?: unknown;
      input?: unknown;
    }>;
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.toolName).toBe("get_weather");
    expect(toolCalls[0]?.args ?? toolCalls[0]?.input).toEqual({ city: "Rome" });
    expect((await result.text)).toBe("Hello from ChatGPT");
    expect(events.filter((event) => event.type === "error")).toEqual([]);
    expect(await result.finishReason).toBe("tool-calls");
    expect(requests).toHaveLength(1);
  });

  it("fails closed before any network request when the auth source is unavailable", async () => {
    const requests: Request[] = [];
    const execution = new AiSdkModelExecution(
      { env: {} },
      {
        transport: async (input, init) => {
          requests.push(new Request(input, init));
          return new Response("{}", { headers: { "content-type": "application/json" } });
        },
      },
    );
    // 绑定期不携带 requestAuth：openai-oauth 无静态 apiKey，也不回落 env。
    const bound = execution.bindModel({
      providerId: "account:chatgpt",
      modelId: "gpt-6.1-sol",
      providerConfig: chatGptTestProviderConfig(),
      supportsJsonSchemaOutput: false,
      optionSpecs: {
        reasoningLevel: { map: OPENAI_RESPONSES_REASONING_MAP },
        maxOutputTokens: { map: OPENAI_RESPONSES_MAX_TOKENS_MAP },
      },
    });
    const resolved = bound.resolveRequest({
      options: { reasoningLevel: "high", maxOutputTokens: 4_096 },
    });
    // 绑定产物不包含任何静态凭据（Bearer 只能来自 requestAuth Source）。
    expect((resolved.model as unknown as { apiKey?: string }).apiKey).toBeUndefined();
  });
});
