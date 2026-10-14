import assert from "node:assert/strict";
import { test } from "vitest";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import {
  cancelDiscussionGesture,
  clampDiscussionRect,
  DEFAULT_DISCUSSION_RECT,
  dockedDiscussionLayout,
  keyboardDiscussionGeometry,
  MIN_DISCUSSION_HEIGHT,
  MIN_DISCUSSION_WIDTH,
  MIN_DOCUMENT_HEIGHT,
  MIN_DOCUMENT_WIDTH,
  updateDiscussionGesture,
} from "./specDiscussionGeometry.js";

test("floating rect remains reachable after drag, resize and shrinking parent", () => {
  const bounds = { width: 700, height: 600 };
  const start = clampDiscussionRect(DEFAULT_DISCUSSION_RECT, bounds);
  const moved = updateDiscussionGesture(
    { kind: "move", startX: 10, startY: 20, start },
    5000,
    -5000,
    bounds,
  );
  assert.equal(moved.x + moved.width, bounds.width);
  assert.equal(moved.y, 0);
  const resized = updateDiscussionGesture(
    { kind: "resize-floating", startX: 0, startY: 0, start },
    5000,
    5000,
    bounds,
  );
  assert.equal(resized.width, bounds.width);
  assert.equal(resized.height, bounds.height);
  const small = clampDiscussionRect(resized, { width: 120, height: 180 });
  assert.deepEqual(small, { width: 120, height: 180, x: 0, y: 0 });
  assert.ok(
    small.width < MIN_DISCUSSION_WIDTH && small.height < MIN_DISCUSSION_HEIGHT,
    "a small parent bounds the floating viewport; its minimum-size controller must remain scrollable inside it",
  );
  for (const value of Object.values(
    clampDiscussionRect({ x: NaN, y: Infinity, width: -1, height: NaN }, bounds),
  ))
    assert.ok(Number.isFinite(value));
});

test("docked resizing preserves document space and narrow panels use reachable vertical flow", () => {
  const bounds = { width: 700, height: 600 };
  const large = dockedDiscussionLayout({ ...DEFAULT_DISCUSSION_RECT, width: 10000 }, bounds);
  assert.equal(large.stacked, false);
  assert.equal(large.width, bounds.width - MIN_DOCUMENT_WIDTH);
  const narrow = dockedDiscussionLayout(DEFAULT_DISCUSSION_RECT, { width: 240, height: 180 });
  assert.equal(narrow.stacked, true);
  assert.equal(narrow.width, 240);
  assert.ok(narrow.height! >= 320);
  assert.ok(
    MIN_DOCUMENT_HEIGHT + narrow.height! > 180,
    "short/narrow docked panes deliberately scroll as a column instead of collapsing the native composer or document",
  );
  const gesture = {
    kind: "resize-docked" as const,
    startX: 0,
    startY: 0,
    start: { ...DEFAULT_DISCUSSION_RECT },
  };
  assert.equal(updateDiscussionGesture(gesture, -5000, 0, bounds).width, 540);
  assert.deepEqual(cancelDiscussionGesture(gesture, bounds), DEFAULT_DISCUSSION_RECT);
});

test("keyboard movement and resizing use bounded geometry without mouse gestures", () => {
  const bounds = { width: 700, height: 600 };
  assert.equal(
    keyboardDiscussionGeometry(DEFAULT_DISCUSSION_RECT, "move", "ArrowRight", false, bounds).x,
    20,
  );
  assert.equal(
    keyboardDiscussionGeometry(DEFAULT_DISCUSSION_RECT, "move", "ArrowDown", true, bounds).y,
    44,
  );
  assert.equal(
    keyboardDiscussionGeometry(
      DEFAULT_DISCUSSION_RECT,
      "resize-floating",
      "ArrowRight",
      true,
      bounds,
    ).width,
    332,
  );
  assert.equal(
    keyboardDiscussionGeometry(DEFAULT_DISCUSSION_RECT, "resize-docked", "ArrowLeft", false, bounds)
      .width,
    308,
  );
});

test("actual pane keeps one aside and one keyed discussion subtree across dock/float/hide", async () => {
  const text = await readFile(new URL("./SpecDocumentPane.tsx", import.meta.url), "utf8");
  const source = ts.createSourceFile(
    "documents.tsx",
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const tags: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))
      tags.push(node.tagName.getText(source));
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.equal(tags.filter((tag) => tag === "aside").length, 1);
  assert.equal(tags.filter((tag) => tag === "SpecDiscussionPane").length, 1);
  assert.match(text, /key=\{thread.id\}/);
  assert.match(text, /data-discussion-mode=\{discussionMode\}/);
  // U-06 之后面板内的弹出窗口 portal 被重新授权，但只允许经由 specPopoutRegion
  // （renderer-only 的 Document PiP 机制）。旧断言“面板源码不得出现 createPortal”
  // 继续成立（portal 集中在 specPopoutRegion.tsx），不再是唯一的防线；这里同时
  // 钉住被授权的边界：面板只经 useSpecPopoutRegion 接线，不得直接开窗口，
  // 也不得回潮任何 Main 侧弹窗机制（RETIREMENT-2）。
  assert.equal(text.includes("createPortal("), false);
  assert.equal(text.includes("window.open("), false);
  assert.match(text, /useSpecPopoutRegion/);
  const popoutSource = await readFile(
    new URL("./specPopoutWindow.ts", import.meta.url),
    "utf8",
  );
  assert.match(popoutSource, /requestWindow/);
  assert.equal(popoutSource.includes("window.open("), false);
  assert.equal(popoutSource.includes("BrowserWindow"), false);
  assert.equal(popoutSource.includes("ipcRenderer"), false);
  assert.equal(popoutSource.includes("window.zcode"), false);
  // 评审修复回归（2026-10-14）：宿主节点在面板内必须是 display:contents 透传——
  // 创建处不得写死填充 class（w-full 的宿主在 contents 锚点下会把内容列挤到 0px）。
  const regionSource = await readFile(
    new URL("./specPopoutRegion.tsx", import.meta.url),
    "utf8",
  );
  assert.match(regionSource, /POPOUT_HOST_DOCKED_CLASS = "contents"/);
  assert.match(regionSource, /host\.className = POPOUT_HOST_DOCKED_CLASS;/);
  assert.match(text, /ResizeObserver/);
  assert.match(text, /onPointerCancel/);
  assert.match(text, /flex-col overflow-y-auto/);
  assert.match(text, /minHeight: MIN_DOCUMENT_HEIGHT/);
  assert.match(text, /relative flex min-h-0 shrink-0 flex-col/);
  assert.match(
    text,
    /absolute z-20 flex min-h-0 flex-col overflow-auto/,
    "short/narrow floating panes scroll instead of clipping the native composer and header controls",
  );
  assert.match(text, /flex shrink-0 items-center/);
  assert.match(
    text,
    /minWidth: MIN_DISCUSSION_WIDTH,\s+minHeight: MIN_DISCUSSION_HEIGHT,\s+flexShrink: 0/,
  );
});
