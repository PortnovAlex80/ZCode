// @vitest-environment jsdom
/**
 * U-04（统一位置无关面板开关，角色模型）/ U-05（无死布局状态）聚焦套件。
 *
 * 分层：
 * 1. resolveWorkspaceBodyRoleState 真值表（纯函数，含不可达组合的确定性）。
 * 2. 交互模型 harness：真实 resolver + 真实 specGeneralChatCollapse/specShellLayoutSwap
 *    状态机 + 真实 caption 控制组件（WorkspaceSidePaneCaptionControls）与真实聊天列
 *    Header 门（WorkspaceHeaderActionSection），按 WorkspaceShellLayout 同款接线，
 *    全部 16 个开关组合逐态枚举 + 序列点击，断言只经由渲染出的 affordance
 *    （role/aria 查询），不触碰内部状态。
 * 3. 全壳静态渲染（mobile-style mock 集）：真实 WorkspaceShellLayout 接线 × 真实
 *    caption/Header 子组件，覆盖静态可达组合（含 localStorage 预置 swap = 重载存活）。
 * 4. 快捷键注册唯一性与默认键位无碰撞（@zcode/shared 命令表）。
 * 5. 源契约：方向性面板图标清理、⤢/Show-main-chat 移除无 stray aria-label。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createElement,
  useCallback,
  useEffect,
  useRef,
  useState,
  act,
} from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseShortcutBinding,
  serializeShortcutBinding,
  SHORTCUT_COMMANDS,
  TID_SIDE_PANE_TOGGLE,
} from "@zcode/shared";
import {
  canCollapseSpecGeneralChat,
  resolveSpecGeneralChatCollapsed,
  toggleSpecGeneralChatCollapse,
} from "@/spec-document/specGeneralChatCollapse.js";
import {
  readSpecShellLayoutSwap,
  specShellLayoutSwapKey,
  writeSpecShellLayoutSwap,
} from "@/spec-document/specShellLayoutSwap.js";
import { resolveWorkspaceBodyRoleState } from "@/spec-document/workspacePanelRoles.js";

vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: { formatMessage: ({ id }: { id: string }) => id },
  }),
}));

vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({}),
  useOptionalPlatform: () => undefined,
}));

vi.mock("@/DesktopWindowControls.js", () => ({
  DesktopWindowControls: () =>
    createElement("div", { "data-testid": "desktop-window-controls" }),
}));

vi.mock("@/WorkspaceHeaderSections/WorkspaceEditorButtonGroup.js", () => ({
  WorkspaceEditorButtonGroup: () => null,
}));

vi.mock("@/WorkspaceTerminalToggleButton.js", () => ({
  WorkspaceTerminalToggleButton: () => null,
}));

vi.mock("@/WorkspaceHelpMenuButton.js", () => ({
  WorkspaceHelpMenuButton: () => null,
}));

vi.mock("@/ConversationShareMenu.js", () => ({
  ConversationShareMenu: () => null,
}));

const { WorkspaceHeaderActionSection } =
  await import("@/WorkspaceHeaderSections/WorkspaceHeaderActionSection.js");
const { WorkspaceSidePaneCaptionControls } =
  await import("@/app-shell/WorkspaceSidePaneCaptionControls.js");

function readSource(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

// ============================================================================
// 1. 角色真值表
// ============================================================================

describe("resolveWorkspaceBodyRoleState truth table (U-04)", () => {
  it("assigns primary/auxiliary by arrangement", () => {
    expect(
      resolveWorkspaceBodyRoleState({
        documentCenter: false,
        sidePaneVisible: true,
        generalChatCollapsed: false,
      }),
    ).toMatchObject({ primary: "general-chat", auxiliary: "side-pane" });
    expect(
      resolveWorkspaceBodyRoleState({
        documentCenter: true,
        sidePaneVisible: true,
        generalChatCollapsed: false,
      }),
    ).toMatchObject({ primary: "side-pane", auxiliary: "general-chat" });
  });

  it("targets the auxiliary when nothing is hidden, in both arrangements", () => {
    expect(
      resolveWorkspaceBodyRoleState({
        documentCenter: false,
        sidePaneVisible: true,
        generalChatCollapsed: false,
      }),
    ).toMatchObject({
      roleToggleTarget: "side-pane",
      roleToggleTargetHidden: false,
    });
    expect(
      resolveWorkspaceBodyRoleState({
        documentCenter: true,
        sidePaneVisible: true,
        generalChatCollapsed: false,
      }),
    ).toMatchObject({
      roleToggleTarget: "general-chat",
      roleToggleTargetHidden: false,
    });
  });

  it("restore-first: a hidden region is always the toggle target, primary or not (U-05)", () => {
    // chat-center + 聊天被隐藏（swap 保留显隐可达）：PRIMARY 自身隐藏 ⇒ caption 不可达，
    // 角色开关必须优先恢复聊天，而不是把可见的 AUXILIARY 也藏掉。
    expect(
      resolveWorkspaceBodyRoleState({
        documentCenter: false,
        sidePaneVisible: true,
        generalChatCollapsed: true,
      }),
    ).toMatchObject({
      hiddenRegion: "general-chat",
      roleToggleTarget: "general-chat",
      roleToggleTargetHidden: true,
      primaryHidden: true,
    });
    // document-center + 聊天被隐藏（常规隐藏路径）。
    expect(
      resolveWorkspaceBodyRoleState({
        documentCenter: true,
        sidePaneVisible: true,
        generalChatCollapsed: true,
      }),
    ).toMatchObject({
      hiddenRegion: "general-chat",
      roleToggleTarget: "general-chat",
      roleToggleTargetHidden: true,
      primaryHidden: false,
    });
    // tabs 容器被隐藏（两种排列下均为 PRIMARY 隐藏）。
    for (const documentCenter of [false, true]) {
      expect(
        resolveWorkspaceBodyRoleState({
          documentCenter,
          sidePaneVisible: false,
          generalChatCollapsed: false,
        }),
      ).toMatchObject({
        hiddenRegion: "side-pane",
        roleToggleTarget: "side-pane",
        roleToggleTargetHidden: true,
        primaryHidden: documentCenter,
      });
    }
  });

  it("stays deterministic for the unreachable both-hidden input (chat wins)", () => {
    // resolveSpecGeneralChatCollapsed 在 side pane 关闭时强制还原聊天，双隐藏不可达；
    // 纯函数层面仍给出确定结果，避免任何调用点出现未定义行为。
    expect(
      resolveWorkspaceBodyRoleState({
        documentCenter: false,
        sidePaneVisible: false,
        generalChatCollapsed: true,
      }).hiddenRegion,
    ).toBe("general-chat");
  });
});

// ============================================================================
// 2. 交互模型 harness（真实状态机 + 真实 affordance 组件，壳层同款接线）
// ============================================================================

interface HarnessOptions {
  /** 初始排列（写入 swap 存储；swap 点击在 harness 内真实切换模式）。 */
  initialSwapMode?: "chat-center" | "document-center";
  sidePaneOpen?: boolean;
  documentActive?: boolean;
  sidebarVisible?: boolean;
  usesInlineWindowControls?: boolean;
  storage?: Storage;
}

const HARNESS_WORKSPACE_KEY = "ws-key";
const HARNESS_SWAP_KEY = specShellLayoutSwapKey("D:\\ws", "ws-identity");

/**
 * 与 WorkspaceShellLayout 同款接线（引用处为当前工作树行号）：
 * - 角色解析 + 角色开关下发（sidePaneRoleToggle）；
 * - tabs caption 窗控路由 sidePaneCaptionCarriesWindowControls = !documentCenter || collapsed；
 * - 聊天列 Header 的 isSidePaneOpen = (sidePaneOpen && carries) || (!inline && !restoreTargets)
 *   （WorkspaceHeaderActionSection 把恢复按钮与内联窗控绑在同一门上，见产品注释）；
 * - collapse 自愈 effect（collapsed 请求不再可解析时清除）。
 */
function WorkspaceBodyRoleHarness({
  sidePaneOpen: initialSidePaneOpen,
  documentActive,
  sidebarVisible,
  usesInlineWindowControls,
  storage,
  onChatMount,
  chatDraftRef,
}: Omit<HarnessOptions, "initialSwapMode"> & {
  onChatMount?: (delta: 1 | -1) => void;
  chatDraftRef?: { current: HTMLInputElement | null };
}) {
  const storagePort = storage ?? localStorage;
  const [mode, setMode] = useState(() =>
    readSpecShellLayoutSwap(HARNESS_SWAP_KEY, storagePort),
  );
  const [sidePaneOpen, setSidePaneOpen] = useState(initialSidePaneOpen);
  const [collapseKey, setCollapseKey] = useState<string | null>(null);
  const documentCenter = mode === "document-center";
  const collapseContext = {
    workspaceKey: HARNESS_WORKSPACE_KEY,
    documentActive,
    sidePaneOpen,
    workspaceMainView: "chat",
  };
  const generalChatCollapsed = resolveSpecGeneralChatCollapsed(
    collapseKey,
    collapseContext,
  );
  useEffect(() => {
    if (collapseKey && !generalChatCollapsed) setCollapseKey(null);
  }, [collapseKey, generalChatCollapsed]);
  const handleToggleGeneralChat = useCallback(() => {
    setCollapseKey((current) =>
      toggleSpecGeneralChatCollapse(current, collapseContext),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 与产品一致：context 取当前渲染值
  }, [documentActive, sidePaneOpen]);
  const handleToggleSidePane = useCallback(() => {
    setSidePaneOpen((open) => !open);
  }, []);
  const handleToggleSwap = useCallback(() => {
    setMode((current) => {
      const next =
        current === "document-center" ? "chat-center" : "document-center";
      writeSpecShellLayoutSwap(HARNESS_SWAP_KEY, next, storagePort);
      return next;
    });
  }, [storagePort]);

  const roleState = resolveWorkspaceBodyRoleState({
    documentCenter,
    sidePaneVisible: sidePaneOpen,
    generalChatCollapsed,
  });
  const roleToggleTargetsGeneralChat =
    roleState.roleToggleTarget === "general-chat";
  const sidePaneRoleToggle = {
    targetHidden: roleState.roleToggleTargetHidden,
    onToggle: roleToggleTargetsGeneralChat
      ? handleToggleGeneralChat
      : handleToggleSidePane,
    disabled:
      roleToggleTargetsGeneralChat &&
      !roleState.roleToggleTargetHidden &&
      !canCollapseSpecGeneralChat(collapseContext),
    shortcutLabel: roleToggleTargetsGeneralChat ? undefined : "Ctrl+Alt+B",
  };
  const sidePaneCaptionCarriesWindowControls =
    !documentCenter || generalChatCollapsed;
  const chatCaptionRestoreTargetsSidePane =
    roleState.hiddenRegion === "side-pane";
  const handleChatCaptionRestorePanel = useCallback(() => {
    // 与产品一致：仅当确有被隐藏的 tabs 容器时动作生效；dc 双可见（Win/Linux 门耦合
    // 导致按钮仍渲染）时为惰性按钮——点击无副作用，真实角色开关在 tabs caption。
    if (roleState.hiddenRegion !== "side-pane") return;
    handleToggleSidePane();
  }, [roleState.hiddenRegion, handleToggleSidePane]);
  const chatHeaderIsSidePaneOpen =
    (sidePaneOpen && sidePaneCaptionCarriesWindowControls) ||
    (!usesInlineWindowControls && !chatCaptionRestoreTargetsSidePane);

  return createElement(
    "div",
    { "data-sidebar-visible": sidebarVisible ? "true" : "false" },
    createElement(
      "div",
      {
        "data-caption": "chat",
        "data-chat-collapsed": generalChatCollapsed ? "true" : "false",
      },
      createElement(ChatRegion, {
        onMount: onChatMount,
        draftRef: chatDraftRef,
        header: createElement(WorkspaceHeaderActionSection, {
          variant: "draft",
          isDesktop: true,
          isSidePaneOpen: chatHeaderIsSidePaneOpen,
          onToggleSidePane: handleChatCaptionRestorePanel,
          toggleSidePaneShortcutLabel: chatCaptionRestoreTargetsSidePane
            ? "Ctrl+Alt+B"
            : undefined,
          showWindowControls: usesInlineWindowControls,
        }),
      }),
    ),
    createElement(
      "div",
      {
        "data-caption": "tabs",
        "data-tabs-visible": sidePaneOpen ? "true" : "false",
      },
      sidePaneOpen
        ? createElement(WorkspaceSidePaneCaptionControls, {
            roleToggle: sidePaneRoleToggle,
            documentCenter,
            onToggleShellLayoutSwap: handleToggleSwap,
            showWindowControls:
              usesInlineWindowControls && sidePaneCaptionCarriesWindowControls,
          })
        : null,
    ),
  );
}

function ChatRegion({
  header,
  onMount,
  draftRef,
}: {
  header: React.ReactNode;
  onMount?: (delta: 1 | -1) => void;
  draftRef?: { current: HTMLInputElement | null };
}) {
  const draftRefLocal = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    onMount?.(1);
    return () => onMount?.(-1);
  }, [onMount]);
  return createElement(
    "div",
    null,
    header,
    createElement("input", {
      "data-testid": "chat-draft",
      ref: (element: HTMLInputElement | null) => {
        (draftRef ?? draftRefLocal).current = element;
      },
      value: "unsaved-draft",
      readOnly: true,
    }),
  );
}

async function renderHarness(options: HarnessOptions = {}) {
  const storagePort = options.storage ?? localStorage;
  // 仅显式给定初始排列时预写；不给时沿用持久层现状（reload 存活测试依赖这一点）。
  if (options.initialSwapMode) {
    writeSpecShellLayoutSwap(
      HARNESS_SWAP_KEY,
      options.initialSwapMode,
      storagePort,
    );
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  let mounts = 0;
  const chatDraftRef = { current: null as HTMLInputElement | null };
  const root = createRoot(container);
  const props = {
    sidePaneOpen: true,
    documentActive: true,
    sidebarVisible: true,
    usesInlineWindowControls: true,
    ...options,
    onChatMount: (delta: 1 | -1) => {
      mounts += delta;
    },
    chatDraftRef,
  };
  await act(async () => {
    root.render(createElement(WorkspaceBodyRoleHarness, props));
  });
  return {
    container,
    root,
    mounts: () => mounts,
    chatDraftRef,
    async rerender(next: HarnessOptions = {}) {
      await act(async () => {
        root.render(
          createElement(WorkspaceBodyRoleHarness, { ...props, ...next }),
        );
      });
    },
    async unmount() {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
  configurable: true,
  get() {
    return actEnvironmentActive;
  },
  set(value: boolean) {
    actEnvironmentActive = value;
  },
});
let actEnvironmentActive = false;
beforeEach(() => {
  actEnvironmentActive = true;
  localStorage.clear();
});
afterEach(() => {
  actEnvironmentActive = false;
  localStorage.clear();
});

function click(element: Element) {
  act(() => {
    element.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
  });
}

const SHOW_LABEL = 'button[aria-label="sidePane.expand"]';
const HIDE_LABEL = 'button[aria-label="sidePane.collapse"]';
const SWAP_TO_DC = 'button[aria-label="Документ в центре"]';
const SWAP_TO_CC = 'button[aria-label="Чат в центре"]';

function captionQuery(
  container: HTMLElement,
  caption: "chat" | "tabs",
  selector: string,
) {
  return Array.from(
    container.querySelectorAll(`[data-caption="${caption}"] ${selector}`),
  ) as HTMLButtonElement[];
}

/**
 * U-05 不变量：每个被隐藏的区域都有可见且可用的恢复 affordance；窗控可达。
 * 只经由渲染出的 role/aria 断言，不读内部状态。
 */
function assertNoDeadLayoutState(
  container: HTMLElement,
  options: { usesInlineWindowControls: boolean },
) {
  const chatCollapsed = container
    .querySelector("[data-caption='chat']")
    ?.getAttribute("data-chat-collapsed");
  const tabsVisible =
    container
      .querySelector("[data-caption='tabs']")
      ?.getAttribute("data-tabs-visible") === "true";
  expect(chatCollapsed).toBeTruthy();
  const chatHidden = chatCollapsed === "true";

  // 聊天隐藏 ⇒ tabs caption 存活且角色开关提供恢复（enabled）。
  if (chatHidden) {
    expect(
      tabsVisible,
      "chat hidden keeps the tabs pane mounted (resolver invariant)",
    ).toBe(true);
    const restore = captionQuery(container, "tabs", SHOW_LABEL);
    expect(
      restore.length,
      "chat hidden ⇒ tabs caption offers a restore affordance",
    ).toBe(1);
    expect(restore[0].disabled).toBe(false);
  }
  // tabs 隐藏 ⇒ 聊天列 Header 存活且提供恢复（enabled）。
  if (!tabsVisible) {
    const restore = captionQuery(container, "chat", SHOW_LABEL);
    expect(
      restore.length,
      "tabs hidden ⇒ chat caption offers a restore affordance",
    ).toBe(1);
    expect(restore[0].disabled).toBe(false);
    expect(
      chatHidden,
      "tabs hidden ⇒ chat visible (both-hidden is unreachable)",
    ).toBe(false);
  }
  // 窗控恰好一处（聊天列 Header 或 tabs caption），任何组合下都可达。
  if (options.usesInlineWindowControls) {
    const chatControls = captionQuery(
      container,
      "chat",
      '[data-testid="desktop-window-controls"]',
    );
    const tabsControls = captionQuery(
      container,
      "tabs",
      '[data-testid="desktop-window-controls"]',
    );
    expect(
      chatControls.length + tabsControls.length,
      "exactly one window-controls cluster",
    ).toBe(1);
  }
  // 被移除的旧按钮不残留任何 stray aria-label。
  for (const stray of [
    "Show main chat",
    "Развернуть документ",
    "Вернуть чат",
  ]) {
    expect(container.querySelectorAll(`[aria-label="${stray}"]`).length).toBe(
      0,
    );
  }
}

describe("U-05 state enumeration — every toggle combination keeps a live restore path", () => {
  const combinations = [true, false].flatMap((sidebarVisible) =>
    [true, false].flatMap((documentCenter) =>
      [true, false].flatMap((sidePaneOpen) =>
        [true, false].map((usesInlineWindowControls) => ({
          sidebarVisible,
          documentCenter,
          sidePaneOpen,
          usesInlineWindowControls,
        })),
      ),
    ),
  );

  it.each(combinations)(
    "sidebar=$sidebarVisible dc=$documentCenter tabs=$sidePaneOpen inline=$usesInlineWindowControls: no dead state, incl. after hiding the auxiliary",
    async ({
      sidebarVisible,
      documentCenter,
      sidePaneOpen,
      usesInlineWindowControls,
    }) => {
      const view = await renderHarness({
        initialSwapMode: documentCenter ? "document-center" : "chat-center",
        sidePaneOpen,
        sidebarVisible,
        usesInlineWindowControls,
      });
      try {
        assertNoDeadLayoutState(view.container, { usesInlineWindowControls });
        // 起点无隐藏 ⇒ 角色开关隐藏 AUXILIARY；有隐藏 ⇒ 恢复。逐个可达状态都断言。
        const hide = captionQuery(view.container, "tabs", HIDE_LABEL);
        if (sidePaneOpen) {
          expect(hide.length).toBe(1);
          click(hide[0]);
          assertNoDeadLayoutState(view.container, { usesInlineWindowControls });
          // 隐藏后再点击恢复。
          const restore = captionQuery(
            view.container,
            documentCenter ? "tabs" : "chat",
            SHOW_LABEL,
          );
          expect(restore.length).toBe(1);
          click(restore[0]);
          assertNoDeadLayoutState(view.container, { usesInlineWindowControls });
        } else {
          expect(hide.length).toBe(0);
        }
      } finally {
        await view.unmount();
      }
    },
  );

  it.each([true, false])(
    "chat hidden via swap-preserved visibility stays restorable (dc=%s entry)",
    async (documentCenter) => {
      const view = await renderHarness({
        initialSwapMode: documentCenter ? "document-center" : "chat-center",
        sidePaneOpen: true,
      });
      try {
        // dc：角色开关隐藏聊天；cc：隐藏 tabs 后 swap。两条路径都到「聊天隐藏」态。
        if (documentCenter) {
          click(captionQuery(view.container, "tabs", HIDE_LABEL)[0]);
        } else {
          click(captionQuery(view.container, "tabs", SWAP_TO_DC)[0]);
          click(captionQuery(view.container, "tabs", HIDE_LABEL)[0]);
          click(captionQuery(view.container, "tabs", SWAP_TO_CC)[0]);
        }
        expect(
          view.container
            .querySelector("[data-caption='chat']")
            ?.getAttribute("data-chat-collapsed"),
        ).toBe("true");
        assertNoDeadLayoutState(view.container, {
          usesInlineWindowControls: true,
        });
      } finally {
        await view.unmount();
      }
    },
  );
});

describe("U-04 role toggle — one position-independent control", () => {
  it("the same button hides the tabs pane in chat-center and the chat in document-center", async () => {
    const chatCenter = await renderHarness({ initialSwapMode: "chat-center" });
    try {
      const toggle = captionQuery(
        chatCenter.container,
        "tabs",
        `[data-testid="${TID_SIDE_PANE_TOGGLE}"]`,
      );
      expect(toggle.length).toBe(1);
      click(toggle[0]);
      expect(
        chatCenter.container
          .querySelector("[data-caption='tabs']")
          ?.getAttribute("data-tabs-visible"),
      ).toBe("false");
      expect(
        chatCenter.container
          .querySelector("[data-caption='chat']")
          ?.getAttribute("data-chat-collapsed"),
      ).toBe("false");
    } finally {
      await chatCenter.unmount();
    }

    const documentCenter = await renderHarness({
      initialSwapMode: "document-center",
    });
    try {
      const toggle = captionQuery(
        documentCenter.container,
        "tabs",
        `[data-testid="${TID_SIDE_PANE_TOGGLE}"]`,
      );
      expect(toggle.length).toBe(1);
      click(toggle[0]);
      expect(
        documentCenter.container
          .querySelector("[data-caption='chat']")
          ?.getAttribute("data-chat-collapsed"),
      ).toBe("true");
      expect(
        documentCenter.container
          .querySelector("[data-caption='tabs']")
          ?.getAttribute("data-tabs-visible"),
      ).toBe("true");
    } finally {
      await documentCenter.unmount();
    }
  });

  it("labels stay constant across arrangements: hide while the target is visible, show while hidden", async () => {
    for (const initialSwapMode of ["chat-center", "document-center"] as const) {
      const view = await renderHarness({ initialSwapMode });
      try {
        expect(captionQuery(view.container, "tabs", HIDE_LABEL).length).toBe(1);
        expect(captionQuery(view.container, "tabs", SHOW_LABEL).length).toBe(0);
        click(captionQuery(view.container, "tabs", HIDE_LABEL)[0]);
        // 隐藏后唯一的恢复入口换到幸存 caption：cc（tabs 隐藏）⇒ 聊天列 Header；
        // dc（聊天隐藏）⇒ tabs caption。全容器恰一个 SHOW。
        expect(view.container.querySelectorAll(SHOW_LABEL).length).toBe(1);
        expect(view.container.querySelectorAll(HIDE_LABEL).length).toBe(0);
      } finally {
        await view.unmount();
      }
    }
  });

  it("swap exchanges roles but preserves each region's visibility", async () => {
    const sequence = await renderHarness({ initialSwapMode: "chat-center" });
    try {
      // 隐藏 tabs（chat-center 的 AUXILIARY）→ 恢复 → swap ⇒ tabs 仍可见；
      // 再在 dc 隐藏聊天（AUXILIARY）→ swap ⇒ 聊天仍隐藏（角色互换、显隐保留）。
      click(captionQuery(sequence.container, "tabs", HIDE_LABEL)[0]);
      click(captionQuery(sequence.container, "chat", SHOW_LABEL)[0]);
      expect(
        sequence.container
          .querySelector("[data-caption='tabs']")
          ?.getAttribute("data-tabs-visible"),
      ).toBe("true");
      click(captionQuery(sequence.container, "tabs", SWAP_TO_DC)[0]);
      expect(
        sequence.container
          .querySelector("[data-caption='tabs']")
          ?.getAttribute("data-tabs-visible"),
      ).toBe("true");
      click(captionQuery(sequence.container, "tabs", HIDE_LABEL)[0]);
      expect(
        sequence.container
          .querySelector("[data-caption='chat']")
          ?.getAttribute("data-chat-collapsed"),
      ).toBe("true");
      click(captionQuery(sequence.container, "tabs", SWAP_TO_CC)[0]);
      expect(
        sequence.container
          .querySelector("[data-caption='chat']")
          ?.getAttribute("data-chat-collapsed"),
      ).toBe("true");
      expect(
        sequence.container
          .querySelector("[data-caption='tabs']")
          ?.getAttribute("data-tabs-visible"),
      ).toBe("true");
    } finally {
      await sequence.unmount();
    }
  });

  it("renders disabled (never a fake switch) when the chat cannot be hidden without an active document", async () => {
    const view = await renderHarness({
      initialSwapMode: "document-center",
      documentActive: false,
    });
    try {
      const toggle = captionQuery(
        view.container,
        "tabs",
        `[data-testid="${TID_SIDE_PANE_TOGGLE}"]`,
      )[0];
      expect(toggle.disabled).toBe(true);
      click(toggle);
      expect(
        view.container
          .querySelector("[data-caption='chat']")
          ?.getAttribute("data-chat-collapsed"),
      ).toBe("false");
    } finally {
      await view.unmount();
    }
  });
});

describe("U-04/U-05 sequence tests — entry scenario is the swapped arrangement (live repro)", () => {
  it("document-center → hide auxiliary → swap → toggle again: every step keeps affordances", async () => {
    const view = await renderHarness({ initialSwapMode: "document-center" });
    const assertLive = () =>
      assertNoDeadLayoutState(view.container, {
        usesInlineWindowControls: true,
      });
    try {
      assertLive();
      // 1) 隐藏 AUXILIARY（聊天）。
      click(captionQuery(view.container, "tabs", HIDE_LABEL)[0]);
      assertLive();
      expect(
        view.container
          .querySelector("[data-caption='chat']")
          ?.getAttribute("data-chat-collapsed"),
      ).toBe("true");
      // 2) swap：角色互换，聊天仍隐藏（restore-first 语义下同一按钮当前提供恢复）。
      click(captionQuery(view.container, "tabs", SWAP_TO_CC)[0]);
      assertLive();
      expect(
        view.container
          .querySelector("[data-caption='chat']")
          ?.getAttribute("data-chat-collapsed"),
      ).toBe("true");
      // 3) 再次点击同一开关：restore-first ⇒ 恢复聊天，回到无隐藏态。
      click(captionQuery(view.container, "tabs", SHOW_LABEL)[0]);
      assertLive();
      expect(
        view.container
          .querySelector("[data-caption='chat']")
          ?.getAttribute("data-chat-collapsed"),
      ).toBe("false");
      // 4) 再隐藏一次：chat-center 下 AUXILIARY 已换为 tabs 容器——同一按钮、同一标签，
      //    目标随角色交换。
      click(captionQuery(view.container, "tabs", HIDE_LABEL)[0]);
      assertLive();
      expect(
        view.container
          .querySelector("[data-caption='tabs']")
          ?.getAttribute("data-tabs-visible"),
      ).toBe("false");
      expect(
        view.container
          .querySelector("[data-caption='chat']")
          ?.getAttribute("data-chat-collapsed"),
      ).toBe("false");
    } finally {
      await view.unmount();
    }
  });

  it("document-center → hide auxiliary → swap → reopen: affordances after every step", async () => {
    const view = await renderHarness({ initialSwapMode: "document-center" });
    const assertLive = () =>
      assertNoDeadLayoutState(view.container, {
        usesInlineWindowControls: true,
      });
    try {
      click(captionQuery(view.container, "tabs", HIDE_LABEL)[0]);
      assertLive();
      click(captionQuery(view.container, "tabs", SWAP_TO_CC)[0]);
      assertLive();
      click(captionQuery(view.container, "tabs", SHOW_LABEL)[0]);
      assertLive();
      // 回到 chat-center、无隐藏：角色开关重新指向（可见的）tabs 容器。
      expect(captionQuery(view.container, "tabs", HIDE_LABEL).length).toBe(1);
    } finally {
      await view.unmount();
    }
  });

  it("chat stays mounted with its draft across hide/restore and swaps (no remounts)", async () => {
    const view = await renderHarness({ initialSwapMode: "document-center" });
    try {
      const draft = view.chatDraftRef.current;
      expect(draft).toBeTruthy();
      expect(view.mounts()).toBe(1);
      click(captionQuery(view.container, "tabs", HIDE_LABEL)[0]);
      click(captionQuery(view.container, "tabs", SWAP_TO_CC)[0]);
      click(captionQuery(view.container, "tabs", SHOW_LABEL)[0]);
      click(captionQuery(view.container, "tabs", SWAP_TO_DC)[0]);
      expect(view.mounts()).toBe(1);
      expect(view.chatDraftRef.current).toBe(draft);
      expect(draft?.isConnected).toBe(true);
    } finally {
      await view.unmount();
    }
  });

  it("state survives reload (fresh mount re-reads swap storage) and the main-view round trip", async () => {
    const storage = new FakeStorage();
    const first = await renderHarness({
      initialSwapMode: "document-center",
      storage,
    });
    try {
      click(captionQuery(first.container, "tabs", HIDE_LABEL)[0]);
      expect(
        first.container
          .querySelector("[data-caption='chat']")
          ?.getAttribute("data-chat-collapsed"),
      ).toBe("true");
    } finally {
      await first.unmount();
    }
    // 模拟重载：全新挂载只从持久层恢复 swap 模式；聊天显隐是本地呈现态（会话内），
    // 重载后回到可见——不变的是模式与每个区域的恢复能力。
    const second = await renderHarness({ storage });
    try {
      expect(
        second.container.querySelector(
          "[data-caption='tabs'] button[aria-pressed='true']",
        ),
      ).toBeTruthy();
      expect(captionQuery(second.container, "tabs", HIDE_LABEL).length).toBe(1);
      assertNoDeadLayoutState(second.container, {
        usesInlineWindowControls: true,
      });
    } finally {
      await second.unmount();
    }

    // mainView 往返（documentActive 掉线再恢复）：swap 保留；聊天隐藏被既有守卫自愈还原。
    const third = await renderHarness({
      initialSwapMode: "document-center",
      storage,
    });
    try {
      click(captionQuery(third.container, "tabs", HIDE_LABEL)[0]);
      await third.rerender({ documentActive: false });
      expect(
        third.container
          .querySelector("[data-caption='chat']")
          ?.getAttribute("data-chat-collapsed"),
      ).toBe("false");
      await third.rerender({ documentActive: true });
      expect(
        third.container.querySelector(
          "[data-caption='tabs'] button[aria-pressed='true']",
        ),
      ).toBeTruthy();
      assertNoDeadLayoutState(third.container, {
        usesInlineWindowControls: true,
      });
    } finally {
      await third.unmount();
    }
  });
});

class FakeStorage {
  private readonly map = new Map<string, string>();
  getItem(key: string) {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  setItem(key: string, value: string) {
    this.map.set(key, String(value));
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
}

// ============================================================================
// 4. 快捷键：命令表唯一注册、默认键位无碰撞
// ============================================================================

describe("role toggle shortcut registration (U-04)", () => {
  it("registers the side-pane toggle command exactly once in the shared command table", () => {
    const entries = SHORTCUT_COMMANDS.filter(
      (entry) => entry.id === "toggleSidePane",
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].defaultBindings.length).toBeGreaterThan(0);
  });

  it("has no default-binding collisions across the whole shortcut table", () => {
    const seen = new Map<string, string>();
    for (const entry of SHORTCUT_COMMANDS) {
      for (const binding of entry.defaultBindings) {
        const parsed = parseShortcutBinding(binding);
        expect(parsed, `binding must parse: ${binding}`).toBeTruthy();
        const canonical = serializeShortcutBinding(parsed);
        expect(canonical).toBe(binding);
        const owner = seen.get(canonical ?? binding);
        expect(
          owner,
          `default binding ${binding} of ${entry.id} collides with ${owner ?? "unknown"}`,
        ).toBeUndefined();
        seen.set(canonical ?? binding, entry.id);
      }
    }
  });

  it("dispatches the shortcut through the single App entry and only advertises it for side-pane actions", () => {
    // App.tsx 在 useAppKeyboard 只注册一条 toggleSidePane 分发；壳层只在动作等价于
    // side pane 开关时透出快捷键提示（防提示与行为漂移）。正则容忍 prettier 换行。
    const appSource = readSource("packages/ui/src/App.tsx");
    expect(appSource.match(/toggleSidePane: \(\) =>/g)).toHaveLength(1);
    const shellSource = readSource(
      "packages/ui/src/app-shell/WorkspaceShellLayout.tsx",
    );
    expect(shellSource).toMatch(
      /shortcutLabel:\s*roleToggleTargetsGeneralChat\s*\?\s*undefined\s*:\s*toggleSidePaneShortcutLabel,/u,
    );
  });
});

// ============================================================================
// 5. 源契约：方向性图标与旧按钮清理
// ============================================================================

describe("removed position-dependent controls leave no trace (U-04 migration)", () => {
  it("keeps the shell free of PanelLeft/Right Open/Close glyphs", () => {
    for (const path of [
      "packages/ui/src/app-shell/AnimatedSidePanePanel.tsx",
      "packages/ui/src/app-shell/WorkspaceSidePaneCaptionControls.tsx",
      "packages/ui/src/app-shell/WorkspaceShellLayout.tsx",
      "packages/ui/src/WorkspaceSidePaneToggleButton.tsx",
    ]) {
      const source = readSource(path);
      for (const glyph of [
        "PanelLeftOpen",
        "PanelRightOpen",
        "PanelLeftClose",
        "PanelRightClose",
      ]) {
        expect(source, `${path} must not use ${glyph}`).not.toContain(glyph);
      }
    }
  });

  it("retires the document-header expand control and the show-main-chat arrow", () => {
    const paneSource = readSource(
      "packages/ui/src/spec-document/SpecDocumentPane.tsx",
    );
    expect(paneSource).not.toContain("Развернуть документ");
    expect(paneSource).not.toContain("Вернуть чат");
    expect(paneSource).not.toContain("onToggleGeneralChat");
    const panelSource = readSource(
      "packages/ui/src/app-shell/AnimatedSidePanePanel.tsx",
    );
    expect(panelSource).not.toContain("Show main chat");
    // 位置无关的 swap 控制保留原语义（目标态标签 + aria-pressed）。
    const captionSource = readSource(
      "packages/ui/src/app-shell/WorkspaceSidePaneCaptionControls.tsx",
    );
    expect(captionSource).toContain('data-spec-shell-layout-swap-toggle=""');
    expect(captionSource).toContain("aria-pressed={documentCenter}");
  });

  it("keeps the navigator root toggle untouched (fixed-left overlay stays)", () => {
    // 侧栏（navigator）固定在左侧，其 PanelLeft* 图标是位置恒真的例外（本次不改动）。
    const overlaySource = readSource("packages/ui/src/DesktopTopOverlay.tsx");
    expect(overlaySource).toContain("PanelLeftClose");
    expect(overlaySource).toContain("PanelLeftOpen");
  });
});

// ============================================================================
// 3. 全壳静态渲染：真实 WorkspaceShellLayout 接线（mobile-style mock 集）
// ============================================================================

vi.mock("@/app-shell/AnimatedSidePanePanel.js", async () => {
  const { WorkspaceSidePaneCaptionControls } =
    await import("@/app-shell/WorkspaceSidePaneCaptionControls.js");
  return {
    AnimatedSidePanePanel: (props: {
      sidePaneRoleToggle?: {
        targetHidden: boolean;
        onToggle: () => void;
        disabled: boolean;
      };
      documentCenter?: boolean;
      onToggleShellLayoutSwap?: () => void;
      showWindowControls?: boolean;
      isVisible?: boolean;
      mobileOverlay?: boolean;
    }) =>
      createElement(
        "div",
        {
          "data-testid": "side-pane-panel",
          "data-panel-visible": props.isVisible ? "true" : "false",
          "data-mobile-overlay": props.mobileOverlay ? "true" : "false",
        },
        props.isVisible && !props.mobileOverlay
          ? createElement(WorkspaceSidePaneCaptionControls, {
              roleToggle: props.sidePaneRoleToggle ?? null,
              documentCenter: Boolean(props.documentCenter),
              onToggleShellLayoutSwap: props.onToggleShellLayoutSwap,
              showWindowControls: props.showWindowControls,
            })
          : null,
      ),
  };
});

vi.mock("@/WorkspaceHeader.js", async () => {
  const { WorkspaceHeaderActionSection } =
    await import("@/WorkspaceHeaderSections/WorkspaceHeaderActionSection.js");
  return {
    WorkspaceHeader: (props: {
      variant?: string;
      isSidePaneOpen?: boolean;
      onToggleSidePane?: () => void;
      toggleSidePaneShortcutLabel?: string;
      isDesktop?: boolean;
      isWindowsDesktop?: boolean;
      isMacDesktop?: boolean;
    }) =>
      createElement(
        "header",
        {
          "data-testid": "workspace-header",
          "data-workspace-header-variant": props.variant,
        },
        createElement(WorkspaceHeaderActionSection, {
          variant: "draft",
          isDesktop: props.isDesktop,
          isSidePaneOpen: Boolean(props.isSidePaneOpen),
          onToggleSidePane: props.onToggleSidePane,
          toggleSidePaneShortcutLabel: props.toggleSidePaneShortcutLabel,
          showWindowControls: Boolean(
            props.isWindowsDesktop || (props.isDesktop && !props.isMacDesktop),
          ),
        }),
      ),
  };
});

vi.mock("@/app-shell/AnimatedTerminalPanel.js", () => ({
  AnimatedTerminalPanel: () =>
    createElement("div", { "data-testid": "terminal-panel" }),
}));

vi.mock("@/app-shell/useAnimatedResizablePanel.js", () => ({
  useAnimatedResizablePanel: ({ open }: { open: boolean }) => ({
    isVisible: open,
    panelElementRef: { current: null },
    panelRef: { current: null },
  }),
}));

vi.mock("@/settings/AutomationsSection.js", () => ({
  AUTOMATIONS_TOAST_ANCHOR_ID: "automations-main-toast-anchor",
  AutomationsSection: () =>
    createElement("div", { "data-testid": "automations-section" }),
}));

vi.mock("@/v4/V4ChatPane.js", () => ({
  V4ChatPane: () => createElement("div", { "data-testid": "v4-chat-pane" }),
}));

vi.mock("@/v4/V4WorkspaceChatArea.js", () => ({
  V4WorkspaceChatArea: () =>
    createElement("div", { "data-testid": "v4-chat-pane" }),
}));

vi.mock("@/BotsDialog.js", () => ({
  BotsDialog: () => createElement("div", { "data-testid": "bots-dialog" }),
}));

vi.mock("@/components/ui/resizable.js", () => ({
  ResizableHandle: ({ className }: { className?: string }) =>
    createElement("div", { className, "data-testid": "resizable-handle" }),
  ResizablePanel: ({
    children,
    className,
    id,
  }: {
    children: React.ReactNode;
    className?: string;
    id: string;
  }) => createElement("section", { className, "data-panel-id": id }, children),
  ResizablePanelGroup: ({
    children,
    className,
    layoutId,
  }: {
    children: React.ReactNode;
    className?: string;
    layoutId: string;
  }) =>
    createElement("div", { className, "data-layout-id": layoutId }, children),
}));

vi.mock("@/components/ui/dropdown-menu.js", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) =>
    createElement("div", { "data-testid": "dropdown-menu" }, children),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) =>
    createElement("div", null, children),
  DropdownMenuItem: ({ children }: { children: React.ReactNode }) =>
    createElement("button", { "data-testid": "dropdown-menu-item" }, children),
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) =>
    children,
}));

vi.mock("@/DesktopTopOverlay.js", () => ({
  DesktopTopOverlay: () =>
    createElement("div", { "data-testid": "desktop-top-overlay" }),
}));

vi.mock("@/DesktopWindowFrame.js", () => ({
  DesktopWindowFrame: ({ children }: { children: React.ReactNode }) =>
    createElement("div", { "data-testid": "desktop-window-frame" }, children),
}));

vi.mock("@/feedback/feedbackStore.js", () => ({
  useFeedbackStore: (
    selector: (state: {
      openFeatureRequest: () => void;
      openSubmit: () => void;
    }) => unknown,
  ) =>
    selector({
      openFeatureRequest: vi.fn(),
      openSubmit: vi.fn(),
    }),
}));

vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useBaseWorkspaceServices: () => ({}),
}));

vi.mock("@/store/TabStoreProvider.js", () => ({
  useTabStoreApi: () => ({
    getState: () => ({
      activateTabByPath: vi.fn(() => true),
      addTab: vi.fn(),
    }),
  }),
}));

vi.mock("@/WorkspaceSidebar.js", () => ({
  WorkspaceSidebar: () =>
    createElement("aside", { "data-testid": "workspace-sidebar" }),
}));

vi.mock("@/WebRemoteControlMobileShell.js", () => ({
  WebRemoteControlMobileShell: () =>
    createElement("div", { "data-testid": "web-remote-mobile-shell" }),
}));

function createWorkspaceShellProps() {
  return {
    activeGitSourceId: "unstaged" as const,
    activeSessionId: null,
    activeTaskChangeSummary: null,
    activeTaskId: null,
    activeTaskProvider: null,
    activeTaskTitle: "",
    activeTraceId: null,
    allowOpenWorkspace: false,
    allowRemoteWorkspace: false,
    appLogoUrl: "",
    browserNavigationRequest: null,
    browserRestoreUrls: {},
    canGoBack: false,
    canGoForward: false,
    canTaskNavBack: false,
    canTaskNavForward: false,
    gitState: {
      datasets: {
        staged: { sections: [] },
        unstaged: { sections: [] },
      },
      summary: {
        isGitAvailable: false,
        isRepository: false,
      },
    },
    goBackShortcutLabel: "",
    goForwardShortcutLabel: "",
    handleActivateSidePaneTab: vi.fn(),
    handleBrowserNavigationRequestHandled: vi.fn(),
    handleBrowserPageMetadataChange: vi.fn(),
    handleBrowserUrlChange: vi.fn(),
    handleCloseCodeViewer: vi.fn(),
    handleCloseGit: vi.fn(),
    handleOpenBrowserTab: vi.fn(),
    handleOpenBrowserUrl: vi.fn(),
    handleOpenCodeViewer: vi.fn(),
    handleRefreshGit: vi.fn(),
    handleReloadSession: vi.fn(async () => {}),
    handleReorderSidePaneTab: vi.fn(),
    handleOpenAutomations: vi.fn(),
    handleSelectTask: vi.fn(),
    handleStartDraftInWorkspace: vi.fn(),
    handleTaskNavBack: vi.fn(),
    handleTaskNavForward: vi.fn(),
    handleToggleBrowser: vi.fn(),
    handleToggleGit: vi.fn(),
    handleToggleSidePane: vi.fn(),
    handleToggleSidebar: vi.fn(),
    handleToggleTerminal: vi.fn(),
    onOpenAutomationConsumed: vi.fn(),
    onWorkspaceMainViewChange: vi.fn(),
    openAutomationId: null,
    workspaceMainView: "chat" as const,
    headerGitChangeSummary: null,
    isBrowserOpen: false,
    isDesktop: true,
    isGitOpen: false,
    isMacDesktop: false,
    isMacFullscreen: false,
    isSidePaneOpen: false,
    isSidebarVisible: true,
    isTerminalOpen: false,
    isWindowsDesktop: false,
    newTaskShortcutLabel: "",
    onCancelRemoteProject: vi.fn(async () => {}),
    onConnectRemote: vi.fn(async () => ""),
    onCreateTask: vi.fn(),
    onLogin: vi.fn(),
    onLogout: vi.fn(),
    onOpenWorkspace: vi.fn(),
    onReconnectRemoteWorkspace: vi.fn(async () => {}),
    onSelectRemoteProject: vi.fn(async () => {}),
    platform: {},
    projectName: "project",
    providerConfigFile: {
      exists: false,
      loading: false,
      path: null,
    },
    reconnectingRemoteWorkspaceKeys: [],
    reloadSessionDisabled: false,
    reloadSessionPending: false,
    remoteWorkspaceErrorByWorkspaceKey: {},
    remoteWorkspaceSessions: [],
    resolvedActiveTaskMeta: null,
    services: {},
    setGitSelectedSourceId: vi.fn(),
    setIsTerminalOpen: vi.fn(),
    shellPanelIds: ["sidebar", "content"],
    sidePaneState: null,
    sidebarContainerRef: { current: null },
    taskNativeSessionLogFile: {
      exists: false,
      loading: false,
      path: null,
      provider: null,
    },
    taskSessionFile: {
      path: null,
    },
    testMessages: null,
    theme: "light" as const,
    toggleSidebarShortcutLabel: "",
    toggleSidePaneShortcutLabel: "Ctrl+Alt+B",
    updateReadyVersion: null,
    user: null,
    webRemoteControlWorkspaceSwitcher: undefined,
    workspaceAbsPath: "/tmp/project",
    workspaceRemoteSessionId: undefined,
    workspaceShellZCodeState: {
      activeTaskId: null,
      modelSwitchPending: false,
      modelSwitchStage: null,
      optimisticTaskListByTaskId: {},
      selectedProvider: "codex",
      taskError: null,
      taskStatus: "notReady",
      workspaceInit: {
        attempts: 0,
        error: null,
        status: "idle",
      },
    },
    workspaceTabs: [],
  };
}

describe("WorkspaceShellLayout wiring (full-shell static render)", () => {
  async function renderShell(
    overrides: Partial<ReturnType<typeof createWorkspaceShellProps>>,
  ) {
    const { WorkspaceShellLayout } =
      await import("@/app-shell/WorkspaceShellLayout.js");
    return renderToStaticMarkup(
      createElement(WorkspaceShellLayout, {
        ...createWorkspaceShellProps(),
        ...overrides,
      } as Parameters<typeof WorkspaceShellLayout>[0]),
    );
  }

  it.each([
    { name: "chat-center, tabs visible", dc: false, tabs: true },
    {
      name: "chat-center, tabs hidden (chat full width)",
      dc: false,
      tabs: false,
    },
    {
      name: "document-center, tabs visible (persisted swap = reload survival)",
      dc: true,
      tabs: true,
    },
    { name: "document-center, tabs hidden", dc: true, tabs: false },
  ])(
    "$name: role toggle present with honest labels, exactly one window-controls cluster",
    async ({ dc, tabs }) => {
      localStorage.setItem(
        specShellLayoutSwapKey("/tmp/project"),
        JSON.stringify({
          version: 1,
          mode: dc ? "document-center" : "chat-center",
        }),
      );
      const html = await renderShell({
        isSidePaneOpen: tabs,
        isWindowsDesktop: true,
      });
      expect(html).toContain(
        `data-spec-shell-layout="${dc ? "document-center" : "chat-center"}"`,
      );
      // 角色开关：tabs caption（可见时）为主入口；tabs 隐藏 ⇒ 聊天列 Header 承接恢复。
      // dc 双可见时聊天列 Header 因「按钮/窗控同门」契约额外渲染一个惰性恢复按钮
      // （点击无副作用），真实角色开关（Скрыть）始终唯一。
      const roleToggles =
        html.split(`data-testid="${TID_SIDE_PANE_TOGGLE}"`).length - 1;
      const hideLabels =
        html.split('aria-label="sidePane.collapse"').length - 1;
      const showLabels = html.split('aria-label="sidePane.expand"').length - 1;
      if (tabs) {
        expect(roleToggles).toBe(dc ? 2 : 1);
        expect(hideLabels).toBe(1);
        expect(showLabels).toBe(dc ? 1 : 0);
      } else {
        expect(roleToggles).toBe(1);
        expect(hideLabels).toBe(0);
        expect(showLabels).toBe(1);
      }
      // 窗控恰一组。
      expect(
        html.split('data-testid="desktop-window-controls"').length - 1,
      ).toBe(1);
      // 旧按钮不残留。
      expect(html).not.toContain("Show main chat");
      expect(html).not.toContain("Развернуть документ");
      expect(html).not.toContain("Вернуть чат");
      // swap 控制随 tabs caption 存在；aria-pressed 跟随排列。
      if (tabs) {
        expect(html).toContain('data-spec-shell-layout-swap-toggle=""');
        expect(html).toContain(`aria-pressed="${dc ? "true" : "false"}"`);
      }
    },
  );

  it("chat-center with tabs visible puts the window controls on the tabs caption, not the chat header", async () => {
    const html = await renderShell({
      isSidePaneOpen: true,
      isWindowsDesktop: true,
    });
    expect(html).toContain('data-testid="side-pane-panel"');
    const panelIndex = html.indexOf('data-testid="side-pane-panel"');
    const headerIndex = html.indexOf('data-testid="workspace-header"');
    const controlsIndex = html.indexOf('data-testid="desktop-window-controls"');
    expect(headerIndex).toBeGreaterThan(-1);
    expect(panelIndex).toBeGreaterThan(-1);
    expect(controlsIndex).toBeGreaterThan(panelIndex);
  });

  it("document-center routes the window controls to the chat header while both regions are visible", async () => {
    localStorage.setItem(
      specShellLayoutSwapKey("/tmp/project"),
      JSON.stringify({ version: 1, mode: "document-center" }),
    );
    const html = await renderShell({
      isSidePaneOpen: true,
      isWindowsDesktop: true,
    });
    const headerIndex = html.indexOf('data-testid="workspace-header"');
    const panelIndex = html.indexOf('data-testid="side-pane-panel"');
    const controlsIndex = html.indexOf('data-testid="desktop-window-controls"');
    expect(controlsIndex).toBeGreaterThan(headerIndex);
    expect(controlsIndex).toBeLessThan(panelIndex);
  });

  it("web (no inline window controls) suppresses the idle chat-caption restore button in document-center", async () => {
    localStorage.setItem(
      specShellLayoutSwapKey("/tmp/project"),
      JSON.stringify({ version: 1, mode: "document-center" }),
    );
    // isDesktop=false 且无 task 时不渲染 Header；给一个 task 让 Header 渲染，
    // 抑制逻辑才真正被检验（否则两个开关：tabs caption + Header）。
    const html = await renderShell({
      isSidePaneOpen: true,
      isDesktop: false,
      isWindowsDesktop: false,
      isMacDesktop: false,
      activeTaskId: "task-1",
    });
    // 无内联窗控平台：dc 双可见时聊天列 Header 不渲染无事可做的恢复按钮；
    // 唯一角色开关在 tabs caption。
    expect(html.split(`data-testid="${TID_SIDE_PANE_TOGGLE}"`).length - 1).toBe(
      1,
    );
    expect(html.split('aria-label="sidePane.collapse"').length - 1).toBe(1);
    expect(html).not.toContain('data-testid="desktop-window-controls"');
  });

  it("tabs hidden parks the restore affordance in the chat header (shell-anchored, outside the hidden region)", async () => {
    const html = await renderShell({
      isSidePaneOpen: false,
      isWindowsDesktop: true,
    });
    // tabs 隐藏 ⇒ 恢复入口落在聊天列 Header（壳层常驻，不在被隐藏区域内）。
    const toggleIndex = html.indexOf(`data-testid="${TID_SIDE_PANE_TOGGLE}"`);
    const headerIndex = html.indexOf('data-testid="workspace-header"');
    expect(toggleIndex).toBeGreaterThan(headerIndex);
    expect(html.split('aria-label="sidePane.expand"').length - 1).toBe(1);
  });
});
