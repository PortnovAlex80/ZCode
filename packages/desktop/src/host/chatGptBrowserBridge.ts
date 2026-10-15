import { randomUUID } from "node:crypto";
import { HostResponseTypes } from "@zcode/shared";

const OPEN_TIMEOUT_MS = 20_000;

/** Native browser launch belongs to Main; utilityProcess shell launch can silently do nothing. */
export function createChatGptBrowserBridge(
  send: (message: {
    type: typeof HostResponseTypes.ChatGptBrowserOpenRequest;
    requestId: string;
    url: string;
  }) => void,
  timeoutMs = OPEN_TIMEOUT_MS,
) {
  const pending = new Map<
    string,
    { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
  >();
  return {
    open(url: string): Promise<void> {
      const requestId = randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error("Native browser launch timed out."));
        }, timeoutMs);
        pending.set(requestId, { resolve, reject, timer });
        try {
          send({ type: HostResponseTypes.ChatGptBrowserOpenRequest, requestId, url });
        } catch {
          clearTimeout(timer);
          pending.delete(requestId);
          reject(new Error("Native browser launch is unavailable."));
        }
      });
    },
    accept(result: { requestId: string; ok: boolean }): void {
      const request = pending.get(result.requestId);
      if (!request) return;
      pending.delete(result.requestId);
      clearTimeout(request.timer);
      if (result.ok) request.resolve();
      else request.reject(new Error("Could not open the default browser."));
    },
  };
}
