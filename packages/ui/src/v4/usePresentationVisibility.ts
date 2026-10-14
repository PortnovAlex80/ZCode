import { useSyncExternalStore } from "react";

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
 */

function subscribeDocumentVisibility(listener: () => void): () => void {
  if (typeof document === "undefined" || typeof document.addEventListener !== "function") {
    return () => {};
  }
  document.addEventListener("visibilitychange", listener);
  return () => {
    document.removeEventListener("visibilitychange", listener);
  };
}

function getDocumentVisible(): boolean {
  if (typeof document === "undefined" || typeof document.visibilityState !== "string") {
    // 最小 DOM 测试环境可能没有 visibilityState；按可见处理，不改变既有行为。
    return true;
  }
  return document.visibilityState !== "hidden";
}

/** 文档级可见性（window 最小化/整页隐藏）。useSyncExternalStore 保证 hydrate/teardown 一致。 */
export function useDocumentVisibility(): boolean {
  return useSyncExternalStore(subscribeDocumentVisibility, getDocumentVisible, () => true);
}

/**
 * 宿主展示可见性 ∧ 文档级可见性。宿主输入为 true（缺省）时行为与旧版完全一致；
 * 返回 false 期间展示推导按各消费点自行冻结，控制面不读取本值。
 */
export function useCombinedPresentationVisibility(presentationVisible: boolean): boolean {
  const documentVisible = useDocumentVisibility();
  return presentationVisible && documentVisible;
}
