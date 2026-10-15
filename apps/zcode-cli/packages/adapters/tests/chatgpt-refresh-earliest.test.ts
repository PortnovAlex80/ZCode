import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSharedZCodeCredentialStore } from "../src/auth/shared-credentials.js";
import { createChatGptRefreshCoordinator } from "../src/auth/chatgpt/chatgpt-refresh-coordinator.js";
import {
  readChatGptCredentialRecord,
  toChatGptCredentialRecord,
  writeChatGptCredentialRecord,
} from "../src/auth/chatgpt/chatgpt-credential-record.js";
import { createMockAuthServer, RsaTestSigner } from "./chatgpt-oauth-mock-server.js";

/**
 * earliest_refresh_at 合规（计划 §3 code review 备注 2）。
 *
 * 虚拟时钟：now 注入 simulatedNow；sleep 注入「推进虚拟时钟」的实现，等待不消耗
 * 真实时间。fetch 包装记录「发出请求时的虚拟时刻」，断言请求绝不早于 earliest。
 */
const tempDirs: string[] = [];
let simulatedNow = Date.now();

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  simulatedNow = Date.now();
});

async function createTempCredentialStore() {
  const dir = await mkdtemp(join(tmpdir(), "zcode-chatgpt-earliest-"));
  tempDirs.push(dir);
  return createSharedZCodeCredentialStore({ filePath: join(dir, "credentials.json") });
}

async function seedExpiredWithEarliest(
  store: ReturnType<typeof createSharedZCodeCredentialStore>,
  earliestRefreshAt: number | string,
): Promise<void> {
  const record = toChatGptCredentialRecord({
    clientId: "oaiapp_test_client",
    tokenResponse: {
      access_token: "initial-access-1",
      refresh_token: "initial-refresh-1",
      id_token: "seed-id-token",
      token_type: "Bearer",
      expires_in: 3600,
      scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
      earliest_refresh_at: earliestRefreshAt,
    },
    scopes: ["openid", "chatgpt.tokens.use.direct"],
    accountClaims: { subject: "user-subject-1" },
    now: () => simulatedNow,
  });
  await writeChatGptCredentialRecord(store, { ...record, expiresAt: simulatedNow - 1_000 });
}

function virtualSleep() {
  return async (ms: number) => {
    simulatedNow += ms;
  };
}

describe("earliest_refresh_at 合规", () => {
  it("token 仍有效且 earliest 在未来：先用完当前窗口，零网络请求", async () => {
    const server = await createMockAuthServer({ signer: new RsaTestSigner() });
    const store = await createTempCredentialStore();
    try {
      await seedExpiredWithEarliest(store, simulatedNow + 60_000);
      // 手动把记录改回「有效但临期」：expiresAt 在未来，earliest 也在未来。
      const record = (await readChatGptCredentialRecord(store))!;
      await writeChatGptCredentialRecord(store, {
        ...record,
        expiresAt: simulatedNow + 30_000,
      });
      const coordinator = createChatGptRefreshCoordinator({
        store,
        env: {
          ZCODE_CHATGPT_OAUTH_ISSUER: server.url,
          ZCODE_CHATGPT_API_BASE_URL: `${server.url}/v1`,
        },
        now: () => simulatedNow,
        sleep: virtualSleep(),
      });
      const outcome = await coordinator.refresh();
      expect(outcome.status).toBe("current");
      expect(outcome.record.accessToken).toBe("initial-access-1");
      expect(server.accessTokenRequests.length).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("token 已过期：请求只在 earliest_refresh_at 到点之后发出（虚拟时钟）", async () => {
    const server = await createMockAuthServer({ signer: new RsaTestSigner() });
    const store = await createTempCredentialStore();
    try {
      const earliest = simulatedNow + 5_000;
      await seedExpiredWithEarliest(store, earliest);
      const requestVirtualTimes: number[] = [];
      const wrappingFetch = (async (...args: Parameters<typeof globalThis.fetch>) => {
        requestVirtualTimes.push(simulatedNow);
        return globalThis.fetch(...args);
      }) as typeof globalThis.fetch;
      const coordinator = createChatGptRefreshCoordinator({
        store,
        env: {
          ZCODE_CHATGPT_OAUTH_ISSUER: server.url,
          ZCODE_CHATGPT_API_BASE_URL: `${server.url}/v1`,
        },
        fetchImpl: wrappingFetch,
        now: () => simulatedNow,
        sleep: virtualSleep(),
      });
      const outcome = await coordinator.refresh();
      expect(outcome.status).toBe("refreshed");
      expect(requestVirtualTimes.length).toBe(1);
      // 关键断言：发出时刻不早于 earliest_refresh_at（fork 在 60s 上限后照发，会违反）。
      expect(requestVirtualTimes[0]).toBeGreaterThanOrEqual(earliest);
      expect(outcome.record.accessToken).toBe("refreshed-access-1");
    } finally {
      await server.close();
    }
  });

  it("earliest_refresh_at 以 epoch 秒给出时正确换算为 ms", async () => {
    const server = await createMockAuthServer({ signer: new RsaTestSigner() });
    const store = await createTempCredentialStore();
    try {
      const seededAt = simulatedNow;
      // 秒级时间戳：floor(now/1000) + 5s。
      await seedExpiredWithEarliest(store, Math.floor(seededAt / 1000) + 5);
      const record = (await readChatGptCredentialRecord(store))!;
      const expectedEarliestMs = (Math.floor(seededAt / 1000) + 5) * 1000;
      expect(record.earliestRefreshAt).toBe(expectedEarliestMs);
      const requestVirtualTimes: number[] = [];
      const wrappingFetch = (async (...args: Parameters<typeof globalThis.fetch>) => {
        requestVirtualTimes.push(simulatedNow);
        return globalThis.fetch(...args);
      }) as typeof globalThis.fetch;
      const coordinator = createChatGptRefreshCoordinator({
        store,
        env: {
          ZCODE_CHATGPT_OAUTH_ISSUER: server.url,
          ZCODE_CHATGPT_API_BASE_URL: `${server.url}/v1`,
        },
        fetchImpl: wrappingFetch,
        now: () => simulatedNow,
        sleep: virtualSleep(),
      });
      const outcome = await coordinator.refresh();
      expect(outcome.status).toBe("refreshed");
      // 请求时刻不早于换算后的 earliest_refresh_at（epoch 秒 → ms）。
      expect(requestVirtualTimes[0]).toBeGreaterThanOrEqual(expectedEarliestMs);
    } finally {
      await server.close();
    }
  });

  it("等待超出预算仍未到点：类型化拒绝，绝不提前发请求", async () => {
    const server = await createMockAuthServer({ signer: new RsaTestSigner() });
    const store = await createTempCredentialStore();
    try {
      const earliest = simulatedNow + 10 * 60 * 1000;
      await seedExpiredWithEarliest(store, earliest);
      const coordinator = createChatGptRefreshCoordinator({
        store,
        env: {
          ZCODE_CHATGPT_OAUTH_ISSUER: server.url,
          ZCODE_CHATGPT_API_BASE_URL: `${server.url}/v1`,
        },
        now: () => simulatedNow,
        sleep: virtualSleep(),
        maxEarliestRefreshWaitMs: 1_000,
      });
      await expect(coordinator.refresh()).rejects.toMatchObject({
        code: "chatgpt_refresh_too_early",
      });
      expect(server.accessTokenRequests.length).toBe(0);
      // 凭据保留：等待失败不清空。
      expect(await readChatGptCredentialRecord(store)).not.toBeNull();
    } finally {
      await server.close();
    }
  });

  it("abort 在 earliest 等待期间即时生效", async () => {
    const server = await createMockAuthServer({ signer: new RsaTestSigner() });
    const store = await createTempCredentialStore();
    try {
      await seedExpiredWithEarliest(store, simulatedNow + 60_000);
      const controller = new AbortController();
      const coordinator = createChatGptRefreshCoordinator({
        store,
        env: {
          ZCODE_CHATGPT_OAUTH_ISSUER: server.url,
          ZCODE_CHATGPT_API_BASE_URL: `${server.url}/v1`,
        },
        now: () => simulatedNow,
        // 真实 sleep 但极短分片：等待期间触发 abort。
        sleep: async () => {
          controller.abort();
        },
      });
      await expect(coordinator.refresh({ abortSignal: controller.signal })).rejects.toThrow();
      expect(server.accessTokenRequests.length).toBe(0);
    } finally {
      await server.close();
    }
  });
});
