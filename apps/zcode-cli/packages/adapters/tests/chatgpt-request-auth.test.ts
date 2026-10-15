import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSharedZCodeCredentialStore } from "../src/auth/shared-credentials.js";
import {
  createChatGptRequestAuthSource,
  type ChatGptRequestAuthSource,
} from "../src/auth/chatgpt/chatgpt-request-auth.js";
import {
  readChatGptCredentialRecord,
  serializeChatGptCredentialRecord,
  toChatGptCredentialRecord,
  writeChatGptCredentialRecord,
  type ChatGptCredentialRecord,
} from "../src/auth/chatgpt/chatgpt-credential-record.js";
import { createMockAuthServer, RsaTestSigner } from "./chatgpt-oauth-mock-server.js";

const tempDirs: string[] = [];
let simulatedNow = Date.now();

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  simulatedNow = Date.now();
});

async function createTempCredentialStore() {
  const dir = await mkdtemp(join(tmpdir(), "zcode-chatgpt-auth-"));
  tempDirs.push(dir);
  return createSharedZCodeCredentialStore({ filePath: join(dir, "credentials.json") });
}

function envFor(issuer: string): Record<string, string> {
  return {
    ZCODE_CHATGPT_OAUTH_ISSUER: issuer,
    ZCODE_CHATGPT_API_BASE_URL: `${issuer}/v1`,
  };
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
      scope:
        (overrides.scopes ?? [
          "openid",
          "profile",
          "email",
          "offline_access",
          "resource.invoke",
          "chatgpt.tokens.use.direct",
        ]).join(" "),
      ...(overrides.earliestRefreshAt !== undefined
        ? { earliest_refresh_at: overrides.earliestRefreshAt }
        : {}),
    },
    scopes:
      overrides.scopes ?? [
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

function resolveInput() {
  return { attempt: 1, providerId: "account:chatgpt", modelId: "gpt-6.1-sol" } as const;
}

describe("ChatGPT request auth source", () => {
  it("token 新鲜时直接返回，零网络请求", async () => {
    const server = await createMockAuthServer({ signer: new RsaTestSigner() });
    const store = await createTempCredentialStore();
    try {
      await seedCredential(store);
      const source = createChatGptRequestAuthSource({
        store,
        env: envFor(server.url),
        now: () => simulatedNow,
      });
      const auth = await source.resolve(resolveInput());
      expect(auth).toEqual({ apiKey: "initial-access-1" });
      expect(server.accessTokenRequests.length).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("临期刷新：轮换落盘、generation 更新、凭据仍加密", async () => {
    const server = await createMockAuthServer({ signer: new RsaTestSigner() });
    const store = await createTempCredentialStore();
    try {
      const seeded = await seedCredential(store);
      // 推进时间越过 5 分钟阈值（token 尚未完全过期）。
      simulatedNow += 3_600_000 - 5 * 60 * 1000 + 1_000;
      const source = createChatGptRequestAuthSource({
        store,
        env: envFor(server.url),
        now: () => simulatedNow,
        sleep: async () => undefined,
      });
      const auth = await source.resolve(resolveInput());
      expect(auth).toEqual({ apiKey: "refreshed-access-1" });
      const record = await readChatGptCredentialRecord(store);
      expect(record!.refreshToken).toBe("rotated-refresh-1");
      expect(record!.generation).not.toBe(seeded.generation);
      expect(record!.expiresAt).toBeGreaterThan(simulatedNow);
    } finally {
      await server.close();
    }
  });

  it("单实例并发 resolve（协程竞态）：single-flight，只发一次 refresh", async () => {
    const server = await createMockAuthServer({ signer: new RsaTestSigner() });
    const store = await createTempCredentialStore();
    try {
      await seedCredential(store);
      simulatedNow += 3_600_000 + 1_000;
      const source = createChatGptRequestAuthSource({
        store,
        env: envFor(server.url),
        now: () => simulatedNow,
        sleep: async () => undefined,
      });
      const [first, second] = await Promise.all([
        source.resolve({ ...resolveInput(), attempt: 1 }),
        source.resolve({ ...resolveInput(), attempt: 2 }),
      ]);
      expect(first).toEqual({ apiKey: "refreshed-access-1" });
      expect(second).toEqual({ apiKey: "refreshed-access-1" });
      expect(server.refreshRequestCount()).toBe(1);
    } finally {
      await server.close();
    }
  });

  it("两个独立实例（模拟两进程，只共享凭据文件）并发刷新：旧 token 只被使用一次", async () => {
    const server = await createMockAuthServer({ signer: new RsaTestSigner() });
    const store = await createTempCredentialStore();
    try {
      await seedCredential(store);
      simulatedNow += 3_600_000 + 1_000;
      const options = {
        store,
        env: envFor(server.url),
        now: () => simulatedNow,
        sleep: async () => undefined,
      } as const;
      // 两个 source 实例 = 两个独立调用方：无共享内存状态，仅共享加密存储文件
      // 与 refresh 文件锁。任何并发使用旧 refresh token 都会被 mock 的单次使用
      // 语义判 invalid_grant 并暴露。
      const first = createChatGptRequestAuthSource(options);
      const second = createChatGptRequestAuthSource(options);
      const [fromFirst, fromSecond] = await Promise.all([
        first.resolve(resolveInput()),
        second.resolve(resolveInput()),
      ]);
      expect(fromFirst).toEqual({ apiKey: "refreshed-access-1" });
      expect(fromSecond).toEqual({ apiKey: "refreshed-access-1" });
      // 关键断言：旧 refresh token 只发送了一次（fork 的「先请求后认领」在此会发出两次，
      // 第二次撞 reuse-detection）。
      expect(server.refreshRequestCount()).toBe(1);
      expect(server.accessTokenRequests[0]!.refreshToken).toBe("initial-refresh-1");
      const record = await readChatGptCredentialRecord(store);
      expect(record!.refreshToken).toBe("rotated-refresh-1");
    } finally {
      await server.close();
    }
  });

  it("不可用 refresh token：generation 守卫清空 + 类型化重登录错误", async () => {
    const server = await createMockAuthServer({
      signer: new RsaTestSigner(),
      tokenResponseOverrides: () => ({ error: "invalid_grant" }),
    });
    const store = await createTempCredentialStore();
    try {
      await seedCredential(store);
      simulatedNow += 3_600_000 + 1_000;
      const source = createChatGptRequestAuthSource({
        store,
        env: envFor(server.url),
        now: () => simulatedNow,
        sleep: async () => undefined,
      });
      await expect(source.resolve(resolveInput())).rejects.toMatchObject({
        code: "chatgpt_relogin_required",
      });
      expect(await readChatGptCredentialRecord(store)).toBeNull();
      expect(await source.isLoggedIn()).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("网络失败（临时故障）：凭据保留，可重试", async () => {
    const server = await createMockAuthServer({ signer: new RsaTestSigner() });
    const store = await createTempCredentialStore();
    try {
      await seedCredential(store);
      simulatedNow += 3_600_000 + 1_000;
      const failingFetch = (async () => {
        throw new Error("simulated network outage");
      }) as typeof globalThis.fetch;
      const source = createChatGptRequestAuthSource({
        store,
        env: envFor(server.url),
        fetchImpl: failingFetch,
        now: () => simulatedNow,
        sleep: async () => undefined,
      });
      // 官方 errors-and-recovery：临时网络故障不清凭据。
      await expect(source.resolve(resolveInput())).rejects.toMatchObject({
        code: "chatgpt_token_network_error",
      });
      expect(await source.isLoggedIn()).toBe(true);
      // 网络恢复后重试成功（真实 fetch 指向 mock 服务器）。
      const recovered = createChatGptRequestAuthSource({
        store,
        env: envFor(server.url),
        now: () => simulatedNow,
        sleep: async () => undefined,
      });
      expect(await recovered.resolve(resolveInput())).toEqual({ apiKey: "refreshed-access-1" });
    } finally {
      await server.close();
    }
  });

  it("未登录 fail-closed（undefined、零网络）", async () => {
    const server = await createMockAuthServer({ signer: new RsaTestSigner() });
    const store = await createTempCredentialStore();
    try {
      const source = createChatGptRequestAuthSource({
        store,
        env: envFor(server.url),
        now: () => simulatedNow,
      });
      expect(await source.resolve(resolveInput())).toBeUndefined();
      expect(server.accessTokenRequests.length).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("refresh 网络往返期间被并发登录取代：CAS 丢弃本次轮换，返回新会话", async () => {
    const server = await createMockAuthServer({ signer: new RsaTestSigner() });
    const store = await createTempCredentialStore();
    try {
      await seedCredential(store);
      simulatedNow += 3_600_000 + 1_000;
      let loginTokens: ChatGptCredentialRecord | undefined;
      const wrappingFetch = (async (...args: Parameters<typeof globalThis.fetch>) => {
        // 模拟：refresh 请求在网络上飞行时，另一路径完成了重新登录（全新 generation）。
        loginTokens = toChatGptCredentialRecord({
          clientId: "oaiapp_test_client",
          tokenResponse: {
            access_token: "login-access",
            refresh_token: "login-refresh",
            id_token: "login-id-token",
            token_type: "Bearer",
            expires_in: 3600,
            scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
          },
          scopes: ["openid", "chatgpt.tokens.use.direct"],
          accountClaims: { subject: "user-subject-1" },
          now: () => simulatedNow,
        });
        await writeChatGptCredentialRecord(store, loginTokens);
        return globalThis.fetch(...args);
      }) as typeof globalThis.fetch;
      const source = createChatGptRequestAuthSource({
        store,
        env: envFor(server.url),
        fetchImpl: wrappingFetch,
        now: () => simulatedNow,
        sleep: async () => undefined,
      });
      const auth = await source.resolve(resolveInput());
      // 旧会话的轮换结果被丢弃；调用方拿到的是新登录会话的 token。
      expect(auth).toEqual({ apiKey: "login-access" });
      const record = await readChatGptCredentialRecord(store);
      expect(record!.accessToken).toBe("login-access");
      expect(record!.refreshToken).toBe("login-refresh");
      // mock 的 refresh 确实发生且响应被丢弃（存里没有 rotated-refresh）。
      expect(server.refreshRequestCount()).toBe(1);
      expect(serializeChatGptCredentialRecord(record!)).not.toContain("rotated-refresh-1");
    } finally {
      await server.close();
    }
  });

  it("不可用 refresh 的清空带 generation 守卫：并行进程刚轮换的新会话不被误删", async () => {
    const server = await createMockAuthServer({
      signer: new RsaTestSigner(),
      tokenResponseOverrides: () => ({ error: "refresh_token_reused" }),
    });
    const store = await createTempCredentialStore();
    try {
      await seedCredential(store);
      simulatedNow += 3_600_000 + 1_000;
      const wrappingFetch = (async (...args: Parameters<typeof globalThis.fetch>) => {
        // refresh 在网络上飞行时，另一进程完成轮换并写入新会话。
        const rotated = toChatGptCredentialRecord({
          clientId: "oaiapp_test_client",
          tokenResponse: {
            access_token: "winner-access",
            refresh_token: "winner-refresh",
            id_token: "winner-id-token",
            token_type: "Bearer",
            expires_in: 3600,
            scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
          },
          scopes: ["openid", "chatgpt.tokens.use.direct"],
          accountClaims: { subject: "user-subject-1" },
          now: () => simulatedNow,
        });
        await writeChatGptCredentialRecord(store, rotated);
        return globalThis.fetch(...args);
      }) as typeof globalThis.fetch;
      const source: ChatGptRequestAuthSource = createChatGptRequestAuthSource({
        store,
        env: envFor(server.url),
        fetchImpl: wrappingFetch,
        now: () => simulatedNow,
        sleep: async () => undefined,
      });
      await expect(source.resolve(resolveInput())).rejects.toMatchObject({
        code: "chatgpt_relogin_required",
      });
      // 输了竞态的一方收到错误，但 winner 的新会话必须完好。
      const record = await readChatGptCredentialRecord(store);
      expect(record!.refreshToken).toBe("winner-refresh");
      expect(record!.accessToken).toBe("winner-access");
    } finally {
      await server.close();
    }
  });
});
