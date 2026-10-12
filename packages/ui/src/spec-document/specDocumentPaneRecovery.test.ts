// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { ServiceProvider } from "../hooks/useServices.js";
import { SpecDocumentPane } from "./SpecDocumentPane.js";
import {
  defaultDocumentPresentation,
  documentPaneWritesRetired,
  documentPresentationKey,
  newDocumentPaneWriteToken,
  readDocumentDraft,
  readDocumentPresentation,
  recoverMissingDocumentPresentation,
  retireDocumentPaneWrites,
  writeDocumentDraft,
  writeDocumentPresentation,
} from "./specDocumentPresentationState.js";
import { specDiscussionRemoveRefusal } from "./useSpecDiscussion.js";

const conversationMocks = vi.hoisted(() => {
  // layer 必须是稳定引用：useSpecWriteGuard 的 effect 依赖 [layer, ids] 且同步
  // setGuard；若每次渲染返回新对象，会形成渲染期无限循环（CPU 100% 挂死）。
  const layer = {
    acquire: (id: string) => ({
      sessionId: id,
      store: {
        subscribe: () => () => {},
        getState: () => ({ status: "idle", snapshot: undefined, optimisticCommands: [] }),
      },
      release: () => {},
    }),
  };
  return { layer };
});
vi.mock("../PreviewPane.js", () => ({ PreviewPane: () => null }));
vi.mock("../v4/V4ConversationContext.js", () => ({
  V4PaneConversationProvider: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  // 只提供 useSpecWriteGuard 需要的只读 lease 面；本测试不驱动原生命令。
  useV4Conversation: () => ({
    layer: conversationMocks.layer,
    sendCommand: async () => {
      throw new Error("no native uplink in this test");
    },
  }),
}));

function specDocumentsService(options: { missing?: string[] } = {}) {
  return {
    getWorkspace: async () => ({ root: "D:\\ws", writable: false }),
    list: async () => ["docs/there.md"],
    read: async ({ path }: { path: string }) => {
      if (options.missing?.includes(path))
        throw Object.assign(
          new Error(`ENOENT: no such file or directory, open 'D:\\ws\\${path}'`),
          { code: "ENOENT" },
        );
      return { path, content: `content of ${path}`, sha256: `sha-${path}` };
    },
    save: async () => {
      throw new Error("read-only in this test");
    },
  };
}
const fileWatcherStub = {
  watch: async () => ({ id: "watch-1" }),
  unwatch: async () => {},
  onDynamicChange: () => () => {},
};
function renderDocumentPane(identity: string) {
  return render(
    createElement(ServiceProvider, {
      services: {
        specDocumentService: specDocumentsService({ missing: ["docs/gone.md"] }),
        fileWatcherService: fileWatcherStub,
      } as unknown as Parameters<typeof ServiceProvider>[0]["services"],
      children: createElement(SpecDocumentPane, {
        workspacePath: "D:\\ws",
        workspaceIdentity: identity,
        parentSessionId: null,
        onClose: () => {},
      }),
    }),
  );
}

function makeSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    control: { activeWorks: [], phase: "idle", stopState: "idle" },
    queue: { items: [] },
    backgroundWorks: [],
    ...overrides,
  } as unknown as ConversationSnapshot;
}

describe("document pane recovery, handoff writes and delete refusal", () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    // jsdom 没有 ResizeObserver；文档面板的停靠布局测量在测试里退化为空观察器。
    globalThis.ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  });

  it("迟到的清理写入不能覆盖子面板已持久化的草稿", () => {
    const key = documentPresentationKey("D:\\ws", "handoff-identity");
    const source = newDocumentPaneWriteToken();
    const child = newDocumentPaneWriteToken();
    expect(
      writeDocumentDraft(
        key,
        "docs/spec.md",
        { content: "source edits", baseSha256: "h1" },
        localStorage,
        source,
      ),
    ).toBe(true);
    // 子窗口接管面板并持久化自己的草稿。
    expect(
      writeDocumentDraft(
        key,
        "docs/spec.md",
        { content: "child edits", baseSha256: "h2" },
        localStorage,
        child,
      ),
    ).toBe(true);
    // 源面板卸载清理退役令牌；随后的迟到写入（包括删除型）必须被拒绝。
    retireDocumentPaneWrites(key, source, localStorage);
    expect(
      writeDocumentDraft(
        key,
        "docs/spec.md",
        { content: "stale source edits", baseSha256: "h1" },
        localStorage,
        source,
      ),
    ).toBe(true);
    expect(readDocumentDraft(key, "docs/spec.md", localStorage)).toEqual({
      content: "child edits",
      baseSha256: "h2",
    });
    expect(writeDocumentDraft(key, "docs/spec.md", null, localStorage, source)).toBe(true);
    expect(readDocumentDraft(key, "docs/spec.md", localStorage)).toEqual({
      content: "child edits",
      baseSha256: "h2",
    });
    // 接管面板未退役，继续可写。
    expect(documentPaneWritesRetired(key, child, localStorage)).toBe(false);
    expect(
      writeDocumentDraft(
        key,
        "docs/spec.md",
        { content: "child edits 2", baseSha256: "h2" },
        localStorage,
        child,
      ),
    ).toBe(true);
    expect(readDocumentDraft(key, "docs/spec.md", localStorage)).toEqual({
      content: "child edits 2",
      baseSha256: "h2",
    });
    // 退役可重复（幂等）且不误伤其他令牌。
    retireDocumentPaneWrites(key, source, localStorage);
    retireDocumentPaneWrites(key, source, localStorage);
    expect(documentPaneWritesRetired(key, source, localStorage)).toBe(true);
  });

  it("缺失的持久化文档呈现可见恢复态：清除过期 path 并保留草稿", async () => {
    const key = documentPresentationKey("D:\\ws", "recovery-identity");
    writeDocumentPresentation(
      key,
      {
        ...defaultDocumentPresentation(),
        path: "docs/gone.md",
        editing: true,
        scrollTop: 33,
        activeThreadId: "thread-1",
        discussionsVisible: true,
      },
      localStorage,
    );
    writeDocumentDraft(
      key,
      "docs/gone.md",
      { content: "unsaved recovery draft", baseSha256: "sha-old" },
      localStorage,
    );
    renderDocumentPane("recovery-identity");
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("no longer in this workspace"),
    );
    // 可见恢复面：文档选择器仍可用，恢复说明解释草稿去向。
    expect(screen.getByRole("alert").textContent).toContain("draft");
    expect(screen.getByLabelText("Choose project document")).toBeTruthy();
    // 持久化视图清除过期 path；草稿原样保留，文件回来后可恢复。
    const recovered = readDocumentPresentation(key, localStorage);
    expect(recovered.path).toBeNull();
    expect(recovered.activeThreadId).toBeNull();
    expect(recovered.discussionsVisible).toBe(false);
    expect(recovered.editing).toBe(true);
    expect(readDocumentDraft(key, "docs/gone.md", localStorage)).toEqual({
      content: "unsaved recovery draft",
      baseSha256: "sha-old",
    });
    // 再次恢复幂等（无 path 时原样返回），不破坏存储。
    expect(recoverMissingDocumentPresentation(key, localStorage)).toEqual(recovered);
  });

  it("删除拒绝原因与 canRemove 使用同一组输入推导（D-04）", async () => {
    const idle = {
      pending: false,
      dispatching: false,
      sessionId: "child-1",
      projectionStatus: "live",
      snapshot: makeSnapshot(),
      optimisticCommandCount: 0,
    };
    expect(specDiscussionRemoveRefusal(idle)).toBeNull();
    expect(
      specDiscussionRemoveRefusal({
        ...idle,
        pending: true,
      }),
    ).toMatch(/admission is still being checked/);
    expect(
      specDiscussionRemoveRefusal({
        ...idle,
        dispatching: true,
      }),
    ).toMatch(/in-flight native command/);
    expect(
      specDiscussionRemoveRefusal({
        ...idle,
        projectionStatus: "connecting",
        snapshot: null,
      }),
    ).toMatch(/not reachable yet/);
    expect(
      specDiscussionRemoveRefusal({
        ...idle,
        snapshot: makeSnapshot({ control: { activeWorks: [], phase: "running", stopState: "idle" } }),
      }),
    ).toMatch(/stop it before deleting/);
    expect(
      specDiscussionRemoveRefusal({
        ...idle,
        snapshot: makeSnapshot({ queue: { items: [{ commandId: "queued" }] } }),
      }),
    ).toMatch(/stop it before deleting/);
    expect(
      specDiscussionRemoveRefusal({
        ...idle,
        snapshot: makeSnapshot({
          backgroundWorks: [{ status: "running" }],
        }),
      }),
    ).toMatch(/stop it before deleting/);
    expect(
      specDiscussionRemoveRefusal({
        ...idle,
        optimisticCommandCount: 2,
      }),
    ).toMatch(/unacknowledged local commands/);
    // 无原生会话的新线程可直接删除。
    expect(
      specDiscussionRemoveRefusal({
        ...idle,
        sessionId: undefined,
        snapshot: null,
        projectionStatus: "idle",
      }),
    ).toBeNull();

    // 接线检查：面板把拒绝原因渲染为可见状态，而不是只有禁用态。
    const discussionSource = await readFile(
      // jsdom 环境下 import.meta.url 不是 file: 协议，这里按仓库根相对路径读取。
      resolve("packages/ui/src/spec-document/SpecDiscussionPane.tsx"),
      "utf8",
    );
    expect(discussionSource).toContain("native.removeBlockedReason");
    expect(discussionSource).toMatch(/role="status"/);
    // 单一真相：canRemove 由同一函数的结果派生。
    const hookSource = await readFile(
      resolve("packages/ui/src/spec-document/useSpecDiscussion.ts"),
      "utf8",
    );
    expect(hookSource).toContain("const canRemove = removeBlockedReason === null;");
  });

  it("面板的所有草稿写入点都携带写入令牌，卸载时退役（源码接线）", async () => {
    const text = await readFile(
      resolve("packages/ui/src/spec-document/SpecDocumentPane.tsx"),
      "utf8",
    );
    const source = ts.createSourceFile(
      "SpecDocumentPane.tsx",
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const writeCalls: ts.CallExpression[] = [];
    const retireCalls: ts.CallExpression[] = [];
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node)) {
        const name = node.expression.getText(source);
        if (name === "writeDocumentDraft") writeCalls.push(node);
        if (name === "retireDocumentPaneWrites") retireCalls.push(node);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    expect(writeCalls.length).toBeGreaterThanOrEqual(3);
    for (const call of writeCalls) {
      const token = call.arguments[call.arguments.length - 1];
      expect(
        token && ts.isIdentifier(token) && token.getText(source) === "paneWriteToken",
        `writeDocumentDraft 调用必须携带 paneWriteToken，实际：${call.getText(source)}`,
      ).toBe(true);
    }
    expect(retireCalls.length).toBe(1);
    expect(retireCalls[0]!.getText(source)).toContain("retireDocumentPaneWrites(presentationKey");
    // 清理哨兵按 workspace+path 登记，作为最后一个 child 渲染。
    expect(text).toContain("<DocumentCleanupSentinel");
    expect(text).toContain("specDocumentCleanupKey(");
  });
});
