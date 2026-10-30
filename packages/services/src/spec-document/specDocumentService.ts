import { createHash, randomUUID } from "node:crypto";
import { lstat, open, readdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ISpecDocumentService, SpecDocumentSnapshot } from "./specDocument.js";

const MAX_BYTES = 2 * 1024 * 1024;
const DOCUMENT_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".rst"]);

/**
 * U-18：主机接线规则——写权跟随 desktop-local 服务权限（node.ts 组合根使用）。
 * 手动编辑属用户控制，直接落盘；其余 authority 形态保持只读（root() 对非本地
 * 主机本就拒绝全部文档 IO）。集中成单一函数避免组合根再次漏传写权标志。
 */
export function specDocumentServiceHostOptions(mode: string | undefined): {
  desktopLocal: boolean;
  allowUnleasedWrites: boolean;
} {
  const desktopLocal = mode === "desktop-local";
  return { desktopLocal, allowUnleasedWrites: desktopLocal };
}

export function createSpecDocumentService(options: {
  desktopLocal: boolean;
  /**
   * U-18（用户裁决 2026-10-30）：手动文档写权（文档 tab 的编辑保存/删除）。
   * desktop-local 主机授予；写入仍受 expectedSha256 CAS、写队列与路径边界约束，
   * 并发外部/agent 修改以可见冲突拒绝。非 desktop-local 主机整体没有文档 IO，
   * 不经本标志放行。
   */
  allowUnleasedWrites?: boolean;
}): ISpecDocumentService {
  let writeQueue: Promise<unknown> = Promise.resolve();
  async function root(workspacePath: string): Promise<string> {
    if (!options.desktopLocal) throw new Error("Documents is disabled for non-local hosts.");
    if (
      typeof workspacePath !== "string" ||
      !isAbsolute(workspacePath) ||
      workspacePath.includes("\0")
    ) {
      throw new Error("Absolute local workspace path required.");
    }
    const canonical = await realpath(workspacePath);
    if (!(await lstat(canonical)).isDirectory()) throw new Error("Workspace must be a directory.");
    return canonical;
  }
  async function resolveDocument(
    path: string,
    workspacePath: string,
  ): Promise<{ absolute: string; path: string; dev: number; ino: number }> {
    if (!path || isAbsolute(path) || path.includes("\0") || path.includes(":"))
      throw new Error("Relative document path required.");
    const workspace = await root(workspacePath);
    const absolute = resolve(workspace, path);
    const local = relative(workspace, absolute);
    if (!local || local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) {
      throw new Error("Document is outside the granted workspace.");
    }
    if (!DOCUMENT_EXTENSIONS.has(extname(local).toLowerCase()))
      throw new Error("Unsupported text document.");
    // Symlink/junction traversal is refused, including intermediate directories.
    let cursor = workspace;
    for (const part of local.split(sep)) {
      cursor = join(cursor, part);
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) throw new Error("Linked document paths are not supported.");
    }
    const canonical = await realpath(absolute);
    if (canonical !== absolute) throw new Error("Document path changed during validation.");
    const info = await lstat(absolute);
    if (!info.isFile() || info.size > MAX_BYTES)
      throw new Error("Documents must be text files up to 2 MiB.");
    return { absolute, path: local.split(sep).join("/"), dev: info.dev, ino: info.ino };
  }
  function snapshot(path: string, bytes: Buffer): SpecDocumentSnapshot {
    if (bytes.byteLength > MAX_BYTES) throw new Error("Document exceeds 2 MiB.");
    const content = bytes.toString("utf8");
    if (content.includes("\0") || !Buffer.from(content, "utf8").equals(bytes)) {
      throw new Error("Only valid UTF-8 text documents are supported.");
    }
    return { path, content, sha256: createHash("sha256").update(bytes).digest("hex") };
  }
  async function read(path: string, workspacePath: string): Promise<SpecDocumentSnapshot> {
    const target = await resolveDocument(path, workspacePath);
    const handle = await open(target.absolute, "r");
    try {
      const opened = await handle.stat();
      if (opened.dev !== target.dev || opened.ino !== target.ino)
        throw new Error("Document identity changed during open.");
      const bytes = await handle.readFile();
      const current = await resolveDocument(target.path, workspacePath);
      if (current.dev !== opened.dev || current.ino !== opened.ino)
        throw new Error("Document identity changed during read.");
      return snapshot(target.path, bytes);
    } finally {
      await handle.close();
    }
  }
  return {
    async getWorkspace({ workspacePath }) {
      return { root: await root(workspacePath), writable: options.allowUnleasedWrites === true };
    },
    async list({ workspacePath }) {
      const workspace = await root(workspacePath);
      const found: string[] = [];
      async function walk(directory: string, depth: number): Promise<void> {
        if (depth > 8 || found.length >= 200) return;
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.isSymbolicLink())
            continue;
          const absolute = join(directory, entry.name);
          if (entry.isDirectory()) await walk(absolute, depth + 1);
          else if (entry.isFile() && DOCUMENT_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
            found.push(relative(workspace, absolute).split(sep).join("/"));
          }
          if (found.length >= 200) break;
        }
      }
      await walk(workspace, 0);
      return found.sort();
    },
    async read({ path, workspacePath }) {
      return read(path, workspacePath);
    },
    async save(params) {
      if (options.allowUnleasedWrites !== true)
        throw new Error("Documents are read-only for this host.");
      // Serializes this service's writes. External tools are not part of this queue.
      const operation = writeQueue
        .catch(() => undefined)
        .then(async () => {
          if (!/^[a-f0-9]{64}$/.test(params.expectedSha256))
            throw new Error("Expected document hash required.");
          const bytes = Buffer.from(params.content, "utf8");
          const next = snapshot(params.path, bytes);
          const target = await resolveDocument(params.path, params.workspacePath);
          const current = await read(target.path, params.workspacePath);
          if (current.sha256 !== params.expectedSha256)
            throw new Error("Document changed on disk. Reload before saving.");
          const temporary = join(dirname(target.absolute), `.spec-harness-${randomUUID()}.tmp`);
          try {
            await writeFile(temporary, bytes, {
              flag: "wx",
              mode: (await lstat(target.absolute)).mode,
            });
            // Revalidate after staging; no force-save or merge of external changes.
            if ((await read(target.path, params.workspacePath)).sha256 !== params.expectedSha256) {
              throw new Error("Document changed while saving. Reload before saving.");
            }
            await rename(temporary, target.absolute);
          } finally {
            await unlink(temporary).catch(() => undefined);
          }
          return { ...next, path: target.path };
        });
      writeQueue = operation;
      return operation;
    },
    async remove(params) {
      // U-14（活体反馈 2026-10-14 «корзина в пикере не удаляет»）：删除链路此前
      // 根本不存在（服务无 remove、UI 无处理器）——用户点删除永远是静默 no-op。
      // 修复：真实 unlink，且与 save 同一写许可门（未获 writer lease 一律拒绝）和
      // 同一写队列（排队中的 save 先落盘、再删除；删除后到达的 save 会在
      // resolveDocument 处失败并可见报错），删除前复核文件身份（dev/ino），
      // 防止校验与删除之间目标被替换成其它文件。
      if (options.allowUnleasedWrites !== true)
        throw new Error("Documents are read-only for this host.");
      const operation = writeQueue
        .catch(() => undefined)
        .then(async () => {
          const target = await resolveDocument(params.path, params.workspacePath);
          const info = await lstat(target.absolute);
          if (info.dev !== target.dev || info.ino !== target.ino)
            throw new Error("Document identity changed before deletion.");
          await unlink(target.absolute);
          return { path: target.path };
        });
      writeQueue = operation;
      return operation;
    },
  };
}
