import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSharedZCodeCredentialStore } from "../src/auth/shared-credentials.js";
import {
  CHATGPT_OAUTH_SCOPE_STRING,
  CHATGPT_CREDENTIAL_KEYS,
} from "../src/auth/chatgpt/chatgpt-oauth-protocol.js";
import {
  buildChatGptAuthorizeUrl,
  exchangeChatGptAuthorizationCode,
  fetchChatGptModelList,
  hasChatGptTokenSharingScope,
  parseChatGptCallbackUrl,
  parseEarliestRefreshAt,
  parseGrantedScopes,
  refreshChatGptAccessToken,
  resolveChatGptOAuthEndpoints,
  revokeChatGptSession,
} from "../src/auth/chatgpt/chatgpt-oauth-client.js";
import {
  createMockAuthServer,
  RsaTestSigner,
} from "./chatgpt-oauth-mock-server.js";

describe("ChatGPT model catalog deadline", () => {
  afterEach(() => vi.useRealTimers());
  it.each(["headers", "body"])(
    "aborts stalled %s and rejects even if fetch ignores cancellation",
    async (stage) => {
      vi.useFakeTimers();
      let signal: AbortSignal | null | undefined;
      const never = new Promise<never>(() => {});
      const request = fetchChatGptModelList(
        "https://api.openai.com/v1/models",
        "test-token",
        async (_url, init) => {
          signal = init?.signal;
          if (stage === "headers") return never;
          return { ok: true, json: () => never } as unknown as Response;
        },
      );
      const assertion = expect(request).rejects.toMatchObject({
        code: "chatgpt_models_timeout",
      });
      await vi.advanceTimersByTimeAsync(15_000);
      await assertion;
      expect(signal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("buildChatGptAuthorizeUrl (官方 sign-in 参数)", () => {
  const base = {
    redirectUri: "http://127.0.0.1:1455/auth/callback",
    state: "state-1",
    nonce: "nonce-1",
    codeChallenge: "challenge-1",
    extAgentHostId: "urn:uuid:00000000-0000-4000-8000-000000000000",
  };

  it("首次动态注册携带 dynamic_agent_client 与 agent_name_hint", () => {
    const url = new URL(
      buildChatGptAuthorizeUrl(
        "https://auth.openai.com/api/accounts/authorize",
        base,
      ),
    );
    expect(url.searchParams.get("client_id")).toBe("dynamic_agent_client");
    expect(url.searchParams.get("agent_name_hint")).toBe("ZCode Harness");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toBe(CHATGPT_OAUTH_SCOPE_STRING);
    expect(url.searchParams.get("resource")).toBe("https://api.openai.com/v1");
    expect(url.searchParams.get("ext_agent_host_id")).toBe(base.extAgentHostId);
  });

  it("重登录复用签发 client_id 且不再携带 agent_name_hint", () => {
    const url = new URL(
      buildChatGptAuthorizeUrl(
        "https://auth.openai.com/api/accounts/authorize",
        {
          ...base,
          clientId: "oaiapp_issued",
        },
      ),
    );
    expect(url.searchParams.get("client_id")).toBe("oaiapp_issued");
    expect(url.searchParams.get("agent_name_hint")).toBeNull();
    // login_hint / id_token_hint 按存在与否携带。
    const withHints = new URL(
      buildChatGptAuthorizeUrl(
        "https://auth.openai.com/api/accounts/authorize",
        {
          ...base,
          clientId: "oaiapp_issued",
          loginHint: "user@example.com",
          idTokenHint: "id-token-value",
        },
      ),
    );
    expect(withHints.searchParams.get("login_hint")).toBe("user@example.com");
    expect(withHints.searchParams.get("id_token_hint")).toBe("id-token-value");
  });

  it("env 覆盖 issuer 与 api base（测试 / 自托管）", () => {
    const endpoints = resolveChatGptOAuthEndpoints({
      ZCODE_CHATGPT_OAUTH_ISSUER: "http://127.0.0.1:1",
      ZCODE_CHATGPT_API_BASE_URL: "http://127.0.0.1:1/v1/",
    });
    expect(endpoints.authorizeUrl).toBe(
      "http://127.0.0.1:1/api/accounts/authorize",
    );
    expect(endpoints.tokenUrl).toBe(
      "http://127.0.0.1:1/api/accounts/oauth/token",
    );
    expect(endpoints.apiBaseUrl).toBe("http://127.0.0.1:1/v1");
  });
});

describe("parseChatGptCallbackUrl", () => {
  it("提取 code/state/client_id/error", () => {
    const query = parseChatGptCallbackUrl(
      "http://127.0.0.1:1234/auth/callback?code=c&state=s&client_id=oaiapp_x",
    );
    expect(query).toMatchObject({
      code: "c",
      state: "s",
      clientId: "oaiapp_x",
    });
    const denied = parseChatGptCallbackUrl(
      "http://127.0.0.1:1234/auth/callback?error=access_denied&error_description=nope&state=s",
    );
    expect(denied).toMatchObject({
      oauthError: "access_denied",
      oauthErrorDescription: "nope",
      state: "s",
    });
  });
});

describe("token endpoint 请求形态（真实 mock 服务器）", () => {
  it("authorization_code 交换 form 包含 code_verifier 与 resource", async () => {
    const signer = new RsaTestSigner();
    const server = await createMockAuthServer({ signer });
    try {
      await exchangeChatGptAuthorizationCode(
        `${server.url}/api/accounts/oauth/token`,
        {
          clientId: "oaiapp_test_client",
          code: "mock-code-1",
          codeVerifier: "verifier".repeat(6),
          redirectUri: "http://127.0.0.1:1455/auth/callback",
        },
        globalThis.fetch,
      );
      expect(server.accessTokenRequests[0]!.grantType).toBe(
        "authorization_code",
      );
      expect(server.accessTokenRequests[0]!.codeVerifier).toBe(
        "verifier".repeat(6),
      );
    } finally {
      await server.close();
    }
  });

  it("refresh 不带 scope（官方：omit scope to retain the grant）", async () => {
    const signer = new RsaTestSigner();
    const server = await createMockAuthServer({ signer });
    try {
      await refreshChatGptAccessToken(
        `${server.url}/api/accounts/oauth/token`,
        { clientId: "oaiapp_test_client", refreshToken: "r1" },
        globalThis.fetch,
      );
      expect(server.accessTokenRequests[0]!.grantType).toBe("refresh_token");
    } finally {
      await server.close();
    }
  });

  it("单次使用 refresh token：复用返回 invalid_grant（rotation reuse-detection）", async () => {
    const signer = new RsaTestSigner();
    const server = await createMockAuthServer({ signer });
    try {
      await refreshChatGptAccessToken(
        `${server.url}/api/accounts/oauth/token`,
        { clientId: "oaiapp_test_client", refreshToken: "r1" },
        globalThis.fetch,
      );
      await expect(
        refreshChatGptAccessToken(
          `${server.url}/api/accounts/oauth/token`,
          { clientId: "oaiapp_test_client", refreshToken: "r1" },
          globalThis.fetch,
        ),
      ).rejects.toMatchObject({
        code: "chatgpt_token_request_failed",
        oauthError: "invalid_grant",
      });
    } finally {
      await server.close();
    }
  });
});

describe("revokeChatGptSession (OpenID discovery)", () => {
  it("从 openid-configuration 解析 revocation_endpoint 并 POST token", async () => {
    const signer = new RsaTestSigner();
    const server = await createMockAuthServer({ signer });
    try {
      await revokeChatGptSession(
        `${server.url}/.well-known/openid-configuration`,
        {
          clientId: "oaiapp_test_client",
          refreshToken: "r1",
        },
        globalThis.fetch,
      );
      expect(server.revocationRequests.length).toBe(1);
      expect(server.revocationRequests[0]).toMatchObject({
        token: "r1",
        token_type_hint: "refresh_token",
        client_id: "oaiapp_test_client",
      });
    } finally {
      await server.close();
    }
  });
});

describe("fetchChatGptModelList", () => {
  it("只保留 visibility=list 且 supported_in_api 的模型，保持服务器顺序", async () => {
    const signer = new RsaTestSigner();
    const server = await createMockAuthServer({ signer });
    try {
      const result = await fetchChatGptModelList(
        `${server.url}/v1/models`,
        "token",
        globalThis.fetch,
      );
      expect(result.models.map((model) => model.slug)).toEqual([
        "gpt-6.1-sol",
        "gpt-6.1-sol-fast",
      ]);
    } finally {
      await server.close();
    }
  });
});

describe("scope 门禁与 earliest_refresh_at 解析", () => {
  it("parseGrantedScopes / hasChatGptTokenSharingScope", () => {
    expect(
      parseGrantedScopes({
        access_token: "x",
        scope: "openid profile chatgpt.tokens.use.direct",
      }),
    ).toEqual(["openid", "profile", "chatgpt.tokens.use.direct"]);
    expect(hasChatGptTokenSharingScope(["openid"])).toBe(false);
    expect(hasChatGptTokenSharingScope(["chatgpt.tokens.use.direct"])).toBe(
      true,
    );
    expect(parseGrantedScopes({ access_token: "x" })).toEqual([]);
  });

  it("parseEarliestRefreshAt 兼容 epoch 秒 / epoch ms / RFC 3339 / 非法值", () => {
    expect(parseEarliestRefreshAt(1_700_000_000)).toBe(1_700_000_000_000);
    expect(parseEarliestRefreshAt(1_700_000_000_000)).toBe(1_700_000_000_000);
    expect(parseEarliestRefreshAt("2026-10-15T00:00:00.000Z")).toBe(
      Date.parse("2026-10-15T00:00:00.000Z"),
    );
    expect(parseEarliestRefreshAt("1700000000")).toBe(1_700_000_000_000);
    expect(parseEarliestRefreshAt(undefined)).toBeUndefined();
    expect(parseEarliestRefreshAt("not-a-time")).toBeUndefined();
    expect(parseEarliestRefreshAt(Number.NaN)).toBeUndefined();
    expect(parseEarliestRefreshAt(-5)).toBeUndefined();
  });
});

describe("SharedZCodeCredentialStore.saveIfValue（refresh CAS 原语）", () => {
  it("仅在当前值等于期望时写入；期望 null 表示 key 不存在", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-chatgpt-cas-"));
    tempDirs.push(dir);
    const store = createSharedZCodeCredentialStore({
      filePath: join(dir, "credentials.json"),
    });

    expect(
      await store.saveIfValue(
        CHATGPT_CREDENTIAL_KEYS.credentials,
        null,
        "first",
      ),
    ).toBe(true);
    expect(await store.load(CHATGPT_CREDENTIAL_KEYS.credentials)).toBe("first");

    // 旧 generation 持有者写入被拒绝；新 generation 持有者成功。
    expect(
      await store.saveIfValue(
        CHATGPT_CREDENTIAL_KEYS.credentials,
        null,
        "second",
      ),
    ).toBe(false);
    expect(
      await store.saveIfValue(
        CHATGPT_CREDENTIAL_KEYS.credentials,
        "stale",
        "second",
      ),
    ).toBe(false);
    expect(await store.load(CHATGPT_CREDENTIAL_KEYS.credentials)).toBe("first");
    expect(
      await store.saveIfValue(
        CHATGPT_CREDENTIAL_KEYS.credentials,
        "first",
        "second",
      ),
    ).toBe(true);
    expect(await store.load(CHATGPT_CREDENTIAL_KEYS.credentials)).toBe(
      "second",
    );
  });

  it("与 deleteIfValue 组成同一把锁下的 generation 守卫（交错写入不误删）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-chatgpt-cas-"));
    tempDirs.push(dir);
    const store = createSharedZCodeCredentialStore({
      filePath: join(dir, "credentials.json"),
    });
    // 另一进程已轮换为 generation-b：按 a 的陈旧观察清空必须失败。
    await store.save(CHATGPT_CREDENTIAL_KEYS.credentials, "generation-b");
    expect(
      await store.deleteIfValue(
        CHATGPT_CREDENTIAL_KEYS.credentials,
        "generation-a",
      ),
    ).toBe(false);
    expect(await store.load(CHATGPT_CREDENTIAL_KEYS.credentials)).toBe(
      "generation-b",
    );
    // 只有当前值的观察者才能清空。
    expect(
      await store.deleteIfValue(
        CHATGPT_CREDENTIAL_KEYS.credentials,
        "generation-b",
      ),
    ).toBe(true);
    expect(await store.load(CHATGPT_CREDENTIAL_KEYS.credentials)).toBeNull();
  });
});
