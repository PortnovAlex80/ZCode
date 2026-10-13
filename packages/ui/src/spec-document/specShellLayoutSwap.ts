/**
 * U-01 «Документ в центре」布局互换（中心聊天 ⇄ 整个右侧 tabs 容器）的本地呈现状态。
 *
 * 边界：这里只持久化「排列模式」这一呈现偏好（与 specDocumentPresentationState 同一
 * localStorage 模式，按 workspaceIdentity 隔离）；面板尺寸由 react-resizable-panels
 * 的 layoutId 持久化负责，会话/文档业务状态不经过本文件。
 */
export type SpecShellLayoutSwapMode = "chat-center" | "document-center";

/** 交换排列下文档（右侧 tabs 容器）初始占工作区的大头。 */
export const SPEC_SHELL_DOCUMENT_CENTER_SIDE_PANE_DEFAULT_SIZE = "62%";
export const SPEC_SHELL_DOCUMENT_CENTER_SIDE_PANE_MAX_SIZE = "80%";
export const SPEC_SHELL_DOCUMENT_CENTER_CONVERSATION_DEFAULT_SIZE = "38%";
export const SPEC_SHELL_DOCUMENT_CENTER_CONVERSATION_MIN_SIZE = "20%";

type StoragePort = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function specShellLayoutSwapKey(workspacePath: string, workspaceIdentity?: string): string {
  return `spec-harness-shell-layout-swap:v1:${
    workspaceIdentity?.trim() || workspacePath.replaceAll("\\", "/").replace(/\/$/, "")
  }`;
}

export function readSpecShellLayoutSwap(
  key: string,
  storage?: StoragePort,
): SpecShellLayoutSwapMode {
  try {
    storage ??= globalThis.localStorage;
    const value = JSON.parse(storage?.getItem(key) || "null");
    return value?.version === 1 && value.mode === "document-center"
      ? "document-center"
      : "chat-center";
  } catch {
    return "chat-center";
  }
}

export function writeSpecShellLayoutSwap(
  key: string,
  mode: SpecShellLayoutSwapMode,
  storage?: StoragePort,
): boolean {
  try {
    storage ??= globalThis.localStorage;
    if (!storage) return false;
    storage.setItem(key, JSON.stringify({ version: 1, mode }));
    return true;
  } catch {
    return false;
  }
}

export function toggleSpecShellLayoutSwapMode(
  mode: SpecShellLayoutSwapMode,
): SpecShellLayoutSwapMode {
  return mode === "document-center" ? "chat-center" : "document-center";
}

export function isSpecShellDocumentCenter(mode: SpecShellLayoutSwapMode): boolean {
  return mode === "document-center";
}

/**
 * RRP 的布局存储键按「布局记录的键序」拼接（useDefaultLayout 保存侧），
 * 而读取侧用 panelIds prop 的顺序拼同一个键。交换排列后面板顺序翻转，
 * panelIds 必须同步翻转，否则换位后读不回自己保存的尺寸。
 */
export function resolveSpecShellBodyPanelIds(
  documentCenter: boolean,
  basePanelIds: readonly string[],
): string[] {
  return documentCenter ? [...basePanelIds].reverse() : [...basePanelIds];
}

/** 交换排列使用独立的 layoutId 命名空间，两种排列各自记住自己的宽度。 */
export function specShellBodyLayoutId(baseLayoutId: string, documentCenter: boolean): string {
  return documentCenter ? `${baseLayoutId}:document-center` : baseLayoutId;
}

/**
 * U-01 视觉换位的落点：三个 flex item 的 order 恒为 聊天列=1 / 分隔条=2 / tabs 容器=3
 * （普通排列 = DOM 顺序），交换排列把两端对调（tabs=1、聊天=3），分隔条不动 —— 始终位于
 * 文档与聊天之间。
 *
 * 原因：RRP Panel 的 style prop 落在内层包装 div 上，外层 flex item 只能指令式写入
 * order；且库在面板重注册（约束变化）时按 offsetLeft 重排面板（浏览器中 offsetLeft
 * 反映 flex order），order 必须在重注册 effect 读取之前生效 —— 因此由宿主在渲染期
 * 调用本函数，而不是放到 effect 里。DOM 顺序与组件树保持稳定：chat/timeline 不重挂载，
 * browser <webview> guest 不被移动，拖拽与键盘方向跟随实际视觉位置。
 *
 * @returns 两个外层元素是否都已就绪（未就绪时保持未同步，等下一次渲染重试）。
 */
export function applySpecShellLayoutSwapOrders(
  conversationColumnElement: HTMLElement | null,
  sidePanePanelElement: HTMLElement | null,
  documentCenter: boolean,
): boolean {
  if (!conversationColumnElement || !sidePanePanelElement) return false;
  conversationColumnElement.style.setProperty("order", documentCenter ? "3" : "1");
  sidePanePanelElement.style.setProperty("order", documentCenter ? "1" : "3");
  return true;
}
