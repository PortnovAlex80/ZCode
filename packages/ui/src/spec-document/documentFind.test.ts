// @vitest-environment jsdom
// U-19 unit coverage：文内查找的纯逻辑——textarea 缓冲偏移与渲染 DOM 的 Range 收集。
// （面板级 Ctrl+F/导航行为在 specDocumentFindPane.test.tsx；CSS Highlight 注册表在
//  jsdom 缺失，apply 层走 no-op 分支，这里只测无环境依赖的收集器。）
import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import { collectDocumentFindRanges, findTextareaMatchOffsets } from "./documentFind.js";

describe("U-19 document find collectors", () => {
  it("textarea offsets are case-insensitive, non-overlapping and ordered", () => {
    const content = "Alpha beta ALPHA gamma beta";
    assert.deepEqual(findTextareaMatchOffsets(content, "alpha"), [0, 11]);
    assert.deepEqual(findTextareaMatchOffsets(content, "beta"), [6, 23]);
    // 重叠自包含查询不吃掉相邻命中：aaa 对 aa 命中 [0]，再从 2 起。
    assert.deepEqual(findTextareaMatchOffsets("aaa", "aa"), [0]);
    assert.deepEqual(findTextareaMatchOffsets(content, "  "), []);
    assert.deepEqual(findTextareaMatchOffsets(content, ""), []);
  });

  it("collects DOM ranges across text nodes and skips interactive elements", () => {
    const root = document.createElement("div");
    root.innerHTML = [
      "<p>Find me here and find me again</p>",
      "<p>no match</p>",
      "<button>find me in a button</button>",
      '<span data-doc-find-ignore="true">find me ignored</span>',
      "<p>tail FIND</p>",
    ].join("");
    const ranges = collectDocumentFindRanges(root, "find me");
    // 命中只来自第一段的两个文本命中；button 与 ignore 区域跳过。
    assert.equal(ranges.length, 2);
    assert.equal(ranges[0]!.startContainer.nodeType, Node.TEXT_NODE);
    assert.equal(ranges[0]!.toString().toLowerCase(), "find me");
    const tail = collectDocumentFindRanges(root, "tail");
    assert.equal(tail.length, 1);
    assert.equal(tail[0]!.toString(), "tail");
  });

  it("empty query collects nothing", () => {
    const root = document.createElement("div");
    root.textContent = "anything";
    assert.deepEqual(collectDocumentFindRanges(root, ""), []);
    expect(true).toBe(true);
  });
});
