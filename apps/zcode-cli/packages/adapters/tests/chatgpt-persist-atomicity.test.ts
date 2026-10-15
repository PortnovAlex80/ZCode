import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSharedZCodeCredentialStore,
  type SharedZCodeCredentialStore,
} from "../src/auth/shared-credentials.js";
import { createChatGptRefreshCoordinator } from "../src/auth/chatgpt/chatgpt-refresh-coordinator.js";
import {
  readChatGptCredentialRecord,
  toChatGptCredentialRecord,
  writeChatGptCredentialRecord,
} from "../src/auth/chatgpt/chatgpt-credential-record.js";
import { createMockAuthServer, RsaTestSigner } from "./chatgpt-oauth-mock-server.js";

/**
 * 持久化原子性（计划 §3 code review 备注 1 的后半）：
 *
 * - refresh 轮换的落盘是**单键 CAS**（saveIfValue），不存在 delete+write 序列；
 *   kill 在「delete 与 write 之间」不可能丢凭据，因为这个窗口根本不存在。
 * - 任意阶段失败（网络 / 落盘抛错 / kill）后，存储里的记录要么是完整旧记录、
 *   要么是完整新记录，永远是可解析的单条 JSON。
 */

const tempDirs: string[] = [];
let simulatedNow = Date.now();

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  simulatedNow = Date.now();
});

async function createTempCredentialStore() {
  const dir = await mkdtemp(join(tmpdir(), "zcode-chatgpt-atomic-"));
  tempDirs.push(dir);
  return createSharedZCodeCredentialStore({ filePath: join(dir, "credentials.json") });
}

async function seedExpired(
  store: SharedZCodeCredentialStore,
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
    },
    scopes: ["openid", "chatgpt.tokens.use.direct"],
    accountClaims: { subject: "user-subject-1" },
    now: () => simulatedNow,
  });
  await writeChatGptCredentialRecord(store, { ...record, expiresAt: simulatedNow - 1_000 });
}

interface MutationLog {
  deletes: string[];
  saves: string[];
  saveIfValue: Array<{ key: string; expected: string | null }>;
}

/** 记录所有写路径的 store 包装：断言事务形态（单 CAS、零 delete）。 */
function wrapStore(store: SharedZCodeCredentialStore): { store: SharedZCodeCredentialStore; log: MutationLog } {
  const log: MutationLog = { deletes: [], saves: [], saveIfValue: [] };
  return {
    log,
    store: {
      ...store,
      delete: async (key: string) => {
        log.deletes.push(key);
        await store.delete(key);
      },
      deleteIfValue: async (key: string, expectedValue: string) => {
        log.deletes.push(`${key}?`);
        return store.deleteIfValue(key, expectedValue);
      },
      save: async (key: string, value: string) => {
        log.saves.push(key);
        await store.save(key, value);
      },
      saveIfValue: async (key: string, expectedValue: string | null, value: string) => {
        log.saveIfValue.push({ key, expected: expectedValue });
        return store.saveIfValue(key, expectedValue, value);
      },
    },
  };
}

function coordinatorFor(
  store: SharedZCodeCredentialStore,
  serverUrl: string,
  extra: Partial<Parameters<typeof createChatGptRefreshCoordinator>[0]> = {},
) {
  return createChatGptRefreshCoordinator({
    store,
    env: {
      ZCODE_CHATGPT_OAUTH_ISSUER: serverUrl,
      ZCODE_CHATGPT_API_BASE_URL: `${serverUrl}/v1`,
    },
    now: () => simulatedNow,
    sleep: async () => undefined,
    ...extra,
  });
}

describe("refresh 持久化原子性", () => {
  it("成功轮换 = 恰一次单键 CAS 写，零 delete（不存在 delete+write 窗口）", async () => {
    const server = await createMockAuthServer({ signer: new RsaTestSigner() });
    const store = await createTempCredentialStore();
    try {
      await seedExpired(store);
      const wrapped = wrapStore(store);
      const outcome = await coordinatorFor(wrapped.store, server.url).refresh();
      expect(outcome.status).toBe("refreshed");
      // 唯一的写路径：对 oauth:chatgpt:credentials 的一次 saveIfValue。
      expect(wrapped.log.saveIfValue.length).toBe(1);
      expect(wrapped.log.saveIfValue[0]!.key).toBe("oauth:chatgpt:credentials");
      expect(wrapped.log.saveIfValue[0]!.expected).not.toBeNull();
      expect(wrapped.log.deletes).toEqual([]);
      expect(wrapped.log.saves).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("落盘前崩溃（saveIfValue 抛错 / kill 模拟）：记录仍是完整的旧值", async () => {
    const server = await createMockAuthServer({ signer: new RsaTestSigner() });
    const store = await createTempCredentialStore();
    try {
      await seedExpired(store);
      const before = (await readChatGptCredentialRecord(store))!;
      const exploding: SharedZCodeCredentialStore = {
        ...store,
        saveIfValue: async () => {
          // 模拟进程在持久化点被 kill（写入未发生）。
          throw new Error("simulated kill during persist");
        },
      };
      await expect(coordinatorFor(exploding, server.url).refresh()).rejects.toThrow(
        "simulated kill during persist",
      );
      // 凭据没有丢：完整旧记录仍然可读（refresh token 未被删）。
      const after = await readChatGptCredentialRecord(store);
      expect(after).not.toBeNull();
      expect(after!.refreshToken).toBe(before.refreshToken);
      expect(after!.accessToken).toBe(before.accessToken);
      // 文件仍是合法 JSON（单条完整记录，无半写）。
      const raw = await readFile(store.filePath, "utf8");
      expect(() => JSON.parse(raw)).not.toThrow();
    } finally {
      await server.close();
    }
  });

  it("落盘已完成但调用方在返回前崩溃（写后抛错）：记录是完整的新值", async () => {
    const server = await createMockAuthServer({ signer: new RsaTestSigner() });
    const store = await createTempCredentialStore();
    try {
      await seedExpired(store);
      const storeWithPostWriteCrash: SharedZCodeCredentialStore = {
        ...store,
        saveIfValue: async (key: string, expectedValue: string | null, value: string) => {
          await store.saveIfValue(key, expectedValue, value);
          // 写入已原子完成；随后进程崩溃（调用方收不到结果）。
          throw new Error("simulated kill after persist");
        },
      };
      await expect(coordinatorFor(storeWithPostWriteCrash, server.url).refresh()).rejects.toThrow(
        "simulated kill after persist",
      );
      // 结果二选一且完整：这里必须是新记录（原子 rename 已完成）。
      const after = await readChatGptCredentialRecord(store);
      expect(after).not.toBeNull();
      expect(after!.refreshToken).toBe("rotated-refresh-1");
      expect(after!.accessToken).toBe("refreshed-access-1");
      // 下一次刷新使用新 refresh token，旧 token 不再被使用。
      const second = await coordinatorFor(store, server.url, {
        now: () => simulatedNow + 3_600_000,
      }).refresh();
      expect(second.status).toBe("refreshed");
      expect(server.accessTokenRequests[1]!.refreshToken).toBe("rotated-refresh-1");
    } finally {
      await server.close();
    }
  });

  it("刷新前崩溃（网络中断）：记录保持旧值，恢复后用同一 token 重试成功", async () => {
    const server = await createMockAuthServer({ signer: new RsaTestSigner() });
    const store = await createTempCredentialStore();
    try {
      await seedExpired(store);
      const before = (await readChatGptCredentialRecord(store))!;
      const failingFetch = (async () => {
        throw new Error("simulated crash before request");
      }) as typeof globalThis.fetch;
      await expect(
        coordinatorFor(store, server.url, { fetchImpl: failingFetch }).refresh(),
      ).rejects.toMatchObject({ code: "chatgpt_token_network_error" });
      const after = await readChatGptCredentialRecord(store);
      expect(after!.refreshToken).toBe(before.refreshToken);
      // 恢复后：同一个旧 refresh token 完成一次性刷新。
      const outcome = await coordinatorFor(store, server.url).refresh();
      expect(outcome.status).toBe("refreshed");
      expect(server.refreshRequestCount()).toBe(1);
      expect(server.accessTokenRequests[0]!.refreshToken).toBe("initial-refresh-1");
    } finally {
      await server.close();
    }
  });
});
