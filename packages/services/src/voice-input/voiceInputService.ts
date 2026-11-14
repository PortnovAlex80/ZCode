import { Emitter } from "@zcode/rpc";
import type { ApiClient } from "@zcode/shared";
import type { WebSocket } from "undici";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import type {
  IVoiceInputService,
  VoiceInputErrorCode,
  VoiceInputEvent,
} from "#src/voice-input/contract.js";

const log = createServiceLogger("voice-input");

// zcode-server ASR 协议见其仓库 docs/asr.md；这里只用 realtime 模式。
const TICKET_PATH = "/api/v1/asr/tickets";
const TICKET_TIMEOUT_MS = 10_000;

interface Session {
  attemptId: string;
  language: "zh-CN" | "en-US" | "ru-RU";
  startedAt: number;
  socket: WebSocket | null;
  /** 本次连接是否经 HTTP 代理；由 Host 网络 transport 的选路结果决定 */
  viaProxy: boolean;
  /** WS 握手成功（onopen）；用于区分握手失败与握手后被断开 */
  opened: boolean;
  started: boolean;
  finishRequested: boolean;
  /** started 之前到达的音频；started 后按顺序发出并清空 */
  pending: Uint8Array[];
  sentBytes: number;
  /** 已经发出终态事件（completed / error），之后的关闭不再报错 */
  settled: boolean;
  serverSessionId?: string;
  provider?: string;
}

/** Fork GLM engine session state (no WS; buffers PCM and transcribes on finish). */
interface GlmSession {
  kind: "glm";
  attemptId: string;
  startedAt: number;
  /** Total PCM bytes buffered across chunks (for logging). */
  bufferedBytes: number;
  chunks: Uint8Array[];
  finishRequested: boolean;
  settled: boolean;
  transcription: Promise<void> | null;
}

const GLM_SAMPLE_RATE = 16_000;
/** GLM audio/transcriptions hard limit per request. */
const GLM_CHUNK_PCM_BYTES = GLM_SAMPLE_RATE * 2 * 30;

/** Minimal RIFF/WAVE header for 16-bit mono PCM at the captured sample rate. */
function buildWavHeader(pcmBytes: number): Uint8Array {
  const header = new Uint8Array(44);
  const view = new DataView(header.buffer);
  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + pcmBytes, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, GLM_SAMPLE_RATE, true);
  view.setUint32(28, GLM_SAMPLE_RATE * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(36, "data");
  view.setUint32(40, pcmBytes, true);
  return header;
}

export function createGlmWavFromPcm(pcm: Uint8Array): Uint8Array {
  const out = new Uint8Array(44 + pcm.byteLength);
  out.set(buildWavHeader(pcm.byteLength), 0);
  out.set(pcm, 44);
  return out;
}

/** Split a PCM buffer into ≤30s WAV-framed requests (identity for short input). */
export function splitPcmIntoGlmWavChunks(pcm: Uint8Array): Uint8Array[] {
  if (pcm.byteLength === 0) return [];
  const parts: Uint8Array[] = [];
  for (let offset = 0; offset < pcm.byteLength; offset += GLM_CHUNK_PCM_BYTES) {
    const end = Math.min(offset + GLM_CHUNK_PCM_BYTES, pcm.byteLength);
    parts.push(createGlmWavFromPcm(pcm.subarray(offset, end)));
  }
  return parts;
}

export function mapAsrErrorCode(code: string | undefined, status?: number): VoiceInputErrorCode {
  switch (code) {
    case "unauthorized":
      return "unauthorized";
    case "rate_limited":
      return "rate_limited";
    case "unavailable":
    case "upstream_unavailable":
      return "unavailable";
    case "upstream_timeout":
      return "upstream_timeout";
    case "audio_limit_exceeded":
      return "audio_limit_exceeded";
    case "empty_audio":
    case "audio_too_short":
      return "audio_too_short";
  }
  if (status === 401) return "unauthorized";
  // 通用限流中间件返回无响应体的 429。
  if (status === 429) return "rate_limited";
  if (status === 503) return "unavailable";
  return "failed";
}

function readServerMessage(data: unknown): Record<string, unknown> | null {
  if (typeof data !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(data);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function createVoiceInputService(options: {
  apiClient: ApiClient;
  getToken: () => Promise<string | null | undefined>;
  resolveOrigin: () => Promise<string>;
  /** 由 Host 网络 transport 提供，与 HTTP 请求共用代理、No Proxy 与自定义 CA；不提供默认直连实现 */
  createSocket: (url: string) => Promise<{ socket: WebSocket; viaProxy: boolean }>;
  /**
   * Fork GLM engine (2026-11-15): resolves the endpoint + API key for the
   * local transcription path used by languages the server realtime ASR
   * rejects (ru-RU). Returns null when no GLM provider API key is configured;
   * the session then fails with glm_key_missing. See
   * docs/chat/composer-voice-input.md.
   */
  resolveGlmTranscription?: () => Promise<{ url: string; apiKey: string } | null>;
}): IVoiceInputService & { dispose(): void } {
  const emitter = new Emitter<VoiceInputEvent>();
  const createSocket = options.createSocket;
  const resolveGlmTranscription = options.resolveGlmTranscription;
  // 唯一数据源：当前会话。旧会话的回调通过 `current !== session` 判断后丢弃。
  let current: Session | null = null;
  let currentGlm: GlmSession | null = null;

  function emit(session: Session, event: VoiceInputEvent) {
    if (current !== session || session.settled) return;
    if (event.type === "completed" || event.type === "error") session.settled = true;
    emitter.fire(event);
  }

  function summary(session: Session) {
    return {
      attemptId: session.attemptId,
      serverSessionId: session.serverSessionId,
      provider: session.provider,
      sentBytes: session.sentBytes,
      elapsedMs: Date.now() - session.startedAt,
    };
  }

  function fail(session: Session, code: VoiceInputErrorCode, detail: Record<string, unknown>) {
    if (current !== session || session.settled) return;
    log.warn(undefined, "voice input failed", { ...summary(session), code, ...detail });
    emit(session, { attemptId: session.attemptId, type: "error", code });
    release(session);
  }

  function release(session: Session) {
    if (current === session) current = null;
    const socket = session.socket;
    session.socket = null;
    if (socket && socket.readyState <= 1) socket.close(1000);
  }

  function sendChunk(session: Session, chunk: Uint8Array) {
    session.sentBytes += chunk.byteLength;
    log.debug(undefined, "voice input audio chunk", {
      attemptId: session.attemptId,
      bytes: chunk.byteLength,
    });
    session.socket?.send(chunk);
  }

  async function requestTicket(): Promise<{ ticket: string; wsPath: string }> {
    const origin = await options.resolveOrigin();
    const token = (await options.getToken())?.trim();
    if (!token) throw Object.assign(new Error("missing_token"), { status: 401 });
    const response = await options.apiClient.request(new URL(TICKET_PATH, origin).href, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "realtime" }),
      timeoutMs: TICKET_TIMEOUT_MS,
      redirect: "error",
    });
    const body = (await response.json().catch(() => null)) as {
      code?: number;
      logid?: string;
      data?: { ticket?: string; ws_path?: string; error_code?: string };
    } | null;
    if (!response.ok || body?.code !== 0 || !body.data?.ticket || !body.data.ws_path) {
      throw Object.assign(new Error("ticket_rejected"), {
        status: response.status,
        errorCode: body?.data?.error_code,
        logid: body?.logid,
      });
    }
    return { ticket: body.data.ticket, wsPath: new URL(body.data.ws_path, origin).href };
  }

  function handleMessage(session: Session, data: unknown) {
    const message = readServerMessage(data);
    if (!message) return;
    const text = typeof message.text === "string" ? message.text : "";
    switch (message.type) {
      case "started": {
        session.started = true;
        session.serverSessionId =
          typeof message.session_id === "string" ? message.session_id : undefined;
        session.provider = typeof message.provider === "string" ? message.provider : undefined;
        log.info(undefined, "voice input started", summary(session));
        emit(session, { attemptId: session.attemptId, type: "started" });
        for (const chunk of session.pending.splice(0)) sendChunk(session, chunk);
        if (session.finishRequested) session.socket?.send(JSON.stringify({ type: "finish" }));
        return;
      }
      case "result":
        log.debug(undefined, "voice input result", {
          attemptId: session.attemptId,
          length: text.length,
        });
        emit(session, { attemptId: session.attemptId, type: "result", text });
        return;
      case "completed":
        log.info(undefined, "voice input completed", {
          ...summary(session),
          length: text.length,
          audioDurationMs: message.audio_duration_ms,
        });
        emit(session, { attemptId: session.attemptId, type: "completed", text });
        release(session);
        return;
      case "error":
        fail(session, mapAsrErrorCode(String(message.code ?? "")), {
          serverCode: message.code,
          retryable: message.retryable,
        });
        return;
    }
  }

  async function connect(session: Session) {
    let ticket: { ticket: string; wsPath: string };
    try {
      ticket = await requestTicket();
    } catch (error) {
      const status = (error as { status?: number }).status;
      const errorCode = (error as { errorCode?: string }).errorCode;
      // 没有 HTTP 状态说明请求没有到达服务端（DNS、断网、超时、代理）。
      fail(session, status === undefined ? "network" : mapAsrErrorCode(errorCode, status), {
        stage: "ticket",
        status,
        errorCode,
        logid: (error as { logid?: string }).logid,
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (current !== session) return;
    const url = new URL(ticket.wsPath);
    url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
    url.searchParams.set("ticket", ticket.ticket);
    // Node 的 WebSocket 不带 Origin 头；renderer 的 file:// 来源会被服务端 allowed_origins 拒绝。
    let socket: WebSocket;
    try {
      const connection = await createSocket(url.href);
      socket = connection.socket;
      session.viaProxy = connection.viaProxy;
    } catch (error) {
      // 代理配置无效、CA 读取失败等：fail-closed，不回退直连。
      fail(session, "network", {
        stage: "socket-create",
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (current !== session) {
      socket.close(1000);
      return;
    }
    socket.binaryType = "arraybuffer";
    session.socket = socket;
    socket.onopen = () => {
      if (current !== session) return;
      session.opened = true;
      log.info(undefined, "voice input socket open", {
        attemptId: session.attemptId,
        viaProxy: session.viaProxy,
        elapsedMs: Date.now() - session.startedAt,
      });
      socket.send(
        JSON.stringify({
          type: "start",
          audio: { encoding: "pcm_s16le", sample_rate: 16000, channels: 1 },
          language: session.language,
          options: { punctuation: true, itn: true },
        }),
      );
    };
    socket.onmessage = (event) => {
      if (current === session) handleMessage(session, event.data);
    };
    socket.onerror = () => {
      // 修复原因：Host transport 用 undici 6 的 WebSocket，握手被拒（非 101，如 ticket 失效 401/403）
      // 时只触发 error、不触发 close；原先只在 onclose 里失败，会话一直停在连接中，没有提示和日志。
      // 握手前的 error 直接按握手失败结束；握手后的 error 仍由随后的 onclose 记录 close code。
      // 握手失败时 Node 不提供 HTTP 状态，无法区分代理与服务端，所以归为 failed。
      if (!session.opened) {
        fail(session, "failed", { stage: "handshake", opened: false, viaProxy: session.viaProxy });
      }
    };
    socket.onclose = (event) => {
      // 修复原因：用户经本地 MITM 抓包代理使用时，ticket 成功，WS 每次约 5 秒后 1006 断开。
      // 服务端在 started 前失败时一定先发 error 事件再发 close 帧（1011），客户端两者都没收到，
      // 说明帧被中间的代理丢弃；原先统一提示「语音识别失败，请重试」，用户无法定位到代理。
      // 只在经代理、握手成功后、started 前、非正常关闭时归为 proxy；其他断开仍是 failed。
      // 必须要求 opened：握手阶段服务端用 HTTP 状态拒绝（如 ticket 无效返回 403）时，
      // 客户端同样只看到 1006，无法区分代理和服务端，归为 proxy 会误导用户去排查代理。
      const code =
        session.viaProxy && session.opened && !session.started && !event.wasClean
          ? "proxy"
          : "failed";
      fail(session, code, {
        stage: "socket",
        opened: session.opened,
        viaProxy: session.viaProxy,
        closeCode: event.code,
        wasClean: event.wasClean,
        reason: event.reason,
      });
    };
  }

  // ───────── Fork GLM engine (ru-RU): buffer PCM, transcribe on finish ─────────

  function glmEmit(session: GlmSession, event: VoiceInputEvent) {
    if (currentGlm !== session || session.settled) return;
    if (event.type === "completed" || event.type === "error") session.settled = true;
    emitter.fire(event);
  }

  function glmFail(session: GlmSession, code: VoiceInputErrorCode, detail: Record<string, unknown>) {
    if (currentGlm !== session || session.settled) return;
    log.warn(undefined, "voice input (glm) failed", {
      attemptId: session.attemptId,
      bufferedBytes: session.bufferedBytes,
      elapsedMs: Date.now() - session.startedAt,
      code,
      ...detail,
    });
    glmEmit(session, { attemptId: session.attemptId, type: "error", code });
  }

  /** POST one WAV chunk to GLM audio/transcriptions; returns its final text. */
  async function transcribeGlmChunk(
    session: GlmSession,
    url: string,
    apiKey: string,
    wav: Uint8Array,
  ): Promise<string> {
    const form = new FormData();
    // Copy into a plain ArrayBuffer-backed view: BlobPart requires
    // Uint8Array<ArrayBuffer>, while the capture pipeline hands us
    // Uint8Array<ArrayBufferLike>.
    const wavBytes = new Uint8Array(wav.byteLength);
    wavBytes.set(wav);
    form.append("file", new Blob([wavBytes], { type: "audio/wav" }), "dictation.wav");
    form.append("model", "glm-asr-2512");
    // apiClient shares the host proxy/CA policy; follow redirects is irrelevant
    // for multipart POSTs, and errors surface through !ok like the ticket path.
    const response = await options.apiClient.request(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      timeoutMs: 60_000,
      redirect: "error",
    });
    const body = (await response.json().catch(() => null)) as { text?: unknown } | null;
    if (!response.ok || !body || typeof body.text !== "string") {
      throw Object.assign(new Error("glm_transcription_rejected"), {
        status: response.status,
      });
    }
    return body.text;
  }

  async function runGlmTranscription(session: GlmSession) {
    const pcm = new Uint8Array(session.bufferedBytes);
    let offset = 0;
    for (const chunk of session.chunks.splice(0)) {
      pcm.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const chunks = splitPcmIntoGlmWavChunks(pcm);
    if (chunks.length === 0) {
      glmFail(session, "audio_too_short", { stage: "glm-empty-buffer" });
      return;
    }
    let credentials: { url: string; apiKey: string } | null = null;
    try {
      credentials = resolveGlmTranscription ? await resolveGlmTranscription() : null;
    } catch (error) {
      log.warn(undefined, "voice input (glm) credential resolve threw", {
        attemptId: session.attemptId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    if (!credentials) {
      glmFail(session, "glm_key_missing", { stage: "glm-credentials" });
      return;
    }
    const texts: string[] = [];
    for (const [index, wav] of chunks.entries()) {
      if (currentGlm !== session || session.settled) return;
      try {
        texts.push(
          (await transcribeGlmChunk(session, credentials.url, credentials.apiKey, wav)).trim(),
        );
      } catch (error) {
        const status = (error as { status?: number }).status;
        glmFail(session, status === 401 ? "unauthorized" : "unavailable", {
          stage: "glm-transcribe",
          chunk: index + 1,
          of: chunks.length,
          status,
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }
    }
    if (currentGlm !== session || session.settled) return;
    const text = texts.filter(Boolean).join(" ");
    log.info(undefined, "voice input (glm) completed", {
      attemptId: session.attemptId,
      chunks: chunks.length,
      bufferedBytes: session.bufferedBytes,
      length: text.length,
      elapsedMs: Date.now() - session.startedAt,
    });
    glmEmit(session, { attemptId: session.attemptId, type: "completed", text });
  }

  return {
    onEvent: emitter.event,
    async start({ attemptId, language }) {
      if (current) {
        log.info(undefined, "voice input replaced", summary(current));
        const previous = current;
        previous.settled = true;
        if (previous.socket?.readyState === 1)
          previous.socket.send(JSON.stringify({ type: "cancel" }));
        release(previous);
      }
      if (currentGlm) {
        log.info(undefined, "voice input (glm) replaced", {
          attemptId: currentGlm.attemptId,
        });
        currentGlm.settled = true;
        currentGlm = null;
      }
      if (language === "ru-RU") {
        const session: GlmSession = {
          kind: "glm",
          attemptId,
          startedAt: Date.now(),
          bufferedBytes: 0,
          chunks: [],
          finishRequested: false,
          settled: false,
          transcription: null,
        };
        currentGlm = session;
        log.info(undefined, "voice input (glm) start", { attemptId, language });
        // No connection to establish: the engine is ready the moment it starts.
        glmEmit(session, { attemptId, type: "started" });
        return;
      }
      const session: Session = {
        attemptId,
        language,
        startedAt: Date.now(),
        socket: null,
        viaProxy: false,
        opened: false,
        started: false,
        finishRequested: false,
        pending: [],
        sentBytes: 0,
        settled: false,
      };
      current = session;
      log.info(undefined, "voice input start", { attemptId, language });
      void connect(session);
    },
    async sendAudio({ attemptId, chunk }) {
      const glm = currentGlm;
      if (glm && glm.attemptId === attemptId) {
        if (glm.finishRequested || glm.settled) return;
        glm.chunks.push(chunk);
        glm.bufferedBytes += chunk.byteLength;
        return;
      }
      const session = current;
      if (!session || session.attemptId !== attemptId || session.finishRequested) return;
      if (!session.started) session.pending.push(chunk);
      else sendChunk(session, chunk);
    },
    async finish({ attemptId }) {
      const glm = currentGlm;
      if (glm && glm.attemptId === attemptId) {
        if (glm.finishRequested || glm.settled) return;
        glm.finishRequested = true;
        glm.transcription = runGlmTranscription(glm);
        return;
      }
      const session = current;
      if (!session || session.attemptId !== attemptId || session.finishRequested) return;
      session.finishRequested = true;
      if (session.started) session.socket?.send(JSON.stringify({ type: "finish" }));
    },
    async cancel({ attemptId }) {
      const glm = currentGlm;
      if (glm && glm.attemptId === attemptId) {
        log.info(undefined, "voice input (glm) cancelled", {
          attemptId: glm.attemptId,
          bufferedBytes: glm.bufferedBytes,
        });
        glm.settled = true;
        currentGlm = null;
        return;
      }
      const session = current;
      if (!session || session.attemptId !== attemptId) return;
      log.info(undefined, "voice input cancelled", summary(session));
      session.settled = true;
      if (session.socket?.readyState === 1) session.socket.send(JSON.stringify({ type: "cancel" }));
      release(session);
    },
    dispose() {
      if (current) {
        current.settled = true;
        release(current);
      }
      if (currentGlm) {
        currentGlm.settled = true;
        currentGlm = null;
      }
      emitter.dispose();
    },
  };
}
