import { createContext, useCallback, useContext, useSyncExternalStore } from "react";

/**
 * Presentation visibility（渲染性能 Wave A）：会话表面是否「真实展示中」。
 *
 * 与既有两个可见性概念分工，不允许互相合并：
 * - `focused`：全局快捷键（Esc stop）/add-to-chat 的路由目标，多个可见分屏只有一个 focused；
 * - `telemetryVisible`：foreground UI telemetry 的口径；
 * - `presentationVisible`（本契约）：本 pane 的会话表面当前是否被宿主真实展示。
 *   为 false 时只暂停 token 频率的重量级展示推导（render units/plugin 派生/行渲染/
 *   展示时钟/几何读取/纯展示驱动的历史补拉）；订阅、control/lifecycle、execution-config
 *   源、permissions/问答、后台聚合与插件 live feed 全部保持存活。
 *
 * 隐藏来源（都路由到同一个布尔输入，不按「哪一侧」推断）：
 * force-mounted 隐藏侧栏 tab、折叠/文档居中被隐藏的主聊天、Settings 覆盖层、
 * 文档级隐藏（document.hidden，本 hook 负责折叠）、Markdown 讨论宿主不可见。
 *
 * 文档级可见性跟随「实际挂载宿主文档」（window/layout waves 7-8 集成，2026-10-14）：
 * Document PiP popout（U-06/U-07）把整个会话子树搬进独立 OS 窗口的 document——此时
 * 文档级可见性必须读 PiP 文档的 visibilityState，而不是主文档。宿主经
 * `PresentationHostDocumentContext` 声明实际文档（见 specPopoutRegion 的
 * SpecPopoutRegionPortal）；未声明时缺省主文档，行为与本 hook 引入前一致。
 * 主文档最小化不得冻结仍展示在 PiP 窗口里的会话；PiP 窗口最小化则照常冻结。
 */

/**
 * 当前展示宿主文档覆盖（null = 主文档）。由知道「子树实际住在哪个 document」的宿主
 * 提供（目前唯一提供者：SpecPopoutRegionPortal——弹出时 host 节点被 adopt 进 PiP 文档）。
 * 值是 Document | null 而非布尔：消费点（如运行时钟的 visibilitychange 追平）需要
 * 订阅正确文档的事件，不只是读一次布尔。
 */
export const PresentationHostDocumentContext = createContext<Document | null>(null);

type MaybeDocument = Document | undefined;

function resolvePresentationDocument(host: Document | null): MaybeDocument {
  if (host !== null) return host;
  return typeof document === "undefined" ? undefined : document;
}

function subscribeDocumentVisibility(doc: MaybeDocument, listener: () => void): () => void {
  if (!doc || typeof doc.addEventListener !== "function") {
    return () => {};
  }
  doc.addEventListener("visibilitychange", listener);
  return () => {
    doc.removeEventListener("visibilitychange", listener);
  };
}

function getDocumentVisible(doc: MaybeDocument): boolean {
  if (!doc || typeof doc.visibilityState !== "string") {
    // 最小 DOM 测试环境可能没有 visibilityState；按可见处理，不改变既有行为。
    return true;
  }
  return doc.visibilityState !== "hidden";
}

/**
 * 文档级可见性（window 最小化/整页隐藏），按传入文档裁决；null/undefined 缺省主文档。
 * useSyncExternalStore 保证 hydrate/teardown 一致。
 */
export function useDocumentVisibility(hostDocument?: Document | null): boolean {
  const doc = hostDocument ?? resolvePresentationDocument(null);
  const subscribe = useCallback(
    (listener: () => void) => subscribeDocumentVisibility(doc, listener),
    [doc],
  );
  const getSnapshot = useCallback(() => getDocumentVisible(doc), [doc]);
  return useSyncExternalStore(subscribe, getSnapshot, () => true);
}

/**
 * 当前展示实际所属的文档（宿主覆盖优先，缺省主文档；无 DOM 环境为 undefined）。
 * 需要订阅文档事件（如 visibilitychange 追平）的展示消费点应改用本结果，
 * 而不是全局 document——PiP 挂载子树的事件在 PiP 文档上。
 */
export function usePresentationDocument(): MaybeDocument {
  return resolvePresentationDocument(useContext(PresentationHostDocumentContext));
}

/**
 * 宿主展示可见性 ∧ 实际宿主文档级可见性。宿主输入为 true（缺省）时行为与旧版完全一致；
 * 返回 false 期间展示推导按各消费点自行冻结，控制面不读取本值。
 */
export function useCombinedPresentationVisibility(presentationVisible: boolean): boolean {
  const documentVisible = useDocumentVisibility(useContext(PresentationHostDocumentContext));
  return presentationVisible && documentVisible;
}
