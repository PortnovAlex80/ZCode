import { describe, expect, it, vi } from "vitest";
import { createChatGptAccountService } from "../src/model-provider/chatGptAccountService.js";

function credentials() {
  return { loadCredential: vi.fn(async () => null), deleteCredential: vi.fn(async () => {}) };
}

describe("ChatGPT model catalog retry", () => {
  it("fails closed without a configured bridge", async () => {
    const service = createChatGptAccountService(credentials());
    expect(await service.refreshModels()).toEqual({ result: "unavailable" });
  });

  it("preserves credentials on HTTP failure and retries without login", async () => {
    const store = credentials();
    const loginBridge = vi.fn(async () => {});
    const refreshModelsBridge = vi
      .fn()
      .mockResolvedValueOnce({ result: "failed", code: "models_http_error", httpStatus: 520 })
      .mockResolvedValueOnce({ result: "completed", modelCount: 2 });
    const service = createChatGptAccountService({ ...store, loginBridge, refreshModelsBridge });
    expect(await service.refreshModels()).toEqual({
      result: "failed",
      code: "models_http_error",
      httpStatus: 520,
    });
    expect(await service.refreshModels()).toEqual({ result: "completed", modelCount: 2 });
    expect(loginBridge).not.toHaveBeenCalled();
    expect(store.deleteCredential).not.toHaveBeenCalled();
  });

  it("coalesces retries and serializes disconnect before a subsequent retry", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const order: string[] = [];
    const refreshModelsBridge = vi.fn(async () => {
      order.push("refresh");
      await gate;
      return { result: "completed" as const, modelCount: 1 };
    });
    const service = createChatGptAccountService({
      ...credentials(),
      refreshModelsBridge,
      logoutBridge: async () => {
        order.push("logout");
        return { revoked: true };
      },
    });
    const first = service.refreshModels();
    const second = service.refreshModels();
    const logout = service.disconnect();
    const next = service.refreshModels();
    await Promise.resolve();
    expect(order).toEqual(["refresh"]);
    release();
    await Promise.all([first, second, logout, next]);
    expect(order).toEqual(["refresh", "logout", "refresh"]);
    expect(refreshModelsBridge).toHaveBeenCalledTimes(2);
  });

  it("does not expose unexpected bridge errors or remove credentials", async () => {
    const store = credentials();
    const service = createChatGptAccountService({
      ...store,
      refreshModelsBridge: async () => {
        throw new Error("secret token");
      },
    });
    expect(await service.refreshModels()).toEqual({
      result: "failed",
      code: "chatgpt_models_refresh_failed",
    });
    expect(store.deleteCredential).not.toHaveBeenCalled();
  });
});
