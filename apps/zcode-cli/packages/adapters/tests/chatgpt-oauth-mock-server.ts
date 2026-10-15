import { createSign, generateKeyPairSync, randomUUID, type KeyObject } from "node:crypto";
import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * 测试用 RS256 签名器 + mock 授权服务器（authorize/token/jwks/openid-configuration/
 * revoke/models）。骨架来自 nasone32/ZCode feat/chatgpt-oauth（commit bd5171cb）的
 * tests/chatgpt-test-auth-server.ts；按本仓库测试需求增强：
 * - refresh token 单次使用（rotation reuse-detection）：同一 refresh_token 第二次出现
 *   返回 `invalid_grant`——任何跨进程竞态都会在这里被抓住；
 * - 每个 token/refresh 请求记录到达时刻，供 earliest_refresh_at 断言使用；
 * - authorize 可配置重定向错误（error=access_denied）模拟用户拒绝。
 */

export interface SignedIdTokenInput {
  readonly audience: string;
  readonly email?: string;
  readonly issuer: string;
  readonly name?: string;
  readonly nonce: string;
  readonly subject?: string;
  readonly expiresInSeconds?: number;
  readonly tamperPayload?: boolean;
  readonly headerOverrides?: Record<string, unknown>;
}

export class RsaTestSigner {
  readonly publicKey: KeyObject;
  readonly privateKey: KeyObject;
  readonly jwk: Record<string, unknown>;
  readonly kid: string;

  constructor() {
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    this.publicKey = pair.publicKey;
    this.privateKey = pair.privateKey;
    this.kid = `test-key-${randomUUID()}`;
    this.jwk = {
      ...(this.publicKey.export({ format: "jwk" }) as Record<string, unknown>),
      alg: "RS256",
      use: "sig",
      kid: this.kid,
    };
  }

  signIdToken(input: SignedIdTokenInput, now = Date.now()): string {
    const header = { alg: "RS256", typ: "JWT", kid: this.kid, ...input.headerOverrides };
    const payload = {
      iss: input.issuer,
      aud: input.audience,
      sub: input.subject ?? "user-subject-1",
      exp: Math.floor(now / 1000) + (input.expiresInSeconds ?? 600),
      iat: Math.floor(now / 1000),
      nonce: input.nonce,
      ...(input.email ? { email: input.email, email_verified: true } : {}),
      ...(input.name ? { name: input.name } : {}),
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-1", chatgpt_plan_type: "plus" },
    };
    const encodedHeader = Buffer.from(JSON.stringify(header)).toString("base64url");
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signer = createSign("RSA-SHA256");
    signer.update(`${encodedHeader}.${encodedPayload}`);
    const signature = signer.sign(this.privateKey).toString("base64url");
    // tamperPayload 模拟「验签必须失败」的伪造：签名覆盖原 payload，发出时替换内容。
    const emittedPayload = input.tamperPayload
      ? Buffer.from(JSON.stringify({ ...payload, sub: "tampered" })).toString("base64url")
      : encodedPayload;
    return `${encodedHeader}.${emittedPayload}.${signature}`;
  }
}

export interface MockTokenRequestContext {
  readonly clientId: string;
  readonly codeVerifier: string;
  readonly grantType: string;
  readonly nonce: string;
  readonly refreshToken?: string;
  readonly receivedAt: number;
}

export interface MockAuthServerOptions {
  readonly signer: RsaTestSigner;
  readonly issuedClientId?: string;
  /** authorize 重定向错误（error=access_denied 等）；设置后不再发 code。 */
  readonly authorizeError?: string;
  /** token 响应覆盖；包含 error 字符串时整体作为 OAuth 错误返回。 */
  readonly tokenResponseOverrides?: (context: MockTokenRequestContext) => Record<string, unknown>;
  readonly models?: unknown[];
  /** 关闭单次使用强制（个别用例需要服务器容忍复用时才打开）。 */
  readonly allowRefreshReuse?: boolean;
}

export interface MockAuthServer {
  readonly accessTokenRequests: MockTokenRequestContext[];
  readonly authorizeRequests: URL[];
  readonly revocationRequests: Array<Record<string, string>>;
  readonly refreshRequestCount: () => number;
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

export async function createMockAuthServer(
  options: MockAuthServerOptions,
): Promise<MockAuthServer> {
  const issuedClientId = options.issuedClientId ?? "oaiapp_test_client";
  const accessTokenRequests: MockTokenRequestContext[] = [];
  const authorizeRequests: URL[] = [];
  const revocationRequests: Array<Record<string, string>> = [];
  const codesIssued = new Map<string, string>();
  /** 单次使用的 refresh token；二次使用即 invalid_grant（rotation reuse-detection）。 */
  const consumedRefreshTokens = new Set<string>();
  // handler 只在 listen 之后被调用；届时 effectiveIssuer 一定已解析。
  let effectiveIssuer = "http://127.0.0.1.invalid";

  const server: Server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", effectiveIssuer);
    if (request.method === "GET" && url.pathname === "/api/accounts/authorize") {
      authorizeRequests.push(url);
      const redirectUri = url.searchParams.get("redirect_uri") ?? "";
      const state = url.searchParams.get("state") ?? "";
      const redirect = new URL(redirectUri);
      redirect.searchParams.set("state", state);
      if (options.authorizeError) {
        redirect.searchParams.set("error", options.authorizeError);
        redirect.searchParams.set("error_description", "The user denied the request.");
      } else {
        const code = `mock-code-${accessTokenRequests.length + 1}`;
        codesIssued.set(code, url.searchParams.get("nonce") ?? "");
        redirect.searchParams.set("code", code);
        redirect.searchParams.set("client_id", issuedClientId);
      }
      response.writeHead(302, { location: redirect.toString() });
      response.end();
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/accounts/oauth/token") {
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
      });
      request.on("end", () => {
        const params = new URLSearchParams(body);
        const grantType = params.get("grant_type") ?? "";
        const code = params.get("code") ?? "";
        const refreshToken = params.get("refresh_token") ?? "";
        const context: MockTokenRequestContext = {
          clientId: params.get("client_id") ?? "",
          codeVerifier: params.get("code_verifier") ?? "",
          grantType,
          nonce: codesIssued.get(code) ?? "nonce-unused",
          ...(refreshToken ? { refreshToken } : {}),
          receivedAt: Date.now(),
        };
        accessTokenRequests.push(context);

        if (grantType === "refresh_token") {
          if (!options.allowRefreshReuse && consumedRefreshTokens.has(refreshToken)) {
            response.writeHead(400, { "content-type": "application/json" });
            response.end(
              JSON.stringify({
                error: "invalid_grant",
                error_description: "refresh token reuse detected",
              }),
            );
            return;
          }
          consumedRefreshTokens.add(refreshToken);
        }
        if (params.get("scope") !== null) {
          // 官方 profiles-and-sessions：refresh 不带 scope 以保留授权。
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "invalid_request", error_description: "scope must be omitted on refresh" }));
          return;
        }

        const idToken = options.signer.signIdToken({
          audience: context.clientId,
          issuer: effectiveIssuer,
          nonce: context.nonce,
          email: "user@example.com",
          name: "Test User",
        });
        const base =
          grantType === "refresh_token"
            ? {
                access_token: `refreshed-access-${accessTokenRequests.length}`,
                refresh_token: `rotated-refresh-${accessTokenRequests.length}`,
                token_type: "Bearer",
                expires_in: 3600,
                scope:
                  "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
              }
            : {
                access_token: `initial-access-${accessTokenRequests.length}`,
                refresh_token: `initial-refresh-${accessTokenRequests.length}`,
                id_token: idToken,
                token_type: "Bearer",
                expires_in: 3600,
                scope:
                  "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
                earliest_refresh_at: Date.now() + 5_000,
              };
        const overrides = options.tokenResponseOverrides?.(context) ?? {};
        // 覆盖里带 error 时整体作为 OAuth 错误响应返回（不合并 token 字段）。
        const isErrorResponse = typeof (overrides as Record<string, unknown>).error === "string";
        const payload = isErrorResponse ? overrides : { ...base, ...overrides };
        response.writeHead(isErrorResponse ? 400 : 200, { "content-type": "application/json" });
        response.end(JSON.stringify(payload));
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/.well-known/jwks.json") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ keys: [options.signer.jwk] }));
      return;
    }
    if (request.method === "GET" && url.pathname === "/.well-known/openid-configuration") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          issuer: effectiveIssuer,
          revocation_endpoint: `${effectiveIssuer}/revoke`,
        }),
      );
      return;
    }
    if (request.method === "POST" && url.pathname === "/revoke") {
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
      });
      request.on("end", () => {
        revocationRequests.push(Object.fromEntries(new URLSearchParams(body)));
        response.writeHead(200);
        response.end();
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          models: options.models ?? [
            {
              slug: "gpt-6.1-sol",
              display_name: "GPT Sol",
              visibility: "list",
              supported_in_api: true,
            },
            {
              slug: "gpt-6.1-sol-fast",
              display_name: "GPT Sol Fast",
              visibility: "list",
              supported_in_api: true,
            },
            { slug: "hidden-model", display_name: "Hidden", visibility: "owner" },
            { slug: "unsupported-model", display_name: "Unsupported", visibility: "list", supported_in_api: false },
          ],
        }),
      );
      return;
    }
    response.writeHead(404);
    response.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  effectiveIssuer = `http://127.0.0.1:${port}`;
  return {
    accessTokenRequests,
    authorizeRequests,
    revocationRequests,
    refreshRequestCount: () =>
      accessTokenRequests.filter((request) => request.grantType === "refresh_token").length,
    port,
    url: effectiveIssuer,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
