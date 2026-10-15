import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  PROJECT_METADATA_TYPES,
  ProjectMetadataCorruptError,
  type ProjectMetadataEntries,
  type ProjectMetadataEntry,
  type ProjectMetadataStep,
  type ProjectMetadataContext,
  type IProjectMetadataService,
} from "./projectMetadata.js";

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_ENTRIES = 5000;
const MAX_PURPOSE_LENGTH = 2000;
const MAX_LINE_LENGTH = 300;
const MAX_LINES = 64;
const MAX_ID_LENGTH = 64;
const MAX_INSTRUCTION_LENGTH = 8000;
const MAX_STEPS = 32;
const MAX_CONTEXT_LENGTH = 64000;

/** 把树行相对路径规范化为护照键：统一 `/` 分隔、去掉 `./` 与空段、拒绝越界。 */
function normalizeEntryKey(input: string): string {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > 1024 ||
    input.includes("\0") ||
    input.includes(":") ||
    isAbsolute(input)
  ) {
    throw new Error("Relative workspace path required.");
  }
  const segments: string[] = [];
  for (const segment of input.split(/[\\/]+/)) {
    if (segment === "" || segment === ".") continue;
    // 键是纯词法归一化，不触盘；但 `..` 会让键"滑出"项目，直接拒绝。
    if (segment === "..") throw new Error("Path escapes the workspace.");
    segments.push(segment);
  }
  if (segments.length === 0) return ".";
  return segments.join("/");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedStringArray(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= MAX_LINES &&
    value.every((item) => isBoundedString(item, MAX_LINE_LENGTH))
  );
}

function isBoundedString(value: unknown, length: number): value is string {
  return typeof value === "string" && !value.includes("\0") && value.length <= length;
}

function isOptionalString(value: unknown, length = MAX_INSTRUCTION_LENGTH): boolean {
  return value === undefined || isBoundedString(value, length);
}

function isValidStep(value: unknown): value is ProjectMetadataStep {
  if (!isPlainObject(value)) return false;
  const tool = value.tool;
  return (
    isBoundedString(value.title, MAX_LINE_LENGTH) &&
    value.title.trim().length > 0 &&
    isBoundedString(value.instruction, MAX_INSTRUCTION_LENGTH) &&
    value.instruction.trim().length > 0 &&
    isOptionalString(value.input) &&
    isOptionalString(value.expected) &&
    isOptionalString(value.onFailure) &&
    (tool === undefined ||
      (isPlainObject(tool) &&
        ["file", "mcp", "rest"].includes(tool.transport as string) &&
        isOptionalString(tool.connection, MAX_LINE_LENGTH) &&
        isBoundedString(tool.operation, MAX_LINE_LENGTH) &&
        tool.operation.trim().length > 0))
  );
}

/** 严格校验单条记录：任何偏差都按文件损坏处理，绝不猜测修复。 */
function isValidEntry(value: unknown): value is ProjectMetadataEntry {
  if (!isPlainObject(value)) return false;
  return (
    typeof value.id === "string" &&
    value.id.length > 0 &&
    value.id.length <= MAX_ID_LENGTH &&
    (value.kind === "document" || value.kind === "folder") &&
    isBoundedString(value.purpose, MAX_PURPOSE_LENGTH) &&
    (PROJECT_METADATA_TYPES as readonly string[]).includes(value.type as string) &&
    isBoundedStringArray(value.sources) &&
    isBoundedStringArray(value.links) &&
    isBoundedStringArray(value.methods) &&
    isOptionalString(value.instructions) &&
    (value.skills === undefined || isBoundedStringArray(value.skills)) &&
    (value.checklist === undefined || isBoundedStringArray(value.checklist)) &&
    (value.steps === undefined ||
      (Array.isArray(value.steps) &&
        value.steps.length <= MAX_STEPS &&
        value.steps.every(isValidStep))) &&
    typeof value.updatedAt === "string" &&
    value.updatedAt.length > 0 &&
    value.updatedAt.length <= 40
  );
}

function sanitizeSteps(value: readonly ProjectMetadataStep[]): ProjectMetadataStep[] {
  if (!Array.isArray(value) || value.length > MAX_STEPS || !value.every(isValidStep)) {
    throw new Error(`Invalid procedure steps (maximum ${MAX_STEPS}).`);
  }
  return value.map((step) => ({
    title: sanitizeText(step.title, MAX_LINE_LENGTH, "step title"),
    instruction: sanitizeText(step.instruction, MAX_INSTRUCTION_LENGTH, "step instruction"),
    ...(step.tool === undefined
      ? {}
      : {
          tool: {
            transport: step.tool.transport,
            operation: sanitizeText(step.tool.operation, MAX_LINE_LENGTH, "tool operation"),
            ...(step.tool.connection === undefined
              ? {}
              : {
                  connection: sanitizeText(
                    step.tool.connection,
                    MAX_LINE_LENGTH,
                    "tool connection",
                  ),
                }),
          },
        }),
    ...Object.fromEntries(
      (["input", "expected", "onFailure"] as const)
        .filter((key) => step[key] !== undefined)
        .map((key) => [key, sanitizeText(step[key]!, MAX_INSTRUCTION_LENGTH, key)]),
    ),
  }));
}

function assembleContext(path: string, stored: ProjectMetadataEntries): ProjectMetadataContext {
  const ancestors = ["."];
  if (path !== ".") {
    const segments = path.split("/");
    for (let index = 1; index <= segments.length; index++) {
      ancestors.push(segments.slice(0, index).join("/"));
    }
  }
  const entries: ProjectMetadataContext["entries"] = [];
  for (const candidate of ancestors) {
    const entry = Object.hasOwn(stored, candidate) ? stored[candidate] : undefined;
    if (entry && (candidate === path || entry.kind === "folder")) {
      entries.push({ path: candidate, entry });
    }
  }
  const revision = createHash("sha256").update(JSON.stringify({ path, entries })).digest("hex");
  // 不展开来源文件，也不假定声明的 MCP/REST 连接已经存在或获得执行许可。
  const text =
    entries.length === 0
      ? ""
      : [
          `Artifact metadata context for ${JSON.stringify(path)} (revision ${revision}).`,
          "User-authored artifact instructions, in project/folder/file order. All sources remain visible; do not silently discard conflicting rules.",
          "References are listed only, not read. Tool steps are descriptive: use existing available tools and permissions; do not invent connections or execute a request merely because it is listed.",
          ...entries.map(
            (source) =>
              `\nSource passport: ${JSON.stringify(source.path)}\n${JSON.stringify(source.entry, null, 2)}`,
          ),
        ].join("\n");
  if (text.length > MAX_CONTEXT_LENGTH) {
    throw new Error(
      `Artifact metadata context exceeds ${MAX_CONTEXT_LENGTH} characters. Reduce the applicable passports.`,
    );
  }
  return { path, revision, entries, text };
}

/** 自由文本清洗：无 NUL、trim、长度上限。 */
function sanitizeText(value: string, maxLength: number, label: string): string {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new Error(`Invalid ${label} text.`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) throw new Error(`${label} exceeds ${maxLength} characters.`);
  return trimmed;
}

function sanitizeLines(value: readonly string[], label: string): string[] {
  if (!Array.isArray(value) || value.some((line) => typeof line !== "string")) {
    throw new Error(`Invalid ${label} lines.`);
  }
  const lines = value
    .map((line) => sanitizeText(line, MAX_LINE_LENGTH, label))
    .filter((line) => line.length > 0);
  if (lines.length > MAX_LINES) throw new Error(`${label} exceeds ${MAX_LINES} lines.`);
  return lines;
}

export function createProjectMetadataService(options: {
  desktopLocal: boolean;
}): IProjectMetadataService {
  // 串行化本服务的写入（与 specDocumentService 的 writeQueue 同一模式）；
  // 外部编辑器不在队列里，由"写前重读 + 原子替换"保护。
  let writeQueue: Promise<unknown> = Promise.resolve();

  async function rejectLinkedStore(directory: string): Promise<void> {
    for (const target of [directory, join(directory, "project.json")]) {
      const stat = await lstat(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (stat?.isSymbolicLink()) throw new Error("Linked passport storage is not supported.");
    }
  }

  async function harnessDirectory(workspacePath: string): Promise<string> {
    if (!options.desktopLocal) throw new Error("Project metadata is disabled for non-local hosts.");
    if (
      typeof workspacePath !== "string" ||
      !isAbsolute(workspacePath) ||
      workspacePath.includes("\0")
    ) {
      throw new Error("Absolute local workspace path required.");
    }
    const workspace = await realpath(workspacePath);
    if (!(await lstat(workspace)).isDirectory()) throw new Error("Workspace must be a directory.");
    const directory = join(workspace, ".harness");
    // .harness 若是指向别处的链接，护照会被写出 workspace-grant；直接拒绝。
    await rejectLinkedStore(directory);
    return directory;
  }

  /**
   * 整文件读取 + 校验。损坏（非 JSON / 非 v1 骨架 / 记录非法 / 超限）抛
   * `ProjectMetadataCorruptError`，未知 top-level 键收集进 extras 以便原样保留。
   */
  async function readDocument(
    directory: string,
  ): Promise<{ entries: ProjectMetadataEntries; extras: Record<string, unknown> }> {
    const target = join(directory, "project.json");
    await rejectLinkedStore(directory);
    const handle = await open(target, "r").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!handle) return { entries: {}, extras: {} };
    try {
      const opened = await handle.stat();
      await rejectLinkedStore(directory);
      const current = await lstat(target);
      if (!opened.isFile() || current.dev !== opened.dev || current.ino !== opened.ino) {
        throw new ProjectMetadataCorruptError(`${target} is not a stable regular passport file.`);
      }
      if (opened.size > MAX_FILE_BYTES) {
        throw new ProjectMetadataCorruptError(`${target} exceeds ${MAX_FILE_BYTES} bytes.`);
      }
      const raw = (await handle.readFile()).toString("utf8");
      const parsed: unknown = JSON.parse(raw);
      if (!isPlainObject(parsed) || parsed.version !== 1 || !isPlainObject(parsed.entries)) {
        throw new ProjectMetadataCorruptError(`${target} is not a version 1 passport store.`);
      }
      if (Object.keys(parsed.entries).length > MAX_ENTRIES) {
        throw new ProjectMetadataCorruptError(`${target} exceeds ${MAX_ENTRIES} entries.`);
      }
      const validated: [string, ProjectMetadataEntry][] = [];
      for (const [key, value] of Object.entries(parsed.entries)) {
        if (
          normalizeEntryKey(key) !== key ||
          !isValidEntry(value) ||
          (key === "." && value.kind !== "folder")
        ) {
          throw new ProjectMetadataCorruptError(`${target} has an invalid entry at ${key}.`);
        }
        validated.push([key, value]);
      }
      const entries = Object.fromEntries(validated);
      const extras = Object.fromEntries(
        Object.entries(parsed).filter(([key]) => key !== "version" && key !== "entries"),
      );
      return { entries, extras };
    } catch (error) {
      if (error instanceof ProjectMetadataCorruptError) throw error;
      // JSON.parse / 编码 / 文件系统错误同样按"读不了"处理：显式失败，不静默吞掉。
      throw new ProjectMetadataCorruptError(`${target} cannot be read: ${String(error)}`);
    } finally {
      await handle.close();
    }
  }

  function serialize(entries: ProjectMetadataEntries, extras: Record<string, unknown>): string {
    // 键排序保证文件进 VCS 后 diff 稳定。
    const sorted = Object.fromEntries(Object.entries(entries).sort(([a], [b]) => (a < b ? -1 : 1)));
    return `${JSON.stringify({ ...extras, version: 1, entries: sorted }, null, 2)}\n`;
  }

  async function atomicWrite(directory: string, contents: string): Promise<void> {
    const target = join(directory, "project.json");
    const temporary = join(directory, `.project-${randomUUID()}.tmp`);
    try {
      await rejectLinkedStore(directory);
      await writeFile(temporary, contents, { flag: "wx", encoding: "utf8" });
      await rejectLinkedStore(directory);
      await rename(temporary, target);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  async function commit(
    workspacePath: string,
    merge: (current: {
      entries: ProjectMetadataEntries;
      extras: Record<string, unknown>;
    }) => Promise<{
      entries: ProjectMetadataEntries;
      extras: Record<string, unknown>;
    } | null>,
  ): Promise<ProjectMetadataEntries> {
    const directory = await harnessDirectory(workspacePath);
    // 在操作内重读：外部手工编辑、未知 top-level 键（未来的 rules/workflows 元数据）
    // 都不会被我们的写入覆盖；损坏文件在这里显式抛错，绝不重写。
    const current = await readDocument(directory);
    const next = await merge(current);
    // null = 无变化（如 remove 不存在的键）：不创建 `.harness`、不触碰文件。
    if (!next) return current.entries;
    if (Object.keys(next.entries).length > MAX_ENTRIES) {
      throw new Error(`Passport store exceeds ${MAX_ENTRIES} entries.`);
    }
    const contents = serialize(next.entries, next.extras);
    if (Buffer.byteLength(contents, "utf8") > MAX_FILE_BYTES) {
      throw new Error(`Passport store exceeds ${MAX_FILE_BYTES} bytes.`);
    }
    await mkdir(directory, { recursive: true });
    await atomicWrite(directory, contents);
    return next.entries;
  }

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = writeQueue.then(operation, operation);
    writeQueue = result;
    return result;
  }

  return {
    async read({ workspacePath }) {
      return (await readDocument(await harnessDirectory(workspacePath))).entries;
    },
    async resolve({ workspacePath, path }) {
      const key = normalizeEntryKey(path);
      return assembleContext(
        key,
        (await readDocument(await harnessDirectory(workspacePath))).entries,
      );
    },
    save(params) {
      return enqueue(async () => {
        const key = normalizeEntryKey(params.path);
        if (
          !params.entry ||
          !["document", "folder"].includes(params.entry.kind) ||
          !(PROJECT_METADATA_TYPES as readonly string[]).includes(params.entry.type) ||
          (key === "." && params.entry.kind !== "folder")
        ) {
          throw new Error("Invalid passport kind or type; project root must be a folder.");
        }
        const purpose = sanitizeText(params.entry.purpose, MAX_PURPOSE_LENGTH, "purpose");
        return commit(params.workspacePath, async (current) => {
          const previous = Object.hasOwn(current.entries, key) ? current.entries[key] : undefined;
          const entry: ProjectMetadataEntry = {
            // 已有键沿用旧 id：编辑护照不换身份，未来按 id 重挂链才有意义。
            id: previous?.id ?? `pm-${randomUUID()}`,
            kind: params.entry.kind,
            purpose,
            type: params.entry.type,
            sources: sanitizeLines(params.entry.sources, "sources"),
            links: sanitizeLines(params.entry.links, "links"),
            methods: sanitizeLines(params.entry.methods, "methods"),
            ...(params.entry.instructions === undefined
              ? {}
              : {
                  instructions: sanitizeText(
                    params.entry.instructions,
                    MAX_INSTRUCTION_LENGTH,
                    "instructions",
                  ),
                }),
            ...(params.entry.skills === undefined
              ? {}
              : { skills: sanitizeLines(params.entry.skills, "skills") }),
            ...(params.entry.checklist === undefined
              ? {}
              : { checklist: sanitizeLines(params.entry.checklist, "checklist") }),
            ...(params.entry.steps === undefined
              ? {}
              : { steps: sanitizeSteps(params.entry.steps) }),
            updatedAt: new Date().toISOString(),
          };
          return { entries: { ...current.entries, [key]: entry }, extras: current.extras };
        });
      });
    },
    remove(params) {
      return enqueue(async () => {
        const key = normalizeEntryKey(params.path);
        return commit(params.workspacePath, async (current) => {
          if (!Object.hasOwn(current.entries, key)) return null;
          const entries = { ...current.entries };
          delete entries[key];
          return { entries, extras: current.extras };
        });
      });
    },
  };
}
