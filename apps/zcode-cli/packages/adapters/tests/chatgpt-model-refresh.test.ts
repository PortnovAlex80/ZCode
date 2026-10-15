import { refreshChatGptModels } from "../src/auth/chatgpt/chatgpt-model-refresh.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createSharedZCodeCredentialStore } from "../src/auth/shared-credentials.js";
import {
  readChatGptCachedModels,
  writeChatGptCachedModels,
  readChatGptCredentialRecord,
  toChatGptCredentialRecord,
  writeChatGptCredentialRecord,
  type ChatGptCredentialRecord,
} from "../src/auth/chatgpt/chatgpt-credential-record.js";

const tempDirs: string[] = [];
let simulatedNow = Date.now();

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
  simulatedNow = Date.now();
});

async function createTempCredentialStore() {
  const dir = await mkdtemp(join(tmpdir(), "zcode-chatgpt-auth-"));
  tempDirs.push(dir);
  return createSharedZCodeCredentialStore({
    filePath: join(dir, "credentials.json"),
  });
}

async function seedCredential(
  store: ReturnType<typeof createSharedZCodeCredentialStore>,
  overrides: Partial<{
    expiresAt: number;
    earliestRefreshAt?: number;
    scopes: string[];
  }> = {},
): Promise<ChatGptCredentialRecord> {
  const record = toChatGptCredentialRecord({
    clientId: "oaiapp_test_client",
    tokenResponse: {
      access_token: "initial-access-1",
      refresh_token: "initial-refresh-1",
      id_token: "seed-id-token",
      token_type: "Bearer",
      expires_in: 3600,
      scope: (
        overrides.scopes ?? [
          "openid",
          "profile",
          "email",
          "offline_access",
          "resource.invoke",
          "chatgpt.tokens.use.direct",
        ]
      ).join(" "),
      ...(overrides.earliestRefreshAt !== undefined
        ? { earliest_refresh_at: overrides.earliestRefreshAt }
        : {}),
    },
    scopes: overrides.scopes ?? [
      "openid",
      "profile",
      "email",
      "offline_access",
      "resource.invoke",
      "chatgpt.tokens.use.direct",
    ],
    accountClaims: { subject: "user-subject-1", email: "user@example.com" },
    now: () => simulatedNow,
  });
  const withExpiry = overrides.expiresAt
    ? { ...record, expiresAt: overrides.expiresAt }
    : record;
  await writeChatGptCredentialRecord(store, withExpiry);
  return withExpiry;
}

const payload = {
  models: [{ slug: "one", display_name: "One", visibility: "list" }],
};
it("recovers catalog using saved auth without consent", async () => {
  const store = await createTempCredentialStore();
  const original = await seedCredential(store);
  expect(
    await refreshChatGptModels({
      store,
      env: {},
      fetchImpl: async (url, init) => {
        expect(String(url)).toBe("https://api.openai.com/v1/models");
        expect(init?.headers).toMatchObject({
          authorization: "Bearer initial-access-1",
        });
        return Response.json(payload);
      },
    }),
  ).toEqual({ result: "completed", modelCount: 1 });
  expect(await readChatGptCachedModels(store)).toEqual([
    { slug: "one", display_name: "One" },
  ]);
  expect(await readChatGptCredentialRecord(store)).toEqual(original);
});
it("preserves credentials and catalog on HTTP520", async () => {
  const store = await createTempCredentialStore();
  const original = await seedCredential(store);
  const previous = [{ slug: "prior", display_name: "Prior" }];
  await writeChatGptCachedModels(store, previous);
  expect(
    await refreshChatGptModels({
      store,
      env: {},
      fetchImpl: async () => new Response("", { status: 520 }),
    }),
  ).toEqual({
    result: "failed",
    code: "chatgpt_models_request_failed",
    httpStatus: 520,
  });
  expect(await readChatGptCredentialRecord(store)).toEqual(original);
  expect(await readChatGptCachedModels(store)).toEqual(previous);
});
it("rejects stale catalog after concurrent account replacement", async () => {
  const store = await createTempCredentialStore();
  const original = await seedCredential(store);
  expect(
    await refreshChatGptModels({
      store,
      env: {},
      fetchImpl: async () => {
        await writeChatGptCredentialRecord(store, {
          ...original,
          accessToken: "new-account-token",
        });
        await writeChatGptCachedModels(store, [
          { slug: "new", display_name: "New" },
        ]);
        return Response.json(payload);
      },
    }),
  ).toEqual({ result: "failed", code: "chatgpt_account_changed" });
  expect(await readChatGptCachedModels(store)).toEqual([
    { slug: "new", display_name: "New" },
  ]);
});
it("requires account and token-sharing scope", async () => {
  const store = await createTempCredentialStore();
  const fetchImpl = async () => {
    throw new Error("must not request");
  };
  expect(await refreshChatGptModels({ store, env: {}, fetchImpl })).toEqual({
    result: "failed",
    code: "chatgpt_not_signed_in",
  });
  await seedCredential(store, { scopes: ["openid"] });
  expect(await refreshChatGptModels({ store, env: {}, fetchImpl })).toEqual({
    result: "failed",
    code: "chatgpt_token_sharing_scope_missing",
  });
});

it.each(["headers", "body"] as const)(
  "bounds expired-token refresh %s, releases lock and ignores late response",
  async (stage) => {
    const store = await createTempCredentialStore();
    const original = await seedCredential(store, { expiresAt: Date.now() - 1 });
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: (value: any) => void;
    const stalled = new Promise<any>((resolve) => {
      release = resolve;
    });
    let signal: AbortSignal | null | undefined;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = refreshChatGptModels({
      store,
      env: {},
      fetchImpl: async (_url, init) => {
        signal = init?.signal;
        started();
        return stage === "headers"
          ? stalled
          : ({ ok: true, status: 200, text: () => stalled } as Response);
      },
    });
    await ready;
    await vi.advanceTimersByTimeAsync(15000);
    expect(await pending).toEqual({
      result: "failed",
      code: "chatgpt_token_timeout",
    });
    expect(signal?.aborted).toBe(true);
    vi.useRealTimers();
    const late = {
      access_token: "late-token",
      refresh_token: "late-refresh",
      expires_in: 3600,
      token_type: "Bearer",
    };
    release(stage === "headers" ? Response.json(late) : JSON.stringify(late));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await readChatGptCredentialRecord(store)).toEqual(original);
    // A second attempt acquires the same refresh lock immediately; no stranded transaction.
    expect(
      await refreshChatGptModels({
        store,
        env: {},
        lockMaxWaitMs: 100,
        fetchImpl: async () => new Response("", { status: 503 }),
      }),
    ).toEqual({
      result: "failed",
      code: "chatgpt_token_request_failed",
      httpStatus: 503,
    });
  },
);
