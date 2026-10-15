import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSharedZCodeCredentialStore } from "../src/auth/shared-credentials.js";
import { runChatGptLogin, runChatGptLogout } from "../src/auth/chatgpt/chatgpt-login-flow.js";
import {
  readChatGptCachedModels,
  readChatGptClientId,
  readChatGptCredentialRecord,
  resolveChatGptHostId,
} from "../src/auth/chatgpt/chatgpt-credential-record.js";
import { createChatGptRequestAuthSource } from "../src/auth/chatgpt/chatgpt-request-auth.js";
import { createMockAuthServer, RsaTestSigner } from "./chatgpt-oauth-mock-server.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createTempCredentialStore() {
  const dir = await mkdtemp(join(tmpdir(), "zcode-chatgpt-login-"));
  tempDirs.push(dir);
  return createSharedZCodeCredentialStore({ filePath: join(dir, "credentials.json") });
}

/** 模拟浏览器：请求 authorize URL 并跟随 302 到 loopback 回调（回调页只展示，不抛错）。 */
async function simulateBrowser(authorizeUrl: string): Promise<void> {
  const response = await fetch(authorizeUrl, { redirect: "manual" });
  const location = response.headers.get("location");
  if (!location) throw new Error("mock authorize did not redirect");
  const callback = await fetch(location, { redirect: "manual" });
  await callback.arrayBuffer().catch(() => undefined);
}

function browserDriver() {
  return async (url: string) => {
    await simulateBrowser(url);
    return { command: "test", opened: true };
  };
}

describe("runChatGptLogin (官方 SIWC 流程 against mock 授权服务器)", () => {
  it("动态注册 → PKCE 交换 → id_token 校验 → 模型缓存；二次登录复用 client_id", async () => {
    const signer = new RsaTestSigner();
    const server = await createMockAuthServer({ signer });
    const store = await createTempCredentialStore();
    const env = {
      ZCODE_CHATGPT_OAUTH_ISSUER: server.url,
      ZCODE_CHATGPT_API_BASE_URL: `${server.url}/v1`,
    };
    try {
      const authorizeUrls: string[] = [];
      const result = await runChatGptLogin({
        store,
        env,
        openBrowser: browserDriver(),
        onAuthorizeUrl: (url) => authorizeUrls.push(url),
        timeoutMs: 10_000,
      });

      expect(result.account.email).toBe("user@example.com");
      expect(result.account.subject).toBe("user-subject-1");
      expect(result.clientId).toBe("oaiapp_test_client");
      expect(result.firstRegistration).toBe(true);
      expect(result.tokenSharingGranted).toBe(true);
      expect(result.models.map((model) => model.slug)).toEqual(["gpt-6.1-sol", "gpt-6.1-sol-fast"]);

      // 首次注册请求必须携带 dynamic_agent_client + agent_name_hint（真实应用名）+ host 标识。
      const authorizeQuery = server.authorizeRequests[0]!.searchParams;
      expect(authorizeQuery.get("client_id")).toBe("dynamic_agent_client");
      expect(authorizeQuery.get("agent_name_hint")).toBe("ZCode Harness");
      expect(authorizeQuery.get("ext_agent_host_id")).toMatch(/^urn:uuid:/u);
      expect(authorizeQuery.get("code_challenge_method")).toBe("S256");
      expect(authorizeQuery.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/u);
      // 每次登录新生成 state / nonce / PKCE。
      expect(authorizeQuery.get("state")).toHaveLength(43);
      expect(authorizeQuery.get("nonce")).toHaveLength(43);
      const exchange = server.accessTokenRequests[0]!;
      expect(exchange.grantType).toBe("authorization_code");
      expect(exchange.clientId).toBe("oaiapp_test_client");
      expect(exchange.codeVerifier).toMatch(/^[A-Za-z0-9\-._~]{43,}$/u);

      // 凭据已加密落盘且完整；generation 存在。
      const record = await readChatGptCredentialRecord(store);
      expect(record).not.toBeNull();
      expect(record!.accessToken).toBe("initial-access-1");
      expect(record!.refreshToken).toBe("initial-refresh-1");
      expect(record!.clientId).toBe("oaiapp_test_client");
      expect(record!.generation).toMatch(/^[0-9a-f]{32}$/u);
      expect(record!.account.scopes).toContain("chatgpt.tokens.use.direct");
      expect(record!.earliestRefreshAt).toBeGreaterThan(Date.now() - 1_000);
      expect(record!.expiresAt).toBeGreaterThan(Date.now());

      const cached = await readChatGptCachedModels(store);
      expect(cached?.map((model) => model.slug)).toContain("gpt-6.1-sol");

      // 文件内容不包含明文 token（AES-256-GCM）。
      const raw = await readFile(store.filePath, "utf8");
      expect(raw).not.toContain("initial-access-1");
      expect(raw).not.toContain("initial-refresh-1");

      // 二次登录：复用已签发 client_id，不再携带 agent_name_hint；host id 不重建。
      const hostIdBefore = await resolveChatGptHostId(store);
      await runChatGptLogin({ store, env, openBrowser: browserDriver(), timeoutMs: 10_000 });
      const secondAuthorize = server.authorizeRequests.at(-1)!.searchParams;
      expect(secondAuthorize.get("client_id")).toBe("oaiapp_test_client");
      expect(secondAuthorize.get("agent_name_hint")).toBeNull();
      // login_hint / id_token_hint 来自已保存账号。
      expect(secondAuthorize.get("login_hint")).toBe("user@example.com");
      expect(secondAuthorize.get("id_token_hint")).toBeTruthy();
      expect(await resolveChatGptHostId(store)).toBe(hostIdBefore);
    } finally {
      await server.close();
    }
  });

  it("用户拒绝授权（error=access_denied）：类型化错误，绝不交换 code", async () => {
    const signer = new RsaTestSigner();
    const server = await createMockAuthServer({ signer, authorizeError: "access_denied" });
    const store = await createTempCredentialStore();
    try {
      const error = await runChatGptLogin({
        store,
        env: {
          ZCODE_CHATGPT_OAUTH_ISSUER: server.url,
          ZCODE_CHATGPT_API_BASE_URL: `${server.url}/v1`,
        },
        openBrowser: browserDriver(),
        timeoutMs: 10_000,
      }).catch((caught: unknown) => caught as Error);
      // 官方 errors-and-recovery：拒绝时校验 state 后不得继续 token 交换。
      expect(error).toMatchObject({
        code: "chatgpt_consent_denied",
        oauthError: "access_denied",
      });
      expect(server.accessTokenRequests.length).toBe(0);
      expect(await readChatGptCredentialRecord(store)).toBeNull();
    } finally {
      await server.close();
    }
  });

  it("scope 未含 chatgpt.tokens.use.direct：保留登录（官方要求），推理 fail-closed", async () => {
    const signer = new RsaTestSigner();
    const server = await createMockAuthServer({
      signer,
      tokenResponseOverrides: () => ({ scope: "openid profile email offline_access" }),
    });
    const store = await createTempCredentialStore();
    const env = {
      ZCODE_CHATGPT_OAUTH_ISSUER: server.url,
      ZCODE_CHATGPT_API_BASE_URL: `${server.url}/v1`,
    };
    try {
      const result = await runChatGptLogin({
        store,
        env,
        openBrowser: browserDriver(),
        timeoutMs: 10_000,
      });
      // 官方 errors-and-recovery：id_token 有效但缺权限 → 保留登录、标记计划用量禁用。
      expect(result.tokenSharingGranted).toBe(false);
      expect(result.grantedScopes).not.toContain("chatgpt.tokens.use.direct");
      const record = await readChatGptCredentialRecord(store);
      expect(record).not.toBeNull();

      // 请求级鉴权 fail-closed：身份在，token 不交付。
      const source = createChatGptRequestAuthSource({ store, env });
      await expect(
        source.resolve({ attempt: 1, providerId: "account:chatgpt", modelId: "gpt-6.1-sol" }),
      ).rejects.toMatchObject({ code: "chatgpt_token_sharing_scope_missing" });
    } finally {
      await server.close();
    }
  });

  it("回调返回与已保存不同的 client_id 被拒绝", async () => {
    const signer = new RsaTestSigner();
    const firstServer = await createMockAuthServer({ signer });
    const secondServer = await createMockAuthServer({ signer, issuedClientId: "oaiapp_other" });
    const store = await createTempCredentialStore();
    try {
      await runChatGptLogin({
        store,
        env: {
          ZCODE_CHATGPT_OAUTH_ISSUER: firstServer.url,
          ZCODE_CHATGPT_API_BASE_URL: `${firstServer.url}/v1`,
        },
        openBrowser: browserDriver(),
        timeoutMs: 10_000,
      });
      const error = await runChatGptLogin({
        store,
        env: {
          ZCODE_CHATGPT_OAUTH_ISSUER: secondServer.url,
          ZCODE_CHATGPT_API_BASE_URL: `${secondServer.url}/v1`,
        },
        openBrowser: browserDriver(),
        timeoutMs: 10_000,
      }).catch((caught: unknown) => caught as Error);
      expect(error).toMatchObject({ code: "chatgpt_client_mismatch" });
    } finally {
      await secondServer.close();
      await firstServer.close();
    }
  });

  it("登出：撤销会话并清空本机令牌，client/host 标识保留供重登录", async () => {
    const signer = new RsaTestSigner();
    const server = await createMockAuthServer({ signer });
    const store = await createTempCredentialStore();
    const env = {
      ZCODE_CHATGPT_OAUTH_ISSUER: server.url,
      ZCODE_CHATGPT_API_BASE_URL: `${server.url}/v1`,
    };
    try {
      await runChatGptLogin({ store, env, openBrowser: browserDriver(), timeoutMs: 10_000 });
      const logout = await runChatGptLogout({ store, env });
      expect(logout.revoked).toBe(true);
      expect(server.revocationRequests.length).toBe(1);
      expect(server.revocationRequests[0]).toMatchObject({ token: "initial-refresh-1" });
      expect(await readChatGptCredentialRecord(store)).toBeNull();
      expect(await readChatGptCachedModels(store)).toBeNull();
      // 官方：重登录复用已保存 client_id。
      expect(await readChatGptClientId(store)).toBe("oaiapp_test_client");
      expect(await resolveChatGptHostId(store)).toMatch(/^urn:uuid:/u);
    } finally {
      await server.close();
    }
  });
});
