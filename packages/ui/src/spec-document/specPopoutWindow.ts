/**
 * U-06/U-07：Document Picture-in-Picture 弹出窗口控制器（renderer-only）。
 *
 * 边界（checklist U-06/U-07，用户请求 2026-10-14 «вынести в окно … плавали везде,
 * пин автоматический, иконками»）：
 * - 只用浏览器端 `documentPictureInPicture`（Electron 41 / Chromium ≥116）；不新增任何
 *   Main 进程窗口机制，不复活 RETIREMENT-2 已退役的 detach 栈——本模块是唯一的弹窗实现。
 * - 一个 App 只有一个 PiP 窗口（共享槽位）：第二个区域请求弹出时，先让在窗口里的
 *   区域自动返回原面板（状态由 React portal 保活的同一棵子树携带，无损）。
 * - PiP 窗口按规范自动置顶（automatic pin），不提供手动置顶开关。
 * - 尺寸按 workspace × 区域持久化；不可用时给出明确的 absent-with-reason。
 *
 * 本文件保持无 React 依赖：共享槽位、尺寸持久化、样式收养与可用性判定都是纯逻辑，
 * React 接线在 useSpecPopoutRegion（specPopoutRegion.tsx）。
 */

/** PiP 窗口的最小接口：测试里用假实现替换，不依赖 DOM lib 的完整类型。 */
export interface SpecPopoutWindow {
  document: Document;
  close(): void;
  innerWidth: number;
  innerHeight: number;
  addEventListener(type: "pagehide", listener: () => void): void;
  removeEventListener(type: "pagehide", listener: () => void): void;
}

export interface SpecPictureInPictureApi {
  requestWindow(options?: { width?: number; height?: number }): Promise<SpecPopoutWindow>;
}

type PopoutWindowHost = {
  documentPictureInPicture?: Partial<SpecPictureInPictureApi> | undefined;
};

export type SpecPopoutAvailability = { supported: true } | { supported: false; reason: string };

function currentHost(): PopoutWindowHost {
  return (globalThis as { window?: PopoutWindowHost }).window ?? {};
}

/**
 * Chromium < 116（或非 Chromium）运行时没有 documentPictureInPicture。
 * 原因字符串同时用于禁用态的 title/aria 说明（absent-with-reason）。
 */
export function readSpecPopoutAvailability(
  host: PopoutWindowHost = currentHost(),
): SpecPopoutAvailability {
  const api = host?.documentPictureInPicture;
  if (!api || typeof api.requestWindow !== "function") {
    return {
      supported: false,
      reason:
        "Separate windows need Document Picture-in-Picture (Chromium 116+ / Electron 41+); this runtime does not provide it.",
    };
  }
  return { supported: true };
}

export function readSpecPopoutApi(
  host: PopoutWindowHost = currentHost(),
): SpecPictureInPictureApi | null {
  const api = host?.documentPictureInPicture;
  return api && typeof api.requestWindow === "function" ? (api as SpecPictureInPictureApi) : null;
}

export const SPEC_POPOUT_SIZE_LIMITS = {
  minWidth: 320,
  maxWidth: 1920,
  minHeight: 240,
  maxHeight: 1080,
  defaultWidth: 480,
  defaultHeight: 640,
} as const;

export interface SpecPopoutSize {
  width: number;
  height: number;
}

export function clampSpecPopoutSize(size: Partial<SpecPopoutSize>): SpecPopoutSize {
  const { minWidth, maxWidth, minHeight, maxHeight, defaultWidth, defaultHeight } =
    SPEC_POPOUT_SIZE_LIMITS;
  const clamp = (value: unknown, min: number, max: number, fallback: number) =>
    typeof value === "number" && Number.isFinite(value)
      ? Math.min(max, Math.max(min, Math.round(value)))
      : fallback;
  return {
    width: clamp(size.width, minWidth, maxWidth, defaultWidth),
    height: clamp(size.height, minHeight, maxHeight, defaultHeight),
  };
}

/** 尺寸键按 区域 × workspace identity（无 identity 用路径，与其它 spec-harness 键一致）。 */
export function specPopoutSizeKey(regionId: string, workspaceKey: string): string {
  return `spec-harness-popout-size:v1:${regionId}:${JSON.stringify(
    workspaceKey.replaceAll("\\", "/").replace(/\/$/, ""),
  )}`;
}

type StoragePort = Pick<Storage, "getItem" | "setItem">;

export function readSpecPopoutSize(key: string, storage?: StoragePort): SpecPopoutSize {
  try {
    storage ??= globalThis.localStorage ?? undefined;
    const value = JSON.parse(storage?.getItem(key) || "null");
    if (!value || value.version !== 1) return clampSpecPopoutSize({});
    return clampSpecPopoutSize(value);
  } catch {
    return clampSpecPopoutSize({});
  }
}

export function writeSpecPopoutSize(
  key: string,
  size: SpecPopoutSize,
  storage?: StoragePort,
): boolean {
  try {
    storage ??= globalThis.localStorage ?? undefined;
    if (!storage) return false;
    storage.setItem(key, JSON.stringify({ version: 1, ...clampSpecPopoutSize(size) }));
    return true;
  } catch {
    return false;
  }
}

/**
 * 共享槽位：整个 App 同时最多一个 PiP 窗口（浏览器本身的约束，也符合 U-07 的
 * “ONE shared PiP slot per app”）。区域注册强制返回回调；请求弹出的区域先驱逐
 * 在窗口里的其它区域，再打开自己的窗口。
 */
const forcedReturnListeners = new Map<string, () => void>();

export function registerSpecPopoutForcedReturn(regionId: string, listener: () => void): () => void {
  forcedReturnListeners.set(regionId, listener);
  return () => {
    if (forcedReturnListeners.get(regionId) === listener) forcedReturnListeners.delete(regionId);
  };
}

/** 驱逐除 exceptRegionId 之外当前在 PiP 窗口里的区域；返回是否有人被驱逐。 */
export function forceReturnSpecPopoutOwner(exceptRegionId?: string): boolean {
  let displaced = false;
  for (const [regionId, listener] of forcedReturnListeners) {
    if (regionId === exceptRegionId) continue;
    displaced = true;
    listener();
  }
  return displaced;
}

/**
 * 把主文档的样式收养进 PiP 文档：直接克隆主文档 head 里的 <style> 与
 * <link rel="stylesheet"> 节点（PiP 文档会自行拉取同源 link），并同步
 * documentElement 的主题 class（dark/theme-zai-*，见 useTheme.ts）——PiP 文档默认
 * 无样式，缺了这步弹出窗口里是白板。不走 document.styleSheets：跨域表读取
 * cssRules 会抛错，且未加载完成的 link 不在集合里。
 */
export function adoptSpecPopoutStyles(from: Document, to: Document): void {
  to.documentElement.className = from.documentElement.className;
  for (const node of Array.from(from.head.querySelectorAll("style, link[rel~='stylesheet']"))) {
    if (node instanceof HTMLStyleElement) {
      to.head.appendChild(node.cloneNode(true));
      continue;
    }
    if (node instanceof HTMLLinkElement) {
      const link = to.createElement("link");
      for (const attribute of ["rel", "href", "type", "media", "crossOrigin"]) {
        const value = node.getAttribute(attribute);
        if (value !== null) link.setAttribute(attribute, value);
      }
      to.head.appendChild(link);
    }
  }
  if (to.body) to.body.style.margin = "0";
}
