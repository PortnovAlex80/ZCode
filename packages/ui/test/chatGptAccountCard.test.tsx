// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatGptAccountCard } from "@/settings/model-provider-section/ChatGptAccountCard.js";
import type { ChatGptAccountRead } from "@/hooks/useChatGptAccount.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
vi.mock("@/hooks/usePlatform.js", () => ({ usePlatform: () => ({ openExternal: vi.fn() }) }));
vi.mock("@/logger.js", () => ({ logger: { warn: vi.fn() } }));
afterEach(cleanup);

function account(beginLogin: ChatGptAccountRead["beginLogin"]): ChatGptAccountRead {
  return {
    status: { status: "not-connected" },
    loading: false,
    refresh: vi.fn(),
    beginLogin,
    disconnect: vi.fn(async () => {}),
  };
}

describe("ChatGPT connection feedback", () => {
  it("can enter the workspace with an already connected account", async () => {
    const current = account(vi.fn());
    current.status = { status: "plan-enabled" };
    const onConnected = vi.fn();
    render(<ChatGptAccountCard account={current} onConnected={onConnected} />);
    fireEvent.click(
      screen.getByRole("button", { name: "settings.modelProvider.chatgpt.openWorkspace" }),
    );
    await waitFor(() => expect(onConnected).toHaveBeenCalledOnce());
    expect(current.beginLogin).not.toHaveBeenCalled();
  });
  it.each(["unavailable", "failed", "rejected"])(
    "shows %s failure and permits retry",
    async (outcome) => {
      const beginLogin = vi.fn<ChatGptAccountRead["beginLogin"]>(async () => {
        if (outcome === "rejected") throw new Error("transport failed");
        if (outcome === "unavailable")
          return { result: "unavailable", reason: "login-bridge-not-configured" };
        return { result: "failed", code: "chatgpt_browser_open_failed", message: "private detail" };
      });
      render(<ChatGptAccountCard account={account(beginLogin)} />);
      fireEvent.click(
        screen.getByRole("button", { name: "settings.modelProvider.chatgpt.continue" }),
      );
      await waitFor(() =>
        expect(screen.getByRole("alert").textContent).toContain("chatgpt.error."),
      );
      expect(screen.queryByText("private detail")).toBeNull();
      fireEvent.click(
        screen.getByRole("button", { name: "settings.modelProvider.chatgpt.continue" }),
      );
      await waitFor(() => expect(beginLogin).toHaveBeenCalledTimes(2));
    },
  );

  it("completes onboarding after plan-enabled login", async () => {
    const onConnected = vi.fn();
    render(
      <ChatGptAccountCard
        account={account(async () => ({
          result: "completed",
          status: { status: "plan-enabled" },
        }))}
        onConnected={onConnected}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "settings.modelProvider.chatgpt.continue" }),
    );
    await waitFor(() => expect(onConnected).toHaveBeenCalledOnce());
  });

  it("keeps disconnect available when quota is exhausted without suggesting reauthorization", () => {
    const current = account(vi.fn());
    current.status = { status: "quota-exhausted" };
    render(<ChatGptAccountCard account={current} />);
    expect(
      screen.getByRole("button", { name: "settings.modelProvider.chatgpt.disconnect" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "settings.modelProvider.chatgpt.continue" }),
    ).toBeNull();
  });
});
