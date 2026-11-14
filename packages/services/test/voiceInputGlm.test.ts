// Fork GLM dictation engine tests (2026-11-15): ru-RU sessions buffer PCM,
// transcribe on finish through /audio/transcriptions with the resolved provider
// key, chunk long buffers at 30s, and surface the existing error taxonomy.
// The realtime WS path (zh/en) is covered by the desktop E2E suite.
import { describe, expect, it, vi } from "vitest";
import {
  createGlmWavFromPcm,
  createVoiceInputService,
  splitPcmIntoGlmWavChunks,
} from "../src/voice-input/voiceInputService.js";
import type { VoiceInputEvent } from "../src/voice-input/contract.js";

function createService(options: {
  resolveGlmTranscription?: () => Promise<{ url: string; apiKey: string } | null>;
  request?: (url: string, init?: unknown) => Promise<Response>;
}) {
  const events: VoiceInputEvent[] = [];
  const apiClient = {
    request:
      options.request ??
      (vi.fn(async () =>
        new Response(JSON.stringify({ text: "привет мир" }), { status: 200 }),
      ) as unknown as typeof apiClient.request),
  };
  const service = createVoiceInputService({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    apiClient: apiClient as any,
    getToken: async () => "jwt",
    resolveOrigin: async () => "https://zcode.z.ai",
    createSocket: async () => {
      throw new Error("glm session must not open a websocket");
    },
    resolveGlmTranscription:
      options.resolveGlmTranscription ??
      (async () => ({ url: "https://api.z.ai/api/paas/v4/audio/transcriptions", apiKey: "k" })),
  });
  service.onEvent((event) => events.push(event));
  return { service, events, apiClient };
}

function pcm(bytes: number): Uint8Array {
  return new Uint8Array(bytes).fill(1);
}

describe("splitPcmIntoGlmWavChunks", () => {
  it("frames short input into a single WAV with a valid header", () => {
    const chunks = splitPcmIntoGlmWavChunks(pcm(3200));
    expect(chunks).toHaveLength(1);
    const wav = chunks[0]!;
    expect(wav.byteLength).toBe(44 + 3200);
    expect(Buffer.from(wav.subarray(0, 4)).toString("ascii")).toBe("RIFF");
    expect(new DataView(wav.buffer, wav.byteOffset).getUint32(40, true)).toBe(3200);
  });

  it("splits beyond 30 seconds at the chunk boundary", () => {
    const thirty = 16000 * 2 * 30;
    const chunks = splitPcmIntoGlmWavChunks(pcm(thirty + 100));
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.byteLength).toBe(44 + thirty);
    expect(chunks[1]!.byteLength).toBe(44 + 100);
  });

  it("returns nothing for empty audio", () => {
    expect(splitPcmIntoGlmWavChunks(new Uint8Array(0))).toHaveLength(0);
  });
});

describe("createGlmWavFromPcm header", () => {
  it("declares 16 kHz mono 16-bit PCM", () => {
    const view = new DataView(createGlmWavFromPcm(pcm(10)).buffer);
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint16(34, true)).toBe(16);
  });
});

describe("voice input GLM session", () => {
  it("emits started immediately and completed with the final text on finish", async () => {
    const { service, events } = createService({});
    await service.start({ attemptId: "a1", language: "ru-RU" });
    await service.sendAudio({ attemptId: "a1", chunk: pcm(3200) });
    expect(events.map((e) => e.type)).toEqual(["started"]);
    await service.finish({ attemptId: "a1" });
    await vi.waitFor(() =>
      expect(events.map((e) => e.type)).toEqual(["started", "completed"]),
    );
    expect(events.at(-1)).toMatchObject({ type: "completed", text: "привет мир" });
    service.dispose();
  });

  it("fails with glm_key_missing when no provider key resolves", async () => {
    const { service, events } = createService({
      resolveGlmTranscription: async () => null,
    });
    await service.start({ attemptId: "a2", language: "ru-RU" });
    await service.sendAudio({ attemptId: "a2", chunk: pcm(3200) });
    await service.finish({ attemptId: "a2" });
    await vi.waitFor(() => expect(events.at(-1)?.type).toBe("error"));
    expect(events.at(-1)).toMatchObject({ type: "error", code: "glm_key_missing" });
    service.dispose();
  });

  it("sends multipart body with the bearer key and stitches multi-chunk finals", async () => {
    const bodies: string[] = [];
    const { service, events } = createService({
      request: (vi.fn(async (_url: string, init: { body: FormData }) => {
        bodies.push(String(init.body));
        const n = bodies.length;
        return new Response(JSON.stringify({ text: "часть " + n }), { status: 200 });
      }) as unknown as () => Promise<Response>) as never,
    });
    await service.start({ attemptId: "a3", language: "ru-RU" });
    const thirty = 16000 * 2 * 30;
    await service.sendAudio({ attemptId: "a3", chunk: pcm(thirty) });
    await service.sendAudio({ attemptId: "a3", chunk: pcm(100) });
    await service.finish({ attemptId: "a3" });
    await vi.waitFor(() => expect(events.at(-1)?.type).toBe("completed"));
    expect(bodies).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ type: "completed", text: "часть 1 часть 2" });
    service.dispose();
  });

  it("classifies a 401 transcription rejection as unauthorized", async () => {
    const { service, events } = createService({
      request: (vi.fn(
        async () => new Response(JSON.stringify({}), { status: 401 }),
      ) as unknown as () => Promise<Response>) as never,
    });
    await service.start({ attemptId: "a4", language: "ru-RU" });
    await service.sendAudio({ attemptId: "a4", chunk: pcm(3200) });
    await service.finish({ attemptId: "a4" });
    await vi.waitFor(() => expect(events.at(-1)?.type).toBe("error"));
    expect(events.at(-1)).toMatchObject({ type: "error", code: "unauthorized" });
    service.dispose();
  });

  it("cancel drops the buffered audio without terminal events", async () => {
    const { service, events } = createService({});
    await service.start({ attemptId: "a5", language: "ru-RU" });
    await service.sendAudio({ attemptId: "a5", chunk: pcm(3200) });
    await service.cancel({ attemptId: "a5" });
    await service.finish({ attemptId: "a5" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(events.map((e) => e.type)).toEqual(["started"]);
    service.dispose();
  });

  it("empty buffer fails as audio_too_short", async () => {
    const { service, events } = createService({});
    await service.start({ attemptId: "a6", language: "ru-RU" });
    await service.finish({ attemptId: "a6" });
    await vi.waitFor(() => expect(events.at(-1)?.type).toBe("error"));
    expect(events.at(-1)).toMatchObject({ type: "error", code: "audio_too_short" });
    service.dispose();
  });
});
