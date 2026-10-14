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
    // 修复原因：断言停在旧的 `hideTurnNavigator ? null : (` 文本上，而基线 f6d3678e
    // 的 rail 挂载门已由 wave-6 升级为 `hideTurnNavigator || 窄容器 < 864px`（rail 由
    // container query 裁决后，窄视口也不得挂载会遍历全部历史的导航目录）。此处按当前
    // 已提交行为更新断言；该项在基线上就是失败的（见审计记录的预存在失败清单）。
    expect(source.slice(navigatorIndex - 160, navigatorIndex)).toContain(
      "hideTurnNavigator || turnNavigatorContainerWidthPx < 864 ? null : (",
    );
  });
});
