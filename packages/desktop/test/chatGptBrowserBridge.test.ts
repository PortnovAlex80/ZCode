import { afterEach, describe, expect, it, vi } from "vitest";
import { createChatGptBrowserBridge } from "../src/host/chatGptBrowserBridge.js";
import { launchChatGptBrowser } from "../src/main/chatGptBrowserLauncher.js";

afterEach(() => vi.useRealTimers());
describe("ChatGPT native browser acknowledgment", () => {
  it("waits for Main success and preserves all encoded authorization parameters", async () => {
    const openExternal = vi.fn(async () => {});
    const url =
      "https://auth.openai.com/api/accounts/authorize?client_id=dynamic_agent_client&state=test&code_challenge=abc";
    const bridge = createChatGptBrowserBridge((request) => {
      void launchChatGptBrowser(request.url, openExternal).then((ok) =>
        bridge.accept({ requestId: request.requestId, ok }),
      );
    });
    await expect(bridge.open(url)).resolves.toBeUndefined();
    expect(openExternal).toHaveBeenCalledWith(url);
  });
  it("rejects when Main cannot open the browser", async () => {
    const bridge = createChatGptBrowserBridge((request) =>
      bridge.accept({ requestId: request.requestId, ok: false }),
    );
    await expect(bridge.open("https://auth.openai.com/api/accounts/authorize")).rejects.toThrow(
      "default browser",
    );
  });
  it("never reports success merely because the acknowledgment timed out", async () => {
    vi.useFakeTimers();
    const bridge = createChatGptBrowserBridge(() => {}, 100);
    const pending = expect(
      bridge.open("https://auth.openai.com/api/accounts/authorize"),
    ).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(100);
    await pending;
  });
  it.each([
    "file:///C:/Windows/notepad.exe",
    "https://evil.example/",
    "https://auth.openai.com.evil.example/api/accounts/authorize",
    "https://auth.openai.com/other",
  ])("blocks unauthorized URL %s", async (url) => {
    const openExternal = vi.fn(async () => {});
    expect(await launchChatGptBrowser(url, openExternal)).toBe(false);
    expect(openExternal).not.toHaveBeenCalled();
  });
});
