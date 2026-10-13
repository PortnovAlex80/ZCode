import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { createSpecDocumentService } from "./specDocumentService.js";
import { createFileWatcherService } from "../fileWatcher/fileWatcherService.js";

test("one Host reads and lists two selected projects independently without a launch-time grant", async () => {
  const first = await mkdtemp(join(tmpdir(), "spec-document-project-a-"));
  const second = await mkdtemp(join(tmpdir(), "spec-document-project-b-"));
  try {
    await writeFile(join(first, "same.md"), "project A");
    await writeFile(join(second, "same.md"), "project B");
    await writeFile(join(second, "only-b.md"), "B only");
    const service = createSpecDocumentService({ desktopLocal: true, allowUnleasedWrites: true });
    const [a, b, filesA, filesB] = await Promise.all([
      service.read({ workspacePath: first, path: "same.md" }),
      service.read({ workspacePath: second, path: "same.md" }),
      service.list({ workspacePath: first }),
      service.list({ workspacePath: second }),
    ]);
    assert.equal(a.content, "project A");
    assert.equal(b.content, "project B");
    assert.deepEqual(filesA, ["same.md"]);
    assert.deepEqual(filesB, ["only-b.md", "same.md"]);
    await service.save({
      workspacePath: second,
      path: b.path,
      content: "updated B",
      expectedSha256: b.sha256,
    });
    assert.equal((await service.read({ workspacePath: first, path: a.path })).content, "project A");
    await assert.rejects(service.read({ workspacePath: first, path: "../outside.md" }), /outside/);
    await assert.rejects(service.getWorkspace({ workspacePath: "relative-project" }), /Absolute/);
    await assert.rejects(
      service.getWorkspace({ workspacePath: join(first, "same.md") }),
      /directory/,
    );
  } finally {
    await rm(first, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
  }
});

test("granted local root, UTF-8 save and stale CAS", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spec-document-test-"));
  try {
    await writeFile(join(directory, "document.md"), "# Пример\r\n");
    const service = createSpecDocumentService({ desktopLocal: true, allowUnleasedWrites: true });
    assert.deepEqual(await service.list({ workspacePath: directory }), ["document.md"]);
    const original = await service.read({ workspacePath: directory, path: "document.md" });
    const readonly = createSpecDocumentService({ desktopLocal: true });
    assert.equal((await readonly.getWorkspace({ workspacePath: directory })).writable, false);
    await assert.rejects(
      readonly.save({
        workspacePath: directory,
        path: original.path,
        content: "blocked",
        expectedSha256: original.sha256,
      }),
      /read-only/,
    );
    assert.equal(await readFile(join(directory, "document.md"), "utf8"), original.content);
    const saved = await service.save({
      workspacePath: directory,
      path: original.path,
      content: "Новый текст\n",
      expectedSha256: original.sha256,
    });
    assert.equal(await readFile(join(directory, "document.md"), "utf8"), saved.content);
    await assert.rejects(
      service.save({
        workspacePath: directory,
        path: original.path,
        content: "stale",
        expectedSha256: original.sha256,
      }),
      /changed on disk/,
    );
    const competing = await Promise.allSettled([
      service.save({
        workspacePath: directory,
        path: saved.path,
        content: "writer A",
        expectedSha256: saved.sha256,
      }),
      service.save({
        workspacePath: directory,
        path: saved.path,
        content: "writer B",
        expectedSha256: saved.sha256,
      }),
    ]);
    assert.equal(competing.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(competing.filter((result) => result.status === "rejected").length, 1);
    await assert.rejects(
      service.read({ workspacePath: directory, path: "../outside.md" }),
      /outside/,
    );
    await assert.rejects(
      service.read({ workspacePath: directory, path: join(directory, "document.md") }),
      /Relative/,
    );
    await writeFile(join(directory, "bad.txt"), Buffer.from([0xff, 0xfe]));
    await assert.rejects(service.read({ workspacePath: directory, path: "bad.txt" }), /UTF-8/);
    await assert.rejects(
      service.save({
        workspacePath: directory,
        path: "document.md",
        content: "x\0",
        expectedSha256: saved.sha256,
      }),
      /UTF-8/,
    );
    await assert.rejects(
      createSpecDocumentService({ desktopLocal: false }).list({ workspacePath: directory }),
      /disabled/,
    );
    await assert.rejects(
      createSpecDocumentService({ desktopLocal: true }).list({ workspacePath: "" }),
      /Absolute/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("native parent-directory watcher sees atomic document replacement and releases its subscription", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spec-document-watch-test-"));
  const watcher = createFileWatcherService();
  let subscription: { dispose(): void } | undefined;
  try {
    const path = join(directory, "doc.md");
    await writeFile(path, "before");
    const { id } = await watcher.watch({ path: directory });
    let events = 0;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const changed = new Promise<void>((resolve, reject) => {
      timeout = setTimeout(
        () => reject(new Error("Native atomic rename watch event timed out")),
        3000,
      );
      subscription = watcher.onDynamicChange(id)(() => {
        events++;
        clearTimeout(timeout);
        resolve();
      });
    });
    await writeFile(join(directory, "replacement.tmp"), "after");
    await rename(join(directory, "replacement.tmp"), path);
    await changed;
    const service = createSpecDocumentService({ desktopLocal: true });
    assert.equal(
      (await service.read({ workspacePath: directory, path: "doc.md" })).content,
      "after",
    );
    subscription?.dispose();
    await watcher.unwatch({ id });
    await writeFile(path, "closed");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(events, 1);
  } finally {
    subscription?.dispose();
    watcher.disposeAll();
    await rm(directory, { recursive: true, force: true });
  }
});

test("document symlink cannot escape the grant", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "spec-document-link-test-"));
  try {
    await writeFile(join(directory, "original.md"), "original");
    try {
      await symlink(join(directory, "original.md"), join(directory, "linked.md"), "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        context.skip("Windows symlinks require OS privilege");
        return;
      }
      throw error;
    }
    const service = createSpecDocumentService({ desktopLocal: true });
    await assert.rejects(service.read({ workspacePath: directory, path: "linked.md" }), /Linked/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// D-02/D-03 服务侧佐证：讨论载荷引用的文档 identity/path 与片段字节来源。
// 快照必须逐字节保留磁盘内容（CRLF、制表符、NBSP、西里尔、emoji），sha256 对原始
// 字节计算（锚点 sha256 的比对基准）；相对路径 identity 归一为正斜杠（Document link）。
// “不静默附带整份文档”是 UI 载荷约束（specDiscussionLanes.test.ts 断言
// documentQuestion 只含片段），本服务按定义返回完整快照供编辑器使用。
test("discussion snapshot source preserves exact bytes and normalizes the document identity path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spec-document-exact-bytes-"));
  try {
    await mkdir(join(directory, "docs", "nested"), { recursive: true });
    const raw = Buffer.from(
      "# Заголовок\r\n\tfragment\t«кириллица» cañón 🎯\u00A0end\r\n",
      "utf8",
    );
    await writeFile(join(directory, "docs", "nested", "exact.md"), raw);
    const service = createSpecDocumentService({ desktopLocal: true });
    const snapshot = await service.read({
      workspacePath: directory,
      // 反斜杠相对输入（launcher/绝对路径裁剪后的形态）必须归一为正斜杠 identity。
      path: join("docs", "nested", "exact.md"),
    });
    assert.equal(snapshot.path, "docs/nested/exact.md");
    assert.equal(Buffer.from(snapshot.content, "utf8").equals(raw), true);
    assert.equal(snapshot.sha256, createHash("sha256").update(raw).digest("hex"));
    // 片段字节从快照原样切片：锚点 quote 的字节来源不做任何归一化。
    assert.equal(snapshot.content.includes("\tfragment\t"), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
