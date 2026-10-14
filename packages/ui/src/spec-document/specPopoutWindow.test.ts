// @vitest-environment jsdom
/**
 * U-06/U-07 聚焦套件：Document PiP 弹出窗口控制器（renderer-only）。
 *
 * jsdom 无法打开真实 PiP 窗口；本套件用假 documentPictureInPicture 覆盖控制器逻辑：
 * - 打开：尺寸按 区域×workspace 持久化读取并 clamp；样式收养（主题 class + <style> 拷贝）；
 * - 状态保活：portal host 是稳定节点——弹出/返回只挪 DOM，子树状态不丢（计数器演示）；
 * - 共享槽位：第二个区域弹出时先强制第一个回位（顺序：回位 → 再开窗）；
 * - 关闭：OS 关闭（pagehide）与 «вернуть»（close()）都恢复原位并持久化最终尺寸；
 * - 不可用：无 API 时 absent-with-reason（aria-disabled + 原因文案），不改动现有布局；
 * - Electron 活体缺陷回归（2026-10-14 实测 Electron 41/Chromium 146）：API 存在但
 *   availability 必须按不可用处理（#39633）；requestWindow 同步 throw 不卡死 opening；
 *   resolve 出 0×0 假窗口时内容留在原面板并给出可见错误。
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement, useState } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SpecPopoutIconButton,
  SpecPopoutRegionPortal,
  useSpecPopoutRegion,
  type SpecPopoutRegion,
} from "./specPopoutRegion.js";
import {
  adoptSpecPopoutStyles,
  clampSpecPopoutSize,
  forceReturnSpecPopoutOwner,
  readSpecPopoutAvailability,
  readSpecPopoutSize,
  registerSpecPopoutForcedReturn,
  specPopoutSizeKey,
  writeSpecPopoutSize,
  type SpecPopoutWindow,
} from "./specPopoutWindow.js";

/** jsdom 主文档注入一个真实 <style>，验证样式收养拷贝。 */
beforeEach(() => {
  localStorage.clear();
  const style = document.createElement("style");
  style.textContent = "body { color: red; }";
  style.setAttribute("data-test", "popout-style");
  document.head.appendChild(style);
  document.documentElement.className = "dark";
});

afterEach(() => {
  cleanup();
  for (const style of Array.from(document.head.querySelectorAll("style[data-test]")))
    style.remove();
  delete (window as { documentPictureInPicture?: unknown }).documentPictureInPicture;
});

/**
 * testing-library 的 fireEvent 要求节点属于“有 window 的文档”；假 PiP 文档
 * （implementation.createHTMLDocument）没有 defaultView，因此对 PiP 内节点派发
 * 主 window 构造的冒泡事件——与产品机制一致：React 的委托监听器挂在稳定 portal
 * host 节点上，host 移动到 PiP 文档后监听器随节点走，PiP 内冒泡到 host 即触发。
 */
function clickInPip(node: Element) {
  node.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
}

interface FakeWindow extends SpecPopoutWindow {
  pagehideListeners: Set<() => void>;
  closeCalls: number;
}

/** 假 API 的可变行为：测试中途可切换（同步 throw / 0×0 假窗口 → 恢复正常）。 */
interface FakePipBehavior {
  size: { width: number; height: number };
  throwSync: boolean;
}

function installFakePiP(initial?: Partial<FakePipBehavior>) {
  const behavior: FakePipBehavior = {
    size: { width: 480, height: 640 },
    throwSync: false,
    ...initial,
  };
  const windows: FakeWindow[] = [];
  const requests: ({ width?: number; height?: number } | undefined)[] = [];
  const api = {
    requestWindow(options?: { width?: number; height?: number }) {
      requests.push(options);
      if (behavior.throwSync) throw new Error("sync rejection before promise");
      const pipDocument = document.implementation.createHTMLDocument("pip");
      const pip = {
        document: pipDocument,
        innerWidth: behavior.size.width,
        innerHeight: behavior.size.height,
        pagehideListeners: new Set<() => void>(),
        closeCalls: 0,
        close() {
          pip.closeCalls += 1;
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
      return Promise.resolve(pip);
    },
  };
  Object.defineProperty(window, "documentPictureInPicture", {
    configurable: true,
    value: api,
  });
  return { windows, requests, behavior };
}

function uninstallFakePiP() {
  delete (window as { documentPictureInPicture?: unknown }).documentPictureInPicture;
}

/** 带计数子树的区域宿主：portal 子树带本地状态，验证弹出/返回不丢状态。（无 JSX：本目录测试按 *.test.ts 收集。） */
function RegionHost({
  regionId,
  workspaceKey,
  title,
  label,
  popLabel,
  enabled = true,
  onRegion,
}: {
  regionId: string;
  workspaceKey: string;
  title: string;
  label: string;
  popLabel: string;
  enabled?: boolean;
  onRegion?: (region: SpecPopoutRegion) => void;
}) {
  const region = useSpecPopoutRegion({
    regionId,
    workspaceKey,
    title,
    enabled,
  });
  onRegion?.(region);
  const [count, setCount] = useState(0);
  return createElement(
    "div",
    { "data-region-host": regionId },
    createElement(
      "div",
      {
        ref: region.anchorRef,
        className: region.popped ? "popped-anchor" : "contents",
      },
      region.popped
        ? createElement("p", { "data-in-pane-placeholder": regionId }, "popped out")
        : null,
      createElement(SpecPopoutRegionPortal, {
        region,
        title,
        children: createElement(
          "section",
          { "data-region-subtree": regionId },
          createElement("span", { "data-count": true }, String(count)),
          createElement("button", { type: "button", onClick: () => setCount(count + 1) }, label),
        ),
      }),
    ),
    createElement(SpecPopoutIconButton, {
      region,
      popLabel,
      restoreLabel: `Вернуть ${label}`,
    }),
  );
}

describe("U-06/U-07 spec popout controller (mocked documentPictureInPicture)", () => {
  it("open adopts styles, moves the stable host into the PiP document and keeps subtree state", async () => {
    const { windows, requests } = installFakePiP();
    let region: SpecPopoutRegion | undefined;
    render(
      createElement(RegionHost, {
        regionId: "spec-discussion",
        workspaceKey: "D:\\ws",
        title: "Дискуссия",
        label: "discuss",
        popLabel: "Вынести дискуссию в окно",
        onRegion: (value) => (region = value),
      }),
    );

    // 初始：子树在主文档锚点内。
    const subtree = document.querySelector("[data-region-subtree='spec-discussion']")!;
    expect(subtree).toBeTruthy();

    // 评审修复回归（2026-10-14）：面板内的宿主必须是 display:contents 透传——
    // 带 w-full 的宿主在 display:contents 锚点下成为 flex item，width:100% 的
    // flex-basis 会把内容列（flex:1 1 0%）挤到 0px，正文整列消失。jsdom 不做
    // 布局，这里钉住“宿主/包装层按位置取 class”的契约。
    const hostInPane = region!.hostNode!;
    expect(hostInPane.className).toBe("contents");
    expect(hostInPane.ownerDocument).toBe(document);
    const [outerWrapperInPane] = Array.from(hostInPane.children) as (HTMLElement | undefined)[];
    expect(outerWrapperInPane?.className).toBe("contents");

    fireEvent.click(screen.getByLabelText("Вынести дискуссию в окно"));
    await waitFor(() => expect(region?.popped).toBe(true));
    expect(requests).toHaveLength(1);
    // 默认尺寸（无持久化时）传给 requestWindow。
    expect(requests[0]).toEqual({
      width: clampSpecPopoutSize({}).width,
      height: clampSpecPopoutSize({}).height,
    });

    // 子树整体（同一 DOM 节点）进入 PiP 文档 body；主文档原位出现占位说明。
    const pip = windows[0]!;
    expect(subtree.ownerDocument).toBe(pip.document);
    expect(pip.document.body.contains(subtree)).toBe(true);
    expect(document.querySelector("[data-in-pane-placeholder='spec-discussion']")).toBeTruthy();
    // PiP 内：宿主与外层包装切换为填充布局（w-full 只允许存在于 PiP 文档中）。
    expect(hostInPane.className).toContain("w-full");
    expect(hostInPane.className).not.toContain("contents");
    const [pinnedOuter, ...pinnedRest] = Array.from(hostInPane.children) as (
      | HTMLElement
      | undefined
    )[];
    expect(pinnedOuter?.className).toContain("h-full");
    expect(pinnedOuter?.className).toContain("flex");
    expect(pinnedRest).toEqual([]);
    // PiP 宿主头部（«вернуть»）在 PiP 文档内可见。
    expect(pip.document.querySelector('[data-spec-popout-control="restore"]')).toBeTruthy();
    // 样式收养：主题 class + <style> 拷贝 + body margin 重置。
    expect(pip.document.documentElement.className).toBe("dark");
    expect(pip.document.head.querySelector("style")?.textContent).toContain("color: red");
    expect(pip.document.body.style.margin).toBe("0px");

    // 状态保活：PiP 里点击计数 → 1；返回原位后计数仍在（同一节点、fiber 未重建）。
    clickInPip(pip.document.querySelector("[data-region-subtree='spec-discussion'] button")!);
    await waitFor(() =>
      expect(
        pip.document.querySelector("[data-region-subtree='spec-discussion'] [data-count]")
          ?.textContent,
      ).toBe("1"),
    );
    fireEvent.click(screen.getByLabelText("Вернуть discuss"));
    await waitFor(() => expect(region?.popped).toBe(false));
    const restored = document.querySelector(
      "[data-region-subtree='spec-discussion'] [data-count]",
    )!;
    expect(restored.textContent).toBe("1");
    expect(restored.ownerDocument).toBe(document);
    expect(pip.closeCalls).toBe(1);
    // 返回后：宿主恢复 contents 透传（PiP 的填充 class 不得留在面板布局里）。
    expect(hostInPane.className).toBe("contents");
    expect(hostInPane.ownerDocument).toBe(document);
  });

  it("persists the final PiP size per region × workspace and reuses it on the next open", async () => {
    const { windows } = installFakePiP();
    let region: SpecPopoutRegion | undefined;
    render(
      createElement(RegionHost, {
        regionId: "main-chat",
        workspaceKey: "ws-id-1",
        title: "Чат",
        label: "chat",
        popLabel: "Вынести чат в окно",
        onRegion: (value) => (region = value),
      }),
    );
    const key = specPopoutSizeKey("main-chat", "ws-id-1");

    fireEvent.click(screen.getByLabelText("Вынести чат в окно"));
    await waitFor(() => expect(region?.popped).toBe(true));
    // 用户调整了 PiP 窗口尺寸后关闭：尺寸持久化。
    windows[0]!.innerWidth = 1024;
    windows[0]!.innerHeight = 800;
    fireEvent.click(screen.getByLabelText("Вернуть chat"));
    await waitFor(() => expect(readSpecPopoutSize(key)).toEqual({ width: 1024, height: 800 }));

    // 再次打开：requestWindow 拿到持久化尺寸。
    fireEvent.click(screen.getByLabelText("Вынести чат в окно"));
    await waitFor(() => expect(windows.length).toBe(2));
    expect(windows[1]!.document.body.hasChildNodes()).toBe(true);

    // 尺寸 clamp：超范围值按界限收拢。
    expect(clampSpecPopoutSize({ width: 9999, height: 1 })).toEqual({
      width: 1920,
      height: 240,
    });
  });

  it("OS close button (pagehide) restores the region in place and persists the size", async () => {
    const { windows } = installFakePiP();
    let region: SpecPopoutRegion | undefined;
    render(
      createElement(RegionHost, {
        regionId: "spec-discussion",
        workspaceKey: "D:\\ws",
        title: "Дискуссия",
        label: "discuss",
        popLabel: "Вынести дискуссию в окно",
        onRegion: (value) => (region = value),
      }),
    );
    fireEvent.click(screen.getByLabelText("Вынести дискуссию в окно"));
    await waitFor(() => expect(region?.popped).toBe(true));

    // 用户按 PiP 窗口的 OS 关闭按钮：pagehide → 回到原位，尺寸持久化。
    windows[0]!.innerWidth = 512;
    windows[0]!.innerHeight = 384;
    for (const listener of Array.from(windows[0]!.pagehideListeners)) listener();
    await waitFor(() => expect(region?.popped).toBe(false));
    expect(document.querySelector("[data-region-subtree='spec-discussion']")?.ownerDocument).toBe(
      document,
    );
    expect(readSpecPopoutSize(specPopoutSizeKey("spec-discussion", "D:\\ws"))).toEqual({
      width: 512,
      height: 384,
    });
  });

  it("shared slot: opening the chat while the discussion is popped out auto-returns the discussion first, with state intact", async () => {
    const { windows } = installFakePiP();
    render(
      createElement(
        "div",
        null,
        createElement(RegionHost, {
          regionId: "spec-discussion",
          workspaceKey: "D:\\ws",
          title: "Дискуссия",
          label: "discuss",
          popLabel: "Вынести дискуссию в окно",
        }),
        createElement(RegionHost, {
          regionId: "main-chat",
          workspaceKey: "D:\\ws",
          title: "Чат",
          label: "chat",
          popLabel: "Вынести чат в окно",
        }),
      ),
    );

    // 讨论先弹出，并在 PiP 里积累本地状态。
    fireEvent.click(screen.getByLabelText("Вынести дискуссию в окно"));
    await waitFor(() =>
      expect(
        windows[0]?.document.querySelector("[data-region-subtree='spec-discussion']"),
      ).toBeTruthy(),
    );
    clickInPip(
      windows[0]!.document.querySelector("[data-region-subtree='spec-discussion'] button")!,
    );
    await waitFor(() =>
      expect(
        windows[0]!.document.querySelector("[data-region-subtree='spec-discussion'] [data-count]")
          ?.textContent,
      ).toBe("1"),
    );

    // 聊天弹出：讨论先被强制回位（一个 App 一个 PiP 窗口），随后才申请新窗口。
    fireEvent.click(screen.getByLabelText("Вынести чат в окно"));
    await waitFor(() => expect(windows.length).toBe(2));
    // 讨论已回到主文档锚点，状态无损（count=1），原位占位消失。
    const discussionCount = document.querySelector(
      "[data-region-subtree='spec-discussion'] [data-count]",
    )!;
    expect(discussionCount.textContent).toBe("1");
    expect(discussionCount.ownerDocument).toBe(document);
    expect(document.querySelector("[data-in-pane-placeholder='spec-discussion']")).toBeNull();
    // 聊天子树在新 PiP 窗口里。
    expect(windows[1]!.document.querySelector("[data-region-subtree='main-chat']")).toBeTruthy();
    // 第一扇窗口被关闭（释放共享槽位）。
    expect(windows[0]!.closeCalls).toBe(1);
  });

  it("unavailable API: icon shows absent-with-reason (aria-disabled, hoverable title) and nothing opens (in-app floating stays)", async () => {
    uninstallFakePiP();
    let region: SpecPopoutRegion | undefined;
    render(
      createElement(RegionHost, {
        regionId: "spec-discussion",
        workspaceKey: "D:\\ws",
        title: "Дискуссия",
        label: "discuss",
        popLabel: "Вынести дискуссию в окно",
        onRegion: (value) => (region = value),
      }),
    );
    const button = screen.getByLabelText("Вынести дискуссию в окно") as HTMLButtonElement;
    // 修复回归（活体缺陷 2026-10-14）：不可用态不再用原生 disabled——Button 基类的
    // disabled:pointer-events-none 会让 title 里的原因永远不可见（「死按钮」）。
    // 契约改为 aria-disabled + 可 hover 的 title + 显式 state 锚点。
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("data-spec-popout-state")).toBe("unavailable");
    // absent-with-reason：title 里带明确原因。
    expect(button.title).toContain("unavailable");
    expect(button.title).toContain("Chromium 116");
    fireEvent.click(button);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(region?.popped).toBe(false);
    // 子树仍在本页面内（现有布局不受影响）。
    expect(document.querySelector("[data-region-subtree='spec-discussion']")?.ownerDocument).toBe(
      document,
    );
    // 直接调用 open() 也只是记录原因，不抛异常。
    region?.open();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(region?.popped).toBe(false);
    expect(region?.lastError).toContain("Chromium 116");
  });

  it("Electron runtime: API present but availability must report unsupported (electron/electron#39633)", async () => {
    // 实测（2026-10-14，Electron 41.0.3 / Chromium 146，file:// 加载）：Electron renderer
    // 里 documentPictureInPicture 存在、requestWindow 在点击手势内 resolve——但 Electron
    // 不创建任何 OS 窗口，返回 0×0 离屏文档。可用性判定必须在 Electron UA 上一律
    // 不可用，否则就是活体缺陷路径（内容被移进不可见文档）。
    installFakePiP();
    const electronAvailability = readSpecPopoutAvailability(
      undefined,
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) zcode/1.0 Chrome/146.0.0.0 Electron/41.0.3 Safari/537.36",
    );
    expect(electronAvailability.supported).toBe(false);
    expect(electronAvailability.supported ? null : electronAvailability.reason).toContain("#39633");
    // 同一份 API（同一 host）在非 Electron 浏览器 UA 下仍然可用——Web 端（Chrome/Edge）
    // 的真实 PiP 不受影响。
    expect(
      readSpecPopoutAvailability(
        undefined,
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
      ).supported,
    ).toBe(true);
    uninstallFakePiP();
  });

  it("runtime resolves an invisible 0×0 window: region stays in place with a visible error and the fake window is closed", async () => {
    // Electron 形态的假窗口：requestWindow resolve，但窗口 0×0（无 OS 窗口）。
    const { windows, behavior } = installFakePiP({
      size: { width: 0, height: 0 },
    });
    let region: SpecPopoutRegion | undefined;
    render(
      createElement(RegionHost, {
        regionId: "spec-discussion",
        workspaceKey: "D:\\ws",
        title: "Дискуссия",
        label: "discuss",
        popLabel: "Вынести дискуссию в окно",
        onRegion: (value) => (region = value),
      }),
    );
    fireEvent.click(screen.getByLabelText("Вынести дискуссию в окно"));
    await waitFor(() => expect(region?.lastError).toContain("without creating a window"));
    expect(region?.popped).toBe(false);
    // 关键契约：子树绝不被移进不可见文档——留在主文档锚点里。
    expect(document.querySelector("[data-region-subtree='spec-discussion']")?.ownerDocument).toBe(
      document,
    );
    // 假窗口被关闭（释放共享槽位），且报错后按钮进入可见 error 态而非死按钮。
    expect(windows[0]!.closeCalls).toBe(1);
    await waitFor(() =>
      expect(
        (screen.getByLabelText("Вынести дискуссию в окно") as HTMLElement).getAttribute(
          "data-spec-popout-state",
        ),
      ).toBe("error"),
    );
    // 行为恢复后（真实浏览器里窗口带尺寸）可以重试成功：错误态不是永久卡死。
    behavior.size = { width: 480, height: 640 };
    fireEvent.click(screen.getByLabelText("Вынести дискуссию в окно"));
    await waitFor(() => expect(region?.popped).toBe(true));
    expect(windows[1]!.document.body.hasChildNodes()).toBe(true);
  });

  it("requestWindow throwing synchronously records a visible error and does not wedge the opening state", async () => {
    const { behavior } = installFakePiP();
    let region: SpecPopoutRegion | undefined;
    render(
      createElement(RegionHost, {
        regionId: "main-chat",
        workspaceKey: "ws-id-1",
        title: "Чат",
        label: "chat",
        popLabel: "Вынести чат в окно",
        onRegion: (value) => (region = value),
      }),
    );
    // 修复回归：同步异常原先会让 setOpening(true) 永远收不回（.finally 挂不上没有
    // 的 promise），按钮从此永久禁用。现在异常走可见错误路径，opening 复位。
    behavior.throwSync = true;
    fireEvent.click(screen.getByLabelText("Вынести чат в окно"));
    await waitFor(() => expect(region?.lastError).toBe("sync rejection before promise"));
    expect(region?.popped).toBe(false);
    expect(region?.opening).toBe(false);
    // 恢复后再次点击可以正常弹出（opening 未被卡死）。
    behavior.throwSync = false;
    fireEvent.click(screen.getByLabelText("Вынести чат в окно"));
    await waitFor(() => expect(region?.popped).toBe(true));
  });

  it("disabled region (hidden/unavailable owner) auto-returns from the PiP window", async () => {
    const { windows } = installFakePiP();
    const { rerender } = render(
      createElement(RegionHost, {
        regionId: "spec-discussion",
        workspaceKey: "D:\\ws",
        title: "Дискуссия",
        label: "discuss",
        popLabel: "Вынести дискуссию в окно",
        enabled: true,
      }),
    );
    fireEvent.click(screen.getByLabelText("Вынести дискуссию в окно"));
    await waitFor(() =>
      expect(
        windows[0]?.document.querySelector("[data-region-subtree='spec-discussion']"),
      ).toBeTruthy(),
    );
    // 区域失活（例如讨论被隐藏/文档关闭）：自动回位。
    rerender(
      createElement(RegionHost, {
        regionId: "spec-discussion",
        workspaceKey: "D:\\ws",
        title: "Дискуссия",
        label: "discuss",
        popLabel: "Вынести дискуссию в окно",
        enabled: false,
      }),
    );
    await waitFor(() =>
      expect(document.querySelector("[data-region-subtree='spec-discussion']")?.ownerDocument).toBe(
        document,
      ),
    );
    expect(windows[0]!.closeCalls).toBe(1);
  });
});

describe("popout pure logic (no React)", () => {
  it("forced-return registry displaces only other regions and unregisters cleanly", () => {
    const calls: string[] = [];
    const releaseA = registerSpecPopoutForcedReturn("a", () => calls.push("a"));
    const releaseB = registerSpecPopoutForcedReturn("b", () => calls.push("b"));
    // a 请求弹出：只有 b 被驱逐。
    expect(forceReturnSpecPopoutOwner("a")).toBe(true);
    expect(calls).toEqual(["b"]);
    releaseA();
    // b 请求弹出：a 已注销，无人可驱逐。
    expect(forceReturnSpecPopoutOwner("b")).toBe(false);
    releaseB();
    expect(forceReturnSpecPopoutOwner()).toBe(false);
    expect(calls).toEqual(["b"]);
  });

  it("availability reports a reason without the API and supported with it", () => {
    uninstallFakePiP();
    const missing = readSpecPopoutAvailability();
    expect(missing.supported).toBe(false);
    expect(missing.supported ? null : missing.reason).toContain("Chromium 116");
    installFakePiP();
    expect(readSpecPopoutAvailability().supported).toBe(true);
  });

  it("size persistence is keyed per region × workspace and survives bad storage values", () => {
    const key = specPopoutSizeKey("main-chat", "D:\\ws\\");
    expect(key).toContain("main-chat");
    expect(key).toContain('"D:/ws"');
    writeSpecPopoutSize(key, { width: 777, height: 555 });
    expect(readSpecPopoutSize(key)).toEqual({ width: 777, height: 555 });
    localStorage.setItem(key, "{not json");
    expect(readSpecPopoutSize(key)).toEqual(clampSpecPopoutSize({}));
    localStorage.removeItem(key);
  });

  it("adoptSpecPopoutStyles clones <style> and <link rel=stylesheet> nodes from the main head", () => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "app.css";
    link.setAttribute("data-test", "popout-link");
    document.head.appendChild(link);
    try {
      const pipDocument = document.implementation.createHTMLDocument("pip");
      adoptSpecPopoutStyles(document, pipDocument);
      const adopted = pipDocument.head.querySelector("link");
      expect(adopted?.getAttribute("rel")).toBe("stylesheet");
      expect(adopted?.getAttribute("href")).toBe("app.css");
      // 主文档注入的 <style> 也被克隆。
      expect(pipDocument.head.querySelector("style")?.textContent).toContain("color: red");
    } finally {
      link.remove();
    }
  });
});
