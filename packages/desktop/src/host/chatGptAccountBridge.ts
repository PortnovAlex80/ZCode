import {
  createSharedZCodeCredentialStore,
  runChatGptLogin,
  runChatGptLogout,
} from "@zcode/adapters/auth";
import { getAppConfigDir, resolveCredentialFilePath } from "@zcode/services/node";

/**
 * ChatGPT（Sign in with ChatGPT）账号桥：Desktop Host 装配层对 agent 侧
 * adapters 登录/登出流程的进程内代理，注入 createLocalServices({ chatGptAccount })。
 *
 * - 桥的创建必须零副作用：不解析凭据路径、不建 store、不启动浏览器；只有
 *   ChatGptAccountService 调用 loginBridge/logoutBridge 时才进入 adapters 流程
 *   （loopback + PKCE + JWKS + 系统浏览器，全部由 runChatGptLogin 收口）。
 *   未注入桥的宿主（server / remote）保持 beginLogin 的 typed 不可用结果，
 *   不发任何网络请求——本桥不改变该 fail-closed 语义。
 * - 凭据必须落在 Host credentialService 与 ChatGPT-aware 投影共同监听的同一份
 *   credentials.json：显式按 Host 数据根（getAppConfigDir 感知 ZCODE_DATA_BASE_DIR
 *   与自定义 dataBaseDir）解析 filePath，不依赖 adapters 的 homedir 默认解析。
 * - 登录成功后由共享凭据文件的监听驱动投影刷新，无需向 service 回传结果；
 *   adapters 的类型化错误（code/message）原样抛出，由 beginLogin 映射为 failed。
 */
export interface DesktopChatGptAccountBridgeOptions {
  /** OAuth 端点与凭据密钥解析使用的环境；缺省为 Host 进程 env。 */
  readonly env?: Record<string, string | undefined>;
  /** 测试注入的凭据文件路径；缺省按 Host 数据根解析。 */
  readonly credentialFilePath?: string;
  /** Main's acknowledged native browser operation (utilityProcess must not spawn a shell). */
  readonly openExternal?: (url: string) => Promise<void>;
}

/** createLocalServices 的 chatGptAccount 注入形状（loginBridge/logoutBridge）。 */
export interface DesktopChatGptAccountBridges {
  readonly loginBridge: () => Promise<void>;
  readonly logoutBridge: () => Promise<{ revoked: boolean }>;
}

export function createDesktopChatGptAccountBridges(
  options: DesktopChatGptAccountBridgeOptions = {},
): DesktopChatGptAccountBridges {
  const env = options.env ?? process.env;
  // 惰性解析与创建：调用期才触碰路径/store，保证组合期零副作用。
  const createStore = () =>
    createSharedZCodeCredentialStore({
      env,
      filePath: options.credentialFilePath ?? resolveCredentialFilePath(getAppConfigDir()),
    });
  return {
    async loginBridge() {
      await runChatGptLogin({
        store: createStore(),
        env,
        ...(options.openExternal
          ? {
              openBrowser: async (url: string) => {
                try {
                  await options.openExternal!(url);
                  return { command: "electron.shell.openExternal", opened: true };
                } catch {
                  return { command: "electron.shell.openExternal", opened: false };
                }
              },
            }
          : {}),
      });
    },
    async logoutBridge() {
      const { revoked } = await runChatGptLogout({ store: createStore(), env });
      return { revoked };
    },
  };
}
