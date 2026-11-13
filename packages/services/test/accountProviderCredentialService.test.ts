import { describe, expect, it, vi } from "vitest";
import { createAccountProviderCredentialService } from "../src/model-provider/accountProviderCredentialService.js";

describe("AccountProviderCredentialService", () => {
  it("使用当前登录态取得 Token，不写入私有凭据键", async () => {
    // Upstream v3.18 replaced loadOAuthAccessToken(family) with
    // loadOAuthAccountMaterial(family); the service matches accountIdentity and
    // forwards account.accessToken to resolveProviderMaterial.
    const loadOAuthAccountMaterial = vi.fn(async () => ({
      family: "bigmodel",
      loginProvider: "bigmodel",
      zcodeUserId: "u-test",
      sessionRevision: null,
      accountIdentity: "account/b",
      accessToken: "oauth-token",
      zcodeJwtToken: null,
    }));
    const resolveProviderMaterial = vi.fn(async () => ({
      token: "remote-key",
      apiKeyId: "id-remote-key",
      organizationId: "org",
      projectId: "proj",
    }));
    const service = createAccountProviderCredentialService({
      loadOAuthAccountMaterial,
      resolveProviderMaterial,
    });

    await expect(
      service.loadCodingPlanApiKey({
        providerId: "account:bigmodel-individual-coding-plan",
        family: "bigmodel",
        accountIdentity: "account/b",
      }),
    ).resolves.toBe("remote-key");

    expect(loadOAuthAccountMaterial).toHaveBeenCalledWith("bigmodel");
    expect(resolveProviderMaterial).toHaveBeenCalledWith(
      "bigmodel",
      "oauth-token",
      "account/b",
      undefined,
    );
  });

  it("同一账号连接的并发读取只执行一次远端解析", async () => {
    let release!: (value: string) => void;
    const remoteKey = new Promise<string>((resolve) => {
      release = resolve;
    });
    const resolveProviderMaterial = vi.fn(async () => ({
      token: await remoteKey,
      apiKeyId: "key-id",
      organizationId: "org",
      projectId: "proj",
    }));
    const service = createAccountProviderCredentialService({
      loadOAuthAccountMaterial: vi.fn(async () => ({
        family: "zai",
        loginProvider: "zai",
        zcodeUserId: "u-test",
        sessionRevision: null,
        accountIdentity: "account-a",
        accessToken: "oauth-token",
        zcodeJwtToken: null,
      })),
      resolveProviderMaterial,
    });
    const input = {
      providerId: "account:zai-individual-coding-plan",
      family: "zai" as const,
      accountIdentity: "account-a",
    };

    const first = service.loadCodingPlanApiKey(input);
    const second = service.loadCodingPlanApiKey(input);
    release("remote-key");

    await expect(Promise.all([first, second])).resolves.toEqual(["remote-key", "remote-key"]);
    expect(resolveProviderMaterial).toHaveBeenCalledTimes(1);
  });

  it("OAuth 重新登录时使用新登录态解析 Token", async () => {
    const resolveProviderMaterial = vi.fn(async () => ({
      token: "fresh-key",
      apiKeyId: "id-fresh-key",
      organizationId: "org",
      projectId: "proj",
    }));
    const service = createAccountProviderCredentialService({
      // Same v3.18 contract swap: material instead of a bare access token.
      loadOAuthAccountMaterial: vi.fn(async () => ({
        family: "zai",
        loginProvider: "zai",
        zcodeUserId: "u-test",
        sessionRevision: null,
        accountIdentity: "account-a",
        accessToken: "new-oauth-token",
        zcodeJwtToken: null,
      })),
      resolveProviderMaterial,
    });

    await expect(
      service.loadCodingPlanApiKey({
        providerId: "account:zai-individual-coding-plan",
        family: "zai",
        accountIdentity: "account-a",
        forceRefresh: true,
      }),
    ).resolves.toBe("fresh-key");

    expect(resolveProviderMaterial).toHaveBeenCalledWith(
      "zai",
      "new-oauth-token",
      "account-a",
      undefined,
    );
  });
});
