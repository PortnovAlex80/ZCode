// @vitest-environment jsdom
/**
 * U-14（活体反馈 2026-10-14 «корзина в пикере документов не удаляет——тихий no-op»）：
 * 面板级删除链路。覆盖验收：
 * - 删除执行：服务 remove 被调用，列表刷新，当前文档被删时打开态/持久化 path/
 *   per-path 草稿槽一并清除；
 * - 可见确认：成功后状态行显示删除结果；
 * - 拒绝可见：服务失败时 role=alert 呈现错误，文档与列表不变；
 * - disabled 解释原因：只读工作区（未获写许可）时 корзина 禁用并说明原因。
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ServiceProvider } from "../hooks/useServices.js";
import { SpecDocumentPane } from "./SpecDocumentPane.js";
import {
  documentPresentationKey,
  readDocumentDraft,
  readDocumentPresentation,
  writeDocumentDraft,
} from "./specDocumentPresentationState.js";

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
  useV4Conversation: () => ({
    layer: conversationMocks.layer,
    sendCommand: async () => {
      throw new Error("no native uplink in this test");
    },
  }),
}));

/**
 * 可删除的文档服务桩：文件保存在内存 Map 中，remove 真实移除条目（列表/读取
 * 随之反映）。removeError 可注入一次性失败，用于断言拒绝的可见呈现。
 */
function deletableDocumentsService(options: { writable?: boolean; removeError?: string } = {}) {
  const files = new Map<string, string>([
    ["docs/todo.md", "todo content"],
    ["notes/keep.md", "keep content"],
  ]);
  const writable = options.writable !== false;
  const removeCalls: string[] = [];
  return {
    removeCalls,
    service: {
      getWorkspace: async () => ({ root: "D:\\ws", writable }),
      list: async () => Array.from(files.keys()).sort(),
      read: async ({ path }: { path: string }) => {
        const content = files.get(path);
        if (content === undefined)
          throw Object.assign(new Error(`ENOENT: no such file '${path}'`), { code: "ENOENT" });
        return { path, content, sha256: `sha-${path}` };
      },
      save: async () => {
        throw new Error("save unused in this test");
      },
      remove: async ({ path }: { path: string }) => {
        removeCalls.push(path);
        if (options.removeError) throw new Error(options.removeError);
        if (!files.delete(path))
          throw Object.assign(new Error(`ENOENT: no such file '${path}'`), { code: "ENOENT" });
        return { path };
      },
    },
  };
}

const fileWatcherStub = {
  watch: async () => ({ id: "watch-1" }),
  unwatch: async () => {},
  onDynamicChange: () => () => {},
};

function renderDocumentPane(identity: string, service: unknown, initialPath?: string) {
  return render(
    createElement(ServiceProvider, {
      services: {
        specDocumentService: service,
        fileWatcherService: fileWatcherStub,
      } as unknown as Parameters<typeof ServiceProvider>[0]["services"],
      children: createElement(SpecDocumentPane, {
        workspacePath: "D:\\ws",
        workspaceIdentity: identity,
        parentSessionId: null,
        initialPath,
        onClose: () => {},
      }),
    }),
  );
}

async function openPickerDropdown() {
  // 面板挂载时 files 为空，trigger 处于 disabled（ioPending || !files.length）；
  // 先等列表就绪把 trigger 拉回可用，再打开下拉。
  await waitFor(() =>
    expect((screen.getByLabelText("Choose project document") as HTMLButtonElement).disabled).toBe(
      false,
    ),
  );
  fireEvent.click(screen.getByLabelText("Choose project document"));
  return screen.getByLabelText("Filter documents");
}

function pickerRows() {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-picker-path]")).map(
    (row) => row.dataset.pickerPath,
  );
}

function confirmDelete(path: string) {
  fireEvent.click(document.querySelector<HTMLElement>(`[data-picker-delete="${path}"]`)!);
  fireEvent.click(screen.getByLabelText(`Confirm delete ${path}`));
}

describe("U-14 document pane delete (корзина)", () => {
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

  it("deletes the current document: service remove, refreshed list, cleared open state and draft slot, visible confirmation", async () => {
    const identity = "delete-current";
    const key = documentPresentationKey("D:\\ws", identity);
    // 预置该文件的未保存草稿：用户主动删除后草稿槽必须一并清除。
    writeDocumentDraft(key, "docs/todo.md", {
      content: "unsaved edits",
      baseSha256: "sha-docs/todo.md",
    });
    const { service, removeCalls } = deletableDocumentsService();
    renderDocumentPane(identity, service, "docs/todo.md");
    // 草稿恢复后正文为 dirty（页脚显示 Unsaved draft）；行只在下拉开着时存在，
    // 先开下拉再等列表到位。
    await openPickerDropdown();
    await waitFor(() => expect(pickerRows()).toContain("docs/todo.md"));

    confirmDelete("docs/todo.md");

    await waitFor(() => expect(removeCalls).toEqual(["docs/todo.md"]));
    // 可见确认：状态行给出删除结果（含路径）。
    await waitFor(() => expect(screen.getByText("Deleted docs/todo.md from disk")).toBeTruthy());
    // 列表刷新：下拉里该行消失，其余文档保留。
    expect(pickerRows()).toEqual(["notes/keep.md"]);
    // 打开态清空：面板回到未选文档的占位说明。
    expect(screen.getByText("Choose a project document above to preview it.")).toBeTruthy();
    // 持久化视图与草稿槽清除（重开面板不会试图恢复已删除的文档/草稿）。
    expect(readDocumentPresentation(key, localStorage).path).toBeNull();
    expect(readDocumentDraft(key, "docs/todo.md", localStorage)).toBeNull();
  });

  it("delete failure is visible: alert shows the error, document and list unchanged", async () => {
    const identity = "delete-failure";
    const { service, removeCalls } = deletableDocumentsService({
      removeError: "Documents is read-only until a shared writer lease is implemented.",
    });
    renderDocumentPane(identity, service, "docs/todo.md");
    await openPickerDropdown();
    await waitFor(() => expect(pickerRows()).toContain("docs/todo.md"));
    confirmDelete("docs/todo.md");

    // 拒绝可见：role=alert 呈现服务错误，状态行说明未删除任何东西。
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("read-only"));
    expect(screen.getByText("Delete failed · nothing was removed")).toBeTruthy();
    expect(removeCalls).toEqual(["docs/todo.md"]);
    // 文档仍打开、列表不变（没有静默丢失）。
    expect(pickerRows()).toEqual(["docs/todo.md", "notes/keep.md"]);
    expect(screen.queryByText("Choose a project document above to preview it.")).toBeNull();
  });

  it("read-only workspace: trash is disabled with an explained reason and remove is never called", async () => {
    const identity = "delete-readonly";
    const { service, removeCalls } = deletableDocumentsService({ writable: false });
    renderDocumentPane(identity, service, "docs/todo.md");
    await openPickerDropdown();
    await waitFor(() => expect(pickerRows()).toContain("docs/todo.md"));
    const trash = document.querySelector<HTMLElement>(
      '[data-picker-delete="docs/todo.md"]',
    ) as HTMLButtonElement;
    expect(trash.disabled).toBe(true);
    // disabled 解释原因（挂在包裹 span 的 title 上）。
    expect(trash.parentElement?.getAttribute("title")).toBe(
      "Deleting is not available in this experimental build yet.",
    );
    fireEvent.click(trash);
    expect(document.querySelector("[data-picker-delete-confirm]")).toBeNull();
    expect(removeCalls).toEqual([]);
  });
});
