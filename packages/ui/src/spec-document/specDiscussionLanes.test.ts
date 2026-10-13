// @vitest-environment jsdom
// D-02 fixture coverage：三条上下文通道在 payload 层保持分离。
// 通道 1（项目聊天历史）：父会话只被只读观察（执行白名单），任何命令都不进入父会话。
// 通道 2（继承式 Side conversation）：由 SessionPane 以 createSelectionSideSession 派发到
//   父会话（本文件用源码断言其父绑定，命令构造在 v4 侧）。
// 通道 3（全新讨论）：createSession(sessionId=null, workspaceId, config 白名单) +
//   documentQuestion（仅 project binding、文档链接、精确片段、用户问题）。
// 本文件只伪造原生 uplink（sendCommand / projection store）——这是被测的 service
// boundary；createSession/sendText 载荷与 documentQuestion 均由真实实现构造。
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { act, createElement, type ReactNode } from "react";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandAck, CommandEnvelope, ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { SpecDiscussionPane } from "./SpecDiscussionPane.js";
import {
  changeSpecQuestionDraft,
  getSpecThreadStore,
  mergeSpecThreadUpdate,
  type SpecThread,
} from "./specThread.js";
import { specThreadStorageKey } from "./nativeDiscussionHandoff.js";

const lanes = vi.hoisted(() => ({
  layer: null as unknown as ReturnType<typeof createFakeLayer>,
  sendCommand: null as unknown as (envelope: CommandEnvelope) => Promise<CommandAck>,
  sessionPanes: [] as Record<string, unknown>[],
}));

/**
 * 假的数据层只实现 useConversationProjection/useSpecDiscussion 需要的只读契约：
 * getState 返回缓存对象（useSyncExternalStore 要求），命令方法只计数用于
 * 断言“父会话零命令写入”。
 */
function createFakeLayer() {
  interface FakeState {
    status: string;
    snapshot: ConversationSnapshot | null;
    listeners: Set<() => void>;
    projectionState: Record<string, unknown>;
    commands: { markCommandPending: number; settleCommand: number; expectAccepted: number };
  }
  const sessions = new Map<string, FakeState>();
  const rebuild = (state: FakeState) => {
    state.projectionState = {
      status: state.status,
      snapshot: state.snapshot,
      subscriptionId: null,
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
      sessionPlans: [],
      planDirectoryRevision: 0,
      plansLoading: false,
    };
  };
  const notify = (state: FakeState) => {
    for (const listener of state.listeners) listener();
  };
  return {
    sessions,
    seed(sessionId: string, status: string, snapshot: ConversationSnapshot | null) {
      const state: FakeState = {
        status,
        snapshot,
        listeners: new Set(),
        projectionState: {},
        commands: { markCommandPending: 0, settleCommand: 0, expectAccepted: 0 },
      };
      rebuild(state);
      sessions.set(sessionId, state);
    },
    settle(sessionId: string, status: string, snapshot: ConversationSnapshot | null) {
      const state = sessions.get(sessionId);
      if (!state) throw new Error(`unseeded session ${sessionId}`);
      state.status = status;
      state.snapshot = snapshot;
      rebuild(state);
      notify(state);
    },
    acquire(sessionId: string) {
      const state =
        sessions.get(sessionId) ??
        (sessions.set(
          sessionId,
          (() => {
            const fresh: FakeState = {
              status: "idle",
              snapshot: null,
              listeners: new Set(),
              projectionState: {},
              commands: { markCommandPending: 0, settleCommand: 0, expectAccepted: 0 },
            };
            rebuild(fresh);
            return fresh;
          })(),
        ),
        sessions.get(sessionId)!);
      return {
        sessionId,
        openKind: "pane",
        startedAt: 0,
        store: {
          subscribe: (listener: () => void) => {
            state.listeners.add(listener);
            return () => state.listeners.delete(listener);
          },
          getState: () => state.projectionState,
          markCommandPending: () => {
            state.commands.markCommandPending++;
          },
          settleCommand: () => {
            state.commands.settleCommand++;
          },
          expectAcceptedInputProjection: () => {
            state.commands.expectAccepted++;
          },
        },
        release: () => {},
      };
    },
    async queryCommands() {
      return { results: [] };
    },
  };
}

vi.mock("../v4/V4ConversationContext.js", () => ({
  V4PaneConversationProvider: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  // 只替换原生 uplink（service boundary），载荷构造仍在被测组件内。
  useV4Conversation: () => ({ layer: lanes.layer, sendCommand: lanes.sendCommand }),
}));
vi.mock("../v4/SessionPane.js", () => ({
  SessionPane: (props: Record<string, unknown>) => {
    lanes.sessionPanes.push(props);
    return createElement("div", { "data-native-composer-stub": String(props.sessionId ?? "") });
  },
}));

/** 父会话执行白名单快照：含一个不得进入讨论载荷的额外字段。 */
const PARENT_CONFIG = {
  provider: "native-provider",
  model: "native-model",
  mode: "default",
  thought: "off",
  followupMode: "queue",
  modelSelection: { providerId: "native-provider", modelId: "native-model" },
  planEnabled: false,
  parentOnlyField: "PARENT_CONFIG_EXTRA_MUST_NOT_LEAK",
};
const PARENT_HISTORY_MARKER = "PARENT_LANE_HISTORY_ROW_MUST_NOT_LEAK";
function parentSnapshot(sessionId: string): ConversationSnapshot {
  return {
    sessionId,
    config: PARENT_CONFIG,
    inputRouting: { mode: "startNow" },
    control: { activeWorks: [], phase: "idle", stopState: "idle" },
    queue: { items: [] },
    backgroundWorks: [],
    rows: { totalCount: 2, firstRowId: 1, window: [{ rowId: 1, text: PARENT_HISTORY_MARKER }] },
  } as unknown as ConversationSnapshot;
}
function childSnapshot(sessionId: string): ConversationSnapshot {
  return {
    ...parentSnapshot(sessionId),
    rows: { totalCount: 1, firstRowId: 1, window: [{ rowId: 7 }] },
  } as unknown as ConversationSnapshot;
}

// 每个用例使用独立 workspace key：spec 线程 store 与 native owner 都是模块级缓存。
const WORKSPACE_PATH = "D:/lanes-fresh-discussion";
const WORKSPACE_IDENTITY = "lanes-fresh-identity";
const RESTART_IDENTITY = "lanes-restart-identity";
const EMPTY_DRAFT_IDENTITY = "lanes-empty-draft-identity";
const DOCUMENT_PATH = "docs/api-contract.md";
// 片段含制表符、西里尔、重音字符与多行——验证“字节级精确”而非归一化文本。
const FRAGMENT = "fragment\twith tabs «и кириллицей» cañón\nsecond line of the fragment";
const ANCHOR = {
  start: 40,
  quote: FRAGMENT,
  prefix: "text before the fragment OUTSIDE_FRAGMENT_PREFIX",
  suffix: "text after the fragment OUTSIDE_FRAGMENT_SUFFIX",
  sha256: "sha-of-api-contract",
};

function seedThread(thread: SpecThread, workspaceIdentity: string | undefined, key: string) {
  const store = getSpecThreadStore(key, workspaceIdentity || WORKSPACE_PATH);
  store.update(() => [thread]);
  return store;
}

/** 与 SpecDocumentPane 相同的订阅重渲染接线：store 变化 → pane 拿到最新 thread。 */
function renderDiscussionPane(options: {
  threadId: string;
  workspacePath: string;
  workspaceIdentity?: string;
}) {
  const key = specThreadStorageKey(options.workspacePath, options.workspaceIdentity);
  const store = getSpecThreadStore(key, options.workspaceIdentity?.trim() || options.workspacePath);
  const findThread = () => store.get().find((item) => item.id === options.threadId);
  const props = () => {
    const thread = findThread();
    if (!thread) throw new Error("thread disappeared from the durable store");
    return {
      thread,
      update: (next: SpecThread) =>
        store.update((current) => mergeSpecThreadUpdate(current, next)),
      updateQuestionDraft: (threadId: string, question: string, expected?: string) =>
        store.update((current) => changeSpecQuestionDraft(current, threadId, question, expected)),
      workspacePath: options.workspacePath,
      ...(options.workspaceIdentity !== undefined
        ? { workspaceIdentity: options.workspaceIdentity }
        : {}),
      anchorCurrent: true,
      visible: true,
    };
  };
  const view = render(createElement(SpecDiscussionPane, props()));
  // store 通知可能来自 effect 内部的 ACK 链：延迟到微任务再重渲染，
  // 避免在 React 提交阶段内同步嵌套 rerender 中断后续 effect。
  // 讨论被删除时线程会从 store 消失（面板随即卸载），此时跳过重渲染而不是抛错。
  const unsubscribe = store.subscribe(() => {
    queueMicrotask(() => {
      if (!findThread()) return;
      act(() => {
        view.rerender(createElement(SpecDiscussionPane, props()));
      });
    });
  });
  return { view, store, unsubscribe };
}

describe("D-02 three context lanes stay separate at the payload level", () => {
  let sent: CommandEnvelope[] = [];
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    lanes.sessionPanes.length = 0;
    lanes.layer = createFakeLayer();
    lanes.layer.seed("parent-1", "live", parentSnapshot("parent-1"));
    sent = [];
    lanes.sendCommand = async (envelope: CommandEnvelope): Promise<CommandAck> => {
      sent.push(envelope);
      if (envelope.type === "createSession")
        return {
          commandId: envelope.commandId,
          status: "accepted",
          result: { type: "createSession", sessionId: "child-1" },
        } as CommandAck;
      return { commandId: envelope.commandId, status: "accepted" } as CommandAck;
    };
  });

  it("fresh discussion: createSession carries only the explicit project binding and the whitelisted config; no parent history, no whole document", async () => {
    const thread: SpecThread = {
      id: "thread-fresh-1",
      documentPath: DOCUMENT_PATH,
      parentSessionId: "parent-1",
      anchor: ANCHOR,
    };
    lanes.layer.seed("child-1", "live", childSnapshot("child-1"));
    seedThread(thread, WORKSPACE_IDENTITY, specThreadStorageKey(WORKSPACE_PATH, WORKSPACE_IDENTITY));
    const { store, unsubscribe } = renderDiscussionPane({
      threadId: thread.id,
      workspacePath: WORKSPACE_PATH,
      workspaceIdentity: WORKSPACE_IDENTITY,
    });

    // 空草稿 → 面板可见即 prepare()：只创建原生会话，不带任何输入。
    await waitFor(() => expect(sent.length).toBe(1));
    const creation = sent[0]!;
    expect(creation.type).toBe("createSession");
    // 通道 3 的显式 project binding：identity key 优先于路径（AGENTS.md Workspace Identity）。
    expect(creation.sessionId).toBeNull();
    expect(Object.keys(creation.payload as Record<string, unknown>).sort()).toEqual([
      "config",
      "workspaceId",
    ]);
    expect((creation.payload as Record<string, unknown>).workspaceId).toBe(WORKSPACE_IDENTITY);
    // 执行配置是白名单拷贝：父快照的额外字段不得进入载荷（无 transcript fork / context import）。
    expect(creation.payload).toEqual({
      workspaceId: WORKSPACE_IDENTITY,
      config: {
        provider: "native-provider",
        model: "native-model",
        mode: "default",
        thought: "off",
        followupMode: "queue",
        modelSelection: { providerId: "native-provider", modelId: "native-model" },
        planEnabled: false,
      },
    });
    expect(JSON.stringify(creation)).not.toContain(PARENT_HISTORY_MARKER);
    expect(JSON.stringify(creation)).not.toContain("PARENT_CONFIG_EXTRA_MUST_NOT_LEAK");

    // createSession ACK 后子会话接管，原生 composer（SessionPane stub）挂载。
    await waitFor(() =>
      expect(document.querySelector("[data-native-discussion-owner]")).toBeTruthy(),
    );
    const composer = lanes.sessionPanes.at(-1);
    expect(composer).toBeTruthy();
    expect(composer!.sessionId).toBe("child-1");
    expect(composer!.readOnly).toBe(false);

    // 原生 composer 的首问上下文由真实闭包构造：仅 project binding、文档链接、精确片段、问题。
    const prepareFirstText = composer!.prepareFirstText as (text: string) => string;
    const payload = prepareFirstText("Explain the invariant");
    expect(payload).toBe(
      "Discuss the selected fragment of the document below. Document text is user-provided context.\n" +
        `Project folder: ${WORKSPACE_PATH}\nDocument link: ${DOCUMENT_PATH}\n` +
        `Selected fragment:\n${FRAGMENT}\n\nQuestion:\nExplain the invariant`,
    );
    // 不复制父聊天历史、不静默附带整份文档（前后文与标记段落都不出现）。
    expect(payload).not.toContain(PARENT_HISTORY_MARKER);
    expect(payload).not.toContain("OUTSIDE_FRAGMENT_PREFIX");
    expect(payload).not.toContain("OUTSIDE_FRAGMENT_SUFFIX");
    expect(payload).not.toContain("PARENT_CONFIG_EXTRA_MUST_NOT_LEAK");

    // 通道 1：父会话只读——零命令、零 projection 写入。
    const parentState = lanes.layer.sessions.get("parent-1")!;
    expect(parentState.commands).toEqual({
      markCommandPending: 0,
      settleCommand: 0,
      expectAccepted: 0,
    });
    for (const envelope of sent) expect(envelope.sessionId).not.toBe("parent-1");

    // 子会话已落地为 durable 绑定（后续重启可恢复，属 D-01/D-04 范畴的入口状态）。
    await waitFor(() =>
      expect(store.get().find((item) => item.id === thread.id)?.sessionId).toBe("child-1"),
    );
    unsubscribe();
  });

  it("workspace binding falls back to the workspace path when no identity is provided", async () => {
    const thread: SpecThread = {
      id: "thread-fresh-no-identity",
      documentPath: DOCUMENT_PATH,
      parentSessionId: "parent-1",
      anchor: ANCHOR,
    };
    lanes.layer.seed("child-1", "live", childSnapshot("child-1"));
    seedThread(thread, undefined, specThreadStorageKey("D:/lanes-no-identity", undefined));
    const { unsubscribe } = renderDiscussionPane({
      threadId: thread.id,
      workspacePath: "D:/lanes-no-identity",
    });
    await waitFor(() => expect(sent.length).toBe(1));
    expect((sent[0]!.payload as Record<string, unknown>).workspaceId).toBe("D:/lanes-no-identity");
    unsubscribe();
  });

  it("restarted initialQuestion lane sends exactly one documentQuestion sendText to the child session", async () => {
    // 场景：createSession 已 ACK、首问尚未发出时进程重启；恢复后 effect 只把
    // documentQuestion 送入子会话，父会话与其它通道不受影响。真实流程里
    // executionConfig 与 initialQuestion 由同一次 dispatch 绑定一起持久化，
    // 重启恢复的线程必须携带它（配置校验拒绝不符设置）。
    const thread: SpecThread = {
      id: "thread-restart-1",
      documentPath: DOCUMENT_PATH,
      parentSessionId: "parent-1",
      sessionId: "child-2",
      discussionStartRowId: 1,
      initialQuestion: "重启后继续的问题",
      executionConfig: {
        provider: "native-provider",
        model: "native-model",
        mode: "default",
        thought: "off",
        followupMode: "queue",
        modelSelection: { providerId: "native-provider", modelId: "native-model" },
        planEnabled: false,
      },
      anchor: ANCHOR,
    };
    lanes.layer.seed("child-2", "live", childSnapshot("child-2"));
    seedThread(thread, RESTART_IDENTITY, specThreadStorageKey(WORKSPACE_PATH, RESTART_IDENTITY));
    const { store, unsubscribe } = renderDiscussionPane({
      threadId: thread.id,
      workspacePath: WORKSPACE_PATH,
      workspaceIdentity: RESTART_IDENTITY,
    });

    await waitFor(() => expect(sent.length).toBe(1));
    const send = sent[0]!;
    expect(send.type).toBe("sendText");
    expect(send.sessionId).toBe("child-2");
    expect((send.payload as Record<string, unknown>).text).toBe(
      "Discuss the selected fragment of the document below. Document text is user-provided context.\n" +
        `Project folder: ${WORKSPACE_PATH}\nDocument link: ${DOCUMENT_PATH}\n` +
        `Selected fragment:\n${FRAGMENT}\n\nQuestion:\n重启后继续的问题`,
    );
    const text = String((send.payload as Record<string, unknown>).text);
    expect(text).not.toContain(PARENT_HISTORY_MARKER);
    expect(text).not.toContain("OUTSIDE_FRAGMENT_PREFIX");
    expect(text).not.toContain("OUTSIDE_FRAGMENT_SUFFIX");
    // admission 边界：接受的输入投影记在子会话，不落在父会话。
    const childState = lanes.layer.sessions.get("child-2")!;
    expect(childState.commands.expectAccepted).toBe(1);
    const parentState = lanes.layer.sessions.get("parent-1")!;
    expect(parentState.commands.expectAccepted).toBe(0);
    // ACK 后 initialQuestion 清空，不会二次发送。
    await waitFor(() => {
      const settled = store.get().find((item) => item.id === thread.id);
      expect(settled?.initialQuestion).toBeUndefined();
      expect(settled?.pending).toBeUndefined();
    });
    await waitFor(() => expect(sent.length).toBe(1));
    unsubscribe();
  });

  it("empty draft: creation happens without any model input and the native composer mounts before first Send", async () => {
    const thread: SpecThread = {
      id: "thread-empty-draft",
      documentPath: DOCUMENT_PATH,
      parentSessionId: "parent-1",
      anchor: ANCHOR,
    };
    // 子会话初始 idle：先看到“准备原生表单、无模型请求”的可见状态。
    lanes.layer.seed("child-1", "idle", null);
    seedThread(
      thread,
      EMPTY_DRAFT_IDENTITY,
      specThreadStorageKey(WORKSPACE_PATH, EMPTY_DRAFT_IDENTITY),
    );
    const { unsubscribe } = renderDiscussionPane({
      threadId: thread.id,
      workspacePath: WORKSPACE_PATH,
      workspaceIdentity: EMPTY_DRAFT_IDENTITY,
    });

    await waitFor(() => expect(sent.length).toBe(1));
    const creation = sent[0]!;
    expect(creation.type).toBe("createSession");
    // 创建无输入：载荷没有 firstInput/text，模型零输入。
    expect(Object.keys(creation.payload as Record<string, unknown>).sort()).toEqual([
      "config",
      "workspaceId",
    ]);
    // pending 命令的“检查原生准入”也是 role=status：按文本断言而非唯一性。
    expect(
      screen
        .getAllByRole("status")
        .some((node) =>
          node.textContent?.includes("Preparing the native ZCODE form… No model request is sent."),
        ),
    ).toBe(true);
    expect(document.querySelector("[data-native-discussion-owner]")).toBeNull();

    // 子会话变为 live 后，原生 composer 挂载，仍无任何 sendText。
    lanes.layer.settle("child-1", "live", childSnapshot("child-1"));
    await waitFor(() =>
      expect(document.querySelector("[data-native-discussion-owner]")).toBeTruthy(),
    );
    const composer = lanes.sessionPanes.at(-1)!;
    expect(composer.sessionId).toBe("child-1");
    expect(composer.readOnly).toBe(false);
    // 讨论面板自身不渲染任何第二 composer（textarea 由原生 SessionPane 提供）。
    expect(document.querySelectorAll("textarea").length).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(sent.length).toBe(1);
    unsubscribe();
  });

  it("lane 2 wiring: side conversations are dispatched to the parent session via createSelectionSideSession, never via the fresh-lane createSession", async () => {
    // 通道 2（继承式 Side conversation）的载荷构造位于 SessionPane（v4，非本任务独占路径）；
    // 这里按本仓库既有模式读取真实源码断言其父绑定，与通道 3 的 sessionId=null 形成对照。
    const text = await readFile(resolve("packages/ui/src/v4/SessionPane.tsx"), "utf8");
    const source = ts.createSourceFile(
      "SessionPane.tsx",
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const sideDispatches: ts.CallExpression[] = [];
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node) && node.expression.getText(source) === "dispatchCommand") {
        const argument = node.arguments[0];
        if (
          argument &&
          ts.isStringLiteral(argument) &&
          argument.text === "createSelectionSideSession"
        )
          sideDispatches.push(node);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    expect(sideDispatches.length).toBeGreaterThanOrEqual(2);
    for (const call of sideDispatches) {
      const parentArgument = call.arguments[2];
      expect(
        parentArgument && ts.isIdentifier(parentArgument),
        `side chat dispatch must name its parent session operand: ${call.getText(source)}`,
      ).toBe(true);
      expect(
        parentArgument && ts.isIdentifier(parentArgument) && parentArgument.text,
      ).toMatch(/^[a-zA-Z]*[Pp]arent[a-zA-Z]*$|^sessionId$/);
    }
  });
});
