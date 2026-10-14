// 评审 #2/finding 2 回归：讨论 PiP 弹出态的 per-thread 展示可见性路由（源码契约）。
//
// 缺陷（修复前）：`visible={popped || (visible && discussionsVisible && active)}` 在
// 弹出时给**所有**保留线程 visible=true，而 inactive 线程包装仍是 className="hidden"
// ——presentation/telemetry/问答门/native prepare（useSpecDiscussion 的 visible 输入，
// 可为未发送草稿线程建会话）都会为不可见线程开启。
//
// 修复：活跃线程判定保持在 popped OR 之外。此处按仓库既有先例
// （v4ConversationTimelineScrollbarGutter.test.ts）以源码契约钉住路由表达式的
// 结构性不变量：popped 只 OR 掉「宿主展示」半边，绝不吞掉 active-thread 判定。
// 完整 native-handoff 行为链（live projection + session 绑定）归属窗口owner的
// specDocumentModeSwitch/specDocumentPanePersistence 套件；文档级可见性路由的
// 行为证明见 packages/ui/test/v4PopoutPresentationVisibility.test.ts。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Windows 工作区经 git autocrlf 是 CRLF，断言按 LF 编写；读取后归一化行尾。
const source = readFileSync("packages/ui/src/spec-document/SpecDocumentPane.tsx", "utf8").replaceAll(
  "\r\n",
  "\n",
);

function discussionPaneCallSource(): string {
  const callIndex = source.indexOf("<SpecDiscussionPane");
  expect(callIndex).toBeGreaterThan(-1);
  const propsEnd = source.indexOf("onActivate", callIndex);
  expect(propsEnd).toBeGreaterThan(callIndex);
  return source.slice(callIndex, propsEnd);
}

describe("discussion popout per-thread visibility routing (review 2 / finding 2)", () => {
  it("visible 路由：popped 只 OR 掉宿主展示半边，active-thread 判定在 OR 之外", () => {
    const call = discussionPaneCallSource();
    const visibleMatch = call.match(/visible=\{([\s\S]*?)\n\s*\}/);
    expect(visibleMatch).not.toBeNull();
    // 结构不变量（空白归一化后）：`(popped || (visible && discussionsVisible)) && active`
    // —— 弹出时也只有当前展示线程 visible；非活跃线程（含未发送草稿）不得因弹出
    // 获得 presentation/telemetry/问答门/native prepare。
    const normalized = visibleMatch![1]!.replace(/\s+/g, "");
    expect(normalized).toContain(
      "(discussionPopout.popped||(visible&&discussionsVisible))&&thread.id===activeThreadId",
    );
  });

  it("非活跃线程包装仍是 hidden（弹出不改变 inactive 线程的展示事实源）", () => {
    const asideIndex = source.indexOf('aria-label="Fragment discussions"');
    expect(asideIndex).toBeGreaterThan(-1);
    const wrapperSlice = source
      .slice(asideIndex, asideIndex + 6000)
      .replace(/\s+/g, " ");
    expect(wrapperSlice).toContain(
      'thread.id === activeThreadId ? "flex min-h-0 flex-1 flex-col" : "hidden"',
    );
  });
});
