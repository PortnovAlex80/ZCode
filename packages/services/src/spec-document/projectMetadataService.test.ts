import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import {
  ProjectMetadataCorruptError,
  type ProjectMetadataBlocks,
  type ProjectMetadataEntries,
  type ProjectMetadataInput,
} from "./projectMetadata.js";
import { projectMetadataBlocks } from "./projectMetadataBlocks.js";
import { createProjectMetadataService } from "./projectMetadataService.js";

function sampleEntry(overrides: Partial<ProjectMetadataInput> = {}): ProjectMetadataInput {
  return {
    kind: "document",
    purpose: "Расчёт осадки фундамента",
    type: "calculation",
    sources: ["ГОСТ 12345", "изыскания 2024"],
    links: ["docs/геология.md"],
    methods: ["методика послойного суммирования"],
    ...overrides,
  };
}

test("read returns an empty store when .harness/project.json does not exist and creates nothing", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "project-metadata-read-empty-"));
  try {
    const service = createProjectMetadataService({ desktopLocal: true });
    const entries = await service.read({ workspacePath: workspace });
    assert.deepEqual(entries, {});
    // 只读不建目录：workspace 里不能出现 .harness。
    assert.deepEqual(
      await readdir(workspace).then((names) => names.filter((n) => n === ".harness")),
      [],
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("save writes UTF-8 JSON under normalized path keys and read restores the values", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "project-metadata-roundtrip-"));
  try {
    const service = createProjectMetadataService({ desktopLocal: true });
    await service.save({
      workspacePath: workspace,
      // Windows 分隔符 + 冗余段也要归一化成 `docs/расчёт.md`。
      path: ".\\docs\\расчёт.md",
      entry: sampleEntry(),
    });
    const entries = await service.read({ workspacePath: workspace });
    assert.deepEqual(Object.keys(entries), ["docs/расчёт.md"]);
    assert.equal(
      entries["docs/расчёт.md"]?.blocks?.role,
      "Расчёт осадки фундамента\n\nArtifact type:\ncalculation",
    );
    assert.match(entries["docs/расчёт.md"]?.blocks?.data ?? "", /ГОСТ 12345\nизыскания 2024/);
    assert.equal(entries["docs/расчёт.md"]?.purpose, undefined);

    const raw = await readFile(join(workspace, ".harness", "project.json"), "utf8");
    const parsed = JSON.parse(raw) as { version: number; entries: ProjectMetadataEntries };
    assert.equal(parsed.version, 2);
    assert.ok(entries["docs/расчёт.md"]?.id);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("editing an existing passport keeps the stable entry id; each key gets one id", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "project-metadata-stable-id-"));
  try {
    const service = createProjectMetadataService({ desktopLocal: true });
    const first = await service.save({
      workspacePath: workspace,
      path: "notes/записка.md",
      entry: sampleEntry({ kind: "folder", type: "note" }),
    });
    const second = await service.save({
      workspacePath: workspace,
      path: "notes/записка.md",
      entry: sampleEntry({ kind: "folder", type: "note", purpose: "Обновлённое назначение" }),
    });
    assert.equal(second["notes/записка.md"]?.id, first["notes/записка.md"]?.id);
    assert.match(second["notes/записка.md"]?.blocks?.role ?? "", /Обновлённое назначение/);
    // 同一目录换键 => 新 id。
    const other = await service.save({
      workspacePath: workspace,
      path: "notes/другая.md",
      entry: sampleEntry(),
    });
    assert.notEqual(other["notes/другая.md"]?.id, first["notes/записка.md"]?.id);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("save replaces the file atomically: no leftover tmp files and keys stay sorted", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "project-metadata-atomic-"));
  try {
    const service = createProjectMetadataService({ desktopLocal: true });
    await service.save({ workspacePath: workspace, path: "b/second.md", entry: sampleEntry() });
    await service.save({ workspacePath: workspace, path: "a/first.md", entry: sampleEntry() });
    const harness = join(workspace, ".harness");
    // 原子替换的可见契约：目录里只有 project.json，没有 .tmp 残留。
    assert.deepEqual(await readdir(harness), ["project.json"]);
    const raw = await readFile(join(harness, "project.json"), "utf8");
    const parsed = JSON.parse(raw) as { entries: Record<string, unknown> };
    // 键排序写入，文件进 VCS 后 diff 不因插入顺序抖动。
    assert.deepEqual(Object.keys(parsed.entries), ["a/first.md", "b/second.md"]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("serialized writes from one service instance do not lose each other's keys", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "project-metadata-queue-"));
  try {
    const service = createProjectMetadataService({ desktopLocal: true });
    await Promise.all([
      service.save({ workspacePath: workspace, path: "one.md", entry: sampleEntry() }),
      service.save({ workspacePath: workspace, path: "two.md", entry: sampleEntry() }),
      service.save({ workspacePath: workspace, path: "three.md", entry: sampleEntry() }),
    ]);
    const entries = await service.read({ workspacePath: workspace });
    assert.deepEqual(Object.keys(entries).sort(), ["one.md", "three.md", "two.md"]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a corrupted project.json fails reads visibly and is never overwritten by save", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "project-metadata-corrupt-"));
  try {
    const harness = join(workspace, ".harness");
    await mkdir(harness);
    const corruptPayloads = [
      "{ not json",
      JSON.stringify({ version: 3, entries: {} }),
      JSON.stringify({ version: 1, entries: { "x.md": { purpose: 1 } } }),
    ];
    const service = createProjectMetadataService({ desktopLocal: true });
    for (const payload of corruptPayloads) {
      const target = join(harness, "project.json");
      await writeFile(target, payload, "utf8");
      await assert.rejects(
        service.read({ workspacePath: workspace }),
        (error: unknown) => error instanceof ProjectMetadataCorruptError,
      );
      // 保存也必须先读校验：损坏文件保持逐字节不变（fail visible, no silent rewrite）。
      await assert.rejects(
        service.save({ workspacePath: workspace, path: "y.md", entry: sampleEntry() }),
        (error: unknown) => error instanceof ProjectMetadataCorruptError,
      );
      assert.equal(await readFile(target, "utf8"), payload);
      // 失败的保存不留 tmp 残留。
      assert.deepEqual(
        (await readdir(harness)).filter((name) => name.includes(".tmp")),
        [],
      );
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("external manual edits are picked up on the next open and preserved by later saves", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "project-metadata-external-"));
  try {
    const service = createProjectMetadataService({ desktopLocal: true });
    await service.save({ workspacePath: workspace, path: "a.md", entry: sampleEntry() });

    // 外部手工加入一条记录和一个未知 top-level 键（为未来 rules/workflows 预留）。
    const target = join(workspace, ".harness", "project.json");
    const manual = JSON.parse(await readFile(target, "utf8")) as {
      entries: ProjectMetadataEntries;
    };
    manual.entries["手工.md"] = {
      id: "pm-manual",
      kind: "document",
      purpose: "Внешний паспорт",
      type: "other",
      sources: [],
      links: [],
      methods: [],
      updatedAt: "2026-10-13T00:00:00.000Z",
    };
    await writeFile(
      target,
      `${JSON.stringify({ ...manual, version: 1, rulesHint: "keep-me" })}\n`,
      "utf8",
    );

    // 下一次打开（read）能看到外部编辑。
    const seen = await service.read({ workspacePath: workspace });
    assert.equal(seen["手工.md"]?.purpose, "Внешний паспорт");

    // 之后的 save 保留外部记录、其 id，以及未知 top-level 键。
    const after = await service.save({
      workspacePath: workspace,
      path: "b.md",
      entry: sampleEntry(),
    });
    assert.equal(after["手工.md"]?.id, "pm-manual");
    const raw = JSON.parse(await readFile(target, "utf8")) as Record<string, unknown>;
    assert.equal(raw.rulesHint, "keep-me");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("remove deletes a key and is a no-op for missing keys without touching the file", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "project-metadata-remove-"));
  try {
    const service = createProjectMetadataService({ desktopLocal: true });
    await service.save({ workspacePath: workspace, path: "gone.md", entry: sampleEntry() });
    const afterRemove = await service.remove({ workspacePath: workspace, path: "gone.md" });
    assert.deepEqual(afterRemove, {});
    assert.deepEqual(await service.read({ workspacePath: workspace }), {});

    // 删除不存在的键：文件保持不变。
    const target = join(workspace, ".harness", "project.json");
    const before = await readFile(target, "utf8");
    await service.remove({ workspacePath: workspace, path: "missing.md" });
    assert.equal(await readFile(target, "utf8"), before);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("paths that escape the workspace or are not relative are rejected", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "project-metadata-paths-"));
  try {
    const service = createProjectMetadataService({ desktopLocal: true });
    for (const path of ["../outside.md", "docs/../../outside.md", "C:\\abs.md", "/abs.md", ""]) {
      await assert.rejects(
        service.save({ workspacePath: workspace, path, entry: sampleEntry() }),
        Error,
      );
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("non-local hosts cannot touch the passport store", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "project-metadata-remote-"));
  try {
    const service = createProjectMetadataService({ desktopLocal: false });
    await assert.rejects(service.read({ workspacePath: workspace }), Error);
    await assert.rejects(
      service.save({ workspacePath: workspace, path: "a.md", entry: sampleEntry() }),
      Error,
    );
    // 远端 workspace 上也不落任何文件。
    assert.deepEqual(await readdir(workspace), []);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

async function withWorkspace(run: (workspace: string) => Promise<void>): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), "artifact-context-"));
  try {
    await run(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

test("version 1 old entries stay additive and root/procedure fields round-trip without reading references", async () => {
  await withWorkspace(async (workspace) => {
    const service = createProjectMetadataService({ desktopLocal: true });
    const legacyRoot = {
      ...sampleEntry({
        kind: "folder",
        instructions: "Use only verified requisites.",
        skills: ["skills/nonexistent.md"],
        checklist: ["Mark missing fields"],
        steps: [
          {
            title: "Read requisites",
            instruction: "Read the source with existing tools.",
            tool: { transport: "mcp", connection: "odn", operation: "project.read" },
            input: "Project ID",
            expected: "Requisites",
            onFailure: "Stop and report missing data",
          },
          {
            title: "Fill title",
            instruction: "Preserve author edits.",
            tool: { transport: "file", operation: "document.edit" },
          },
          {
            title: "Optional service",
            instruction: "Use only if configured.",
            tool: { transport: "rest", connection: "existing-odn", operation: "requisites.read" },
          },
        ],
      }),
      id: "root-legacy",
      updatedAt: "2026-10-15T00:00:00Z",
    };
    await mkdir(join(workspace, ".harness"));
    const target = join(workspace, ".harness/project.json");
    const original = JSON.stringify({
      version: 1,
      entries: {
        ".": legacyRoot,
        "old.txt": { ...sampleEntry(), id: "old-legacy", updatedAt: "2026-10-15T00:00:00Z" },
      },
    });
    await writeFile(target, original);
    const fresh = createProjectMetadataService({ desktopLocal: true });
    const entries = await fresh.read({ workspacePath: workspace });
    assert.equal(entries["old.txt"]?.instructions, undefined);
    assert.equal(entries["."]?.steps?.[0]?.tool?.connection, "odn");
    const context = await fresh.resolve({ workspacePath: workspace, path: "old.txt" });
    assert.deepEqual(
      context.entries.map((item) => item.path),
      [".", "old.txt"],
    );
    assert.match(context.text, /skills\/nonexistent\.md/);
    assert.match(context.text, /not read/);
    assert.match(context.text, /descriptive/);
    assert.equal(await readFile(target, "utf8"), original);
    assert.equal(entries["."]?.blocks, undefined);
    const saved = await service.save({
      workspacePath: workspace,
      path: ".",
      entry: { kind: "folder", blocks: projectMetadataBlocks(entries["."]) },
    });
    assert.equal(saved["."]?.id, "root-legacy");
    assert.equal(saved["."]?.steps, undefined);
    assert.equal(saved["old.txt"]?.purpose, "Расчёт осадки фундамента");
    assert.equal(saved["old.txt"]?.blocks, undefined);
    assert.deepEqual(projectMetadataBlocks(saved["."]), projectMetadataBlocks(legacyRoot));
    assert.equal(
      JSON.parse(await readFile(join(workspace, ".harness/project.json"), "utf8")).version,
      2,
    );
  });
});

test("resolve inherits only exact folder ancestors in root-folder-file order and isolates workspaces", async () => {
  await withWorkspace(async (workspace) =>
    withWorkspace(async (other) => {
      const service = createProjectMetadataService({ desktopLocal: true });
      for (const [path, kind] of [
        [".", "folder"],
        ["docs", "folder"],
        ["docs/sub", "folder"],
        ["docs/sub/title.md", "document"],
        ["docs/sub/sibling.txt", "document"],
        ["doc", "folder"],
        ["other", "folder"],
      ] as const) {
        await service.save({
          workspacePath: workspace,
          path,
          entry: sampleEntry({ kind, purpose: path }),
        });
      }
      const context = await service.resolve({
        workspacePath: workspace,
        path: ".\\docs\\sub\\title.md",
      });
      assert.equal(context.path, "docs/sub/title.md");
      assert.deepEqual(
        context.entries.map((item) => item.path),
        [".", "docs", "docs/sub", "docs/sub/title.md"],
      );
      assert.ok(!context.text.includes("sibling.txt"));
      assert.deepEqual(
        (await service.resolve({ workspacePath: workspace, path: "." })).entries.map(
          (item) => item.path,
        ),
        ["."],
      );
      assert.deepEqual(await service.resolve({ workspacePath: other, path: "docs/sub/title.md" }), {
        path: "docs/sub/title.md",
        revision: (await service.resolve({ workspacePath: other, path: "docs/sub/title.md" }))
          .revision,
        entries: [],
        text: "",
      });
      await service.save({
        workspacePath: workspace,
        path: "docs",
        entry: sampleEntry({ kind: "document" }),
      });
      assert.deepEqual(
        (
          await service.resolve({ workspacePath: workspace, path: "docs/sub/title.md" })
        ).entries.map((item) => item.path),
        [".", "docs/sub", "docs/sub/title.md"],
      );
    }),
  );
});

test("context revision is stable, changes on current inherited metadata, and ignores sibling changes", async () => {
  await withWorkspace(async (workspace) => {
    const service = createProjectMetadataService({ desktopLocal: true });
    await service.save({
      workspacePath: workspace,
      path: ".",
      entry: sampleEntry({ kind: "folder", instructions: "First" }),
    });
    const first = await service.resolve({ workspacePath: workspace, path: "title.md" });
    assert.equal(
      (await service.resolve({ workspacePath: workspace, path: "title.md" })).revision,
      first.revision,
    );
    await service.save({ workspacePath: workspace, path: "sibling.txt", entry: sampleEntry() });
    assert.equal(
      (await service.resolve({ workspacePath: workspace, path: "title.md" })).revision,
      first.revision,
    );
    const target = join(workspace, ".harness/project.json");
    const external = JSON.parse(await readFile(target, "utf8"));
    external.entries["."].blocks.assembly = "Changed externally";
    await writeFile(target, JSON.stringify(external));
    const next = await service.resolve({ workspacePath: workspace, path: "title.md" });
    assert.notEqual(next.revision, first.revision);
    assert.match(next.text, /Changed externally/);
  });
});

test("known invalid fields, root kind and procedure overflow fail without rewriting valid storage", async () => {
  await withWorkspace(async (workspace) => {
    const service = createProjectMetadataService({ desktopLocal: true });
    await service.save({ workspacePath: workspace, path: "title.md", entry: sampleEntry() });
    const target = join(workspace, ".harness/project.json");
    const before = await readFile(target, "utf8");
    const invalid = [
      { instructions: "x".repeat(8001) },
      { skills: ["x".repeat(301)] },
      { checklist: ["\0"] },
      { steps: [{ title: "", instruction: "Work" }] },
      {
        steps: [
          { title: "Read", instruction: "Work", tool: { transport: "shell", operation: "run" } },
        ],
      },
      { steps: Array.from({ length: 33 }, () => ({ title: "Read", instruction: "Work" })) },
      { type: "invented" },
      { kind: "invented" },
    ];
    for (const fields of invalid) {
      await assert.rejects(
        service.save({
          workspacePath: workspace,
          path: "title.md",
          entry: { ...sampleEntry(), ...fields } as ProjectMetadataInput,
        }),
      );
      assert.equal(await readFile(target, "utf8"), before);
    }
    await assert.rejects(
      service.save({ workspacePath: workspace, path: ".", entry: sampleEntry() }),
    );
    for (const fields of invalid) {
      const corrupt = JSON.parse(before);
      Object.assign(corrupt.entries["title.md"], fields);
      await writeFile(target, JSON.stringify(corrupt));
      await assert.rejects(service.read({ workspacePath: workspace }), ProjectMetadataCorruptError);
      await assert.rejects(
        service.resolve({ workspacePath: workspace, path: "title.md" }),
        ProjectMetadataCorruptError,
      );
    }
  });
});

test("invalid stored keys cannot inject paths and prototype-named keys remain ordinary entries", async () => {
  await withWorkspace(async (workspace) => {
    const service = createProjectMetadataService({ desktopLocal: true });
    await service.save({ workspacePath: workspace, path: "__proto__", entry: sampleEntry() });
    const entries = await service.read({ workspacePath: workspace });
    assert.equal(Object.getPrototypeOf(entries), Object.prototype);
    assert.equal(Object.hasOwn(entries, "__proto__"), true);
    const target = join(workspace, ".harness/project.json");
    const before = await readFile(target, "utf8");
    for (const key of ["../outside.md", "/outside.md", "C:\\outside.md", "docs//title.md", ""]) {
      const parsed = JSON.parse(before);
      parsed.entries = Object.fromEntries([[key, entries["__proto__"]]]);
      const raw = JSON.stringify(parsed);
      await writeFile(target, raw);
      await assert.rejects(service.read({ workspacePath: workspace }), ProjectMetadataCorruptError);
      await assert.rejects(
        service.save({ workspacePath: workspace, path: "title.md", entry: sampleEntry() }),
      );
      assert.equal(await readFile(target, "utf8"), raw);
    }
  });
});

test("oversized assembled context refuses instead of silently truncating an inherited procedure", async () => {
  await withWorkspace(async (workspace) => {
    const service = createProjectMetadataService({ desktopLocal: true });
    const legacy = {
      ...sampleEntry({
        kind: "folder",
        steps: Array.from({ length: 9 }, (_, index) => ({
          title: `Step ${index}`,
          instruction: "x".repeat(8000),
        })),
      }),
      id: "long-legacy",
      updatedAt: "2026-10-15T00:00:00Z",
    };
    await mkdir(join(workspace, ".harness"));
    const target = join(workspace, ".harness/project.json");
    const original = JSON.stringify({ version: 1, entries: { ".": legacy } });
    await writeFile(target, original);
    await assert.rejects(
      service.resolve({ workspacePath: workspace, path: "title.md" }),
      /context exceeds/,
    );
    assert.equal((await service.read({ workspacePath: workspace }))["."]?.steps?.length, 9);
    await assert.rejects(
      service.save({ workspacePath: workspace, path: ".", entry: legacy }),
      /block exceeds/,
    );
    assert.equal(await readFile(target, "utf8"), original);
  });
});

test("a linked .harness directory refuses reads and writes without touching the destination", async () => {
  await withWorkspace(async (workspace) =>
    withWorkspace(async (outside) => {
      await writeFile(join(outside, "keep.txt"), "unchanged");
      await symlink(
        outside,
        join(workspace, ".harness"),
        process.platform === "win32" ? "junction" : "dir",
      );
      const service = createProjectMetadataService({ desktopLocal: true });
      await assert.rejects(service.read({ workspacePath: workspace }), /Linked/);
      await assert.rejects(
        service.resolve({ workspacePath: workspace, path: "title.md" }),
        /Linked/,
      );
      await assert.rejects(
        service.save({ workspacePath: workspace, path: "title.md", entry: sampleEntry() }),
        /Linked/,
      );
      assert.deepEqual(await readdir(outside), ["keep.txt"]);
    }),
  );
});

test("a linked project.json refuses all operations and leaves its external target untouched", async (context) => {
  await withWorkspace(async (workspace) =>
    withWorkspace(async (outside) => {
      const target = join(outside, "project.json");
      const raw = JSON.stringify({ version: 1, entries: {} });
      await writeFile(target, raw);
      await mkdir(join(workspace, ".harness"));
      try {
        await symlink(target, join(workspace, ".harness/project.json"), "file");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EPERM") {
          context.skip(
            true,
            "File symlink creation requires Windows Developer Mode or link privilege.",
          );
          return;
        }
        throw error;
      }
      const service = createProjectMetadataService({ desktopLocal: true });
      await assert.rejects(service.read({ workspacePath: workspace }), /Linked/);
      await assert.rejects(
        service.resolve({ workspacePath: workspace, path: "title.md" }),
        /Linked/,
      );
      await assert.rejects(
        service.save({ workspacePath: workspace, path: "title.md", entry: sampleEntry() }),
        /Linked/,
      );
      await assert.rejects(
        service.remove({ workspacePath: workspace, path: "title.md" }),
        /Linked/,
      );
      assert.equal(await readFile(target, "utf8"), raw);
    }),
  );
});

test("five blocks preserve whitespace and save only canonical content without a legacy shadow", async () => {
  await withWorkspace(async (workspace) => {
    const service = createProjectMetadataService({ desktopLocal: true });
    const initial = await service.save({
      workspacePath: workspace,
      path: "title.md",
      entry: sampleEntry({ instructions: "OLD INSTRUCTION" }),
    });
    const blocks: ProjectMetadataBlocks = {
      role: "  Role\n\n",
      template: "\n  Template layout\n",
      data: "\tField -> source.txt\n",
      assembly: "```python\n  exact_call()\n```\n",
      acceptance: "\n- [ ] Check result\n  Preserve author text  ",
    };
    const result = await service.save({
      workspacePath: workspace,
      path: "title.md",
      entry: { kind: "document", blocks },
    });
    const reopened = (await service.read({ workspacePath: workspace }))["title.md"];
    assert.deepEqual(reopened?.blocks, blocks);
    assert.equal(reopened?.id, initial["title.md"]?.id);
    assert.deepEqual(Object.keys(result["title.md"]!).sort(), [
      "blocks",
      "id",
      "kind",
      "updatedAt",
    ]);
    const context = await service.resolve({ workspacePath: workspace, path: "title.md" });
    for (const value of Object.values(blocks)) assert.ok(context.text.includes(value));
    assert.ok(!context.text.includes("OLD INSTRUCTION"));
    assert.ok(!context.text.includes(reopened!.id));
    assert.ok(!context.text.includes(reopened!.updatedAt));
    assert.match(context.text, /Source passport: "title\.md"/);
    assert.match(context.text, /\nRole:\n/);
    assert.match(context.text, /\nTemplate:\n/);
    assert.match(context.text, /\nData:\n/);
    assert.match(context.text, /\nAssembly:\n/);
    assert.match(context.text, /\nAcceptance:\n/);
    assert.equal(context.text.split("exact_call()").length - 1, 1);
    const empty = projectMetadataBlocks();
    await service.save({
      workspacePath: workspace,
      path: "title.md",
      entry: { kind: "document", blocks: empty },
    });
    assert.deepEqual((await service.read({ workspacePath: workspace }))["title.md"]?.blocks, empty);
    const cleared = await service.resolve({ workspacePath: workspace, path: "title.md" });
    assert.ok(!cleared.text.includes("OLD INSTRUCTION"));
    assert.ok(!cleared.text.includes("\nRole:\n"));
  });
});

test("mixed content, incomplete legacy and malformed five blocks fail saves and reads without writes", async () => {
  await withWorkspace(async (workspace) => {
    const service = createProjectMetadataService({ desktopLocal: true });
    await service.save({
      workspacePath: workspace,
      path: "title.md",
      entry: { kind: "document", blocks: projectMetadataBlocks() },
    });
    const target = join(workspace, ".harness/project.json");
    const before = await readFile(target, "utf8");
    const invalid = [
      { kind: "document", purpose: "Incomplete" },
      { ...sampleEntry(), blocks: projectMetadataBlocks() },
      { kind: "document", blocks: projectMetadataBlocks(), instructions: "" },
      { kind: "document", blocks: projectMetadataBlocks(), purpose: undefined },
      { kind: "document", blocks: { role: "" } },
      { kind: "document", blocks: { ...projectMetadataBlocks(), extra: "" } },
      { kind: "document", blocks: { ...projectMetadataBlocks(), data: [] } },
      { kind: "document", blocks: { ...projectMetadataBlocks(), assembly: "\0" } },
      { kind: "document", blocks: { ...projectMetadataBlocks(), role: "x".repeat(64001) } },
    ];
    for (const entry of invalid) {
      await assert.rejects(
        service.save({
          workspacePath: workspace,
          path: "title.md",
          entry: entry as ProjectMetadataInput,
        }),
      );
      assert.equal(await readFile(target, "utf8"), before);
      if (Object.hasOwn(entry, "purpose") && entry.purpose === undefined) continue;
      const corrupt = JSON.parse(before);
      corrupt.entries["title.md"] = { id: "invalid", updatedAt: "2026-10-17T00:00:00Z", ...entry };
      const raw = JSON.stringify(corrupt);
      await writeFile(target, raw);
      await assert.rejects(service.read({ workspacePath: workspace }), ProjectMetadataCorruptError);
      await assert.rejects(
        service.save({
          workspacePath: workspace,
          path: "other.md",
          entry: { kind: "document", blocks: projectMetadataBlocks() },
        }),
      );
      assert.equal(await readFile(target, "utf8"), raw);
      await writeFile(target, before);
    }
  });
});

test("a bounded block can still exceed assembled context and is never silently truncated", async () => {
  await withWorkspace(async (workspace) => {
    const service = createProjectMetadataService({ desktopLocal: true });
    const blocks = { ...projectMetadataBlocks(), assembly: "x".repeat(64000) };
    await service.save({ workspacePath: workspace, path: ".", entry: { kind: "folder", blocks } });
    assert.equal(
      (await service.read({ workspacePath: workspace }))["."]?.blocks?.assembly.length,
      64000,
    );
    await assert.rejects(
      service.resolve({ workspacePath: workspace, path: "title.md" }),
      /context exceeds/,
    );
  });
});
