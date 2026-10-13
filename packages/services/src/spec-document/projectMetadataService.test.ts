import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import {
  ProjectMetadataCorruptError,
  type ProjectMetadataEntries,
  type ProjectMetadataInput,
} from "./projectMetadata.js";
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
    assert.equal(entries["docs/расчёт.md"]?.purpose, "Расчёт осадки фундамента");
    assert.equal(entries["docs/расчёт.md"]?.type, "calculation");
    assert.deepEqual(entries["docs/расчёт.md"]?.sources, ["ГОСТ 12345", "изыскания 2024"]);

    const raw = await readFile(join(workspace, ".harness", "project.json"), "utf8");
    const parsed = JSON.parse(raw) as { version: number; entries: ProjectMetadataEntries };
    assert.equal(parsed.version, 1);
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
    assert.equal(second["notes/записка.md"]?.purpose, "Обновлённое назначение");
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
      JSON.stringify({ version: 2, entries: {} }),
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
