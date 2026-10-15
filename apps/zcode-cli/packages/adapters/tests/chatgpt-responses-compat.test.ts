import { describe, expect, it } from "vitest";
import {
  createChatGptResponsesCompatFetch,
  isResponsesEndpointUrl,
  patchResponsesRequestInit,
  sanitizeChatGptResponsesBody,
} from "../src/model/chatgpt-responses-compat.js";

describe("ChatGPT Responses body compliance", () => {
  it("forces store:false / stream:true and keeps supported fields", () => {
    const body = sanitizeChatGptResponsesBody({
      model: "gpt-6.1-sol",
      input: [{ type: "message", role: "user", content: "hi" }],
      instructions: "system prompt",
      reasoning: { effort: "high" },
    });
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
    expect(body.model).toBe("gpt-6.1-sol");
    expect(body.reasoning).toEqual({ effort: "high" });
    expect(body.include).toEqual(["reasoning.encrypted_content"]);
  });

  it("strips documented-unsupported fields", () => {
    const body = sanitizeChatGptResponsesBody({
      model: "m",
      input: [],
      temperature: 0.7,
      top_p: 0.9,
      max_output_tokens: 4096,
      metadata: { session: "x" },
      truncation: "auto",
      user: "u",
      previous_response_id: "resp_1",
      service_tier: "flex",
    });
    for (const field of [
      "temperature",
      "top_p",
      "max_output_tokens",
      "metadata",
      "truncation",
      "user",
      "previous_response_id",
      "service_tier",
    ]) {
      expect(body).not.toHaveProperty(field);
    }
  });

  it("preserves existing include entries and merges the encrypted reasoning include", () => {
    const body = sanitizeChatGptResponsesBody({ include: ["other.include"] });
    expect(body.include).toEqual(["other.include", "reasoning.encrypted_content"]);
  });

  it("overwrites non-compliant store/stream values", () => {
    const body = sanitizeChatGptResponsesBody({ store: true, stream: false });
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
  });

  it("moves system input items into instructions (SIWC rejects them in input)", () => {
    const body = sanitizeChatGptResponsesBody({
      input: [
        { role: "system", content: "You are ZCode." },
        { role: "user", content: [{ type: "input_text", text: "hi" }] },
      ],
    });
    expect(body.instructions).toBe("You are ZCode.");
    expect(body.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "hi" }] },
    ]);
  });

  it("merges multiple system items and preserves existing instructions", () => {
    const body = sanitizeChatGptResponsesBody({
      instructions: "base",
      input: [
        { role: "system", content: "first" },
        { role: "system", content: [{ type: "input_text", text: "second" }] },
        { role: "user", content: "hi" },
      ],
    });
    expect(body.instructions).toBe("base\n\nfirst\n\nsecond");
  });

  it("leaves string input and non-system arrays untouched", () => {
    const body = sanitizeChatGptResponsesBody({
      input: [{ role: "developer", content: "dev" }],
    });
    expect(body.input).toEqual([{ role: "developer", content: "dev" }]);
    expect(body.instructions).toBeUndefined();
    const stringInput = sanitizeChatGptResponsesBody({ input: "plain prompt" });
    expect(stringInput.input).toBe("plain prompt");
  });
});

describe("ChatGPT Responses fetch wrapper", () => {
  it("patches only POST requests to /responses endpoints", () => {
    const patched = patchResponsesRequestInit("https://api.openai.com/v1/responses", {
      method: "POST",
      body: JSON.stringify({ model: "m", input: [], max_output_tokens: 10 }),
    });
    const body = JSON.parse(patched!.body as string) as Record<string, unknown>;
    expect(body.max_output_tokens).toBeUndefined();
    expect(body.store).toBe(false);

    const getRequest = { method: "GET" } as RequestInit;
    const untouched = patchResponsesRequestInit("https://api.openai.com/v1/models", getRequest);
    // 非 /responses POST 不打补丁：原样返回同一 init 引用。
    expect(untouched).toBe(getRequest);

    const postNoBody = { method: "POST" } as RequestInit;
    const noBody = patchResponsesRequestInit("https://api.openai.com/v1/responses", postNoBody);
    expect(noBody).toBe(postNoBody);
  });

  it("recognizes /responses URLs across base paths", () => {
    expect(isResponsesEndpointUrl("https://api.openai.com/v1/responses")).toBe(true);
    expect(isResponsesEndpointUrl("https://api.openai.com/v1/responses/")).toBe(true);
    expect(isResponsesEndpointUrl("https://api.openai.com/v1/chat/completions")).toBe(false);
    expect(isResponsesEndpointUrl(undefined)).toBe(false);
  });

  it("passes the patched body to the inner fetch", async () => {
    const seen: { url: string; body: string }[] = [];
    const inner: typeof globalThis.fetch = async (input, init) => {
      seen.push({
        url: typeof input === "string" ? input : String(input),
        body: String(init?.body ?? ""),
      });
      return new Response("{}", { headers: { "content-type": "application/json" } });
    };
    const wrapped = createChatGptResponsesCompatFetch(inner);
    await wrapped("https://api.openai.com/v1/responses", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-6.1-sol", input: [], temperature: 1 }),
    });
    const body = JSON.parse(seen[0]!.body) as Record<string, unknown>;
    expect(body.temperature).toBeUndefined();
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
  });
});

describe("ChatGPT Responses function tool namespace (review remark #4)", () => {
  it("rewrites outgoing function tools, tool_choice and replayed function_call names", () => {
    const body = sanitizeChatGptResponsesBody(
      {
        model: "m",
        input: [
          { type: "function_call", call_id: "call_1", name: "get_weather", arguments: "{}" },
          { type: "function_call_output", call_id: "call_1", output: "sunny" },
        ],
        tools: [
          { type: "function", name: "get_weather", parameters: { type: "object" } },
          { type: "function", name: "zcode.already_prefixed", parameters: { type: "object" } },
          { type: "web_search_preview" },
        ],
        tool_choice: { type: "function", name: "get_weather" },
      },
      { toolNamespace: "zcode" },
    );
    expect(body.tools).toEqual([
      { type: "function", name: "zcode.get_weather", parameters: { type: "object" } },
      { type: "function", name: "zcode.already_prefixed", parameters: { type: "object" } },
      { type: "web_search_preview" },
    ]);
    expect(body.tool_choice).toEqual({ type: "function", name: "zcode.get_weather" });
    expect(body.input).toEqual([
      { type: "function_call", call_id: "call_1", name: "zcode.get_weather", arguments: "{}" },
      // function_call_output 只按 call_id 关联，wire 上无 name 字段，不改写。
      { type: "function_call_output", call_id: "call_1", output: "sunny" },
    ]);
  });

  it("leaves tools untouched when the namespace flag is off (default wire form)", () => {
    const body = sanitizeChatGptResponsesBody({
      model: "m",
      input: [],
      tools: [{ type: "function", name: "get_weather", parameters: { type: "object" } }],
      tool_choice: { type: "function", name: "get_weather" },
    });
    expect(body.tools).toEqual([
      { type: "function", name: "get_weather", parameters: { type: "object" } },
    ]);
    expect(body.tool_choice).toEqual({ type: "function", name: "get_weather" });
  });

  it("leaves string tool_choice modes untouched when namespacing", () => {
    const body = sanitizeChatGptResponsesBody(
      { model: "m", input: [], tool_choice: "auto" },
      { toolNamespace: "zcode" },
    );
    expect(body.tool_choice).toBe("auto");
  });

  it("strips the namespace prefix from function_call names in SSE frames", async () => {
    const sse = [
      `event: response.output_item.added\ndata: ${JSON.stringify({
        type: "response.output_item.added",
        output_index: 1,
        item: {
          type: "function_call",
          id: "fc_1",
          call_id: "call_1",
          name: "zcode.get_weather",
          arguments: "",
        },
      })}\n\n`,
      `event: response.output_item.done\ndata: ${JSON.stringify({
        type: "response.output_item.done",
        output_index: 1,
        item: {
          type: "function_call",
          id: "fc_1",
          call_id: "call_1",
          name: "zcode.get_weather",
          arguments: '{"city":"Rome"}',
          status: "completed",
        },
      })}\n\n`,
      `event: response.completed\ndata: ${JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp_1",
          output: [
            { type: "message", role: "assistant", content: [] },
            {
              type: "function_call",
              id: "fc_1",
              call_id: "call_1",
              name: "zcode.get_weather",
              arguments: '{"city":"Rome"}',
            },
          ],
        },
      })}\n\n`,
    ].join("");
    const seen: string[] = [];
    const inner: typeof globalThis.fetch = async () =>
      new Response(sse, { headers: { "content-type": "text/event-stream" } });
    const wrapped = createChatGptResponsesCompatFetch(inner, { toolNamespace: "zcode" });
    const response = await wrapped("https://api.openai.com/v1/responses", { method: "POST" });
    const text = await response.text();
    seen.push(text);
    const dataPayloads = [...text.matchAll(/^data: (.+)$/gmu)].map((match) =>
      JSON.parse(match[1]!),
    ) as Array<{
      item?: { type: string; name?: string };
      response?: { output: Array<{ type: string; name?: string }> };
    }>;
    expect(dataPayloads).toHaveLength(3);
    for (const payload of dataPayloads) {
      const names = payload.item
        ? [payload.item.name]
        : (payload.response?.output ?? []).map((item) => item.name);
      expect(names).toContain("get_weather");
      expect(names.every((name) => !name?.startsWith("zcode."))).toBe(true);
    }
    // event: 行保留，帧结构保持 SSE 合法。
    expect(seen[0]).toContain("event: response.completed");
  });

  it("keeps unrelated names and non-JSON frames byte-identical in SSE rewrite", async () => {
    const frames = [
      `event: response.output_text.delta\ndata: ${JSON.stringify({
        type: "response.output_text.delta",
        delta: "zcode.get_weather",
      })}\n\n`,
      `: keep-alive comment\n\n`,
      `event: response.output_item.done\ndata: ${JSON.stringify({
        type: "response.output_item.done",
        item: { type: "function_call", call_id: "call_9", name: "foreign_tool", arguments: "{}" },
      })}\n\n`,
    ].join("");
    const inner: typeof globalThis.fetch = async () =>
      new Response(frames, { headers: { "content-type": "text/event-stream" } });
    const wrapped = createChatGptResponsesCompatFetch(inner, { toolNamespace: "zcode" });
    const response = await wrapped("https://api.openai.com/v1/responses", { method: "POST" });
    expect(await response.text()).toBe(frames);
  });

  it("does not touch the SSE stream when the namespace flag is off", async () => {
    const frames = `event: response.output_item.added\ndata: ${JSON.stringify({
      type: "response.output_item.added",
      item: { type: "function_call", call_id: "call_1", name: "zcode.get_weather" },
    })}\n\n`;
    const inner: typeof globalThis.fetch = async () =>
      new Response(frames, { headers: { "content-type": "text/event-stream" } });
    const wrapped = createChatGptResponsesCompatFetch(inner);
    const response = await wrapped("https://api.openai.com/v1/responses", { method: "POST" });
    expect(await response.text()).toBe(frames);
  });

  it("handles frames split across multiple stream chunks", async () => {
    const first = `event: response.output_item.added\ndata: ${JSON.stringify({
      type: "response.output_item.added",
      item: { type: "function_call", call_id: "call_1", name: "zcode.get_weather" },
    })}\n`;
    const second = "\nevent: response.completed\ndata: ";
    const third = JSON.stringify({
      type: "response.completed",
      response: { output: [{ type: "function_call", call_id: "call_1", name: "zcode.get_weather" }] },
    });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(first));
        controller.enqueue(new TextEncoder().encode(second));
        controller.enqueue(new TextEncoder().encode(third));
        controller.close();
      },
    });
    const inner: typeof globalThis.fetch = async () =>
      new Response(stream, { headers: { "content-type": "text/event-stream" } });
    const wrapped = createChatGptResponsesCompatFetch(inner, { toolNamespace: "zcode" });
    const response = await wrapped("https://api.openai.com/v1/responses", { method: "POST" });
    const text = await response.text();
    expect(text).not.toContain("zcode.get_weather");
    expect(text).toContain('"name":"get_weather"');
  });
});
