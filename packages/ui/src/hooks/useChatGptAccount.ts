import { useCallback, useEffect, useReducer, useState } from "react";
import type { ChatGptAccountStatus } from "@zcode/shared";
import type { IChatGptAccountService } from "@zcode/services";
import { useOptionalServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";

export interface ChatGptAccountRead {
  /** undefined = 服务不可用（旧 host / 远端），UI 隐藏订阅入口。 */
  status: ChatGptAccountStatus | undefined;
  loading: boolean;
  refresh(): void;
  beginLogin(): Promise<
    | { result: "completed"; status: ChatGptAccountStatus }
    | { result: "unavailable"; reason: "login-bridge-not-configured" }
    | { result: "failed"; code: string; message: string }
  >;
  disconnect(): Promise<void>;
  refreshModels?: IChatGptAccountService["refreshModels"];
}

/**
 * ChatGPT（Sign in with ChatGPT）账号状态的 Renderer 订阅。
 *
 * 状态来自 Host 的 sanitized 投影（无 token）；凭据变化时 Host 事件会触发重读，
 * 同时 Registry 的模型选择 View 也独立刷新——两条订阅各自收敛，不在此处合并。
 */
export function useChatGptAccount(): ChatGptAccountRead {
  const services = useOptionalServices();
  const service = services?.chatGptAccountService;
  const [status, setStatus] = useState<ChatGptAccountStatus | undefined>(undefined);
  const [loading, setLoading] = useState(Boolean(service));
  const [reloadVersion, reload] = useReducer((value: number) => value + 1, 0);

  useEffect(() => {
    if (!service) {
      setStatus(undefined);
      setLoading(false);
      return;
    }
    let disposed = false;
    let receivedEvent = false;
    setLoading(true);
    void service
      .getStatus()
      .then((next) => {
        if (!disposed && !receivedEvent) setStatus(next);
      })
      .catch((error: unknown) => {
        if (!disposed) logger.warn("[chatgpt-account] 状态读取失败", { error });
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    const subscription = service.onDidChange((next) => {
      receivedEvent = true;
      if (!disposed) setStatus(next);
    });
    return () => {
      disposed = true;
      subscription.dispose();
    };
  }, [service, reloadVersion]);

  const beginLogin = useCallback(async () => {
    if (!service) {
      return {
        result: "unavailable" as const,
        reason: "login-bridge-not-configured" as const,
      };
    }
    const result = await service.beginLogin();
    if (result.result === "completed") setStatus(result.status);
    return result;
  }, [service]);

  const disconnect = useCallback(async () => {
    if (!service) return;
    const result = await service.disconnect();
    setStatus(result.status);
  }, [service]);

  const refreshModels = useCallback(async () => {
    if (!service?.refreshModels) return { result: "unavailable" as const };
    return service.refreshModels();
  }, [service]);

  return { status, loading, refresh: reload, beginLogin, disconnect, refreshModels };
}
