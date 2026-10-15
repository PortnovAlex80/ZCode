// @vitest-environment jsdom
/**
 * U-08 聚焦套件：工作区文档选择器（可搜索 combobox）。
 * 覆盖：点击行打开下拉、内联过滤（对相对路径不区分大小写、即时）、
 * ↓/↑ 键盘导航、Enter 打开顶部/高亮匹配、双击直接打开、Esc 关闭、
 * txt 与 md 同列（一等文档）、禁用态、trigger 反映当前文档。
 * U-13：展示形 = 干净工作区相对路径（名称主文本 + 目录次级 muted 文本），
 * 过滤按展示形匹配，选择/打开仍用服务原路径。
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SpecDocumentPicker } from "./specDocumentPicker.js";

const FILES = [
  "docs/spec-harness/IMPLEMENTATION-PLAN.md",
  "docs/spec-harness/RENDERING-NOTES.txt",
  "README.md",
  "notes/расчёт.txt",
];

function renderPicker(options?: {
  files?: readonly string[];
  value?: string | null;
  workspaceRoot?: string;
  disabled?: boolean;
}) {
  const onOpen = vi.fn();
  const files = options?.files ?? FILES;
  const value: string | null = options?.value ?? FILES[0] ?? null;
  render(
    createElement(SpecDocumentPicker, {
      files,
      value,
      ...(options?.workspaceRoot === undefined
        ? {}
        : { workspaceRoot: options.workspaceRoot }),
      ...(options?.disabled === undefined ? {} : { disabled: options.disabled }),
      onOpen,
    }),
  );
  return onOpen;
}

function openDropdown() {
  fireEvent.click(screen.getByLabelText("Choose project document"));
  return screen.getByLabelText("Filter documents");
}

function optionRows() {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-picker-path]"));
}

describe("U-08 searchable document picker", () => {
  afterEach(() => cleanup());

  it("lists txt alongside md as first-class documents and reflects the current value", () => {
    renderPicker({ value: "README.md" });
    const trigger = screen.getByLabelText("Choose project document");
    expect(trigger.textContent).toContain("README.md");
    openDropdown();
    const paths = optionRows().map((row) => row.dataset.pickerPath);
    expect(paths).toEqual(FILES);
    // 当前文档在 listbox 中标记为选中。
    const selected = document.querySelector('[role="option"][aria-selected="true"]');
    expect(selected?.getAttribute("data-picker-path")).toBe("README.md");
  });

  it("typing filters immediately, case-insensitively over relative paths", () => {
    renderPicker();
    const filter = openDropdown();
    fireEvent.change(filter, { target: { value: "RENDERING" } });
    expect(optionRows().map((r) => r.dataset.pickerPath)).toEqual([
      "docs/spec-harness/RENDERING-NOTES.txt",
    ]);
    // 大小写无关：小写过滤匹配大写路径段；俄语路径同样可过滤。
    fireEvent.change(filter, { target: { value: "readme" } });
    expect(optionRows().map((r) => r.dataset.pickerPath)).toEqual(["README.md"]);
    fireEvent.change(filter, { target: { value: "расч" } });
    expect(optionRows().map((r) => r.dataset.pickerPath)).toEqual(["notes/расчёт.txt"]);
    // 无匹配时的空态不是可打开的 option。
    fireEvent.change(filter, { target: { value: "zzz-nope" } });
    expect(optionRows()).toEqual([]);
    expect(screen.getByText(/No documents match/u)).toBeTruthy();
  });

  it("arrows navigate and Enter opens the highlighted (top match by default)", () => {
    const onOpen = renderPicker();
    const filter = openDropdown();
    // 过滤后默认高亮第一项（顶部匹配）：Enter 直接打开它。
    fireEvent.change(filter, { target: { value: ".txt" } });
    fireEvent.keyDown(filter, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith("docs/spec-harness/RENDERING-NOTES.txt");
    // Enter 之后下拉关闭。
    expect(screen.queryByLabelText("Filter documents")).toBeNull();

    // ↓/↑ 移动高亮：第二个 .txt（wrap 到首尾）。
    onOpen.mockClear();
    fireEvent.click(screen.getByLabelText("Choose project document"));
    const filterAgain = screen.getByLabelText("Filter documents");
    fireEvent.change(filterAgain, { target: { value: ".txt" } });
    fireEvent.keyDown(filterAgain, { key: "ArrowDown" });
    fireEvent.keyDown(filterAgain, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledWith("notes/расчёт.txt");
    fireEvent.click(screen.getByLabelText("Choose project document"));
    const filterThird = screen.getByLabelText("Filter documents");
    fireEvent.change(filterThird, { target: { value: ".txt" } });
    fireEvent.keyDown(filterThird, { key: "ArrowUp" });
    fireEvent.keyDown(filterThird, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledWith("notes/расчёт.txt");
  });

  it("double-click on a row opens it directly; single click only highlights", () => {
    const onOpen = renderPicker();
    openDropdown();
    const row = optionRows().find((element) => element.dataset.pickerPath === "README.md")!;
    fireEvent.click(row);
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.doubleClick(row);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith("README.md");
    expect(screen.queryByLabelText("Filter documents")).toBeNull();
  });

  it("Esc closes the dropdown; outside pointer closes it; disabled hides interaction", () => {
    const onOpen = renderPicker();
    const filter = openDropdown();
    fireEvent.keyDown(filter, { key: "Escape" });
    expect(screen.queryByLabelText("Filter documents")).toBeNull();
    expect(
      (screen.getByLabelText("Choose project document") as HTMLButtonElement).getAttribute(
        "aria-expanded",
      ),
    ).toBe("false");

    // 外部按下关闭：不抢占焦点（mousedown 先于浏览器把焦点交给点击目标，
    // 此时把焦点拉回 trigger 会与用户的点击目标打架——只关闭）。
    fireEvent.click(screen.getByLabelText("Choose project document"));
    const filterAgain = screen.getByLabelText("Filter documents");
    filterAgain.focus();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByLabelText("Filter documents")).toBeNull();
    expect(document.activeElement).not.toBe(
      screen.getByLabelText("Choose project document"),
    );

    // Esc 关闭则把焦点还给 trigger（键盘用户的连续操作路径）。
    fireEvent.click(screen.getByLabelText("Choose project document"));
    fireEvent.keyDown(screen.getByLabelText("Filter documents"), {
      key: "Escape",
    });
    expect(screen.queryByLabelText("Filter documents")).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByLabelText("Choose project document"),
    );

    // 禁用态（I/O 或空列表）：不展开。
    cleanup();
    renderPicker({ disabled: true });
    const trigger = screen.getByLabelText("Choose project document") as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
    fireEvent.click(trigger);
    expect(screen.queryByLabelText("Filter documents")).toBeNull();
    expect(onOpen).not.toHaveBeenCalled();
  });
});

/**
 * U-13（活体反馈 2026-10-14）：下拉/搜索必须显示干净的工作区相对路径——
 * 名称为主文本、目录为次级 muted 文本；过滤按展示形匹配；打开仍用服务原路径。
 * 服务当前只返回干净的相对 POSIX 路径；这里故意混入脏形态（«./»、绝对 Windows
 * 路径、带工作区根前缀）来锁定视图层的展示契约：脏输入也不会漏到界面上。
 */
describe("U-13 clean workspace-relative display", () => {
  afterEach(() => cleanup());

  const ROOT = "D:\\Development\\ws";
  const DIRTY_FILES = [
    "docs/spec-harness/IMPLEMENTATION-PLAN.md",
    "./notes/расчёт.txt",
    "D:\\Development\\ws\\docs\\abs\\deep-plan.md",
    "README.md",
  ];

  it("shows the file name as primary text and the directory muted, with no «./» or absolute prefixes", () => {
    renderPicker({
      files: DIRTY_FILES,
      value: DIRTY_FILES[2],
      workspaceRoot: ROOT,
    });
    openDropdown();
    const rows = optionRows();
    // 选择源保持服务原路径（打开链路不变）。
    expect(rows.map((row) => row.dataset.pickerPath)).toEqual(DIRTY_FILES);
    expect(rows.map((row) => row.querySelector("[data-picker-file-name]")?.textContent)).toEqual([
      "IMPLEMENTATION-PLAN.md",
      "расчёт.txt",
      "deep-plan.md",
      "README.md",
    ]);
    expect(
      rows.map((row) => row.querySelector("[data-picker-directory]")?.textContent ?? ""),
    ).toEqual(["docs/spec-harness", "notes", "docs/abs", ""]);
    // 可见文本没有任何 «./»、盘符或根斜杠前缀。
    for (const row of rows) {
      expect(row.textContent).not.toContain("./");
      expect(row.textContent).not.toMatch(/[a-z]:/i);
    }
    // 目录是次级 muted 文本；根目录文件（README.md）不渲染目录片段。
    const directory = rows[2]!.querySelector("[data-picker-directory]")!;
    expect(directory.className).toContain("text-foreground-subtlest");
    expect(rows[3]!.querySelector("[data-picker-directory]")).toBeNull();
    // 触发器同一展示形：正文 = 名称 + muted 目录，title = 完整干净相对路径。
    // （下拉开着时 dialog 与按钮共用同一 aria-label，按 role=button 收窄到触发器。）
    const trigger = screen.getByRole("button", { name: "Choose project document" });
    expect(trigger.textContent).toContain("deep-plan.md");
    expect(trigger.textContent).not.toContain("D:");
    expect(trigger.textContent).not.toContain("./");
    expect(trigger.getAttribute("title")).toBe("docs/abs/deep-plan.md");
  });

  it("filters over exactly the displayed form", () => {
    renderPicker({ files: DIRTY_FILES, workspaceRoot: ROOT });
    const filter = openDropdown();
    // 目录段 + 名称的组合（展示形）可过滤。
    fireEvent.change(filter, { target: { value: "abs/deep" } });
    expect(optionRows().map((row) => row.dataset.pickerPath)).toEqual([DIRTY_FILES[2]]);
    fireEvent.change(filter, { target: { value: "расч" } });
    expect(optionRows().map((row) => row.dataset.pickerPath)).toEqual([DIRTY_FILES[1]]);
    // 盘符与 «./» 不属于展示形：按原始（脏）形态过滤必须一无所获。
    fireEvent.change(filter, { target: { value: "D:" } });
    expect(optionRows()).toEqual([]);
    fireEvent.change(filter, { target: { value: "./notes" } });
    expect(optionRows()).toEqual([]);
    expect(screen.getByText(/No documents match/u)).toBeTruthy();
  });

  it("opens the file by the source service path, not the display form", () => {
    const onOpen = renderPicker({ files: DIRTY_FILES, workspaceRoot: ROOT });
    openDropdown();
    const absoluteRow = optionRows().find(
      (row) => row.dataset.pickerPath === DIRTY_FILES[2],
    )!;
    fireEvent.doubleClick(absoluteRow);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith(DIRTY_FILES[2]);
    // 键盘路径（过滤 + Enter）同样拿服务原路径。
    onOpen.mockClear();
    fireEvent.click(screen.getByLabelText("Choose project document"));
    const filter = screen.getByLabelText("Filter documents");
    fireEvent.change(filter, { target: { value: "deep-plan" } });
    fireEvent.keyDown(filter, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith(DIRTY_FILES[2]);
  });
});

/**
 * U-14（活体反馈 2026-10-14 «корзина в пикере не удаляет——тихий no-op»）：
 * 行尾 корзина 先行内确认（Delete/Cancel），确认后 onDelete 携带服务原路径；
 * 禁用态必须解释原因（title）；未提供 onDelete 时不渲染删除入口。
 */
describe("U-14 picker delete (корзина)", () => {
  afterEach(() => cleanup());

  function renderDeletablePicker(options?: {
    deleteDisabled?: boolean;
    deleteDisabledReason?: string;
  }) {
    const onOpen = vi.fn();
    const onDelete = vi.fn();
    render(
      createElement(SpecDocumentPicker, {
        files: FILES,
        value: null,
        onOpen,
        onDelete,
        ...(options?.deleteDisabled === undefined
          ? {}
          : { deleteDisabled: options.deleteDisabled }),
        ...(options?.deleteDisabledReason === undefined
          ? {}
          : { deleteDisabledReason: options.deleteDisabledReason }),
      }),
    );
    return { onOpen, onDelete };
  }

  it("trash asks for confirmation; Delete calls onDelete with the service path (and never opens)", () => {
    const { onOpen, onDelete } = renderDeletablePicker();
    openDropdown();
    const trash = document.querySelector<HTMLElement>(
      '[data-picker-delete="README.md"]',
    )!;
    expect(trash).toBeTruthy();
    fireEvent.click(trash);
    // 行内确认出现；尚未删除。
    expect(
      document.querySelector('[data-picker-delete-confirm="README.md"]'),
    ).toBeTruthy();
    expect(onDelete).not.toHaveBeenCalled();
    // 点 корзина 不打开文档（stopPropagation：option 的选择/打开语义不被触发）。
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("Confirm delete README.md"));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledWith("README.md");
    // 确认后回到普通行（无确认态），下拉保持打开（可继续操作其它文件）。
    expect(
      document.querySelector("[data-picker-delete-confirm]"),
    ).toBeNull();
    expect(screen.getByLabelText("Filter documents")).toBeTruthy();
  });

  it("Cancel keeps the file: no onDelete, confirm cleared", () => {
    const { onDelete } = renderDeletablePicker();
    openDropdown();
    fireEvent.click(
      document.querySelector<HTMLElement>(
        '[data-picker-delete="notes/расчёт.txt"]',
      )!,
    );
    fireEvent.click(
      screen.getByLabelText("Cancel deleting notes/расчёт.txt"),
    );
    expect(onDelete).not.toHaveBeenCalled();
    expect(document.querySelector("[data-picker-delete-confirm]")).toBeNull();
    // корзина 回来了（可再次发起确认）。
    expect(
      document.querySelector<HTMLElement>(
        '[data-picker-delete="notes/расчёт.txt"]',
      ),
    ).toBeTruthy();
  });

  it("deleteDisabled disables the trash and explains why (title); no confirm can be opened", () => {
    const reason = "Deleting is not available in this experimental build yet.";
    renderDeletablePicker({
      deleteDisabled: true,
      deleteDisabledReason: reason,
    });
    openDropdown();
    const trash = document.querySelector<HTMLElement>(
      '[data-picker-delete="README.md"]',
    ) as HTMLButtonElement;
    expect(trash.disabled).toBe(true);
    // 原因挂在包裹 span 的 title 上（禁用按钮在部分环境不触发 tooltip）。
    expect(trash.parentElement?.getAttribute("title")).toBe(reason);
    fireEvent.click(trash);
    expect(document.querySelector("[data-picker-delete-confirm]")).toBeNull();
  });

  it("without onDelete no delete affordance is rendered", () => {
    renderPicker();
    openDropdown();
    expect(document.querySelector("[data-picker-delete]")).toBeNull();
    expect(document.querySelector("[data-picker-delete-confirm]")).toBeNull();
    expect(optionRows()).toHaveLength(FILES.length);
  });
});
