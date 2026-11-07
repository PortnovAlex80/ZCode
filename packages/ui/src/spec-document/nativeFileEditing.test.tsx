// @vitest-environment jsdom
// 2026-11-07 用户裁决覆盖：原生文件预览叠加 fork 编辑（U-18 引擎）。
// 覆盖：可编辑判定（扩展名）、Edit 进入即读盘并显示缓冲、键入防抖自动落盘
//   （CAS 载荷）、外部改写后自动保存可见失败且不自动重试、markdown 视图请求。
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { ServiceProvider } from "../hooks/useServices.js";
import { useNativeFileEditing } from "./nativeFileEditing.js";

const WORKSPACE_PATH = "D:\\ws";

function createDocumentsService() {
  const disk = new Map<string, { content: string; sha256: string }>([
    ["docs/note.md", { content: "# base\n", sha256: "sha-native-base" }],
  ]);
  const saveCalls: { path: string; content: string; expectedSha256: string }[] = [];
  let revision = 0;
  return {
    disk,
    saveCalls,
    mutateDisk(path: string, content: string) {
      revision += 1;
      disk.set(path, { content, sha256: `sha-native-external-${revision}` });
    },
    service: {
      getWorkspace: async () => ({ root: WORKSPACE_PATH, writable: true }),
      read: async ({ path }: { path: string }) => {
        const entry = disk.get(path);
        if (!entry) throw new Error(`ENOENT: ${path}`);
        return { path, content: entry.content, sha256: entry.sha256 };
      },
      save: async (params: { path: string; content: string; expectedSha256: string }) => {
        saveCalls.push({ ...params });
        const current = disk.get(params.path);
        if (!current || current.sha256 !== params.expectedSha256)
          throw new Error("Document changed on disk. Reload before saving.");
        const next = { content: params.content, sha256: `sha-native-saved-${++revision}` };
        disk.set(params.path, next);
        return { path: params.path, ...next };
      },
    },
  };
}

function renderHost(options: { path: string | null; enabled?: boolean; delay?: number }) {
  const documents = createDocumentsService();
  const Harness = () => {
    const editing = useNativeFileEditing({
      workspacePath: WORKSPACE_PATH,
      path: options.path,
      enabled: options.enabled ?? true,
      autosaveDelayMs: options.delay ?? 25,
    });
    return createElement(
      "div",
      null,
      editing.documentActions,
      editing.sourceEditor,
      createElement("span", { "data-markdown-request": editing.requestMarkdownViewMode ?? "" }),
    );
  };
  const view = render(
    createElement(
      ServiceProvider,
      {
        services: { specDocumentService: documents.service } as unknown as Parameters<
          typeof ServiceProvider
        >[0]["services"],
      },
      createElement(Harness),
    ),
  );
  return { view, documents };
}

describe("native file preview editing overlay (2026-11-07 ruling)", () => {
  beforeEach(() => {
    cleanup();
  });

  it("offers no editing affordance for non-text documents (code files stay native)", () => {
    const { view } = renderHost({ path: "config/.oxfmtrc.json" });
    expect(screen.queryByLabelText("Edit")).toBeNull();
    expect(view.container.textContent).toBe("");
  });

  it("Edit reads the disk snapshot, autosaves typed edits with the CAS hash and clears the draft", async () => {
    const { documents } = renderHost({ path: "docs/note.md" });
    fireEvent.click(screen.getByLabelText("Edit"));

    const editor = (await screen.findByLabelText("Document source editor")) as HTMLTextAreaElement;
    await waitFor(() => expect(editor.value).toBe("# base\n"));
    expect(screen.getByText("Editing · autosaves to disk")).toBeTruthy();

    fireEvent.change(editor, { target: { value: "# base\nlocal edit" } });
    expect(screen.getByText("Unsaved draft")).toBeTruthy();

    await waitFor(() => expect(documents.saveCalls.length).toBe(1));
    expect(documents.saveCalls[0]).toMatchObject({
      path: "docs/note.md",
      content: "# base\nlocal edit",
      expectedSha256: "sha-native-base",
    });
    await waitFor(() => expect(documents.disk.get("docs/note.md")!.content).toBe("# base\nlocal edit"));
    await waitFor(() => expect(screen.getByText("Saved on disk")).toBeTruthy());
  });

  it("autosave halts with a visible failure after an external change instead of retrying", async () => {
    const { documents } = renderHost({ path: "docs/note.md" });
    fireEvent.click(screen.getByLabelText("Edit"));
    const editor = (await screen.findByLabelText("Document source editor")) as HTMLTextAreaElement;

    documents.mutateDisk("docs/note.md", "# rewritten externally\n");
    fireEvent.change(editor, { target: { value: "# base\nconflicting local" } });

    await waitFor(() => expect(documents.saveCalls.length).toBe(1));
    expect(screen.getByText("Save failed · draft retained")).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(documents.saveCalls.length).toBe(1);
  });

  it("requests the Source view only while an edit session is active", async () => {
    const { view } = renderHost({ path: "docs/note.md" });
    const request = () =>
      view.container.querySelector("[data-markdown-request]")!.getAttribute("data-markdown-request");
    expect(request()).toBe("");
    fireEvent.click(screen.getByLabelText("Edit"));
    await screen.findByLabelText("Document source editor");
    expect(request()).toBe("code");
    fireEvent.click(screen.getByLabelText("View"));
    expect(request()).toBe("");
  });
});
