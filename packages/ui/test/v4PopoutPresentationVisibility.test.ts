// @vitest-environment jsdom
/**
 * 渲染性能 Wave A × U-06/U-07 集成回归：Document PiP popout 下的 presentation
 * visibility 文档路由。
 *
 * 集成规则（RENDERING-PERFORMANCE-WAVES-PROMPT「Prepare the combined result」）：
 * window 工作新增了 portal/PiP 宿主后，可见性与生命周期路由必须跟随**实际挂载的
 * 宿主文档**——主文档隐藏不得冻结仍展示在 PiP 窗口里的会话；PiP 文档隐藏则照常冻结。
 * 本套件用假 documentPictureInPicture（jsdom 无法开真实 PiP 窗口）验证：
 * - 停靠：主文档 hidden → presented=false（Wave A 原语义，集成不回退）；
 * - 弹出：主文档 hidden + PiP 可见 → presented=true（本集成的核心断言）；
 * - 弹出：PiP hidden + 主文档可见 → presented=false（反向不漏冻结）；
 * - 返回：恢复主文档裁决。
 * useSyncExternalStore 的重渲染经调度器微任务落盘，visibility 断言前先 flush。
 */
import { cleanup, render, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SpecPopoutRegionPortal,
  useSpecPopoutRegion,
  type SpecPopoutRegion,
} from "@/spec-document/specPopoutRegion.js";
import type { SpecPopoutWindow } from "@/spec-document/specPopoutWindow.js";
import { useCombinedPresentationVisibility } from "@/v4/usePresentationVisibility.js";

interface FakeWindow extends SpecPopoutWindow {
  pagehideListeners: Set<() => void>;
}

function installFakePiP() {
  const windows: FakeWindow[] = [];
  const api = {
    async requestWindow() {
      const pipDocument = document.implementation.createHTMLDocument("pip");
      const pip = {
        document: pipDocument,
        innerWidth: 480,
        innerHeight: 640,
        pagehideListeners: new Set<() => void>(),
        close() {
          for (const listener of Array.from(pip.pagehideListeners)) listener();
        },
        addEventListener(_type: "pagehide", listener: () => void) {
          pip.pagehideListeners.add(listener);
        },
        removeEventListener(_type: "pagehide", listener: () => void) {
          pip.pagehideListeners.delete(listener);
        },
      } as FakeWindow;
      windows.push(pip);
      return pip;
    },
  };
  Object.defineProperty(window, "documentPictureInPicture", {
    configurable: true,
    value: api,
  });
  return windows;
}

function setDocVisibility(doc: Document, state: "visible" | "hidden") {
  Object.defineProperty(doc, "visibilityState", { configurable: true, value: state });
  doc.dispatchEvent(new Event("visibilitychange"));
}

/** useSyncExternalStore 的 store 更新走调度器微任务；断言前统一 flush 一个宏任务拍。 */
const flushPresentationUpdates = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function PresentationProbe() {
  const presented = useCombinedPresentationVisibility(true);
  return createElement(
    "span",
    { "data-presentation-probe": presented ? "true" : "false" },
    presented ? "presented" : "frozen",
  );
}

let regionRef: SpecPopoutRegion | null = null;
function RegionHost() {
  const region = useSpecPopoutRegion({
    regionId: "probe-chat",
    workspaceKey: "ws",
    title: "Чат",
  });
  regionRef = region;
  return createElement(
    "div",
    null,
    createElement("div", { ref: region.anchorRef }),
    createElement(SpecPopoutRegionPortal, {
      region,
      title: "Чат",
      children: createElement(PresentationProbe),
    }),
  );
}

function probeOutput(): string | null {
  return document.querySelector("[data-presentation-probe]")?.textContent ?? null;
}

function pipProbeOutput(pip: FakeWindow): string | null {
  return pip.document.querySelector("[data-presentation-probe]")?.textContent ?? null;
}

describe("presentation visibility routing across Document PiP hosts (Wave A x U-06/U-07)", () => {
  let windows: FakeWindow[];

  beforeEach(() => {
    cleanup();
    regionRef = null;
    windows = installFakePiP();
    render(createElement(RegionHost));
  });

  afterEach(() => {
    cleanup();
    delete (window as { documentPictureInPicture?: unknown }).documentPictureInPicture;
  });

  it("停靠时主文档 hidden 冻结展示（Wave A 原语义不被集成回退）", async () => {
    expect(probeOutput()).toBe("presented");
    setDocVisibility(document, "hidden");
    await waitFor(() => expect(probeOutput()).toBe("frozen"));
    setDocVisibility(document, "visible");
    await waitFor(() => expect(probeOutput()).toBe("presented"));
  });

  it("弹出后主文档 hidden 不冻结 PiP 里仍展示的会话；PiP hidden 才冻结", async () => {
    await regionRef!.open();
    const pip = windows[0]!;
    await waitFor(() => expect(regionRef!.popped).toBe(true));
    // 子树已实际移入 PiP 文档（宿主声明与 DOM 归属一致）。
    await waitFor(() => expect(pipProbeOutput(pip)).toBe("presented"));

    // 主文档最小化/隐藏：PiP 窗口仍展示 → 不得冻结。
    setDocVisibility(document, "hidden");
    await flushPresentationUpdates();
    expect(pipProbeOutput(pip)).toBe("presented");

    // PiP 文档隐藏（PiP 窗口最小化）→ 冻结；恢复 → 解冻。
    setDocVisibility(pip.document, "hidden");
    await waitFor(() => expect(pipProbeOutput(pip)).toBe("frozen"));
    setDocVisibility(pip.document, "visible");
    await waitFor(() => expect(pipProbeOutput(pip)).toBe("presented"));
  });

  it("返回原位后恢复主文档裁决", async () => {
    await regionRef!.open();
    const pip = windows[0]!;
    await waitFor(() => expect(regionRef!.popped).toBe(true));
    setDocVisibility(document, "hidden");
    await waitFor(() => expect(pipProbeOutput(pip)).toBe("presented"));

    regionRef!.close();
    await waitFor(() => expect(regionRef!.popped).toBe(false));
    // 回到主文档锚点后，主文档 hidden 恢复冻结语义。
    await waitFor(() => expect(probeOutput()).toBe("frozen"));
    setDocVisibility(document, "visible");
    await waitFor(() => expect(probeOutput()).toBe("presented"));
  });
});
