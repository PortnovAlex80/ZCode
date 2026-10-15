import { z } from "zod";

// 原因随 Account State 发送，必须与严格协议共用枚举，避免整份快照被拒绝。
// credential-failed 表示凭据获取/校验失败，不能据此断言 OAuth 已失效。
//
// 版本化约束（ChatGPT 订阅集成引入，2026-10-15）：该枚举出现在跨版本严格信封
// zcodeProviderUpdateAccountConfigParamsSchema.states[*].unavailableReason 里，
// 直接新增值（如 quota-exhausted/restricted）会让旧 Worker 拒收整条 Host 账号
// 快照。账号细粒度状态（quota-exhausted 等）一律走并行的
// chatGptAccountStatusSchema（专用 ChatGptAccount 服务频道，旧客户端不订阅即不受
// 影响）；本枚举未完成协议版本协商前不得扩展字面量。ChatGPT Provider 写入
// states 的 unavailableReason 只允许使用下方既有值。
export const accountProviderUnavailableReasonSchema = z.enum([
  "not-authenticated",
  "not-connected",
  "credential-failed",
  "not-entitled",
]);
export type AccountProviderUnavailableReason = z.infer<
  typeof accountProviderUnavailableReasonSchema
>;
