export interface DiscussionBounds {
  width: number;
  height: number;
}
export interface DiscussionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export type DiscussionMode = "docked" | "floating";
export type DiscussionGestureKind = "move" | "resize-floating" | "resize-docked";
export interface DiscussionGesture {
  kind: DiscussionGestureKind;
  startX: number;
  startY: number;
  start: DiscussionRect;
}
export const MIN_DISCUSSION_WIDTH = 224;
export const MIN_DISCUSSION_HEIGHT = 320;
export const MIN_DOCUMENT_WIDTH = 160;
export const MIN_DOCUMENT_HEIGHT = 160;
export const DEFAULT_DISCUSSION_RECT: DiscussionRect = { x: 12, y: 12, width: 300, height: 440 };

function finite(value: number, fallback: number) {
  return Number.isFinite(value) ? value : fallback;
}
function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, finite(value, minimum)));
}
export function clampDiscussionRect(
  rect: DiscussionRect,
  bounds: DiscussionBounds,
): DiscussionRect {
  const availableWidth = Math.max(0, finite(bounds.width, 0));
  const availableHeight = Math.max(0, finite(bounds.height, 0));
  const width = clamp(rect.width, Math.min(MIN_DISCUSSION_WIDTH, availableWidth), availableWidth);
  const height = clamp(
    rect.height,
    Math.min(MIN_DISCUSSION_HEIGHT, availableHeight),
    availableHeight,
  );
  return {
    width,
    height,
    x: clamp(rect.x, 0, availableWidth - width),
    y: clamp(rect.y, 0, availableHeight - height),
  };
}
export function dockedDiscussionLayout(rect: DiscussionRect, bounds: DiscussionBounds) {
  const stacked = bounds.width < MIN_DISCUSSION_WIDTH + MIN_DOCUMENT_WIDTH;
  return stacked
    ? {
        stacked,
        width: Math.max(0, bounds.width),
        height: clamp(
          rect.height,
          MIN_DISCUSSION_HEIGHT,
          Math.max(MIN_DISCUSSION_HEIGHT, bounds.height - MIN_DOCUMENT_HEIGHT),
        ),
      }
    : {
        stacked,
        width: clamp(rect.width, MIN_DISCUSSION_WIDTH, bounds.width - MIN_DOCUMENT_WIDTH),
        height: undefined,
      };
}
export function updateDiscussionGesture(
  gesture: DiscussionGesture,
  x: number,
  y: number,
  bounds: DiscussionBounds,
): DiscussionRect {
  const dx = x - gesture.startX;
  const dy = y - gesture.startY;
  if (gesture.kind === "move")
    return clampDiscussionRect(
      { ...gesture.start, x: gesture.start.x + dx, y: gesture.start.y + dy },
      bounds,
    );
  if (gesture.kind === "resize-docked") {
    const width = dockedDiscussionLayout(
      { ...gesture.start, width: gesture.start.width - dx },
      bounds,
    ).width;
    return { ...gesture.start, width };
  }
  return clampDiscussionRect(
    { ...gesture.start, width: gesture.start.width + dx, height: gesture.start.height + dy },
    bounds,
  );
}
export function cancelDiscussionGesture(
  gesture: DiscussionGesture,
  bounds: DiscussionBounds,
): DiscussionRect {
  return clampDiscussionRect(gesture.start, bounds);
}
export function keyboardDiscussionGeometry(
  rect: DiscussionRect,
  kind: DiscussionGestureKind,
  key: string,
  shift: boolean,
  bounds: DiscussionBounds,
): DiscussionRect {
  const step = shift ? 32 : 8;
  const dx = key === "ArrowLeft" ? -step : key === "ArrowRight" ? step : 0;
  const dy = key === "ArrowUp" ? -step : key === "ArrowDown" ? step : 0;
  return updateDiscussionGesture({ kind, startX: 0, startY: 0, start: rect }, dx, dy, bounds);
}
