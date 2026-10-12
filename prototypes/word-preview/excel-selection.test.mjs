import { test } from "node:test";
import assert from "node:assert/strict";
import { readExcelSelection } from "./excel-selection.js";

function fakeExcel(range, steps) {
  range.load = (fields) => steps.push(fields);
  return {
    run: (callback) =>
      callback({
        workbook: { getSelectedRange: () => range },
        sync: async () => steps.push("sync"),
      }),
  };
}
test("Excel context preserves address, displayed values and formulas", async () => {
  const steps = [];
  const result = await readExcelSelection(
    fakeExcel(
      {
        address: "Budget!A1:B2",
        cellCount: 4,
        text: [
          ["Item", "Total"],
          ["Books", "30"],
        ],
        formulas: [
          ["Item", "Total"],
          ["Books", "=10*3"],
        ],
      },
      steps,
    ),
  );
  assert.match(result, /Budget!A1:B2/);
  assert.match(result, /Books\t30/);
  assert.match(result, /\[2,2\] =10\*3/);
  assert.deepEqual(steps, ["address,cellCount", "sync", "text,formulas", "sync"]);
});
test("whole-column selection is rejected before reading cell data", async () => {
  const steps = [];
  await assert.rejects(
    readExcelSelection(fakeExcel({ address: "Sheet1!A:A", cellCount: 1048576 }, steps)),
    /1000/,
  );
  assert.deepEqual(steps, ["address,cellCount", "sync"]);
});
