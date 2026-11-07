/**
 * 2026-11-07（用户裁决）：U-01 «Документ в центре»互换排列整体移除——3.17.2 起
 * 聊天是可自由移动的独立 widget，互换中心/右侧不再有场景。模式读写、独立
 * layoutId 命名空间与尺寸常量已删除；仅保留渲染期 order 重申（U-03：窗口 resize
 * 后 RRP 面板重注册按 offsetLeft 重排，order 必须在任何重注册前与视觉一致，
 * 否则分隔条拖拽方向颠倒）。order 恒为 聊天列=1 / tabs 容器=3；差量写入让
 * 每次渲染的重申零样式突变。
 *
 * @returns 两个外层元素是否都已就绪（未就绪时保持未同步，等下一次渲染重试）。
 */
export function applySpecShellLayoutSwapOrders(
  conversationColumnElement: HTMLElement | null,
  sidePanePanelElement: HTMLElement | null,
): boolean {
  if (!conversationColumnElement || !sidePanePanelElement) return false;
  applyElementOrder(conversationColumnElement, "1");
  applyElementOrder(sidePanePanelElement, "3");
  return true;
}

function applyElementOrder(element: HTMLElement, order: string) {
  if (element.style.order === order) return;
  element.style.setProperty("order", order);
}
