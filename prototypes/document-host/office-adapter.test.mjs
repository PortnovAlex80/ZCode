import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createOfficeAdapter, validateExcelPatch } from "./office-adapter.js";

function fixture(host, options = {}) {
  const state = {
    text: "Original fragment",
    matches: 1,
    changes: [],
    values: [[2]],
    formulas: [[2]],
    tracking: "Off",
  };
  // O-07: an injected settings map models the settings Office persists inside the
  // document (flushed by saveAsync in the real host) so a close/reopen can be simulated
  // by building a new adapter instance over the same persisted settings.
  const settings = options.settings ?? new Map();
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

// O-06 (negative constraint, fixture half): adapters operate on open documents only
// through the application API. The guard walks the Word/Excel adapter sources and fails
// on any filesystem/path write reference, so a future edit cannot quietly add a
// file-level write path behind the open application.
const ADAPTER_SOURCES = ["office-adapter.js", "office-bootstrap.js"];
const FILESYSTEM_WRITE_PATTERN =
  /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|writeSync|writev|createWriteStream|truncate|truncateSync|unlink|unlinkSync|rmdir|rmdirSync|rmSync|mkdir|mkdirSync|rename|renameSync|copyFile|copyFileSync|cpSync|chmod|chmodSync|chown|chownSync|utimes|utimesSync|lutimes|openSync|FileHandle)\b|\bfs\s*\.\s*\w+|\bpath\s*\.\s*\w+|(?:from\s+|import\s*\(\s*["']|require\s*\(\s*["'])(?:node:)?(?:fs|fs\/promises|path)["']/g;
function scanForFilesystemWrites(source) {
  return [...source.matchAll(FILESYSTEM_WRITE_PATTERN)].map((match) => match[0]);
}
test("O-06 guard: adapter sources contain no fs/path write APIs; edits go through the application API only", async () => {
  // Self-check: the scanner actually detects filesystem write references.
  assert.ok(
    scanForFilesystemWrites('const fs = require("node:fs"); fs.writeFileSync(p, b);').length >= 2,
  );
  assert.deepEqual(scanForFilesystemWrites("range.insertText(text, 'Replace');"), []);
  for (const name of ADAPTER_SOURCES) {
    const source = await readFile(new URL(`./${name}`, import.meta.url), "utf8");
    assert.deepEqual(
      scanForFilesystemWrites(source),
      [],
      `${name} must not edit an open document by filesystem means (O-06)`,
    );
  }
});
test("O-06: an external file-level write under the open document is refused as stale and never performed by the adapter", async () => {
  for (const host of ["word", "excel"]) {
    const { adapter, state } = fixture(host);
    const expected = await adapter.execute("readSelection");
    // An external writer rewrites the backing file while the document stays open; the
    // application then reports the externally written content, so the captured snapshot
    // is stale. The fake host exposes application state only through its API — the
    // adapter has no channel to the file at all (the guard test above proves that in
    // source), so the only possible outcome is refusal, never a performed write.
    if (host === "word") state.text = "Rewritten behind the application";
    else state.values = [[7]];
    const receipt = await adapter.execute("applyEdit", {
      operationId: `external-file-${host}`,
      expected,
      patch:
        host === "word"
          ? { kind: "replaceText", text: "No file write" }
          : { kind: "values", data: [[5]] },
    });
    assert.equal(receipt.status, "refused");
    assert.match(String(receipt.reason), /changed/i);
    assert.deepEqual(state.changes, []);
    // A patch that asks for a file-level write is not an adapter operation at all.
    await assert.rejects(
      adapter.execute("applyEdit", {
        operationId: `file-op-${host}`,
        expected: await adapter.execute("readSelection"),
        patch: { kind: "writeFile", path: "over-the-open-document", bytes: "..." },
      }),
      /Unsupported Word patch|do not match the target/,
    );
    assert.deepEqual(state.changes, []);
  }
});
test("O-07: Office-settings identity round-trips the gateway binding id across reopen for both hosts", async () => {
  for (const host of ["word", "excel"]) {
    // The settings Office persists inside the document survive save + close + reopen.
    const persistedSettings = new Map();
    const opened = () => fixture(host, { settings: persistedSettings }).adapter;
    // The gateway derives its binding key exactly like documentGateway.ts on win32:
    // canonical lowercased workspace + host + documentId (never the file path).
    const bindings = new Map();
    const bind = (workspacePath, descriptor) => {
      const key = JSON.stringify([
        workspacePath.toLowerCase(),
        descriptor.host,
        descriptor.documentId,
      ]);
      if (!bindings.has(key)) bindings.set(key, { id: `binding-${host}`, key });
      return bindings.get(key);
    };
    const first = await opened().descriptor();
    const firstBinding = bind("D:\\Fixture\\Project", first);
    // Pane-side metadata is persisted through the same Office settings store, so it
    // travels inside the document instead of a pane-local cache.
    persistedSettings.set(
      "specHarness.pane.binding",
      JSON.stringify({ bindingId: firstBinding.id, workspacePath: "D:\\Fixture\\Project" }),
    );
    // Reopen: a fresh adapter instance over the persisted settings keeps the document
    // identity and gains a new instance identity.
    const reopened = await opened().descriptor();
    assert.equal(reopened.documentId, first.documentId);
    assert.notEqual(reopened.documentInstanceId, first.documentInstanceId);
    // The gateway resolves the reopened document — even through a differently-cased
    // workspace spelling — to the same persisted binding id.
    const reopenedBinding = bind("d:\\fixture\\project", reopened);
    assert.equal(reopenedBinding.id, firstBinding.id);
    // The metadata read back from the document still matches that binding id.
    assert.equal(
      JSON.parse(persistedSettings.get("specHarness.pane.binding")).bindingId,
      reopenedBinding.id,
    );
  }
});
