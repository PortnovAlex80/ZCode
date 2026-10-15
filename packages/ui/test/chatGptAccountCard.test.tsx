// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatGptAccountCard } from "@/settings/model-provider-section/ChatGptAccountCard.js";
import type { ChatGptAccountRead } from "@/hooks/useChatGptAccount.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }, values?: { httpStatus?: number }) =>
        values?.httpStatus ? `${id} HTTP ${values.httpStatus}` : id,
    },
  }),
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
  it("bounds a stalled catalog request and allows another retry", async () => {
    vi.useFakeTimers();
    try {
      const current = account(vi.fn());
      current.status = { status: "plan-enabled" };
      current.refreshModels = vi.fn(() => new Promise(() => {}));
      render(<ChatGptAccountCard account={current} />);
      const button = screen.getByRole("button", {
        name: "settings.modelProvider.chatgpt.models.refresh",
      }) as HTMLButtonElement;
      fireEvent.click(button);
      expect(button.disabled).toBe(true);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(button.disabled).toBe(false);
      expect(screen.getByRole("alert").textContent).toContain("models.failed");
    } finally {
      vi.useRealTimers();
    }
  });
  it("retries a 520 catalog failure without OAuth and reports returned models", async () => {
    const current = account(vi.fn());
    current.status = { status: "plan-enabled" };
    current.refreshModels = vi
      .fn()
      .mockResolvedValueOnce({ result: "failed", code: "private-detail", httpStatus: 520 })
      .mockResolvedValueOnce({ result: "completed", modelCount: 3 });
    render(<ChatGptAccountCard account={current} />);
    const button = screen.getByRole("button", {
      name: "settings.modelProvider.chatgpt.models.refresh",
    });
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("HTTP 520"));
    expect(screen.queryByText("private-detail")).toBeNull();
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("models.loaded"));
    expect(current.beginLogin).not.toHaveBeenCalled();
    expect(current.refreshModels).toHaveBeenCalledTimes(2);
  });

  it.each(["empty", "unavailable", "rejected"])(
    "reports %s catalog result and releases the button",
    async (outcome) => {
      const current = account(vi.fn());
      current.status = { status: "plan-enabled" };
      current.refreshModels = vi.fn(async () => {
        if (outcome === "rejected") throw new Error("private detail");
        if (outcome === "unavailable") return { result: "unavailable" as const };
        return { result: "completed" as const, modelCount: 0 };
      });
      render(<ChatGptAccountCard account={current} />);
      const button = screen.getByRole("button", {
        name: "settings.modelProvider.chatgpt.models.refresh",
      }) as HTMLButtonElement;
      fireEvent.click(button);
      await waitFor(() =>
        expect(screen.getByRole(outcome === "empty" ? "status" : "alert").textContent).toContain(
          `models.${outcome === "rejected" ? "failed" : outcome}`,
        ),
      );
      expect(button.disabled).toBe(false);
      expect(current.beginLogin).not.toHaveBeenCalled();
    },
  );
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
