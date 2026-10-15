import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createSharedZCodeCredentialStore } from "../src/auth/shared-credentials.js";
import {
  readChatGptCredentialRecord,
  writeChatGptCachedModels,
  writeChatGptCredentialRecord,
  toChatGptCredentialRecord,
} from "../src/auth/chatgpt/chatgpt-credential-record.js";
import { createMockAuthServer, RsaTestSigner } from "./chatgpt-oauth-mock-server.js";

/**
 * 跨进程端到端验证（ChatGPT refresh）：
 *
 * 线上竞态发生在多个真实 CLI/Host 进程之间；同进程协程测试无法复现「两个进程同时
 * 读到过期 token、同时抢 refresh」的现场形态（OS 文件锁、PID 死亡回收都未参与）。
 * 本文件用 tsx 拉起真实 OS 子进程驱动 adapters 源码，主进程只托管 mock 授权服务器
 * （单次使用 refresh token：复用即 invalid_grant）并做协议级断言。
 *
 * 结构沿用 tests/mcp-oauth-cross-process.e2e.test.ts 的模式。
 */

const CHILD_TIMEOUT_MS = 60_000;
const SECRET = "chatgpt-cross-process-test-secret";

const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const CHILD_DRIVER = fileURLToPath(
  new URL("./fixtures/chatgpt-refresh-child-driver.ts", import.meta.url),
);

const temporaryDirectories: string[] = [];
const spawnedChildren: ChildProcess[] = [];

afterEach(async () => {
  for (const child of spawnedChildren.splice(0)) {
    if (child.pid !== undefined) {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        // 已退出
      }
    }
  }
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function createCredentialsPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "zcode-chatgpt-xproc-"));
  temporaryDirectories.push(directory);
  return join(directory, "credentials.json");
}

/** 用与子进程相同的加密密钥播种一个已过期的会话。 */
async function seedExpiredSession(credentialsPath: string): Promise<void> {
  const store = createSharedZCodeCredentialStore({
    env: { ZCODE_CREDENTIAL_SECRET: SECRET },
    filePath: credentialsPath,
  });
  const now = Date.now();
  const record = toChatGptCredentialRecord({
    clientId: "oaiapp_test_client",
    tokenResponse: {
      access_token: "seed-access",
      refresh_token: "seed-refresh",
      id_token: "seed-id-token",
      token_type: "Bearer",
      expires_in: 3600,
      scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
    },
    scopes: ["openid", "profile", "email", "offline_access", "resource.invoke", "chatgpt.tokens.use.direct"],
    accountClaims: { subject: "user-subject-1", email: "user@example.com" },
    now: () => now,
  });
  await writeChatGptCredentialRecord(store, { ...record, expiresAt: now - 1_000 });
  await writeChatGptCachedModels(store, []);
}

interface ChildResult {
  jsonLines: Array<Record<string, unknown>>;
  code: number | null;
}

function runChild(config: Record<string, unknown>): Promise<ChildResult> {
  // 用 `node --import tsx` 让驱动直接运行在本进程：tsx CLI 包装器会把自己的真正工作
  // 放进子进程，SIGKILL 包装器只会留下孤儿——孤儿持有锁且 PID 存活，owner-dead 回收
  // 就无法验证。--import 在进程内注册 loader，child.pid 即驱动进程本身。
  const child = spawn(process.execPath, ["--import", "tsx", CHILD_DRIVER, JSON.stringify(config)], {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  spawnedChildren.push(child);
  let stdout = "";
  let stderr = "";
  return new Promise<ChildResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`child timed out after ${CHILD_TIMEOUT_MS}ms; stderr: ${stderr}`));
    }, CHILD_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      const jsonLines = stdout
        .trim()
        .split("\n")
        .filter((line) => line.startsWith("{"))
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      if (code !== 0) {
        reject(new Error(`child exited with ${code}; stderr: ${stderr}`));
        return;
      }
      resolve({ jsonLines, code });
    });
  });
}

/** 等待 leader 子进程报告进入刷新临界区（stdout 阶段行）。 */
function spawnHangingChild(config: Record<string, unknown>): {
  child: ChildProcess;
  enteredCriticalSection: Promise<void>;
} {
  const child = spawn(process.execPath, ["--import", "tsx", CHILD_DRIVER, JSON.stringify(config)], {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  spawnedChildren.push(child);
  let stdout = "";
  let stderr = "";
  let resolveEntered: () => void = () => undefined;
  const enteredCriticalSection = new Promise<void>((resolve, reject) => {
    resolveEntered = resolve;
    const timer = setTimeout(() => {
      reject(new Error(`hanging child did not reach the critical section; stderr: ${stderr}`));
    }, CHILD_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.includes("in-refresh-critical-section")) {
        clearTimeout(timer);
        resolveEntered();
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  return { child, enteredCriticalSection };
}

describe("ChatGPT refresh cross-process end-to-end", () => {
  it("两个真实进程并发刷新同一过期 token：旧 token 只被发送一次，双方拿到同一新 token", async () => {
    const server = await createMockAuthServer({ signer: new RsaTestSigner() });
    const credentialsPath = await createCredentialsPath();
    await seedExpiredSession(credentialsPath);
    try {
      const config = {
        credentialsPath,
        issuer: server.url,
        mode: "refresh",
        secret: SECRET,
      };
      const [first, second] = await Promise.all([runChild(config), runChild(config)]);

      const firstToken = first.jsonLines.at(-1)?.token;
      const secondToken = second.jsonLines.at(-1)?.token;
      // 双方都拿到轮换后的 access token，且完全一致。
      expect(firstToken).toBe("refreshed-access-1");
      expect(secondToken).toBe("refreshed-access-1");

      // 关键断言（计划 §3 备注 1）：旧 refresh token 在网络层只出现一次；
      // mock 的单次使用语义保证任何竞态都会以 invalid_grant 暴露。
      expect(server.refreshRequestCount()).toBe(1);
      expect(server.accessTokenRequests[0]!.refreshToken).toBe("seed-refresh");
      expect(server.accessTokenRequests[0]!.clientId).toBe("oaiapp_test_client");

      // 存储收敛到轮换后的会话。
      const store = createSharedZCodeCredentialStore({
        env: { ZCODE_CREDENTIAL_SECRET: SECRET },
        filePath: credentialsPath,
      });
      const record = await readChatGptCredentialRecord(store);
      expect(record!.refreshToken).toBe("rotated-refresh-1");
      expect(record!.accessToken).toBe("refreshed-access-1");
    } finally {
      await server.close();
    }
  });

  it("leader 在临界区内被 kill：凭据不丢，follower 回收锁后用同一 token 完成刷新", async () => {
    const server = await createMockAuthServer({ signer: new RsaTestSigner() });
    const credentialsPath = await createCredentialsPath();
    await seedExpiredSession(credentialsPath);
    try {
      const hangingConfig = {
        credentialsPath,
        issuer: server.url,
        mode: "hang-before-request",
        secret: SECRET,
      };
      const { child, enteredCriticalSection } = spawnHangingChild(hangingConfig);
      await enteredCriticalSection;
      // leader 已持有 refresh 文件锁、尚未发请求；模拟进程崩溃。
      const leaderPid = child.pid;
      child.kill("SIGKILL");
      if (leaderPid !== undefined) {
        await new Promise<void>((resolve) => {
          const check = (): void => {
            try {
              process.kill(leaderPid, 0);
              setTimeout(check, 25);
            } catch {
              resolve();
            }
          };
          check();
        });
      }

      // follower 进程：必须先回收 owner-dead 锁，再用未被消耗的 seed token 刷新。
      const follower = await runChild({
        credentialsPath,
        issuer: server.url,
        mode: "refresh",
        secret: SECRET,
      });
      expect(follower.jsonLines.at(-1)?.token).toBe("refreshed-access-1");
      expect(server.refreshRequestCount()).toBe(1);
      expect(server.accessTokenRequests[0]!.refreshToken).toBe("seed-refresh");

      // 凭据完整且已轮换——kill 发生在任何持久化之前，没有中间丢失窗口。
      const store = createSharedZCodeCredentialStore({
        env: { ZCODE_CREDENTIAL_SECRET: SECRET },
        filePath: credentialsPath,
      });
      const record = await readChatGptCredentialRecord(store);
      expect(record).not.toBeNull();
      expect(record!.refreshToken).toBe("rotated-refresh-1");
    } finally {
      await server.close();
    }
  });

  it("三个真实进程并发：仍然只有一次网络 refresh（多 follower 全部复用 winner 结果）", async () => {
    const server = await createMockAuthServer({ signer: new RsaTestSigner() });
    const credentialsPath = await createCredentialsPath();
    await seedExpiredSession(credentialsPath);
    try {
      const config = {
        credentialsPath,
        issuer: server.url,
        mode: "refresh",
        secret: SECRET,
      };
      const results = await Promise.all([runChild(config), runChild(config), runChild(config)]);
      const tokens = results.map((result) => result.jsonLines.at(-1)?.token);
      expect(new Set(tokens).size).toBe(1);
      expect(tokens[0]).toBe("refreshed-access-1");
      expect(server.refreshRequestCount()).toBe(1);
    } finally {
      await server.close();
    }
  });
});
