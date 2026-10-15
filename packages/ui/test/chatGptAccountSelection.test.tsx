// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import type {
  IChatGptAccountService,
  IModelSelectionService,
  ModelSelectionView,
  IServiceAccessor,
} from "@zcode/services";
import type { ChatGptAccountStatus } from "@zcode/shared";
import { describe, expect, it, vi } from "vitest";
import { buildRegistryModelSelectGroups } from "@/lib/modelSelectionGroups.js";
import { useChatGptAccount } from "@/hooks/useChatGptAccount.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { useModelSelectionServiceView } from "@/hooks/useModelSelectionView.js";

/**
 * ChatGPT 订阅的 Renderer 侧模型链路（无网络）：
 * Host 事件（凭据 watcher → Registry → Facade）到达后，useModelSelectionView
 * 的视图里出现「OpenAI — ChatGPT 订阅」分组；账号状态 hook 只消费 sanitized 投影。
 */

function chatGptView(revision: number, withModels: boolean): ModelSelectionView {
  return {
    revision,
    providers: withModels
      ? [
          {
            providerId: "account:chatgpt",
            providerName: "ChatGPT",
            config: {
              access: { type: "openai-oauth", entitled: true },
              api: {
                type: "openai-responses",
                baseUrl: "https://api.openai.com/v1",
              },
            },
            models: [{ modelId: "gpt-6.1-sol", config: {} }],
          },
        ]
      : [],
  };
}

function readyView(read: ReturnType<typeof useModelSelectionServiceView>): ModelSelectionView {
  const state = read.state;
  if (state.status !== "ready") throw new Error(`expected ready view, got ${state.status}`);
  return state.view;
}

describe("ChatGPT model selection renderer chain", () => {
  it("登录事件到达后模型菜单出现 OpenAI 分组", async () => {
    let latest = chatGptView(1, false);
    const listeners = new Set<(value: ModelSelectionView) => void>();
    const service: IModelSelectionService = {
      getView: vi.fn(async () => latest),
      onDidChange: (listener) => {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      },
    };
    const hook = renderHook(() => useModelSelectionServiceView(service));
    await waitFor(() => expect(hook.result.current.state.status).toBe("ready"));
    expect(buildRegistryModelSelectGroups("glm", readyView(hook.result.current))).toEqual([]);

    // Host 侧凭据 watcher → Registry → Facade 事件（服务层 e2e 已覆盖真实链路）。
    latest = chatGptView(2, true);
    act(() => listeners.forEach((listener) => listener(latest)));
    await waitFor(() =>
      expect(
        buildRegistryModelSelectGroups("glm", readyView(hook.result.current), {
          openAiFamilyLabel: "OpenAI",
          openAiSubscriptionBadgeLabel: "ChatGPT",
        }),
      ).toHaveLength(1),
    );
    const groups = buildRegistryModelSelectGroups("glm", readyView(hook.result.current), {
      openAiFamilyLabel: "OpenAI",
      openAiSubscriptionBadgeLabel: "ChatGPT",
    });
    expect(groups).toEqual([
      {
        key: "registry-provider:account:chatgpt",
        label: "OpenAI",
        labelBadge: "ChatGPT",
        directItems: true,
        items: [
          {
            key: "registry-provider:account:chatgpt:gpt-6.1-sol",
            value: "custom:account%3Achatgpt:gpt-6.1-sol",
            name: "gpt-6.1-sol",
          },
        ],
      },
    ]);
    hook.unmount();
  });
});

describe("useChatGptAccount", () => {
  function renderWithService(service: IChatGptAccountService | undefined) {
    const services = {
      chatGptAccountService: service,
    } as unknown as IServiceAccessor;
    return renderHook(() => useChatGptAccount(), {
      wrapper: ({ children }) => <ServiceProvider services={services}>{children}</ServiceProvider>,
    });
  }

  function fakeService(initial: ChatGptAccountStatus): {
    service: IChatGptAccountService;
    push(status: ChatGptAccountStatus): void;
  } {
    const listeners = new Set<(status: ChatGptAccountStatus) => void>();
    let current = initial;
    return {
      service: {
        getStatus: vi.fn(async () => current),
        beginLogin: vi.fn(async () => {
          current = {
            status: "plan-enabled",
            usageUrl: "https://chatgpt.com/settings/usage",
          };
          for (const listener of listeners) listener(current);
          return { result: "completed", status: current };
        }),
        disconnect: vi.fn(async () => {
          current = { status: "not-connected" };
          for (const listener of listeners) listener(current);
          return { revoked: true, status: current };
        }),
        onDidChange: (listener) => {
          listeners.add(listener);
          return { dispose: () => listeners.delete(listener) };
        },
        reportRuntimeObservation: vi.fn(async () => {}),
      },
      push(status: ChatGptAccountStatus) {
        current = status;
        for (const listener of listeners) listener(status);
      },
    };
  }

  it("无服务时隐藏（undefined），beginLogin 返回 typed 不可用", async () => {
    const hook = renderWithService(undefined);
    expect(hook.result.current.status).toBeUndefined();
    await expect(hook.result.current.beginLogin()).resolves.toEqual({
      result: "unavailable",
      reason: "login-bridge-not-configured",
    });
    hook.unmount();
  });

  it("订阅 sanitized 状态并在事件后刷新；payload 不含凭据键", async () => {
    const { service, push } = fakeService({ status: "not-connected" });
    const hook = renderWithService(service);
    await waitFor(() => expect(hook.result.current.status).toEqual({ status: "not-connected" }));

    act(() =>
      push({
        status: "plan-enabled",
        email: "user@example.com",
        usageUrl: "https://chatgpt.com/settings/usage",
      }),
    );
    await waitFor(() =>
      expect(hook.result.current.status).toMatchObject({
        status: "plan-enabled",
      }),
    );
    expect(JSON.stringify(hook.result.current.status)).not.toContain("oauth:chatgpt:");
    expect(JSON.stringify(hook.result.current.status)).not.toContain("access_token");

    const login = await hook.result.current.beginLogin();
    expect(login).toEqual({
      result: "completed",
      status: {
        status: "plan-enabled",
        usageUrl: "https://chatgpt.com/settings/usage",
      },
    });
    hook.unmount();
  });
});
