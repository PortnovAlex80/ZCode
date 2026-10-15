import type { ComponentProps } from "react";
import type { ChatGptAccountRead } from "@/hooks/useChatGptAccount.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ChatGptAccountCard } from "./ChatGptAccountCard.js";
import { InlineEditableProviderCard } from "./InlineEditableProviderCard.js";

type ModelControls = Omit<
  ComponentProps<typeof InlineEditableProviderCard>,
  | "provider"
  | "onDelete"
  | "onTestModel"
  | "readOnlyEndpoints"
  | "nameEditable"
  | "headerVisible"
  | "statusSection"
>;

/** 账号投影拥有鉴权与目录；此处只装配已有 Personal model commands。 */
export function ChatGptProviderPanel({
  account,
  provider,
  ...controls
}: ModelControls & {
  account?: ChatGptAccountRead;
  provider: ComponentProps<typeof InlineEditableProviderCard>["provider"] | null;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div className="space-y-3">
      {account?.status ? (
        <ChatGptAccountCard account={account} />
      ) : (
        <p role="status" className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({
            id: account?.loading
              ? "common.loading"
              : "settings.modelProvider.chatgpt.models.unavailable",
          })}
        </p>
      )}
      <p className="text-ui-sm text-foreground-subtle">
        {intl.formatMessage({ id: "settings.modelProvider.chatgpt.manualModels" })}
      </p>
      {!provider?.models.length ? (
        <p role="status" className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "settings.modelProvider.chatgpt.noModels" })}
        </p>
      ) : null}
      {provider ? (
        <InlineEditableProviderCard
          {...controls}
          provider={provider}
          headerVisible={false}
          nameEditable={false}
          readOnlyEndpoints
        />
      ) : null}
    </div>
  );
}
