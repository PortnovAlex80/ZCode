// 渲染性能 Wave A：SessionPane 级 presentation visibility 回归。
//
// 证明（在极简 DOM 中，ConversationTimeline 以捕获 props 的替身渲染）：
// 1. 隐藏（presentationVisible=false）期间的流式 snapshot 更新：
//    - notifyUserInputRendered 不再误报（隐藏树的 commit 不算可见渲染）；
//    - O(rows) 的 workflow 卡联查表不再随 token 重建；
//    - ConversationTimeline 仍收到实时 rows（订阅与控制面保持存活）；
// 2. 恢复展示：pending userInput 补报、timeline 拿到 presentationVisible=true 与最新 rows；
// 3. composer（bottomDock 内容）跨隐藏/恢复保持同一实例；
// 4. 指定隐藏主 pane 的 execution-config 源在 keepSpecExecutionSource 下照常发布；
// 5. 隐藏状态下 composer 仍可发送（控制面不受展示挂起影响）。
//
// 器具复制自 v4SessionPaneComposerContinuity.test.ts。

import { act, createElement, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ConversationRow,
  ConversationSnapshot,
  UserInputRow,
} from "@zcode/shared/zcode-protocol-v4";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import type { PendingCommandEntry } from "@/v4/pendingCommandRegistry.js";
import { SessionPane } from "@/v4/SessionPane.js";
import { useConversationShareSelectionStore } from "@/store/conversationShareSelectionStore.js";

type ProjectionState = {
  status: "connecting" | "live";
  snapshot: ConversationSnapshot | null;
  subscriptionId: string | null;
  lastError: null;
  optimisticCommands: readonly [];
  loadingOlder: boolean;
};

const recoveryCapture = vi.hoisted(() => ({
  entries: [] as PendingCommandEntry[],
  onResend: null as null | (() => void),
}));
vi.mock("@/v4/usePendingCommandRecovery.js", () => ({
  usePendingCommandRecovery: () => recoveryCapture.entries,
}));
vi.mock("@/v4/PendingCommandRecoveryBanner.js", () => ({
  PendingCommandRecoveryBanner: (props: { onResend?: () => void }) => {
    recoveryCapture.onResend = props.onResend ?? null;
    return null;
  },
}));

const sessionCreateCapture = vi.hoisted(() => ({ report: vi.fn(async () => {}) }));
vi.mock("@/lib/sessionCreateTelemetry.js", () => ({
  reportSessionCreate: sessionCreateCapture.report,
}));

const projectionState = vi.hoisted(() => ({
  current: null as ProjectionState | null,
}));

const telemetryCapture = vi.hoisted(() => ({
  notifyUserInputRendered: vi.fn(),
  attachForeground: vi.fn(() => () => {}),
}));
vi.mock("@/v4/telemetry/ConversationTelemetryAttachment.js", () => ({
  useScopedConversationTelemetrySupervisor: () => ({
    attachForeground: telemetryCapture.attachForeground,
    notifyUserInputRendered: telemetryCapture.notifyUserInputRendered,
  }),
  useScopedConversationTelemetryForegroundEnabled: () => true,
}));

const executionSourceCapture = vi.hoisted(() => ({
  publishes: [] as Array<{ workspaceKey: string; enabled: boolean }>,
}));
vi.mock("@/spec-document/nativeExecutionSource.js", () => ({
  nativeExecutionSource: (input: unknown) => input,
  usePublishNativeExecutionSource: (workspaceKey: string, enabled: boolean) => {
    const last = executionSourceCapture.publishes.at(-1);
    if (!last || last.workspaceKey !== workspaceKey || last.enabled !== enabled) {
      executionSourceCapture.publishes.push({ workspaceKey, enabled });
    }
  },
}));

const workflowJoinCapture = vi.hoisted(() => ({
  graphCalls: 0,
  fillGraphCalls: 0,
  draftCalls: 0,
  saveCandidatesCalls: 0,
}));
vi.mock("@/v4/workflowRunCardJoin.js", () => ({
  buildWorkflowRunByRunId: () => new Map(),
  buildWorkflowRunByToolCallId: () => new Map(),
  buildWorkflowRunPendingQuestionsByRunId: () => new Map(),
  buildWorkflowGraphByToolCallId: () => {
    workflowJoinCapture.graphCalls += 1;
    return new Map();
  },
  buildWorkflowFillGraphByRunId: () => {
    workflowJoinCapture.fillGraphCalls += 1;
    return new Map();
  },
  buildWorkflowSaveCandidatesByRunId: () => {
    workflowJoinCapture.saveCandidatesCalls += 1;
    return new Map();
  },
}));
vi.mock("@/v4/workflowDraftJoin.js", () => ({
  buildWorkflowDraftByToolCallId: () => {
    workflowJoinCapture.draftCalls += 1;
    return new Map();
  },
}));

// 复核 #2 发现 4：隐藏期 token-频率展示扫描的确定性计数器。
const hiddenScanCapture = vi.hoisted(() => ({
  pluginReferenceScanCalls: 0,
  shareRenderUnitsBuilds: 0,
}));
vi.mock("@/v4/pluginReferenceIconProjection.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/v4/pluginReferenceIconProjection.js")>();
  return {
    ...actual,
    hasPluginReferenceUserRows: (...args: Parameters<typeof actual.hasPluginReferenceUserRows>) => {
      hiddenScanCapture.pluginReferenceScanCalls += 1;
      return actual.hasPluginReferenceUserRows(...args);
    },
  };
});
vi.mock("@/v4/conversationTurnRenderUnits.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/v4/conversationTurnRenderUnits.js")>();
  return {
    ...actual,
    buildConversationTurnRenderUnits: (
      ...args: Parameters<typeof actual.buildConversationTurnRenderUnits>
    ) => {
      hiddenScanCapture.shareRenderUnitsBuilds += 1;
      return actual.buildConversationTurnRenderUnits(...args);
    },
  };
});
// 分享选择面板挂在极简 DOM 上需要 querySelector/closest；本文件只测 SessionPane 侧的
// 派生计数，不测面板本身（面板有独立测试）。
vi.mock("@/v4/ConversationShareSelectionPanel.js", () => ({
  ConversationShareSelectionPanel: () => null,
}));
vi.mock("@/v4/ConversationShareSelectionReopenTab.js", () => ({
  ConversationShareSelectionReopenTab: () => null,
}));
vi.mock("@/v4/ConversationShareSelectionDock.js", () => ({
  ConversationShareSelectionDock: () => null,
}));

const timelineCapture = vi.hoisted(() => ({
  props: null as null | { rows: readonly ConversationRow[]; presentationVisible?: boolean },
}));
vi.mock("@/v4/ConversationTimeline.js", () => ({
  ConversationTimeline: (props: {
    rows: readonly ConversationRow[];
    presentationVisible?: boolean;
    bottomDock?: ReactNode;
  }) => {
    timelineCapture.props = props;
    return createElement("div", null, props.bottomDock);
  },
}));

const composerLifecycle = vi.hoisted(() => ({
  mounts: 0,
  nextInstanceId: 1,
  onSendText: null as
    | null
    | ((text: string) => Promise<"sent" | "blocked" | "confirmationRequired">),
  unmounts: 0,
}));
vi.mock("@/v4/ConversationComposer.js", () => ({
  ConversationComposer: (props: {
    onSendText: (
      text: string,
      options?: {
        submission?: {
          mode: string;
          modelSelection: {
            providerId: string;
            modelId: string;
            options: Record<string, string>;
          };
        };
      },
    ) => Promise<"sent" | "blocked" | "confirmationRequired">;
  }) => {
    composerLifecycle.onSendText = props.onSendText;
    useEffect(() => {
      composerLifecycle.mounts += 1;
      return () => {
        composerLifecycle.unmounts += 1;
      };
    }, []);
    return createElement("div", { "data-testid": "mock-composer" });
  },
}));

const workflowRunsQueryMock = vi.hoisted(() =>
  vi.fn(() => new Promise<{ runs: unknown[] }>(() => {})),
);
const conversationMock = vi.hoisted(() => {
  const lease = {
    sessionId: "session-1",
    release: vi.fn(),
    store: {
      expectAcceptedInputProjection: vi.fn(),
      markCommandPending: vi.fn(),
      recoverFromStaleAuthority: vi.fn(),
      onLiveDeltas: vi.fn(() => () => {}),
      onOnlineModelTransition: vi.fn(() => () => {}),
      refreshPlans: vi.fn(async () => {}),
      settleCommand: vi.fn(),
    },
  };
  const sendCommand = vi.fn(async (envelope: { commandId: string }) => ({
    commandId: envelope.commandId,
    revisionAtDecision: 1,
    status: "accepted" as const,
  }));
  const layer = {
    acquire: vi.fn(() => lease),
    queryCommands: vi.fn(async () => ({ results: [] })),
  };
  return { layer, lease, sendCommand };
});

const prewarmHookInputs = vi.hoisted(() => ({
  binding: null as null | { sessionId: string },
}));
const servicesMock = vi.hoisted(() => ({
  highspeedCardService: {
    getSnapshot: vi.fn(() => new Promise(() => {})),
    prepareTurn: vi.fn(async () => ({
      kind: "fallback" as const,
      reason: "draw-miss" as const,
      nextDrawAt: null,
    })),
    healthy: vi.fn(),
    share: vi.fn(),
  },
  modelSelectionService: {
    getView: vi.fn(async () => ({
      revision: 1,
      providers: [
        {
          providerId: "provider-deepseek",
          config: { kind: "api" as const },
          models: [{ modelId: "deepseek-v4-flash", config: {} }],
        },
      ],
    })),
    onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
    validate: vi.fn(),
  },
  zcodeSessionService: {
    updateProviderRegistry: vi.fn(),
  },
  zcodeTaskService: {
    restartWorkspaceProcess: vi.fn(),
  },
  // usePublishNativeExecutionSource 的发布裁决要求 specDocumentService 存在。
  specDocumentService: {},
  // 上游 3.16.2 的 recent-submission 流程会解析会话项目归属；补齐 projectService。
  projectService: {
    resolveSessionDirectories: vi.fn(async (task: { taskId?: string }) => ({
      ...task,
      projectId: null,
      additionalDirectories: [],
    })),
  },
}));

vi.mock("@/components/ui/toast.js", () => ({ toast: vi.fn() }));
vi.mock("@/v4/BotGroupDeliveryAction.js", () => ({
  BotGroupDeliveryProvider: ({ children }: { children: unknown }) => children,
  ConnectedBotGroupDeliveryAction: () => null,
}));
vi.mock("@/v4/OffPeakNewTaskEntry.js", () => ({
  OffPeakNewTaskEntry: () => null,
}));
vi.mock("@/v4/ConversationDraftSuggestedPromptsContainer.js", () => ({
  ConversationDraftSuggestedPromptsContainer: () => null,
}));
vi.mock("@/v4/useConversationProjection.js", () => ({
  useConversationProjection: () => projectionState.current,
}));
vi.mock("@/v4/V4ConversationContext.js", () => ({
  useV4Conversation: () => ({
    layer: conversationMock.layer,
    sendCommand: conversationMock.sendCommand,
    attachmentPut: vi.fn(),
    workflowRuns: workflowRunsQueryMock,
    fileChanges: vi.fn(),
    fileRewindPreview: vi.fn(),
  }),
}));
vi.mock("@/store/StoreProvider.js", () => ({
  useZCodeStoreWithDefault: (_selector: unknown, fallback: unknown) => fallback,
}));
vi.mock("@/hooks/useSettingService.js", () => ({
  useSettings: () => ({
    settings: { zcodeInteractionBehavior: "queue" },
    loading: false,
    error: null,
    update: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
  }),
}));
vi.mock("@/hooks/useServices.js", () => ({
  useOptionalServices: () => null,
  useServices: () => servicesMock,
  // 上游 3.16.2 新增的 composer namespace hook；本测试不覆盖该路径。
  useComposerClientNamespace: () => undefined,
}));
vi.mock("@/hooks/useModelSelectionView.js", () => ({
  useModelSelectionServiceView: () => ({
    state: {
      status: "ready",
      view: {
        revision: 1,
        preferredSelection: {
          providerId: "provider-deepseek",
          modelId: "deepseek-v4-flash",
        },
        providers: [
          {
            providerId: "provider-deepseek",
            config: { kind: "api" as const },
            models: [
              {
                modelId: "deepseek-v4-flash",
                config: {
                  optionSpecs: { reasoningLevel: { values: ["low", "high"], map: "{}" } },
                },
              },
            ],
          },
        ],
      },
    },
    reload: vi.fn(),
  }),
}));
vi.mock("@/v4/composer/useDraftConfigControl.js", () => ({
  buildDraftCreateConfigPayload: () => ({}),
  useDraftConfigControl: () => ({
    modelSelectionRead: { state: { status: "ready" } },
    captureAcceptedModelSelection: () => vi.fn(),
    composerDraft: { text: "", updatedAt: 0 },
    draftConfig: {},
    draftConfigRef: {
      current: {
        mode: "build",
        modelSelection: {
          providerId: "provider-deepseek",
          modelId: "deepseek-v4-flash",
          options: { reasoningLevel: "high" },
        },
      },
    },
    resolveInitialDraftConfig: vi.fn(async () => ({})),
    handleDraftSelectModel: vi.fn(),
    handleDraftSelectThought: vi.fn(),
    handleDraftSwitchMode: vi.fn(),
    promoteComposerDraft: vi.fn(),
    replaceComposerDraft: vi.fn(),
    updateComposerContent: vi.fn(),
  }),
}));
vi.mock("@/v4/composer/useDraftSessionPrewarm.js", () => ({
  useDraftSessionPrewarm: () => ({ binding: prewarmHookInputs.binding }),
}));
vi.mock("@/v4/ConversationHeader.js", () => ({
  ConversationHeader: () => createElement("div", null),
}));
vi.mock("@/v4/ConversationStatusPanel.js", () => ({
  ConversationStatusPanel: () => createElement("div", null),
}));
vi.mock("@/v4/ConversationQueuePanel.js", () => ({
  ConversationQueuePanel: () => createElement("div", null),
}));
vi.mock("@/v4/V4InteractionDialogs.js", () => ({
  V4InteractionDialogs: () => createElement("div", null),
}));
vi.mock("@/request-security-edition/V4ProviderRuntimeHeadersController.js", () => ({
  V4ProviderRuntimeHeadersController: () => createElement("div", null),
}));
vi.mock("@/v4/ConversationDraftEmptyState.js", () => ({
  ConversationDraftEmptyState: () => createElement("div", null),
}));

function userInputRow(rowId: number): UserInputRow {
  return {
    rowId,
    turnId: `turn-${rowId}`,
    createdAt: 1_700_000_000_000 + rowId,
    createdAtSeq: rowId,
    kind: "userInput",
    origin: "realUser",
    text: `message ${rowId}`,
    attachments: [],
    sourceCommandId: `cmd-${rowId}`,
  };
}

function makeSessionSnapshot(rows: readonly ConversationRow[]): ConversationSnapshot {
  return {
    protocolVersion: 1,
    sessionId: "session-1",
    logEpoch: "epoch-1",
    seq: rows.length,
    revision: rows.length,
    control: {
      phase: "running",
      sessionEnded: false,
      canStop: true,
      stopState: "idle",
      stopTargetKind: "unknown",
      activeWorks: [],
      lastError: null,
      apiRetry: null,
    },
    availability: {
      fork: { allowed: true },
      compact: { allowed: true },
      switchModelConfig: { allowed: true },
      setFollowupMode: { allowed: true },
      queueEdit: { allowed: true },
      sendQueuedNow: { allowed: false, reasonCode: "emptyQueue" },
      pauseGoal: { allowed: false, reasonCode: "noGoalToPause" },
      resumeGoal: { allowed: false, reasonCode: "noGoalToResume" },
    },
    inputRouting: { mode: "startNow" },
    meta: { title: "", titleSource: "firstInput" },
    config: {
      provider: "provider-deepseek",
      model: "deepseek-v4-flash",
      thought: "medium",
      followupMode: "queue",
      mode: "build",
    },
    usage: {
      contextWindow: null,
      cumulative: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    },
    queue: { items: [], autoDrain: true },
    pendingInteractions: [],
    pendingCommands: [],
    backgroundWorks: [],
    subagents: { revision: 0, childSessionIds: [], running: [], endedTotal: 0 },
    goal: null,
    plan: null,
    rows: { window: [...rows], totalCount: rows.length, firstRowId: rows[0]?.rowId ?? null },
  } as ConversationSnapshot;
}

const mountedRoots: Root[] = [];

function createMinimalElement(ownerDocument: Document, tagName = "div") {
  const element = {
    addEventListener: () => {},
    appendChild: (child: { parentNode?: unknown }) => {
      child.parentNode = element;
      return child;
    },
    childNodes: [] as unknown[],
    clientWidth: 1024,
    getAttribute: () => null,
    insertBefore: (child: { parentNode?: unknown }) => {
      child.parentNode = element;
      return child;
    },
    nodeName: tagName.toUpperCase(),
    nodeType: 1,
    ownerDocument,
    parentNode: null as unknown,
    removeAttribute: () => {},
    removeChild: (child: { parentNode?: unknown }) => {
      child.parentNode = null;
      return child;
    },
    removeEventListener: () => {},
    setAttribute: () => {},
    style: {
      removeProperty: () => {},
      setProperty: () => {},
    },
    tagName: tagName.toUpperCase(),
  };
  return element as unknown as Element;
}

// 复核 #2 发现 3：文档级可见性受控（useCombinedPresentationVisibility 读取
// document.visibilityState；addEventListener 为 no-op，状态变化由测试直接改写后重渲）。
const documentVisibility = { state: "visible" as "visible" | "hidden" };

function installMinimalDom() {
  const documentMock = {
    addEventListener: () => {},
    createElement: (tagName: string) =>
      createMinimalElement(documentMock as unknown as Document, tagName),
    createTextNode: (nodeValue: string) => ({
      nodeType: 3,
      nodeValue,
      ownerDocument: documentMock,
      parentNode: null,
    }),
    nodeType: 9,
    removeEventListener: () => {},
    get visibilityState() {
      return documentVisibility.state;
    },
  } as unknown as Document;
  const windowMock = {
    addEventListener: () => {},
    document: documentMock,
    HTMLIFrameElement: function HTMLIFrameElement() {},
    HTMLElement: function HTMLElement() {},
    innerWidth: 1024,
    Node: function Node() {},
    removeEventListener: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: () => 1,
    clearTimeout: () => {},
  };
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: documentMock,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: windowMock,
  });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
  return createMinimalElement(documentMock, "div");
}

interface PaneRenderOptions {
  sessionId: string | null;
  focused?: boolean;
  telemetryVisible?: boolean;
  presentationVisible?: boolean;
  keepSpecExecutionSource?: boolean;
  isDesktop?: boolean;
}

function renderPane(root: Root, options: PaneRenderOptions): void {
  const { sessionId, ...flags } = options;
  act(() => {
    root.render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(SessionPane, {
          paneId: "workspace-main",
          sessionId,
          workspacePath: "/workspace",
          ...flags,
        }),
      ),
    );
  });
}

beforeEach(() => {
  sessionCreateCapture.report.mockClear();
  recoveryCapture.entries = [];
  recoveryCapture.onResend = null;
  prewarmHookInputs.binding = null;
  composerLifecycle.mounts = 0;
  composerLifecycle.nextInstanceId = 1;
  composerLifecycle.onSendText = null;
  composerLifecycle.unmounts = 0;
  conversationMock.layer.acquire.mockClear();
  conversationMock.lease.release.mockClear();
  conversationMock.sendCommand.mockClear();
  telemetryCapture.notifyUserInputRendered.mockClear();
  telemetryCapture.attachForeground.mockClear();
  executionSourceCapture.publishes = [];
  workflowJoinCapture.graphCalls = 0;
  workflowJoinCapture.fillGraphCalls = 0;
  workflowJoinCapture.draftCalls = 0;
  workflowJoinCapture.saveCandidatesCalls = 0;
  hiddenScanCapture.pluginReferenceScanCalls = 0;
  hiddenScanCapture.shareRenderUnitsBuilds = 0;
  documentVisibility.state = "visible";
  useConversationShareSelectionStore.getState().resetForTests();
  timelineCapture.props = null;
  projectionState.current = {
    status: "live",
    snapshot: makeSessionSnapshot([userInputRow(1), userInputRow(2)]),
    subscriptionId: "sub-1",
    lastError: null,
    optimisticCommands: [],
    loadingOlder: false,
  };
});

afterEach(() => {
  for (const root of mountedRoots.splice(0)) {
    act(() => root.unmount());
  }
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT;
});

describe("SessionPane presentation suspension (Wave A)", () => {
  it("隐藏期间的流式 snapshot：不误报可见渲染、不重建 O(rows) 联查表、rows 仍实时下发给 timeline", () => {
    const root = createRoot(installMinimalDom());
    mountedRoots.push(root);
    renderPane(root, { sessionId: "session-1" });
    const notifiedAfterVisible = telemetryCapture.notifyUserInputRendered.mock.calls.length;
    const graphCallsAfterVisible = workflowJoinCapture.graphCalls;
    expect(notifiedAfterVisible).toBeGreaterThanOrEqual(1);
    expect(graphCallsAfterVisible).toBeGreaterThanOrEqual(1);

    // 隐藏（Settings 覆盖/文档居中折叠等的共同输入），推送 24 次 token 形状的 snapshot。
    renderPane(root, {
      sessionId: "session-1",
      focused: false,
      telemetryVisible: false,
      presentationVisible: false,
    });
    let rows: ConversationRow[] = [userInputRow(1), userInputRow(2)];
    for (let token = 0; token < 24; token += 1) {
      rows = [...rows, userInputRow(10 + token)];
      projectionState.current = {
        ...projectionState.current!,
        snapshot: makeSessionSnapshot(rows),
      };
      renderPane(root, {
        sessionId: "session-1",
        focused: false,
        telemetryVisible: false,
        presentationVisible: false,
      });
    }
    expect(telemetryCapture.notifyUserInputRendered.mock.calls.length).toBe(notifiedAfterVisible);
    expect(workflowJoinCapture.graphCalls).toBe(graphCallsAfterVisible);
    expect(timelineCapture.props?.presentationVisible).toBe(false);
    // 控制面新鲜度：timeline 仍拿到实时 rows（冻结只发生在 timeline 内部的展示推导）。
    expect(timelineCapture.props?.rows.length).toBe(rows.length);

    // 恢复展示：pending userInput 补报，timeline 回到展示态并继续拿最新 rows。
    renderPane(root, { sessionId: "session-1", presentationVisible: true });
    expect(telemetryCapture.notifyUserInputRendered.mock.calls.length).toBeGreaterThan(
      notifiedAfterVisible,
    );
    expect(timelineCapture.props?.presentationVisible).toBe(true);
    expect(timelineCapture.props?.rows.length).toBe(rows.length);
    expect(workflowJoinCapture.graphCalls).toBeGreaterThan(graphCallsAfterVisible);
  });

  it("composer 跨隐藏/恢复保持同一挂载实例，隐藏状态下仍可发送", async () => {
    const root = createRoot(installMinimalDom());
    mountedRoots.push(root);
    renderPane(root, { sessionId: "session-1" });
    renderPane(root, {
      sessionId: "session-1",
      focused: false,
      telemetryVisible: false,
      presentationVisible: false,
    });
    expect(composerLifecycle.onSendText).not.toBeNull();
    let sendResult: "sent" | "blocked" | "confirmationRequired" | null = null;
    await act(async () => {
      // 与真实 Composer 一致：绑定的会话必须随发送携带完整 submission 配置。
      sendResult = await composerLifecycle.onSendText!("hidden pane input", {
        submission: {
          mode: "build",
          modelSelection: {
            providerId: "provider-deepseek",
            modelId: "deepseek-v4-flash",
            options: { reasoningLevel: "high" },
          },
        },
      });
    });
    expect(sendResult).toBe("sent");
    expect(conversationMock.sendCommand).toHaveBeenCalled();

    renderPane(root, { sessionId: "session-1", presentationVisible: true });
    expect(composerLifecycle.mounts).toBe(1);
    expect(composerLifecycle.unmounts).toBe(0);
  });

  it("指定隐藏主 pane（keepSpecExecutionSource）在隐藏期间照常发布 execution-config 源", () => {
    const root = createRoot(installMinimalDom());
    mountedRoots.push(root);
    renderPane(root, {
      sessionId: "session-1",
      focused: false,
      telemetryVisible: false,
      presentationVisible: false,
      keepSpecExecutionSource: true,
      isDesktop: true,
    });
    expect(executionSourceCapture.publishes.at(-1)).toEqual({
      workspaceKey: "/workspace",
      enabled: true,
    });

    // 未被指定为隐藏源的 pane：隐藏时不发布（保持既有裁决，不因新 prop 放宽）。
    executionSourceCapture.publishes = [];
    renderPane(root, {
      sessionId: "session-1",
      focused: false,
      telemetryVisible: false,
      presentationVisible: false,
      isDesktop: true,
    });
    expect(executionSourceCapture.publishes.at(-1)).toEqual({
      workspaceKey: "/workspace",
      enabled: false,
    });
  });

  it("复核 #2 发现 3：宿主文档隐藏同样冻结展示职责，恢复后按累计 projection 补齐（真实 SessionPane 行为）", () => {
    const root = createRoot(installMinimalDom());
    mountedRoots.push(root);
    // 可见宿主：正常推导（workflow 联查表运行）。
    renderPane(root, { sessionId: "session-1" });
    const graphAfterVisible = workflowJoinCapture.graphCalls;
    expect(graphAfterVisible).toBeGreaterThanOrEqual(1);

    // 主文档隐藏（presentationVisible 仍为 true）：等价于隐藏 pane。
    documentVisibility.state = "hidden";
    let rows: ConversationRow[] = [userInputRow(1), userInputRow(2)];
    for (let token = 0; token < 6; token += 1) {
      rows = [...rows, userInputRow(10 + token)];
      projectionState.current = {
        ...projectionState.current!,
        snapshot: makeSessionSnapshot(rows),
      };
      renderPane(root, { sessionId: "session-1" });
    }
    expect(workflowJoinCapture.graphCalls).toBe(graphAfterVisible);
    expect(timelineCapture.props?.presentationVisible).toBe(false);
    const notifiedWhileHidden = telemetryCapture.notifyUserInputRendered.mock.calls.length;

    // 可见 PiP 场景（独立文档 realm 中 document 即该文档）：宿主展示 + 文档可见。
    documentVisibility.state = "visible";
    renderPane(root, { sessionId: "session-1" });
    expect(timelineCapture.props?.presentationVisible).toBe(true);
    expect(telemetryCapture.notifyUserInputRendered.mock.calls.length).toBeGreaterThan(
      notifiedWhileHidden,
    );
    expect(workflowJoinCapture.graphCalls).toBeGreaterThan(graphAfterVisible);
    // 恢复后拿到的是隐藏期间累计的最新窗口。
    expect(timelineCapture.props?.rows.length).toBe(rows.length);

    // 隐藏 PiP：宿主 visible=false + 文档隐藏 → 同样冻结。
    documentVisibility.state = "hidden";
    renderPane(root, { sessionId: "session-1", focused: false, presentationVisible: false });
    expect(timelineCapture.props?.presentationVisible).toBe(false);
  });

  it("复核 #2 发现 4：隐藏期 token 扫描为零（plugin 引用扫描 / share 单元重建 / share 同步），分享激活与未激活都成立", () => {
    const root = createRoot(installMinimalDom());
    mountedRoots.push(root);
    // 暖机（可见）。
    renderPane(root, { sessionId: "session-1" });
    const scansAfterVisible = hiddenScanCapture.pluginReferenceScanCalls;
    const shareBuildsAfterVisible = hiddenScanCapture.shareRenderUnitsBuilds;
    expect(scansAfterVisible).toBeGreaterThanOrEqual(1);

    // --- 分享未激活：隐藏流式。 ---
    let rows: ConversationRow[] = [userInputRow(1), userInputRow(2)];
    for (let token = 0; token < 5; token += 1) {
      rows = [...rows, userInputRow(10 + token)];
      projectionState.current = {
        ...projectionState.current!,
        snapshot: makeSessionSnapshot(rows),
      };
      renderPane(root, { sessionId: "session-1", focused: false, presentationVisible: false });
    }
    expect(hiddenScanCapture.pluginReferenceScanCalls).toBe(scansAfterVisible);
    expect(hiddenScanCapture.shareRenderUnitsBuilds).toBe(shareBuildsAfterVisible);

    // --- 分享激活：可见时建立分享选择，随后隐藏继续流式。 ---
    // 上游 3.16.2 移除了 setScope；激活分享选择改为 openShare（draft.open = true）。
    act(() => {
      useConversationShareSelectionStore.getState().openShare("session-1");
    });
    renderPane(root, { sessionId: "session-1" });
    const shareBuildsAfterActivation = hiddenScanCapture.shareRenderUnitsBuilds;
    expect(shareBuildsAfterActivation).toBeGreaterThan(shareBuildsAfterVisible);
    const syncSpy = vi.spyOn(useConversationShareSelectionStore.getState(), "syncAvailableTurns");
    const syncCallsAfterActivation = syncSpy.mock.calls.length;

    for (let token = 0; token < 5; token += 1) {
      rows = [...rows, userInputRow(20 + token)];
      projectionState.current = {
        ...projectionState.current!,
        snapshot: makeSessionSnapshot(rows),
      };
      renderPane(root, { sessionId: "session-1", focused: false, presentationVisible: false });
    }
    // 隐藏 + 分享激活：进入隐藏的首个 render 把 share 窗口钉回空窗（一次有界转换），
    // 其后每个 token 不再重建 share 渲染单元；available-turns 同步挂起。
    expect(hiddenScanCapture.shareRenderUnitsBuilds).toBe(shareBuildsAfterActivation + 1);
    expect(syncSpy.mock.calls.length).toBe(syncCallsAfterActivation);

    // 恢复展示：share 派生按最新窗口重建一次，同步恢复；选择状态未丢（草稿仍处于激活）。
    renderPane(root, { sessionId: "session-1" });
    expect(hiddenScanCapture.shareRenderUnitsBuilds).toBeGreaterThan(shareBuildsAfterActivation);
    expect(useConversationShareSelectionStore.getState().drafts["session-1"]?.open).toBe(true);
    syncSpy.mockRestore();
  });
});
