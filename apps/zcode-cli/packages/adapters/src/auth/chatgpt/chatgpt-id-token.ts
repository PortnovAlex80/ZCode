import { createPublicKey, verify as verifySignature, type KeyObject } from "node:crypto";
import { ChatGptOAuthError, type ChatGptOAuthFetch } from "./chatgpt-oauth-client.js";

/**
 * id_token 校验（JWKS / RS256），独立于 OAuth 客户端的网络面。
 *
 * 官方 sign-in 文档要求：对 OpenAI 发布的 JWKS 验签名，并校验 issuer、audience
 * （= 本次签发的 client_id）、exp/nbf、每次登录的 nonce 与非空 sub。
 * 逻辑移植自 nasone32/ZCode feat/chatgpt-oauth（commit bd5171cb）的
 * chatgpt-oauth-client.ts（verifyChatGptIdToken）。
 */

export interface ChatGptIdTokenClaims {
  iss?: unknown;
  sub?: unknown;
  aud?: unknown;
  exp?: unknown;
  nbf?: unknown;
  nonce?: unknown;
  email?: unknown;
  name?: unknown;
  [claim: string]: unknown;
}

export interface ChatGptVerifiedIdToken {
  readonly claims: ChatGptIdTokenClaims;
}

export interface ChatGptIdTokenVerificationInput {
  readonly idToken: string;
  readonly issuer: string;
  /** 必须是本次签发的 client_id（官方文档：audience against the issued client ID）。 */
  readonly audience: string;
  readonly nonce: string;
  readonly now?: () => number;
  readonly jwks?: Readonly<Record<string, unknown>>;
  readonly fetchImpl: ChatGptOAuthFetch;
  readonly jwksUrl: string;
}

interface JsonWebKey {
  readonly kid?: string;
  readonly kty?: string;
  readonly n?: string;
  readonly e?: string;
  readonly alg?: string;
}

export async function verifyChatGptIdToken(
  input: ChatGptIdTokenVerificationInput,
): Promise<ChatGptVerifiedIdToken> {
  const now = (input.now ?? Date.now)() / 1000;
  const parts = input.idToken.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new ChatGptOAuthError(
      "chatgpt_id_token_malformed",
      "id_token is not a JWS compact serialization.",
    );
  }
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];

  let header: Record<string, unknown>;
  let claims: ChatGptIdTokenClaims;
  let signature: Buffer;
  try {
    header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    claims = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    signature = Buffer.from(encodedSignature, "base64url");
  } catch {
    throw new ChatGptOAuthError(
      "chatgpt_id_token_malformed",
      "id_token header or payload is not valid base64url JSON.",
    );
  }
  if (header.alg !== "RS256") {
    throw new ChatGptOAuthError(
      "chatgpt_id_token_algorithm",
      `id_token algorithm must be RS256 (received ${String(header.alg)}).`,
    );
  }

  const jwks = input.jwks ?? (await loadJwks(input.jwksUrl, input.fetchImpl));
  const keys = Array.isArray(jwks.keys) ? (jwks.keys as unknown[]) : [];
  const kid = readString(header.kid);
  const rsaKeys = keys.filter(
    (key): key is JsonWebKey =>
      isRecord(key) && readString(key.kty) === "RSA" && !!readString(key.n) && !!readString(key.e),
  );
  const candidates = kid
    ? rsaKeys.filter((key) => key.kid === kid)
    : // 无 kid 的 JWT 只能按唯一 RSA key 尝试；多 key 且无 kid 时拒绝猜测。
      rsaKeys.length === 1
      ? rsaKeys
      : [];
  const jwk = candidates[0];
  if (!jwk) {
    throw new ChatGptOAuthError(
      "chatgpt_id_token_unknown_key",
      "No matching RSA JWK found for id_token.",
    );
  }

  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey({
      key: jwk as unknown as import("node:crypto").JsonWebKey,
      format: "jwk",
    });
  } catch {
    throw new ChatGptOAuthError("chatgpt_id_token_invalid_key", "Matching JWK could not be imported.");
  }
  const signed = Buffer.from(`${encodedHeader}.${encodedPayload}`, "utf8");
  const valid = verifySignature("RSA-SHA256", signed, publicKey, signature);
  if (!valid) {
    throw new ChatGptOAuthError(
      "chatgpt_id_token_invalid_signature",
      "id_token signature verification failed.",
    );
  }

  if (claims.iss !== input.issuer) {
    throw new ChatGptOAuthError(
      "chatgpt_id_token_invalid_issuer",
      `id_token issuer mismatch (received ${String(claims.iss)}).`,
    );
  }
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audience.includes(input.audience)) {
    throw new ChatGptOAuthError(
      "chatgpt_id_token_invalid_audience",
      "id_token audience does not match the issued client_id.",
    );
  }
  if (typeof claims.exp !== "number" || now >= claims.exp) {
    throw new ChatGptOAuthError("chatgpt_id_token_expired", "id_token has expired.");
  }
  if (typeof claims.nbf === "number" && now < claims.nbf - 60) {
    throw new ChatGptOAuthError("chatgpt_id_token_not_yet_valid", "id_token nbf is in the future.");
  }
  if (typeof claims.sub !== "string" || claims.sub.trim().length === 0) {
    throw new ChatGptOAuthError("chatgpt_id_token_missing_subject", "id_token has no usable sub claim.");
  }
  if (claims.nonce !== input.nonce) {
    throw new ChatGptOAuthError(
      "chatgpt_id_token_nonce_mismatch",
      "id_token nonce does not match this attempt.",
    );
  }
  return { claims };
}

async function loadJwks(
  jwksUrl: string,
  fetchImpl: ChatGptOAuthFetch,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(jwksUrl, { headers: { accept: "application/json" } });
  } catch (error) {
    throw new ChatGptOAuthError("chatgpt_jwks_network_error", "Unable to load OpenAI JWKS.", {
      cause: error,
    });
  }
  if (!response.ok) {
    throw new ChatGptOAuthError("chatgpt_jwks_unavailable", `JWKS request failed: ${response.status}`, {
      httpStatus: response.status,
    });
  }
  const body = (await response.json()) as unknown;
  if (!isRecord(body)) {
    throw new ChatGptOAuthError("chatgpt_jwks_malformed", "JWKS response is not a JSON object.");
  }
  return body;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
