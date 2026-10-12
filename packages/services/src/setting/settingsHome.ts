import { homedir } from "node:os";

export function resolveSettingsHomeDir() {
  // 显式桌面 home 必须同时约束设置路径，避免独立实例写入真实用户配置。
  const envHome =
    process.env.ZCODE_DESKTOP_HOME_DIR?.trim() ||
    process.env.HOME?.trim() ||
    process.env.USERPROFILE?.trim();
  return envHome || homedir();
}
