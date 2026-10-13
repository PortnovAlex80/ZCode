import test from "node:test";
import assert from "node:assert/strict";
import { createOfficeAdapter, validateExcelPatch } from "./office-adapter.js";

function fixture(host) {
  const state = {
    text: "Original fragment",
    matches: 1,
    changes: [],
    values: [[2]],
    formulas: [[2]],
    tracking: "Off",
  };
  const settings = new Map();
  const Office = {
    AsyncResultStatus: { Succeeded: "ok" },
    context: {
      document: {
        url: `https://example.invalid/document.${host === "word" ? "docx" : "xlsx"}`,
        settings: {
          get: (key) => settings.get(key),
          set: (key, value) => settings.set(key, value),
          remove: (key) => settings.delete(key),
          saveAsync: (callback) => callback({ status: "ok" }),
        },
      },
      requirements: { isSetSupported: () => true },
    },
  };
  const range = {
    load() {},
    select() {},
    track() {},
    untrack() {},
    tables: { load() {}, items: [] },
    parentTableOrNullObject: { load() {}, isNullObject: true },
    inlinePictures: { load() {}, items: [] },
    get text() {
      return state.text;
    },
    insertText(text) {
      state.changes.push(["replace", text, state.tracking]);
      state.text = text;
      return range;
    },
    insertComment(text) {
      state.changes.push(["comment", text]);
      return { load() {}, id: "comment-1" };
    },
  };
  const wordContext = {
    sync: async () => {},
    document: {
      getSelection: () => state.selection ?? range,
      body: {
        search: () => ({ load() {}, items: Array.from({ length: state.matches }, () => range) }),
      },
      load() {},
      get changeTrackingMode() {
        return state.tracking;
      },
      set changeTrackingMode(value) {
        state.tracking = value;
      },
    },
  };
  const excelRange = {
    load() {},
    select() {},
    getMergedAreasOrNullObject: () => ({ load() {}, isNullObject: !state.merged }),
    worksheet: {
      id: "sheet-1",
      load() {},
      activate() {},
      protection: {
        load() {},
        get protected() {
          return Boolean(state.protected);
        },
      },
    },
    hasSpill: false,
    savedAsArray: false,
    address: "Sheet1!A1",
    cellCount: 1,
    rowCount: 1,
    columnCount: 1,
    get values() {
      return state.values;
    },
    set values(value) {
      state.changes.push(["values", value]);
      state.values = value;
      state.formulas = value;
    },
    get formulas() {
      return state.formulas;
    },
    set formulas(value) {
      state.changes.push(["formulas", value]);
      state.formulas = value;
    },
    get text() {
      return state.values.map((row) => row.map(String));
    },
  };
  const adapter = createOfficeAdapter({
    host,
    Office,
    Word: { run: (...args) => args.at(-1)(wordContext) },
    Excel: {
      run: (fn) =>
        fn({
          sync: async () => {},
          workbook: {
            getSelectedRange: () => excelRange,
            worksheets: { getItem: () => ({ getRange: () => excelRange }) },
          },
        }),
    },
  });
  return { adapter, state, Office, excelRange, range, wordContext };
}

test("Word refuses changed native anchors and never substitutes an identical occurrence", async () => {
  const { adapter, state } = fixture("word");
  const expected = await adapter.execute("readSelection");
  state.text = "Changed by author";
  const receipt = await adapter.execute("applyEdit", {
    operationId: "stale",
    expected,
    patch: { kind: "replaceText", text: "Wrong" },
  });
  assert.equal(receipt.status, "refused");
  assert.deepEqual(state.changes, []);
  state.selection = { text: expected.data.text, load() {} };
  state.matches = 1;
  const wrongOccurrence = await adapter.execute("applyEdit", {
    operationId: "other-occurrence",
    expected,
    patch: { kind: "comment", text: "Review" },
  });
  assert.equal(wrongOccurrence.status, "refused");
  await assert.rejects(
    adapter.execute("locate", {
      ...expected,
      target: { anchorId: "expired", quote: expected.data.text },
    }),
    /expired/,
  );
  assert.deepEqual(state.changes, []);
});
test("Word refuses table replacement and restores tracking even when enabling sync fails", async () => {
  const { adapter, range, state, wordContext } = fixture("word");
  const expected = await adapter.execute("readSelection");
  range.parentTableOrNullObject.isNullObject = false;
  assert.equal(
    (
      await adapter.execute("applyEdit", {
        operationId: "table",
        expected,
        patch: { kind: "replaceText", text: "No" },
      })
    ).status,
    "refused",
  );
  range.parentTableOrNullObject.isNullObject = true;
  let firstToggle = true;
  wordContext.sync = async () => {
    if (state.tracking === "TrackAll" && firstToggle) {
      firstToggle = false;
      throw new Error("Enabling failed");
    }
  };
  assert.equal(
    (
      await adapter.execute("applyEdit", {
        operationId: "toggle",
        expected,
        patch: { kind: "replaceText", text: "No" },
      })
    ).status,
    "unknown",
  );
  assert.equal(state.tracking, "Off");
  assert.deepEqual(state.changes, []);
});
test("Excel refuses merged, protected and spill/array targets without a write", async () => {
  for (const field of ["merged", "protected", "hasSpill", "savedAsArray"]) {
    const { adapter, state, excelRange } = fixture("excel");
    const expected = await adapter.execute("readSelection");
    if (field in excelRange) excelRange[field] = true;
    else state[field] = true;
    assert.equal(
      (
        await adapter.execute("applyEdit", {
          operationId: field,
          expected,
          patch: { kind: "values", data: [[9]] },
        })
      ).status,
      "refused",
    );
    assert.deepEqual(state.changes, []);
  }
});
test("Word uses native revisions, restores tracking and prevents duplicate writes", async () => {
  const { adapter, state } = fixture("word");
  const expected = await adapter.execute("readSelection");
  const proposal = {
    operationId: "review-1",
    expected,
    patch: { kind: "replaceText", text: "Reviewed fragment" },
  };
  assert.equal((await adapter.execute("applyEdit", proposal)).status, "applied");
  assert.deepEqual(state.changes, [["replace", "Reviewed fragment", "TrackAll"]]);
  assert.equal(state.tracking, "Off");
  await assert.rejects(adapter.execute("applyEdit", proposal), /already attempted/);
});
test("Word native comments return their real identity and old instances refuse", async () => {
  const { adapter, state } = fixture("word");
  const expected = await adapter.execute("readSelection");
  const receipt = await adapter.execute("applyEdit", {
    operationId: "comment",
    expected,
    patch: { kind: "comment", text: "Check this requirement" },
  });
  assert.equal(receipt.commentId, "comment-1");
  assert.equal(state.text, "Original fragment");
  await assert.rejects(
    adapter.execute("locate", { ...expected, documentInstanceId: "old" }),
    /instance changed/,
  );
});
test("Excel rejects dimension mismatch, formula injection and non-finite values", () => {
  assert.throws(() => validateExcelPatch({ kind: "values", data: [[1, 2]] }, 1, 1), /dimensions/);
  assert.throws(
    () => validateExcelPatch({ kind: "values", data: [["=HYPERLINK(1)"]] }, 1, 1),
    /formula/,
  );
  assert.throws(() => validateExcelPatch({ kind: "values", data: [[NaN]] }, 1, 1), /Unsupported/);
  assert.throws(
    () => validateExcelPatch({ kind: "formulas", data: [["SUM(A1:A2)"]] }, 1, 1),
    /beginning/,
  );
});
test("Excel applies invariant formulas once and refuses contents changed by another writer", async () => {
  const { adapter, state } = fixture("excel");
  const expected = await adapter.execute("readSelection");
  state.values = [[3]];
  assert.equal(
    (
      await adapter.execute("applyEdit", {
        operationId: "stale",
        expected,
        patch: { kind: "values", data: [[10]] },
      })
    ).status,
    "refused",
  );
  assert.deepEqual(state.changes, []);
  const fresh = await adapter.execute("readSelection");
  const proposal = {
    operationId: "formula-1",
    expected: fresh,
    patch: { kind: "formulas", data: [["=1+2"]] },
  };
  assert.equal((await adapter.execute("applyEdit", proposal)).status, "applied");
  assert.deepEqual(state.formulas, [["=1+2"]]);
  await assert.rejects(adapter.execute("applyEdit", proposal), /already attempted/);
});
test("Excel bounds reads before loading values and does not substitute another instance", async () => {
  const { adapter, excelRange } = fixture("excel");
  const snapshot = await adapter.execute("readSelection");
  await assert.rejects(
    adapter.execute("readTarget", { ...snapshot, documentInstanceId: "different" }),
    /instance changed/,
  );
  excelRange.cellCount = 1001;
  await assert.rejects(adapter.execute("readSelection"), /1000/);
});
test("Word preserves tracking that was already TrackAll before the write", async () => {
  const { adapter, state } = fixture("word");
  state.tracking = "TrackAll";
  const expected = await adapter.execute("readSelection");
  const receipt = await adapter.execute("applyEdit", {
    operationId: "trackall",
    expected,
    patch: { kind: "replaceText", text: "Kept under tracking" },
  });
  assert.equal(receipt.status, "applied");
  assert.equal(receipt.trackingCleanupError, undefined);
  assert.equal(state.tracking, "TrackAll");
  assert.deepEqual(state.changes, [["replace", "Kept under tracking", "TrackAll"]]);
});
test("Word refuses plain replacement of a fragment containing pictures", async () => {
  const { adapter, range, state } = fixture("word");
  const expected = await adapter.execute("readSelection");
  range.inlinePictures.items = [{}];
  const receipt = await adapter.execute("applyEdit", {
    operationId: "pictures",
    expected,
    patch: { kind: "replaceText", text: "No" },
  });
  assert.equal(receipt.status, "refused");
  assert.deepEqual(state.changes, []);
});
test("Word reports an externally collapsed anchor as expired, not as a bad selection", async () => {
  const { adapter, state } = fixture("word");
  const expected = await adapter.execute("readSelection");
  // Real Word collapses a tracked range whose content was wholly replaced externally.
  state.text = "";
  await assert.rejects(
    adapter.execute("applyEdit", {
      operationId: "collapsed",
      expected,
      patch: { kind: "replaceText", text: "Wrong" },
    }),
    /expired/,
  );
  await assert.rejects(adapter.execute("locate", expected), /expired/);
  assert.deepEqual(state.changes, []);
});
