// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  connectionSelectionMatchesNavigationItem,
  resolveSelectedFamilyModeNodeKey,
  useModelProviderNavigation,
} from "@/settings/model-provider-section/useModelProviderNavigation.js";
import { CHATGPT_PROVIDER_ID } from "@zcode/shared";
import type { ProviderSettingsFormProvider } from "@/lib/providerSettingsFormTypes.js";

afterEach(cleanup);
it("does not match or redirect ChatGPT through a saved Zhipu family connection", () => {
  const item = {
    key: CHATGPT_PROVIDER_ID,
    type: "chatgpt" as const,
    label: "ChatGPT",
    provider: null,
    statusActive: false,
  };
  const connectionSelections = { zai: { kind: "individual-coding-plan" as const } };
  expect(connectionSelectionMatchesNavigationItem("zai", connectionSelections.zai, item)).toBe(
    false,
  );
  expect(
    resolveSelectedFamilyModeNodeKey({
      selectedNavItem: item,
      selectableNavigationItems: [item],
      connectionSelections,
    }),
  ).toBeNull();
});
it("keeps ChatGPT subscription selectable without a catalog or entitlement, separate from API-key OpenAI", () => {
  const provider: ProviderSettingsFormProvider = {
    providerId: "account:chatgpt",
    providerName: "ChatGPT",
    enabled: true,
    executable: false,
    hasPersonalConfig: false,
    personalConfig: {},
    config: { group: "openai-family", access: { type: "openai-oauth", entitled: false } },
    models: [],
  };
  const custom: ProviderSettingsFormProvider = {
    ...provider,
    providerId: "my-openai-key",
    config: { group: "standard-personal", access: { type: "api-key", apiKey: "" } },
  };
  const options = {
    presetProviders: [],
    modelProviders: [provider, custom],
    selectedNodeKey: "account:chatgpt",
    setSelectedNodeKey: vi.fn(),
    intl: { formatMessage: ({ id }: { id: string }) => id },
  };
  const hook = renderHook(
    (modelProviders: ProviderSettingsFormProvider[]) =>
      useModelProviderNavigation({ ...options, modelProviders }),
    { initialProps: options.modelProviders },
  );
  expect(hook.result.current.selectedNavItem).toMatchObject({
    type: "chatgpt",
    provider,
    statusActive: false,
  });
  expect(
    hook.result.current.navigationGroups
      .find((group) => group.id === "custom")
      ?.items.map((item) => item.key),
  ).toEqual(["custom:my-openai-key"]);
  hook.rerender([]);
  expect(hook.result.current.selectedNavItem).toMatchObject({ type: "chatgpt", provider: null });
  expect(options.setSelectedNodeKey).not.toHaveBeenCalled();
});
