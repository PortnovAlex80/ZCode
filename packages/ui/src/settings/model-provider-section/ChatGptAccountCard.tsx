import { useState } from "react";
import type { ChatGptAccountStatus } from "@zcode/shared";
import { CHATGPT_USAGE_SETTINGS_URL } from "@zcode/shared";
import { Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import type { ChatGptAccountRead } from "@/hooks/useChatGptAccount.js";
import { logger } from "@/logger.js";

/**
 * ChatGPT（Sign in with ChatGPT）订阅卡片——Manage models 的账号入口。
 *
 * 状态文案与操作按 Host sanitized 投影渲染（无 token）；quota-exhausted 时给官方
 * 用量管理入口。样式与 CodingPlanStatusActions 保持同一模式：主按钮 + outline 断开。
 */
export function ChatGptAccountCard({ account }: { account: ChatGptAccountRead }) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const [loginBusy, setLoginBusy] = useState(false);
  const [disconnectBusy, setDisconnectBusy] = useState(false);
  const snapshot = account.status;
  const status = snapshot?.status;

  // 服务不可用（旧 host / 远端 environment）或首读未完成时不占版面；
  // 状态到达后卡片出现，错误态由 status 键文案表达。
  if (!snapshot) {
    return null;
  }

  const connected = status === "connected" || status === "plan-enabled";
  const showLogin = !connected;
  const showDisconnect = connected;

  const handleLogin = async () => {
    setLoginBusy(true);
    try {
      const result = await account.beginLogin();
      if (result.result === "failed") {
        // 失败原因（typed SIWC 错误码 + 描述）落日志；UI 文案保持稳定，
        // 不把原始 message 直接渲染（可能含端点/region 细节，走 i18n 状态键）。
        logger.warn("[chatgpt-account] 登录失败", {
          code: result.code,
          message: result.message,
        });
      }
    } finally {
      setLoginBusy(false);
    }
  };

  const handleDisconnect = async () => {
    setDisconnectBusy(true);
    try {
      await account.disconnect();
    } catch (error) {
      logger.warn("[chatgpt-account] 断开失败", { error });
    } finally {
      setDisconnectBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card p-4 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            <span className="text-ui-base font-medium">
              {intl.formatMessage({
                id: "settings.modelProvider.chatgpt.title",
              })}
            </span>
            {status ? (
              <span className="rounded-full bg-surface px-1.5 py-px text-ui-xs font-medium leading-normal text-foreground-subtle">
                {intl.formatMessage({
                  id: resolveChatGptStatusLabelId(status),
                })}
              </span>
            ) : null}
          </div>
          <p className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({
              id: "settings.modelProvider.chatgpt.description",
            })}
          </p>
          {snapshot.email ? (
            <p className="text-ui-sm text-foreground-subtle" title={snapshot.email}>
              {snapshot.email}
              {snapshot.plan ? ` · ${snapshot.plan}` : ""}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-wrap justify-start gap-2">
          {showLogin ? (
            <Button type="button" size="lg" onClick={() => void handleLogin()} disabled={loginBusy}>
              {loginBusy ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
              {intl.formatMessage({
                id: "settings.modelProvider.chatgpt.continue",
              })}
            </Button>
          ) : null}
          {status === "quota-exhausted" ? (
            <Button
              type="button"
              variant="outline"
              size="lg"
              onClick={() => platform.openExternal(snapshot.usageUrl ?? CHATGPT_USAGE_SETTINGS_URL)}
            >
              {intl.formatMessage({
                id: "settings.modelProvider.chatgpt.manageUsage",
              })}
            </Button>
          ) : null}
          {showDisconnect ? (
            <Button
              type="button"
              variant="outline"
              size="lg"
              disabled={disconnectBusy}
              onClick={() => void handleDisconnect()}
            >
              {disconnectBusy ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
              {intl.formatMessage({
                id: "settings.modelProvider.chatgpt.disconnect",
              })}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function resolveChatGptStatusLabelId(status: ChatGptAccountStatus["status"]): string {
  switch (status) {
    case "not-connected":
      return "settings.modelProvider.chatgpt.status.notConnected";
    case "connected":
      return "settings.modelProvider.chatgpt.status.connected";
    case "plan-enabled":
      return "settings.modelProvider.chatgpt.status.planEnabled";
    case "reconnect-required":
      return "settings.modelProvider.chatgpt.status.reconnectRequired";
    case "restricted":
      return "settings.modelProvider.chatgpt.status.restricted";
    case "quota-exhausted":
      return "settings.modelProvider.chatgpt.status.quotaExhausted";
  }
}
