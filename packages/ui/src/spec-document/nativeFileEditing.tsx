import { useEffect, useRef, useState, type ReactNode } from "react";
import { Eye, Pencil, Save } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useServices } from "@/hooks/useServices.js";
import type { SpecDocumentSnapshot } from "@zcode/services";

/**
 * 2026-11-07（用户裁决，分支 u20-document-search）：«сохраняем текущий функционал
 * как родной — но добавляем наши возможности по редактированию документа»。
 *
 * 本 hook 把 U-18 的手动编辑引擎（编辑缓冲 + 500ms 防抖自动落盘 + Save 按钮 +
 * expectedSha256 CAS 冲突守卫）接到原生文件预览（文件树打开的 code-viewer /
 * file-manager 标签）上：原生 Preview/Source、Open 菜单（VS Code / Save as…）
 * 一律不动；编辑是叠加能力，默认关闭，用户点 Edit 才进入。
 *
 * 与 SpecDocumentPane 的关系：同一服务契约（specDocumentService read/save）与
 * 同一 CAS 语义，但状态是本标签内存态（原生标签没有 spec presentation 的
 * per-path 草稿槽）；未保存关闭标签会丢弃缓冲——草稿跨重开恢复仍属文档 tab
 * 的 U-18 语义，不在此复制第二份真相。
 *
 * Scope ruling (2026-11-07 #4): any non-binary text document is editable
 * (json/yaml/toml/ini/env/xml/csv/log, extensionless dotfiles, etc.). The UI
 * gate is a binary denylist; the final backstop is the service-side content
 * validation (UTF-8 round-trip, NUL, 2 MiB) — binary content never survives
 * read/save. Markdown keeps its Preview/Source switching behavior unchanged.
 */

/**
 * Binary denylist (user ruling 2026-11-07 #4): everything not listed here is
 * treated as text-compatible and gains the edit overlay. The service-side
 * content guards (UTF-8 round-trip, NUL bytes, 2 MiB limit) are the real
 * backstop — a mis-classified binary still fails its first read with a visible
 * error instead of being edited as text.
 */
const BINARY_DOCUMENT_EXTENSIONS = new Set([
  // images
  "png",
  "jpg",
  "jpeg",
  "gif",
  "bmp",
  "webp",
  "avif",
  "ico",
  "tiff",
  "heic",
  // audio / video
  "mp3",
  "wav",
  "ogg",
  "flac",
  "m4a",
  "mp4",
  "avi",
  "mkv",
  "mov",
  "webm",
  // archives
  "zip",
  "gz",
  "tar",
  "rar",
  "7z",
  "bz2",
  "xz",
  "br",
  // executables / libraries
  "exe",
  "dll",
  "so",
  "dylib",
  "msi",
  "app",
  "jar",
  "class",
  // fonts
  "woff",
  "woff2",
  "ttf",
  "otf",
  // documents / office
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  // databases
  "sqlite",
  "db",
  "db3",
  // disk images / raw blobs
  "bin",
  "iso",
  "img",
  // lockfiles that are machine-generated binary-ish state
  "lock",
]);

/**
 * True unless the path carries a known binary extension. Extensionless names
 * (LICENSE, Makefile) and dotfiles (".env", ".gitignore") are text.
 */
export function isTextCompatibleDocumentPath(path: string): boolean {
  const leaf = path.split(/[\\/]/).at(-1) ?? path;
  const dot = leaf.lastIndexOf(".");
  // No dot, or a leading dot (dotfile): no usable extension, treat as text.
  if (dot <= 0) return true;
  const ext = leaf.slice(dot + 1).toLowerCase();
  return !BINARY_DOCUMENT_EXTENSIONS.has(ext);
}

/** 绝对路径归一为工作区相对 POSIX 路径（与 SpecDocumentPane 打开链路同规则）。 */
function toWorkspaceRelative(path: string, workspacePath: string): string {
  const normalized = path.replaceAll("\\", "/");
  const root = workspacePath.replaceAll("\\", "/").replace(/\/+$/, "");
  const lower = normalized.toLowerCase();
  if (root && lower.startsWith(`${root.toLowerCase()}/`)) {
    return normalized.slice(root.length + 1);
  }
  return normalized;
}

export function useNativeFileEditing(options: {
  workspacePath: string;
  workspaceIdentity?: string;
  /** 原生 source 的 path（绝对或工作区相对）；null = 不可编辑。 */
  path: string | null;
  /** 仅本地工作区；remote 标签保持原生只读。 */
  enabled: boolean;
  /** 测试用防抖钉子（缺省 500，同 U-18）。 */
  autosaveDelayMs?: number;
}): {
  documentActions: ReactNode;
  sourceEditor: ReactNode;
  editing: boolean;
  /** 编辑中要求 PreviewPane 显示 Source 视图（markdown 的编辑器只在 code 视图渲染）。 */
  requestMarkdownViewMode: "code" | null;
} {
  const { specDocumentService } = useServices();
  const { path, enabled, autosaveDelayMs = 500 } = options;
  const applicable =
    enabled && Boolean(specDocumentService) && path !== null && isTextCompatibleDocumentPath(path);

  const [editing, setEditing] = useState(false);
  const [document, setDocument] = useState<SpecDocumentSnapshot | null>(null);
  const [draft, setDraft] = useState("");
  const [ioError, setIoError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const baseSha256Ref = useRef("");
  const draftRef = useRef("");
  const saveInFlightRef = useRef(false);
  const [saveInFlight, setSaveInFlight] = useState(false);
  // 换文件/失能即退出编辑并丢弃缓冲（原生标签切换文件 = 新的编辑会话）。
  useEffect(() => {
    setEditing(false);
    setDocument(null);
    setDraft("");
    draftRef.current = "";
    baseSha256Ref.current = "";
    setIoError(null);
    setStatus("");
  }, [path, applicable]);

  async function enterEditing() {
    if (!specDocumentService || !path) return;
    setIoError(null);
    try {
      const snapshot = await specDocumentService.read({
        workspacePath: options.workspacePath,
        path: toWorkspaceRelative(path, options.workspacePath),
      });
      // 竞争：读取期间用户已切换文件——丢弃迟到结果。
      if (snapshot.path !== toWorkspaceRelative(path, options.workspacePath)) return;
      setDocument(snapshot);
      draftRef.current = snapshot.content;
      setDraft(snapshot.content);
      baseSha256Ref.current = snapshot.sha256;
      setStatus("Editing · autosaves to disk");
      setEditing(true);
    } catch (cause) {
      setIoError(String(cause));
      setStatus("Edit unavailable");
    }
  }

  const dirty = document !== null && draft !== document.content;

  async function save(auto: boolean) {
    if (!specDocumentService || !document || !dirty || saveInFlightRef.current) return;
    saveInFlightRef.current = true;
    setSaveInFlight(true);
    const sent = draftRef.current;
    try {
      const next = await specDocumentService.save({
        workspacePath: options.workspacePath,
        path: document.path,
        content: sent,
        expectedSha256: baseSha256Ref.current,
      });
      if (draftRef.current === sent) {
        setDocument(next);
      } else {
        // 保存期间继续键入：磁盘推进到已发送内容，缓冲保持新值，CAS 基准前移。
        setDocument(next);
        baseSha256Ref.current = next.sha256;
      }
      setStatus("Saved on disk");
      setIoError(null);
    } catch (cause) {
      setStatus(auto ? "Autosave failed · draft retained" : "Save failed · draft retained");
      setIoError(String(cause));
    } finally {
      saveInFlightRef.current = false;
      setSaveInFlight(false);
    }
  }

  // U-18 同款防抖自动落盘；错误态（含 CAS 冲突）停止自动重试，手动 Save 可再试。
  useEffect(() => {
    if (!editing || !dirty || ioError || saveInFlight) return;
    const timer = setTimeout(() => void save(true), autosaveDelayMs);
    return () => clearTimeout(timer);
    // save 是每次渲染重建的本地函数；实际依赖已全部在列表中。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, dirty, draft, ioError, saveInFlight, autosaveDelayMs, document]);

  if (!applicable) {
    return { documentActions: null, sourceEditor: null, editing: false, requestMarkdownViewMode: null };
  }

  const actions = (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={editing ? "View" : "Edit"}
        title={editing ? "View (stop editing)" : "Edit this document with autosave"}
        disabled={saveInFlight}
        onClick={() => {
          if (editing) {
            setEditing(false);
            setStatus("Viewing");
          } else {
            void enterEditing();
          }
        }}
      >
        {editing ? <Eye className="size-4" /> : <Pencil className="size-4" />}
      </Button>
      {editing ? (
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="Save"
          title="Save changes to disk"
          disabled={!dirty || saveInFlight || Boolean(ioError)}
          onClick={() => void save(false)}
        >
          <Save className="size-4" />
        </Button>
      ) : null}
      {editing ? (
        <span
          className="max-w-56 truncate text-ui-xs text-foreground-subtle"
          data-native-editing-status
          title={ioError ?? status}
        >
          {ioError ? "Save failed · draft retained" : dirty ? "Unsaved draft" : status}
        </span>
      ) : null}
    </>
  );

  const editor = editing && document ? (
    <textarea
      aria-label="Document source editor"
      data-native-document-editor
      value={draft}
      disabled={saveInFlight}
      onChange={(event) => {
        draftRef.current = event.target.value;
        setDraft(event.target.value);
      }}
      spellCheck={false}
      className="h-full min-h-0 w-full resize-none bg-background p-4 font-mono text-ui-base leading-relaxed whitespace-pre-wrap break-words text-foreground outline-none"
    />
  ) : null;

  return {
    documentActions: actions,
    sourceEditor: editor,
    editing,
    // markdown 的 sourceEditor 只在 Source 视图渲染（previewPaneContent 契约）；
    // 进入编辑即要求切到 Source，退出编辑交还原生默认。
    requestMarkdownViewMode: editing && document ? "code" : null,
  };
}
