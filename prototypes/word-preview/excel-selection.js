export async function readExcelSelection(excel) {
  return excel.run(async (context) => {
    const range = context.workbook.getSelectedRange();
    range.load("address,cellCount");
    await context.sync();
    if (range.cellCount < 1 || range.cellCount > 1000) {
      throw new Error("Выберите смежный диапазон не больше 1000 ячеек.");
    }
    range.load("text,formulas");
    await context.sync();
    const values = range.text.map((row) => row.join("\t")).join("\n");
    const formulas = range.formulas
      .map((row, r) =>
        row
          .map((value, c) =>
            typeof value === "string" && value.startsWith("=")
              ? `[${r + 1},${c + 1}] ${value}`
              : "",
          )
          .filter(Boolean)
          .join("\n"),
      )
      .filter(Boolean)
      .join("\n");
    const content = `${range.address}\n${values}${formulas ? `\n\nФормулы (позиции внутри диапазона):\n${formulas}` : ""}`;
    return content.length > 20000
      ? `${content.slice(0, 19950)}\n[Контекст сокращён до 20000 символов]`
      : content;
  });
}
