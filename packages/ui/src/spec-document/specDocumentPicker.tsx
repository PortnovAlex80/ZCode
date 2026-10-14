import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { Search } from "lucide-react";
import { cn } from "@/components/lib/utils.js";

/**
 * U-08：工作区文档选择器——可搜索 combobox。
 *
 * 设计（checklist U-08，用户请求 2026-10-14 «не только раскрывающийся список, но и
 * поиск — через иконку или клавиатурой прямо в строке, двойной клик???» → resolved to
 * combobox）：
 * - 点击文件行（trigger）打开下拉，内联过滤输入框（放大镜图标），输入即时过滤；
 * - 键盘优先：↓/↑ 移动高亮，Enter 打开高亮项（过滤后默认第一项），Esc 关闭；
 * - 行上双击直接打开；单击仅选中高亮（打开路径 = Enter / 双击，与设计一致）；
 * - 过滤对展示形相对路径不区分大小写；全局项目搜索图标是另一个独立入口，不在此处。
 *
 * U-13（活体反馈 2026-10-14，用户截图«странные пути»）：诊断确认列表来源是
 * specDocumentService.list() 的单一工作区相对 POSIX 路径，本身没有 «./»、盘符或
 * 重复段；真正的问题是每行把整条多段路径渲染成一行 muted 文本并用 CSS truncate
 * 左起截断——深层路径（如 apps/zcode-cli/docs/design/v2/loop/…）把最右侧的文件名
 * 挤出可视区，用户看到的只剩目录前缀串。修复：展示形 = 同一服务路径的「文件名为
 * 主文本 + 目录为次级 muted 文本」拆分（documentDisplayParts，防御性去掉 «./»、
 * 盘符/根斜杠与工作区根前缀，root 仅参与展示归一）；过滤按展示形匹配；key/aria/
 * onOpen 一律使用服务原路径，打开链路不受影响（列表仍由服务独占持有）。
 *
 * 显式打开路径只有 onOpen 一个：选择器不持有“当前文档”以外的任何状态。
 */

/**
 * 服务路径 → 展示形（干净的相对 POSIX 路径 + 名称/目录拆分）。
 *
 * 原因（U-13）：展示必须永远是「相对 workspace 的干净路径」——直斜杠、无 «./»、
 * 无盘符/根前缀、无工作区根前缀；服务当前返回的已是这种形态，这里再做一层纯展示
 * 归一是为了把契约钉死在视图层（脏输入也不会漏到界面上）。归一只影响显示与过滤，
 * 绝不回写：选择/打开仍用调用方传入的原路径。
 */
export function documentDisplayParts(
  path: string,
  workspaceRoot?: string,
): { display: string; name: string; directory: string } {
  let display = path.replaceAll("\\", "/");
  if (workspaceRoot) {
    const root = workspaceRoot.replaceAll("\\", "/").replace(/\/+$/, "");
    if (root && display.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {
      display = display.slice(root.length + 1);
    }
  }
  display = display
    .replace(/^(?:[a-z]:\/+|\/+)/i, "")
    .replace(/\/{2,}/g, "/");
  while (display.startsWith("./")) display = display.slice(2);
  const slash = display.lastIndexOf("/");
  return {
    display,
    name: display.slice(slash + 1),
    directory: slash < 0 ? "" : display.slice(0, slash),
  };
}

export function SpecDocumentPicker({
  files,
  value,
  workspaceRoot,
  disabled,
  onOpen,
}: {
  files: readonly string[];
  value: string | null;
  /** 仅用于展示归一（剥离绝对前缀）；打开仍然使用 files/value 里的服务原路径。 */
  workspaceRoot?: string;
  disabled?: boolean;
  onOpen: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const filterInputRef = useRef<HTMLInputElement | null>(null);
  const listId = useId();

  // U-13：展示与过滤同源（display 形）；key/aria-selected/onOpen 一律用服务原路径。
  const entries = useMemo(
    () => files.map((path) => ({ path, ...documentDisplayParts(path, workspaceRoot) })),
    [files, workspaceRoot],
  );
  const matches = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return entries;
    return entries.filter((entry) => entry.display.toLowerCase().includes(needle));
  }, [entries, filter]);

  // 过滤结果变化后高亮回落到第一项：Enter 永远打开“顶部匹配”（键盘优先）。
  useEffect(() => {
    setActiveIndex(0);
  }, [filter, entries]);

  useEffect(() => {
    if (!open) return;
    // 键盘优先：下拉一打开焦点就在过滤输入行；Esc 关闭后焦点回到 trigger。
    filterInputRef.current?.focus();
    const onPointerDown = (event: MouseEvent) => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  function close(returnFocus = true) {
    setOpen(false);
    setFilter("");
    if (returnFocus) triggerRef.current?.focus();
  }

  function openDocument(path: string) {
    close();
    onOpen(path);
  }

  function moveActive(delta: 1 | -1) {
    if (!matches.length) return;
    setActiveIndex((current) => {
      const next = current + delta;
      if (next < 0) return matches.length - 1;
      if (next >= matches.length) return 0;
      return next;
    });
  }

  function onFilterKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveActive(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveActive(-1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const target = matches[activeIndex] ?? matches[0];
      if (target) openDocument(target.path);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  }

  // U-13：触发器与下拉行同用一套展示形——名称为主文本、目录为次级 muted 文本；
  // title 保留完整干净相对路径（悬停可查全路径）。
  const valueParts = value === null ? null : documentDisplayParts(value, workspaceRoot);

  return (
    <div ref={rootRef} className="relative min-w-0 flex-1">
      <button
        type="button"
        ref={triggerRef}
        aria-label="Choose project document"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        disabled={disabled}
        title={valueParts ? valueParts.display : "Choose a document…"}
        className={cn(
          "flex w-full items-center justify-between gap-2 rounded-md border border-input-border bg-background px-2 py-1 text-ui-sm",
          disabled ? "text-foreground-subtlest" : "text-foreground",
        )}
        onClick={() => {
          if (open) close(false);
          else {
            setFilter("");
            setOpen(true);
          }
        }}
      >
        <span className="min-w-0 truncate text-left">
          {valueParts ? (
            <>
              <span data-picker-file-name>{valueParts.name}</span>
              {valueParts.directory ? (
                <span
                  data-picker-directory
                  className="ml-1 text-foreground-subtlest"
                >
                  {valueParts.directory}
                </span>
              ) : null}
            </>
          ) : (
            "Choose a document…"
          )}
        </span>
        <span aria-hidden="true" className="shrink-0 text-foreground-subtle">
          ▾
        </span>
      </button>
      {open ? (
        <div
          className="absolute left-0 right-0 top-full z-40 mt-1 rounded-md border border-border bg-popover shadow-lg"
          role="dialog"
          aria-label="Choose project document"
        >
          <div className="flex items-center gap-2 border-b border-border p-2">
            <Search aria-hidden="true" className="size-4 shrink-0 text-foreground-subtle" />
            <input
              ref={filterInputRef}
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              onKeyDown={onFilterKeyDown}
              aria-label="Filter documents"
              placeholder="Фильтр по пути…"
              spellCheck={false}
              className="min-w-0 flex-1 rounded-md border border-input-border bg-background px-2 py-1 text-ui-sm outline-none"
            />
          </div>
          <ul
            id={listId}
            role="listbox"
            aria-label="Project documents"
            className="max-h-64 overflow-y-auto p-1"
          >
            {matches.length ? (
              matches.map(({ path, name, directory }, index) => (
                <li
                  key={path}
                  role="option"
                  aria-selected={path === value}
                  tabIndex={-1}
                  data-picker-path={path}
                  className={cn(
                    "cursor-default rounded-sm px-2 py-1 text-ui-sm",
                    index === activeIndex
                      ? "bg-surface-hover text-foreground"
                      : "text-foreground-subtle",
                  )}
                  onClick={() => setActiveIndex(index)}
                  onDoubleClick={() => openDocument(path)}
                >
                  {/* U-13：名称在前（truncate 只吃掉 muted 目录侧），
                      深路径不再把文件名挤出可视区。 */}
                  <span className="block truncate">
                    <span data-picker-file-name>{name}</span>
                    {directory ? (
                      <span
                        data-picker-directory
                        className="ml-1 text-foreground-subtlest"
                      >
                        {directory}
                      </span>
                    ) : null}
                  </span>
                </li>
              ))
            ) : (
              <li className="px-2 py-3 text-ui-sm text-foreground-subtlest">
                No documents match “{filter.trim()}”.
              </li>
            )}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
