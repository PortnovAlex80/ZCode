// @vitest-environment jsdom
/**
 * U-08 聚焦套件：工作区文档选择器（可搜索 combobox）。
 * 覆盖：点击行打开下拉、内联过滤（对相对路径不区分大小写、即时）、
 * ↓/↑ 键盘导航、Enter 打开顶部/高亮匹配、双击直接打开、Esc 关闭、
 * txt 与 md 同列（一等文档）、禁用态、trigger 反映当前文档。
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

function renderPicker(options?: { value?: string | null; disabled?: boolean }) {
  const onOpen = vi.fn();
  const value: string | null = options?.value ?? FILES[0] ?? null;
  render(
    createElement(SpecDocumentPicker, {
      files: FILES,
      value,
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
