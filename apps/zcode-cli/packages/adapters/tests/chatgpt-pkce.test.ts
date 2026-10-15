import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  base64UrlEncode,
  computePkceCodeChallenge,
  createPkceVerifier,
  createRandomToken,
} from "../src/auth/chatgpt/pkce.js";

/** RFC 7636 Appendix B 官方测试向量。 */
describe("PKCE (RFC 7636)", () => {
  it("verifier 使用 unreserved 字符表且长度合法", () => {
    for (let index = 0; index < 32; index += 1) {
      const verifier = createPkceVerifier();
      expect(verifier).toMatch(/^[A-Za-z0-9\-._~]{64}$/u);
    }
  });

  it("verifier 长度越界直接拒绝（43-128）", () => {
    expect(() => createPkceVerifier(42)).toThrow();
    expect(() => createPkceVerifier(129)).toThrow();
    expect(() => createPkceVerifier(43)).not.toThrow();
    expect(() => createPkceVerifier(128)).not.toThrow();
  });

  it("S256 code_challenge 与 RFC 7636 Appendix B 向量一致", () => {
    // vector: verifier "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
    expect(computePkceCodeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("code_challenge 是去填充的 base64url(SHA-256(verifier))", () => {
    const verifier = createPkceVerifier();
    const expected = base64UrlEncode(createHash("sha256").update(verifier, "utf8").digest());
    expect(computePkceCodeChallenge(verifier)).toBe(expected);
    expect(computePkceCodeChallenge(verifier)).not.toContain("=");
    expect(computePkceCodeChallenge(verifier)).not.toContain("+");
    expect(computePkceCodeChallenge(verifier)).not.toContain("/");
  });

  it("state / nonce 随机且不重复（每次登录新生成）", () => {
    const tokens = new Set(Array.from({ length: 32 }, () => createRandomToken()));
    expect(tokens.size).toBe(32);
    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9\-_]{43}$/u);
    }
  });
});
