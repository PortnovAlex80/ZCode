/**
 * 跨进程 E2E 的子进程驱动（ChatGPT refresh 竞态）。
 *
 * 由 tests/chatgpt-refresh-cross-process.e2e.test.ts 用 `node --import tsx` 以真实 OS
 * 进程拉起：真实文件锁、真实加密凭据文件、真实网络请求都发生在子进程里，主进程只
 * 托管 mock 授权服务器并做协议级断言。这正是线上事故形态——竞态发生在多个 CLI/Host
 * 进程之间，同进程协程测试盖不住 OS 级文件锁与 PID 回收。
 *
 * 协议：argv[2] 是 JSON 配置；阶段事件与最终结果各占一行 JSON（stdout）；
 * 失败 exit 1。
 */
import { createSharedZCodeCredentialStore } from "../../src/auth/shared-credentials.js";
import { createChatGptRequestAuthSource } from "../../src/auth/chatgpt/chatgpt-request-auth.js";

interface DriverConfig {
  credentialsPath: string;
  issuer: string;
  mode: "refresh" | "hang-before-request";
  secret: string;
}

function emit(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

async function main(): Promise<void> {
  const config = JSON.parse(process.argv[2] ?? "{}") as DriverConfig;
  const credentialStore = createSharedZCodeCredentialStore({
    env: { ZCODE_CREDENTIAL_SECRET: config.secret },
    filePath: config.credentialsPath,
  });
  const env = {
    ZCODE_CHATGPT_OAUTH_ISSUER: config.issuer,
    ZCODE_CHATGPT_API_BASE_URL: `${config.issuer}/v1`,
  };

  const fetchImpl =
    config.mode === "hang-before-request"
      ? (async (...args: Parameters<typeof globalThis.fetch>) => {
          // 模拟 leader 在「已拿到 refresh 锁、尚未发出请求」的临界区内被 kill：
          // 先报告阶段，然后永远不返回（不发请求，token 未被消耗）。
          emit({ phase: "in-refresh-critical-section" });
          await new Promise<never>(() => undefined);
          return globalThis.fetch(...args);
        }) as typeof globalThis.fetch
      : undefined;

  const source = createChatGptRequestAuthSource({
    store: credentialStore,
    env,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  const auth = await source.resolve({
    attempt: 1,
    providerId: "account:chatgpt",
    modelId: "gpt-6.1-sol",
  });
  emit({ token: auth?.apiKey ?? null });
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
