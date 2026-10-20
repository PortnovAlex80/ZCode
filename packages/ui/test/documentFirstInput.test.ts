import { expect, test } from "vitest";
import { documentFirstInputBody } from "../src/v4/documentFirstInput.js";

// 上游 3.16.2 删除 planShortcut 斜杠命令：/plan 不再解包为任务正文，也不再被识别为
// 可见斜杠命令；文档上下文按原文冻结首条正文（不再还原快捷键 token，也不再改写）。
test("document context freezes native plan input verbatim instead of unwrapping its shortcut token", () => {
  expect(documentFirstInputBody("/plan explain this paragraph")).toBe("/plan explain this paragraph");
  expect(documentFirstInputBody("explain this paragraph")).toBe("explain this paragraph");
});
test("recognized native controls keep their admission path and never become contextual prompts", () => {
  expect(documentFirstInputBody("/compact")).toBeUndefined();
  expect(documentFirstInputBody("/goal replace ship it")).toBeUndefined();
  expect(documentFirstInputBody("/goal")).toBeUndefined();
  expect(documentFirstInputBody("/goal pause")).toBeUndefined();
});
