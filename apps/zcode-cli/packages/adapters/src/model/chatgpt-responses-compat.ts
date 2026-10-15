type ProviderFetch = typeof globalThis.fetch;

/**
 * ChatGPT 计划用量（Sign in with ChatGPT token sharing）的 Responses 请求合规层。
 *
 * 官方 preview-limitations 要求：
 * - 每个推理请求必须 `store: false` 且 `stream: true`；
 * - 不支持的字段必须从 body 移除（temperature、top_p、max_output_tokens、
 *   previous_response_id、metadata、truncation、user 等）；
 * - 无服务端会话存储 → `include` 需要补 `reasoning.encrypted_content` 以便
 *   在 store:false 下回放推理状态。
 *
 * 该 wrapper 必须位于 option-map fetch 之内层（后于它运行），确保能清理
 * option map 注入的 `max_output_tokens` 等字段。
 *
 * 来源：nasone32/ZCode feat/chatgpt-oauth bd5171cb（ChatGPT 部分），按
 * docs/spec-harness/CHATGPT-SUBSCRIPTION-PLAN.md §3 分类选择性移植；未携带
 * 该 fork 的 Z.ai 路由改动。
 */

/** 文档列出的不支持顶层字段；出现即删除，不能原样发送。 */
const UNSUPPORTED_RESPONSES_BODY_FIELDS: ReadonlySet<string> = new Set([
  "background",
  "conversation",
  "max_output_tokens",
  "max_tool_calls",
  "metadata",
  "moderation",
  "multi_agent",
  "prompt",
  "prompt_cache_retention",
  "safety_identifier",
  "temperature",
  "top_logprobs",
  "top_p",
  "truncation",
  "user",
  "previous_response_id",
  "service_tier",
]);

const ENCRYPTED_REASONING_INCLUDE = "reasoning.encrypted_content";

const SSE_FRAME_SEPARATOR_PATTERN = /\r\n\r\n|\n\n|\r\r/;

export interface ChatGptResponsesCompatFetchOptions {
  /**
   * 预留的 function tool namespace 双向改写（计划 §3 复审意见 #4）。
   *
   * 官方 preview-limitations 要求 SIWC 计划用量把 function/custom tools
   * 放入 namespace 或经 `additional_tools` input items 提供，而 AI SDK
   * （@ai-sdk/openai 3.0.x `prepareResponsesTools`）固定发送 top-level
   * `tools:[{type:"function",name,...}]`。真实接受形式未经 live 验证
   * （GPT-07 关闭前不开启）：启用后出站 `tools[].name`、`tool_choice.name`
   * 与 input 中 function_call 项会加 `"<namespace>."` 前缀，SSE 回包里的
   * `function_call.name` 会去前缀还原，AI SDK 才能匹配本地工具。
   * 默认 undefined = 不改写，按现状发送 top-level function tools。
   */
  readonly toolNamespace?: string;
}

export function createChatGptResponsesCompatFetch(
  baseFetch: ProviderFetch,
  options: ChatGptResponsesCompatFetchOptions = {},
): ProviderFetch {
  return async (input, init) => {
    const patchedInit = patchResponsesRequestInit(input, init, options);
    const response = await baseFetch(input, patchedInit);
    // 回包方向仅在启用 namespace 时介入；未启用时原样返回，错误流/取消语义
    // 仍由既有 stream-retry-boundary / empty-completion-retry 统一处理。
    return options.toolNamespace
      ? rewriteResponsesSseFunctionCallNamespaces(response, options.toolNamespace)
      : response;
  };
}

export function patchResponsesRequestInit(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  options: ChatGptResponsesCompatFetchOptions = {},
): RequestInit | undefined {
  const method = init?.method ?? (typeof input !== "string" && "method" in input ? input.method : "GET");
  if (method.toUpperCase() !== "POST") {
    return init;
  }
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!isResponsesEndpointUrl(url)) {
    return init;
  }
  const body = readJsonBody(init?.body);
  if (!body) {
    return init;
  }
  const patched = sanitizeChatGptResponsesBody(body, options);
  return {
    ...init,
    headers: withJsonContentType(init?.headers),
    body: JSON.stringify(patched),
  };
}

/** 判定 /responses 推理端点（base 可能带 /v1 前缀或代理路径）。 */
export function isResponsesEndpointUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const pathname = new URL(url, "https://api.openai.invalid").pathname;
    return /\/responses\/?$/u.test(pathname);
  } catch {
    return false;
  }
}

export function sanitizeChatGptResponsesBody(
  body: Record<string, unknown>,
  options: ChatGptResponsesCompatFetchOptions = {},
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (UNSUPPORTED_RESPONSES_BODY_FIELDS.has(key)) continue;
    result[key] = value;
  }
  result.store = false;
  result.stream = true;
  result.include = mergeEncryptedReasoningInclude(result.include);
  moveSystemInputItemsToInstructions(result);
  if (options.toolNamespace) {
    applyFunctionToolNamespace(result, options.toolNamespace);
  }
  return result;
}

/**
 * SIWC 要求 system 提示走 `instructions`（或 developer message），
 * 顶层 `{role:"system"}` input item 会被 ChatGPT 计划用量拒绝。
 * AI SDK 会把 messages 数组中的 system 消息放入 input，这里统一搬移。
 */
function moveSystemInputItemsToInstructions(body: Record<string, unknown>): void {
  if (!Array.isArray(body.input)) return;
  const systemTexts: string[] = [];
  const input: unknown[] = [];
  for (const item of body.input) {
    if (!isRecord(item) || item.role !== "system") {
      input.push(item);
      continue;
    }
    const text = readInputItemText(item.content);
    if (text) systemTexts.push(text);
  }
  if (systemTexts.length === 0) return;
  const existingInstructions =
    typeof body.instructions === "string" && body.instructions.trim().length > 0
      ? body.instructions
      : undefined;
  body.input = input;
  body.instructions = [...(existingInstructions ? [existingInstructions] : []), ...systemTexts]
    .join("\n\n");
}

function readInputItemText(content: unknown): string | undefined {
  if (typeof content === "string") return content.length > 0 ? content : undefined;
  if (!Array.isArray(content)) return undefined;
  const parts = content
    .filter(isRecord)
    .filter((part) => part.type === "input_text" || part.type === "output_text")
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .filter((text) => text.length > 0);
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function mergeEncryptedReasoningInclude(value: unknown): string[] {
  const existing = Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
  if (existing.includes(ENCRYPTED_REASONING_INCLUDE)) return existing;
  return [...existing, ENCRYPTED_REASONING_INCLUDE];
}

/**
 * 出站方向的 namespace 改写（意见 #4，flag 关闭时不调用）：
 * - top-level `tools[]` 中 `type:"function"` 的 name；
 * - `tool_choice` 对象形式的 name（与 tools 命名保持一致，否则服务端拒绝）；
 * - `input[]` 中历史 `function_call` 项的 name（多轮回放与工具命名一致）。
 * `function_call_output` 只按 `call_id` 关联，wire 上无 name，不需要改写。
 */
function applyFunctionToolNamespace(body: Record<string, unknown>, namespace: string): void {
  const prefix = `${namespace}.`;
  if (Array.isArray(body.tools)) {
    body.tools = body.tools.map((entry) => {
      const tool = isRecord(entry) ? entry : undefined;
      if (!tool || tool.type !== "function" || typeof tool.name !== "string") return entry;
      if (tool.name.startsWith(prefix) || tool.name.includes(".")) return entry;
      return { ...tool, name: `${prefix}${tool.name}` };
    });
  }
  const toolChoice = isRecord(body.tool_choice) ? body.tool_choice : undefined;
  if (toolChoice && typeof toolChoice.name === "string" && !toolChoice.name.startsWith(prefix)) {
    body.tool_choice = { ...toolChoice, name: `${prefix}${toolChoice.name}` };
  }
  if (Array.isArray(body.input)) {
    body.input = body.input.map((entry) => {
      const item = isRecord(entry) ? entry : undefined;
      if (!item || item.type !== "function_call" || typeof item.name !== "string") return entry;
      if (item.name.startsWith(prefix)) return entry;
      return { ...item, name: `${prefix}${item.name}` };
    });
  }
}

/**
 * 回包方向：SSE 中 `function_call.name` 去掉 namespace 前缀还原。
 * AI SDK 直接以 `response.output_item.added` 的 `item.name` 作为本地工具名，
 * 不还原则 tool-call 无法匹配 ZCode 已注册的工具。仅在启用了出站 namespace
 * 时包一层 TransformStream；帧不完整时原样透传，不在 compat 层重试或吞错，
 * 网络中断/空 completion 的恢复仍由既有 retry 边界负责。
 */
function rewriteResponsesSseFunctionCallNamespaces(
  response: Response,
  namespace: string,
): Response {
  if (response.body === null) return response;
  if (response.headers.get("content-type")?.toLowerCase().includes("event-stream") !== true) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Response(
    response.body.pipeThrough(createFunctionCallNamespaceSseTransform(namespace)),
    {
      headers,
      status: response.status,
      statusText: response.statusText,
    },
  );
}

function createFunctionCallNamespaceSseTransform(
  namespace: string,
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true });
      pending = emitRewrittenSseFrames(pending, controller, encoder, namespace);
    },
    flush(controller) {
      pending += decoder.decode();
      if (pending.length === 0) return;
      emitRewrittenSseFrames(pending, controller, encoder, namespace);
    },
  });
}

function emitRewrittenSseFrames(
  input: string,
  controller: TransformStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  namespace: string,
): string {
  let pending = input;
  for (;;) {
    const match = SSE_FRAME_SEPARATOR_PATTERN.exec(pending);
    if (!match) return pending;
    const separator = match[0] ?? "";
    const frame = pending.slice(0, match.index);
    pending = pending.slice(match.index + separator.length);
    const rewritten = rewriteSseFrameFunctionCallNamespace(frame, namespace);
    controller.enqueue(encoder.encode(`${rewritten}${separator}`));
  }
}

/**
 * 重写单个完整 SSE 帧；JSON 不可解析或没有 function_call 命中时保持字节不变。
 * 命中时仅替换 data 行内容，event:/id: 等其余行按原分隔符重组。
 */
function rewriteSseFrameFunctionCallNamespace(frame: string, namespace: string): string {
  const lines = frame.split(/\r\n|\n|\r/);
  const dataLineIndices: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]!.startsWith("data:")) dataLineIndices.push(index);
  }
  if (dataLineIndices.length === 0) return frame;
  const dataText = dataLineIndices
    .map((index) => trimSseFieldValue(lines[index]!.slice("data:".length)))
    .join("\n");
  let parsed: unknown;
  try {
    parsed = JSON.parse(dataText);
  } catch {
    return frame;
  }
  const rewritten = rewriteResponsesEventFunctionCallNames(parsed, namespace);
  if (rewritten === undefined) return frame;
  const rebuilt = [...lines];
  rebuilt[dataLineIndices[0]!] = `data: ${JSON.stringify(rewritten)}`;
  for (let index = dataLineIndices.length - 1; index >= 1; index -= 1) {
    rebuilt.splice(dataLineIndices[index]!, 1);
  }
  return rebuilt.join(frame.includes("\r\n") ? "\r\n" : "\n");
}

/** 只处理 Responses SSE 中携带 function_call 名称的已知事件形态。 */
function rewriteResponsesEventFunctionCallNames(
  event: unknown,
  namespace: string,
): Record<string, unknown> | undefined {
  if (!isRecord(event)) return undefined;
  let result: Record<string, unknown> = event;
  // response.output_item.added / response.output_item.done
  if (isRecord(event.item) && event.item.type === "function_call") {
    const name = stripFunctionCallNamespace(event.item.name, namespace);
    if (name !== undefined) {
      result = { ...result, item: { ...event.item, name } };
    }
  }
  // response.completed / response.incomplete / response.failed 的 response.output[]
  const response = isRecord(event.response) ? event.response : undefined;
  if (response && Array.isArray(response.output)) {
    let changed = false;
    const output = response.output.map((entry) => {
      const item = isRecord(entry) ? entry : undefined;
      if (!item || item.type !== "function_call") return entry;
      const name = stripFunctionCallNamespace(item.name, namespace);
      if (name === undefined) return entry;
      changed = true;
      return { ...item, name };
    });
    if (changed) {
      result = { ...result, response: { ...response, output } };
    }
  }
  return result === event ? undefined : result;
}

function stripFunctionCallNamespace(name: unknown, namespace: string): string | undefined {
  if (typeof name !== "string") return undefined;
  const prefix = `${namespace}.`;
  if (!name.startsWith(prefix)) return undefined;
  const stripped = name.slice(prefix.length);
  return stripped.length > 0 ? stripped : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonBody(body: BodyInit | null | undefined): Record<string, unknown> | undefined {
  if (typeof body !== "string") return undefined;
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function withJsonContentType(headers: HeadersInit | undefined): HeadersInit {
  const result = new Headers(headers);
  if (!result.has("content-type")) {
    result.set("content-type", "application/json");
  }
  return result;
}

function trimSseFieldValue(value: string): string {
  return value.startsWith(" ") ? value.slice(1) : value;
}
