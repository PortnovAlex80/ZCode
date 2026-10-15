import { describe, expect, it } from "vitest";
import { verifyChatGptIdToken } from "../src/auth/chatgpt/chatgpt-id-token.js";
import { RsaTestSigner } from "./chatgpt-oauth-mock-server.js";

/** id_token 校验（RS256/JWKS/iss/aud/exp/nbf/nonce/sub）——官方 sign-in 文档要求。 */
const ISSUER = "http://127.0.0.1:9";
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;
const fetchNever = (async () => {
  throw new Error("network must not be used when jwks is provided");
}) as typeof globalThis.fetch;

function baseInput(signer: RsaTestSigner, idToken: string, nonce = "nonce-1") {
  return {
    idToken,
    issuer: ISSUER,
    audience: "oaiapp_test_client",
    nonce,
    jwks: { keys: [signer.jwk] },
    fetchImpl: fetchNever,
    jwksUrl: JWKS_URL,
  };
}

describe("verifyChatGptIdToken", () => {
  it("接受正确签名与声明，返回 claims", async () => {
    const signer = new RsaTestSigner();
    const idToken = signer.signIdToken({
      audience: "oaiapp_test_client",
      issuer: ISSUER,
      nonce: "nonce-1",
      email: "user@example.com",
      name: "Test User",
    });
    const verified = await verifyChatGptIdToken(baseInput(signer, idToken));
    expect(verified.claims.sub).toBe("user-subject-1");
    expect(verified.claims.email).toBe("user@example.com");
  });

  it("篡改 payload 后验签失败", async () => {
    const signer = new RsaTestSigner();
    const idToken = signer.signIdToken({
      audience: "oaiapp_test_client",
      issuer: ISSUER,
      nonce: "nonce-1",
      tamperPayload: true,
    });
    await expect(verifyChatGptIdToken(baseInput(signer, idToken))).rejects.toMatchObject({
      code: "chatgpt_id_token_invalid_signature",
    });
  });

  it("issuer 不匹配被拒绝", async () => {
    const signer = new RsaTestSigner();
    const idToken = signer.signIdToken({ audience: "oaiapp_test_client", issuer: "https://evil.example", nonce: "nonce-1" });
    await expect(verifyChatGptIdToken(baseInput(signer, idToken))).rejects.toMatchObject({
      code: "chatgpt_id_token_invalid_issuer",
    });
  });

  it("audience 不是本次签发 client_id 被拒绝", async () => {
    const signer = new RsaTestSigner();
    const idToken = signer.signIdToken({ audience: "oaiapp_other_client", issuer: ISSUER, nonce: "nonce-1" });
    await expect(verifyChatGptIdToken(baseInput(signer, idToken))).rejects.toMatchObject({
      code: "chatgpt_id_token_invalid_audience",
    });
  });

  it("nonce 不属于本次尝试被拒绝（重放防护）", async () => {
    const signer = new RsaTestSigner();
    const idToken = signer.signIdToken({ audience: "oaiapp_test_client", issuer: ISSUER, nonce: "nonce-other" });
    await expect(verifyChatGptIdToken(baseInput(signer, idToken, "nonce-1"))).rejects.toMatchObject({
      code: "chatgpt_id_token_nonce_mismatch",
    });
  });

  it("过期 id_token 被拒绝", async () => {
    const signer = new RsaTestSigner();
    const idToken = signer.signIdToken({
      audience: "oaiapp_test_client",
      issuer: ISSUER,
      nonce: "nonce-1",
      expiresInSeconds: -10,
    });
    await expect(verifyChatGptIdToken(baseInput(signer, idToken))).rejects.toMatchObject({
      code: "chatgpt_id_token_expired",
    });
  });

  it("非 RS256 算法被拒绝", async () => {
    const signer = new RsaTestSigner();
    const idToken = signer.signIdToken({
      audience: "oaiapp_test_client",
      issuer: ISSUER,
      nonce: "nonce-1",
      headerOverrides: { alg: "HS256" },
    });
    await expect(verifyChatGptIdToken(baseInput(signer, idToken))).rejects.toMatchObject({
      code: "chatgpt_id_token_algorithm",
    });
  });

  it("kid 指向未知 key 被拒绝；多 key 无 kid 拒绝猜测", async () => {
    const signer = new RsaTestSigner();
    const otherSigner = new RsaTestSigner();
    const idToken = signer.signIdToken({ audience: "oaiapp_test_client", issuer: ISSUER, nonce: "nonce-1" });
    const wrongJwksInput = {
      ...baseInput(signer, idToken),
      jwks: { keys: [otherSigner.jwk] },
    };
    await expect(verifyChatGptIdToken(wrongJwksInput)).rejects.toMatchObject({
      code: "chatgpt_id_token_unknown_key",
    });
    // 无 kid 的 JWT + 多把 RSA key：不猜测，直接拒绝。
    const [, encodedPayload, signature] = idToken.split(".");
    const tokenWithoutKidHeader = [
      Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url"),
      encodedPayload,
      signature,
    ].join(".");
    await expect(
      verifyChatGptIdToken({
        ...baseInput(signer, tokenWithoutKidHeader),
        jwks: { keys: [signer.jwk, otherSigner.jwk] },
      }),
    ).rejects.toMatchObject({ code: "chatgpt_id_token_unknown_key" });
  });

  it("结构非法 / 缺 sub 被拒绝", async () => {
    const signer = new RsaTestSigner();
    await expect(verifyChatGptIdToken(baseInput(signer, "not-a-jwt"))).rejects.toMatchObject({
      code: "chatgpt_id_token_malformed",
    });
    const noSub = signer.signIdToken({ audience: "oaiapp_test_client", issuer: ISSUER, nonce: "n", subject: " " });
    // subject 为空白：签名有效但 sub 不可用。
    await expect(
      verifyChatGptIdToken(baseInput(signer, noSub, "n")),
    ).rejects.toMatchObject({ code: "chatgpt_id_token_missing_subject" });
  });
});
