import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Windows 工作区经 git autocrlf 是 CRLF，断言按 LF 编写；读取后归一化行尾，Linux 上是无操作。
const readTimelineSource = () =>
  readFileSync("packages/ui/src/v4/ConversationTimeline.tsx", "utf8").replaceAll("\r\n", "\n");

describe("ConversationTimeline scrollbar gutter", () => {
  it("reserves stable scrollbar space on the shared conversation viewport", () => {
    const source = readTimelineSource();

    expect(source).toContain("overflow-y-auto [scrollbar-gutter:stable]");
  });

  it("exposes and applies the share selection scroll lock", () => {
    const source = readTimelineSource();

    expect(source).toContain(
      'data-v4-timeline-scroll-locked={backgroundScrollLocked ? "true" : "false"}',
    );
    expect(source).toContain('backgroundScrollLocked && "!overflow-y-hidden"');
  });

  it("share selection mode hides the turn navigator so the share flow owns the left rail", () => {
    const source = readTimelineSource();
    const navigatorIndex = source.indexOf("<ConversationTurnNavigator\n");

    expect(navigatorIndex).toBeGreaterThan(-1);
    // ab298827（Spec Harness 移植）在 hideTurnNavigator 之外追加
    // turnNavigatorContainerWidthPx < 864：窄视口的 rail 本就被 864px container query
    // 隐藏，不挂载可以避免流式更新仍遍历全部历史、拼接正文并生成 hover preview。
    // 分享选择独占左 rail 的不变量不变，这里按加宽后的挂载条件断言。
    expect(source.slice(navigatorIndex - 160, navigatorIndex)).toContain(
      "hideTurnNavigator || turnNavigatorContainerWidthPx < 864 ? null : (",
    );
  });
});
