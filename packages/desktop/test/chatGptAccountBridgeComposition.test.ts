import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 桥只应代理 adapters 的登录/登出流程；单测把 @zcode/adapters/auth 整体 mock 掉，
// 断言「桥传入 createLocalServices 后 beginLogin 不再 unavailable」，同时保证
// 不注入桥（缺服务实现）时 fail-closed：runChatGptLogin 一次都不会被调用（不启浏览器）。
const adaptersMock = vi.hoisted(() => ({
  runChatGptLogin: vi.fn(async () => ({
    account: { subject: "test-subject" },
    clientId: "test-client-id",
    firstRegistration: true,
    tokenSharingGranted: true,
    grantedScopes: ["chatgpt.tokens.use.direct"],
    models: [],
    credentialsPath: "credentials.json",
  })),
  runChatGptLogout: vi.fn(async () => ({
    revoked: true,
    credentialsPath: "credentials.json",
  })),
  createSharedZCodeCredentialStore: vi.fn((options: { filePath?: string } = {}) => ({
    filePath: options.filePath,
  })),
}));

vi.mock("@zcode/adapters/auth", () => adaptersMock);

const originalHome = process.env.HOME;
const tempHomes: string[] = [];

function makeTempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "zcode-chatgpt-bridge-composition-"));
  tempHomes.push(home);
  return home;
}

describe("desktop ChatGPT account bridge composition", () => {
  it("injects acknowledged native browser launch instead of the CLI shell launcher", async () => {
    const { createDesktopChatGptAccountBridges } =
      await import("../src/host/chatGptAccountBridge.js");
    const openExternal = vi.fn(async () => {});
    await createDesktopChatGptAccountBridges({
      openExternal,
      credentialFilePath: "test-credentials.json",
    }).loginBridge();
    const passed = (
      adaptersMock.runChatGptLogin.mock.calls as unknown as [
        { openBrowser: (url: string) => Promise<{ opened: boolean }> },
      ][]
    )[0]![0];
    const url = "https://auth.openai.com/api/accounts/authorize?state=probe&nonce=probe";
    await expect(passed.openBrowser(url)).resolves.toMatchObject({ opened: true });
    expect(openExternal).toHaveBeenCalledWith(url);
    openExternal.mockRejectedValueOnce(new Error("OS launch failed"));
    await expect(passed.openBrowser(url)).resolves.toMatchObject({ opened: false });
  });
  beforeEach(() => {
    adaptersMock.runChatGptLogin.mockClear();
    adaptersMock.runChatGptLogout.mockClear();
    adaptersMock.createSharedZCodeCredentialStore.mockClear();
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    vi.resetModules();
    for (const home of tempHomes.splice(0)) {
      // Windows 上句柄异步收口期间直接 rm 会 EPERM；沿用有界重试，清理失败不判红。
      try {
        rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      } catch {
        // 临时目录由操作系统回收。
      }
    }
  });

  it("bridge proxies login/logout lazily without touching the credential store at creation", async () => {
    const { createDesktopChatGptAccountBridges } =
      await import("../src/host/chatGptAccountBridge.js");

    const env = { ZCODE_CREDENTIAL_SECRET: "test-secret" };
    const credentialFilePath = join("D:", "temp", "credentials.json");
    const bridges = createDesktopChatGptAccountBridges({ env, credentialFilePath });

    // 组合期零副作用：不建 store、不进登录流程（不启动浏览器）。
    expect(adaptersMock.createSharedZCodeCredentialStore).not.toHaveBeenCalled();
    expect(adaptersMock.runChatGptLogin).not.toHaveBeenCalled();

    await expect(bridges.loginBridge()).resolves.toBeUndefined();
    expect(adaptersMock.runChatGptLogin).toHaveBeenCalledTimes(1);
    expect(adaptersMock.runChatGptLogin).toHaveBeenCalledWith({
      store: { filePath: credentialFilePath },
      env,
    });

    await expect(bridges.logoutBridge()).resolves.toEqual({ revoked: true });
    expect(adaptersMock.runChatGptLogout).toHaveBeenCalledTimes(1);
    expect(adaptersMock.runChatGptLogout).toHaveBeenCalledWith({
      store: { filePath: credentialFilePath },
      env,
    });
  });

  it("resolves the credential file from the host data root (ZCODE_DATA_BASE_DIR-aware)", async () => {
    const home = makeTempHome();
    process.env.HOME = home;
    const { createDesktopChatGptAccountBridges } =
      await import("../src/host/chatGptAccountBridge.js");

    await createDesktopChatGptAccountBridges().loginBridge();

    // 与 Host credentialService / ChatGPT-aware 投影共用同一份 credentials.json。
    expect(adaptersMock.createSharedZCodeCredentialStore).toHaveBeenCalledWith({
      env: process.env,
      filePath: join(home, ".zcode", "v2", "credentials.json"),
    });
  });

  it("beginLogin is completed (not unavailable) when the bridge is passed to createLocalServices", async () => {
    const home = makeTempHome();
    process.env.HOME = home;
    const [{ createLocalServices, disposeServiceResources }, { IChatGptAccountService }] =
      await Promise.all([import("@zcode/services/node"), import("@zcode/services")]);
    const { createDesktopChatGptAccountBridges } =
      await import("../src/host/chatGptAccountBridge.js");

    const services = createLocalServices({
      zcodeBuiltinProviderConfigFilePath: join(
        import.meta.dirname,
        "../../../config/provider/zcode-builtin.json",
      ),
      chatGptAccount: createDesktopChatGptAccountBridges(),
    });

    try {
      const result = await services.get(IChatGptAccountService).beginLogin();

      expect(adaptersMock.runChatGptLogin).toHaveBeenCalledTimes(1);
      // mocked runChatGptLogin 不落凭据，状态投影仍为 not-connected；关键是
      // 组合注入桥后不再返回 unavailable（login-bridge-not-configured）。
      expect(result).toMatchObject({ result: "completed" });
      expect(result).not.toMatchObject({ result: "unavailable" });
    } finally {
      disposeServiceResources(services);
    }
  });

  it("without the bridge beginLogin stays fail-closed and never launches the login flow", async () => {
    const home = makeTempHome();
    process.env.HOME = home;
    const [{ createLocalServices, disposeServiceResources }, { IChatGptAccountService }] =
      await Promise.all([import("@zcode/services/node"), import("@zcode/services")]);

    const services = createLocalServices({
      zcodeBuiltinProviderConfigFilePath: join(
        import.meta.dirname,
        "../../../config/provider/zcode-builtin.json",
      ),
    });

    try {
      const result = await services.get(IChatGptAccountService).beginLogin();

      expect(result).toEqual({
        result: "unavailable",
        reason: "login-bridge-not-configured",
      });
      // fail-closed：不注入桥时不得进入 adapters 登录流程（不监听 loopback、不开浏览器）。
      expect(adaptersMock.runChatGptLogin).not.toHaveBeenCalled();
      expect(adaptersMock.createSharedZCodeCredentialStore).not.toHaveBeenCalled();
    } finally {
      disposeServiceResources(services);
    }
  });
});
