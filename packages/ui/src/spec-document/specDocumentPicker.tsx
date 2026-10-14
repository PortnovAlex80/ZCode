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
 * - 过滤对相对路径不区分大小写；全局项目搜索图标是另一个独立入口，不在此处。
 *
 * 显式打开路径只有 onOpen 一个：选择器不持有“当前文档”以外的任何状态。
 */
export function SpecDocumentPicker({
  files,
  value,
  disabled,
  onOpen,
}: {
  files: readonly string[];
  value: string | null;
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

  const matches = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return files;
    return files.filter((path) => path.toLowerCase().includes(needle));
  }, [files, filter]);

  // 过滤结果变化后高亮回落到第一项：Enter 永远打开“顶部匹配”（键盘优先）。
  useEffect(() => {
    setActiveIndex(0);
  }, [filter, files]);

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
      if (target !== undefined) openDocument(target);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  }

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
        title={value ?? "Choose a document…"}
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
        <span className="min-w-0 truncate text-left">{value ?? "Choose a document…"}</span>
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
              matches.map((path, index) => (
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
                  <span className="block truncate">{path}</span>
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
