import {
  ModelConfigRules,
  ProviderConfigMap,
  type ProviderConfigSnapshot,
  type ProviderSource,
} from "@zcode/provider";
import { BUILTIN_MODEL_PROVIDER_IDS, type ProviderFamilyDomain } from "@zcode/shared";
import { describe, expect, it, vi } from "vitest";
import { createAccountProviderConfigSource } from "../src/model-provider/accountProviderConnectionResolver.js";
import { createAccountProviderCredentialService } from "../src/model-provider/accountProviderCredentialService.js";
import { createAccountProviderConfig } from "./providerConfigFixtures.js";

/**
 * Upstream 3.18.1/3.18.2 contract: the account config source now requires an
 * OAuth session snapshot revision reader plus dedicated Start plan material and
 * full OAuth account material loaders (no bare access-token reader anymore).
 */
const stableSessionRevision = async () => "rev-1";

function createStartPlanMaterial(family: ProviderFamilyDomain, accountIdentity: string) {
  return {
    family,
    loginProvider: family,
    zcodeUserId: "user-1",
    sessionRevision: "rev-1",
    accountIdentity,
    zcodeJwtToken: "start-jwt",
  };
}

function createOAuthAccountMaterial(family: ProviderFamilyDomain, accountIdentity: string) {
  return {
    family,
    loginProvider: family,
    zcodeUserId: "user-1",
    sessionRevision: "rev-1",
    accountIdentity,
    accessToken: "new-login-token",
    zcodeJwtToken: null,
  };
}

class StaticConfigSource implements ProviderSource<ProviderConfigSnapshot> {
  async read(): Promise<ProviderConfigSnapshot> {
    return {
      revision: "config-1",
      zcodeBuiltinRevision: "builtin-1",
      personalRevision: "personal-1",
      zcodeBuiltinProviders: new ProviderConfigMap([
        [
          BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
          createAccountProviderConfig({
            accountType: "zai",
            mode: "individual-coding-plan",
            models: ["GLM-5.2"],
          }),
        ],
        [
          BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan,
          createAccountProviderConfig({
            accountType: "zai",
            mode: "start-plan",
            models: ["GLM-5-Turbo"],
          }),
        ],
      ]),
      personalProviders: ProviderConfigMap.empty(),
      zcodeBuiltinModelRules: ModelConfigRules.empty(),
      personalModels: ModelConfigRules.empty(),
    };
  }

  onDidChange(): () => void {
    return () => {};
  }
}

describe("createAccountProviderConfigSource", () => {
  it("刷新账号配置时无旧 Key Store 也能恢复账号 Token", async () => {
    const providerId = BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan;
    const resolveProviderMaterial = vi.fn(async () => ({
      token: "fresh-key",
      apiKeyId: "id-fresh-key",
      organizationId: "org",
      projectId: "proj",
    }));
    const credentials = createAccountProviderCredentialService({
      // Upstream 3.18.1: the credential service reads the full OAuth account
      // material; the access token travels inside it.
      loadOAuthAccountMaterial: async (family) => createOAuthAccountMaterial(family, "same-account"),
      resolveProviderMaterial,
    });
    const source = createAccountProviderConfigSource({
      configSource: new StaticConfigSource(),
      readSettings: async () => ({
        providerFamilyDomain: "zai",
        selections: { zai: { kind: "individual-coding-plan" } },
      }),
      // Start plan stays logged out here; this test only exercises the paid
      // plan key recovery path.
      loadStartPlanMaterial: async () => null,
      loadSessionRevision: stableSessionRevision,
      loadAccountIdentity: async () => "same-account",
      loadCodingPlanApiKey: (id, family, accountIdentity, forceRefresh) =>
        id === providerId
          ? credentials.loadCodingPlanApiKey({
              providerId: id,
              family,
              accountIdentity,
              forceRefresh,
            })
          : Promise.resolve(null),
      resolveFamilyAvailability: async ({ providers }) => ({
        [providerId]:
          providers.find((p) => p.providerId === providerId)?.apiKey === "fresh-key"
            ? { kind: "available" as const }
            : {
                kind: "unavailable" as const,
                reason: "coding_plan_auth_failed" as const,
              },
      }),
    });
    try {
      expect((await source.read()).states[providerId]).toMatchObject({
        availability: "available",
      });
      await source.refresh("oauth-login-entitlement");
      expect(resolveProviderMaterial).toHaveBeenCalledTimes(2);
      expect(resolveProviderMaterial).toHaveBeenCalledWith(
        "zai",
        "new-login-token",
        "same-account",
        undefined,
      );
      expect((await source.read()).states[providerId]).toMatchObject({
        availability: "available",
        entitled: true,
      });
    } finally {
      source.dispose();
    }
  });

  it("直接从 Config 与账号连接结果产生第三层 Account Config", async () => {
    const resolveFamilyAvailability = vi.fn(async () => ({
      [BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan]: {
        kind: "available" as const,
      },
      [BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan]: {
        kind: "available" as const,
        models: ["remote-start-model"],
      },
    }));
    const loadCodingPlanApiKey = vi.fn(
      async (providerId: string, _family: string, accountIdentity: string) =>
        providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan
          ? `personal-key:${accountIdentity}`
          : null,
    );
    const source = createAccountProviderConfigSource({
      configSource: new StaticConfigSource(),
      readSettings: async () => ({
        providerFamilyDomain: "zai",
        selections: { zai: { kind: "individual-coding-plan" } },
      }),
      loadCodingPlanApiKey,
      loadAccountIdentity: async () => "account-a",
      // Upstream 3.18.2: Start connections take identity from the dedicated
      // Start plan material, so zaiStart resolves as connected and current.
      loadStartPlanMaterial: async (family) => createStartPlanMaterial(family, "account-a"),
      loadSessionRevision: stableSessionRevision,
      resolveFamilyAvailability,
    });

    await expect(source.read()).resolves.toMatchObject({
      providers: expect.any(ProviderConfigMap),
    });
    expect(
      Object.fromEntries(
        (await source.read()).providers.entries().map(([id, config]) => [id, config.toJSON()]),
      ),
    ).toEqual({
      [BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan]: {
        access: { type: "zhipu-account", entitled: true },
      },
      [BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan]: {
        // 未选中不等于没有权益；current 由状态层隔离，不能反写为未授权。
        access: { type: "zhipu-account", entitled: true },
        builtinModelIds: ["remote-start-model"],
      },
    });
    expect((await source.read()).states).toMatchObject({
      [BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan]: {
        availability: "available",
        entitled: true,
        current: true,
      },
      [BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan]: {
        availability: "available",
        entitled: true,
        current: true,
      },
    });
    expect(resolveFamilyAvailability).toHaveBeenCalledTimes(1);
    expect(resolveFamilyAvailability).toHaveBeenCalledWith(
      expect.objectContaining({
        providers: expect.arrayContaining([
          expect.objectContaining({
            providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
            apiKey: "personal-key:account-a",
          }),
        ]),
      }),
    );

    await source.refresh("oauth-login-entitlement");
    expect(loadCodingPlanApiKey).toHaveBeenCalledWith(
      BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan,
      "zai",
      "account-a",
      true,
    );

    source.dispose();
  });
});
