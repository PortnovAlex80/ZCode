import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Plugin Store try mention commit", () => {
  it("keeps the hidden Settings workspace from consuming the one-shot prefill", () => {
    const shell = readFileSync(
      "packages/ui/src/app-shell/WorkspaceShellLayout.tsx",
      "utf8",
    );
    const workbench = readFileSync("packages/ui/src/v4/V4WorkspaceChatArea.tsx", "utf8");
    // ab298827（Spec Harness 移植）之后的不变量接线：
    // 1) shell 传入的 foregroundEnabled 除「工作区可见」外还要求通用聊天栏未折叠
    //    （2f90b0e3 只是把该属性折成多行，语义未变）；
    // 2) workbench 不再内联 focused={foregroundEnabled && focusedPaneId === leaf.paneId}，
    //    而是把 selected / foregroundEnabled 交给共享的 specGeneralChatLeafPresentation，
    //    由它算出 focused = selected && foregroundEnabled——隐藏的 Settings workspace
    //    仍然不可能提前消费 Plugin 试用的一次性预填。
    // 上游 v3.15.1（aac47556）的旧断言钉的是旧接线字符串，这里按新接线断言。
    const presentation = readFileSync(
      "packages/ui/src/spec-document/specGeneralChatCollapse.ts",
      "utf8",
    );

    expect(shell).toContain("isWorkspaceVisible && !generalChatCollapsed");
    expect(workbench).toContain("foregroundEnabled?: boolean;");
    expect(workbench).toContain("{...specGeneralChatLeafPresentation({");
    expect(workbench).toContain("selected: focusedPaneId === leaf.paneId,");
    expect(presentation).toContain("focused: options.selected && options.foregroundEnabled,");
  });
});
