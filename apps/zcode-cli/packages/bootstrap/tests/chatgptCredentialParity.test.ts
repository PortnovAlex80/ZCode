import { describe, expect, it } from "vitest";
import {
  CHATGPT_CREDENTIAL_KEYS as ADAPTER_KEYS,
  serializeChatGptCredentialRecord,
  type ChatGptCredentialRecord,
} from "@zcode/adapters/auth";
import {
  CHATGPT_CREDENTIAL_KEYS as SHARED_KEYS,
  CHATGPT_TOKEN_SHARING_SCOPE as SHARED_SCOPE,
  parseChatGptCachedModelsJson,
  parseChatGptSanitizedCredentialSnapshot,
} from "@zcode/shared";

/**
 * Host（services，经 @zcode/shared 解析）与 agent（adapters）读写同一个
 * `~/.zcode/v2/credentials.json`。键字面量在两个包里各自声明（services 不依赖
 * adapters）；本测试守住漂移：任何一端改键名/记录格式，这里必须先红。
 */

describe("ChatGPT 凭据键与记录格式双端一致", () => {
  it("credential store 键字面量 shared 与 adapters 完全一致", () => {
    expect({ ...SHARED_KEYS }).toEqual({ ...ADAPTER_KEYS });
  });

  it("shared sanitized 解析接受 adapters 序列化的记录，且不暴露 token", () => {
    const record: ChatGptCredentialRecord = {
      generation: "gen-42",
      clientId: "oaiapp_client",
      accessToken: "secret-access",
      refreshToken: "secret-refresh",
      idToken: "secret-id",
      account: {
        subject: "subject-1",
        email: "user@example.com",
        plan: "plus",
        scopes: ["openid", SHARED_SCOPE],
      },
      expiresAt: Date.now() + 3_600_000,
      issuedAt: Date.now(),
    };
    const snapshot = parseChatGptSanitizedCredentialSnapshot(
      serializeChatGptCredentialRecord(record),
    );
    expect(snapshot).toEqual({
      account: {
        subject: "subject-1",
        email: "user@example.com",
        plan: "plus",
        scopes: ["openid", SHARED_SCOPE],
      },
      planEnabled: true,
    });
    expect(JSON.stringify(snapshot)).not.toContain("secret-access");
    expect(JSON.stringify(snapshot)).not.toContain("secret-refresh");
    expect(JSON.stringify(snapshot)).not.toContain("secret-id");

    // 缺任一 token 成员的记录在 Host 侧视为未登录（fail-closed）。
    const broken: ChatGptCredentialRecord = { ...record, refreshToken: "" };
    expect(parseChatGptSanitizedCredentialSnapshot(serializeChatGptCredentialRecord(broken))).toBeNull();
  });

  it("models 缓存解析接受 adapters 的写入口径", () => {
    expect(parseChatGptCachedModelsJson(JSON.stringify([{ slug: "gpt-6.1-sol", display_name: "GPT 6.1" }]))).toEqual([
      { slug: "gpt-6.1-sol", display_name: "GPT 6.1" },
    ]);
    expect(parseChatGptCachedModelsJson("[]")).toBeNull();
    expect(parseChatGptCachedModelsJson("not-json")).toBeNull();
  });
});
