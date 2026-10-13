import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function readSource(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("WorkspaceShellLayout resize auto-collapse", () => {
  it("waits for window resize idle before collapsing conversation panels", () => {
    const layoutSource = readSource("packages/ui/src/app-shell/WorkspaceShellLayout.tsx");

    expect(layoutSource).toContain("CONVERSATION_AUTO_COLLAPSE_RESIZE_IDLE_MS");
    expect(layoutSource).toContain("conversationAutoCollapseResizeTimerRef");
    expect(layoutSource).toMatch(/window\.setTimeout\(\s*\(\) => \{/u);
    expect(layoutSource).toMatch(/\},\s*CONVERSATION_AUTO_COLLAPSE_RESIZE_IDLE_MS,?\s*\);/u);
    expect(layoutSource).toContain(
      "window.clearTimeout(conversationAutoCollapseResizeTimerRef.current)",
    );
    expect(layoutSource).not.toContain("conversationAutoCollapseFrameRef");
  });

  it("keeps the auto-collapse listener untouched by the U-01 layout swap arrangement", () => {
    const layoutSource = readSource("packages/ui/src/app-shell/WorkspaceShellLayout.tsx");

    // 自动收起仍只挂在 chat 主视图且只注册一个 window resize 监听；
    // 阈值判定读的是 conversation 面板的实测宽度（getBoundingClientRect），
    // «Документ в центре»只是改变面板视觉位置，测量与收起语义不变。
    const resizeListeners = layoutSource.match(
      /window\.addEventListener\("resize", handleWindowResize\)/gu,
    );
    expect(resizeListeners).toHaveLength(1);
    expect(layoutSource).toContain('if (workspaceMainView !== "chat") {');
    expect(layoutSource).toMatch(
      /conversationPanelElementRef\.current\?\.getBoundingClientRect\(\)\.width/u,
    );
    expect(layoutSource).toContain("CONVERSATION_AUTO_COLLAPSE_SIDE_PANE_WIDTH_PX");
    expect(layoutSource).toContain("CONVERSATION_AUTO_COLLAPSE_SIDEBAR_WIDTH_PX");
    // 交换排列不改变收起动作：仍是 handleToggleSidePane / handleToggleSidebar。
    expect(layoutSource).toMatch(/collapseSidePane\(\);/u);
    expect(layoutSource).toMatch(/collapseSidebar\(\);/u);
  });
});
