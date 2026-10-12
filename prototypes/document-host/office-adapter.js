const MAX_CELLS = 1000;
const MAX_TEXT = 20000;
function boundedSnapshot(snapshot) {
  if (new TextEncoder().encode(JSON.stringify(snapshot)).length > 64 * 1024)
    throw new Error("Selection exceeds 64 KiB; capture a smaller target");
  return snapshot;
}

export function sameOfficeData(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
export function validateExcelPatch(patch, rows, columns) {
  if (
    !["values", "formulas"].includes(patch.kind) ||
    !Array.isArray(patch.data) ||
    patch.data.length !== rows ||
    patch.data.some((row) => !Array.isArray(row) || row.length !== columns)
  )
    throw new Error("Patch dimensions or kind do not match the target");
  for (const row of patch.data)
    for (const cell of row) {
      if (
        !["string", "number", "boolean"].includes(typeof cell) ||
        (typeof cell === "number" && !Number.isFinite(cell))
      )
        throw new Error("Unsupported cell value");
      if (patch.kind === "formulas" && (typeof cell !== "string" || !cell.startsWith("=")))
        throw new Error("Formula patch requires invariant Excel formulas beginning with =");
      if (patch.kind === "values" && typeof cell === "string" && /^[=+\-@]/.test(cell))
        throw new Error(
          "Use a formula patch for a formula; formula-like text requires an explicit text operation",
        );
    }
}

export function createOfficeAdapter({ Office, Word, Excel, host }) {
  const instanceId = crypto.randomUUID();
  let documentId;
  const attempts = new Map();
  // Tracked native ranges preserve occurrence identity; never search for another identical quote.
  const wordAnchors = new Map();
  async function descriptor() {
    if (!documentId) {
      const settings = Office.context.document.settings;
      documentId = settings.get("specHarness.documentId");
      if (!documentId) {
        documentId = crypto.randomUUID();
        settings.set("specHarness.documentId", documentId);
        try {
          await new Promise((resolve, reject) =>
            settings.saveAsync((result) =>
              result.status === Office.AsyncResultStatus.Succeeded
                ? resolve()
                : reject(new Error("Document identity could not be saved")),
            ),
          );
        } catch (error) {
          settings.remove("specHarness.documentId");
          documentId = undefined;
          throw error;
        }
      }
    }
    const url = Office.context.document.url || "";
    return {
      host,
      documentId,
      documentInstanceId: instanceId,
      name: url
        ? decodeURIComponent(url.split(/[\\/]/).at(-1).split("?")[0])
        : host === "excel"
          ? "Несохранённая книга"
          : "Несохранённый документ",
      ...(url ? { url } : {}),
    };
  }
  function assertInstance(expected) {
    if (expected?.documentInstanceId !== instanceId)
      throw new Error("Document instance changed; capture the target again");
  }
  async function wordExecute(method, args) {
    const expected = args.expected;
    if (method === "applyEdit") assertInstance(expected);
    const target = expected?.target ?? args.target;
    const captured = target ? wordAnchors.get(target.anchorId) : undefined;
    if (target && !captured)
      throw new Error("Text anchor expired; capture the original fragment again");
    const batch = async (context) => {
      const range = captured ?? context.document.getSelection();
      range.load("text");
      await context.sync();
      if (!range.text.trim() || range.text.length > MAX_TEXT)
        throw new Error("Select between 1 and 20000 characters");
      let anchorId = target?.anchorId;
      if (!anchorId) {
        anchorId = crypto.randomUUID();
        range.track();
        await context.sync();
        wordAnchors.set(anchorId, range);
        if (wordAnchors.size > 100) {
          const [oldId, oldRange] = wordAnchors.entries().next().value;
          wordAnchors.delete(oldId);
          oldRange.untrack();
          await Word.run([oldRange], (oldContext) => oldContext.sync()).catch(() => {});
        }
      }
      const snapshot = boundedSnapshot({
        host,
        documentInstanceId: instanceId,
        target: { anchorId },
        data: { text: range.text },
      });
      if (method === "readSelection" || method === "readTarget") return snapshot;
      if (method === "locate") {
        range.select();
        await context.sync();
        return { status: "located" };
      }
      if (method !== "applyEdit") throw new Error("Unsupported Word operation");
      if (!sameOfficeData(expected.data, snapshot.data))
        return { status: "refused", reason: "Fragment changed since proposal" };
      const patch = args.patch;
      if (
        !["replaceText", "comment"].includes(patch.kind) ||
        typeof patch.text !== "string" ||
        patch.text.length > MAX_TEXT
      )
        throw new Error("Unsupported Word patch");
      if (!Office.context.requirements.isSetSupported("WordApi", "1.4"))
        throw new Error("WordApi 1.4 is required for reviewed changes and comments");
      const tables = range.tables;
      const parentTable = range.parentTableOrNullObject;
      const pictures = range.inlinePictures;
      tables.load("items");
      parentTable.load("isNullObject");
      pictures.load("items");
      range.load("text");
      await context.sync();
      if (
        patch.kind === "replaceText" &&
        (tables.items.length || !parentTable.isNullObject || pictures.items.length)
      )
        return {
          status: "refused",
          reason: "Plain text replacement does not support tables or pictures",
        };
      if (range.text !== expected.data.text)
        return { status: "refused", reason: "Fragment changed before apply" };
      if (patch.kind === "comment") {
        const comment = range.insertComment(patch.text);
        comment.load("id");
        await context.sync();
        return { status: "applied", commentId: comment.id };
      }
      context.document.load("changeTrackingMode");
      await context.sync();
      const priorMode = context.document.changeTrackingMode;
      let receipt;
      try {
        context.document.changeTrackingMode = "TrackAll";
        range.load("text");
        await context.sync();
        if (range.text !== expected.data.text)
          return { status: "refused", reason: "Fragment changed while enabling revisions" };
        const replaced = range.insertText(patch.text, "Replace");
        replaced.load("text");
        await context.sync();
        receipt = {
          status: replaced.text === patch.text ? "applied" : "partial",
          text: replaced.text,
        };
      } catch (error) {
        receipt = { status: "unknown", reason: error.message };
      } finally {
        try {
          context.document.load("changeTrackingMode");
          await context.sync();
          if (context.document.changeTrackingMode === "TrackAll" && priorMode !== "TrackAll") {
            context.document.changeTrackingMode = priorMode;
            await context.sync();
          }
        } catch (error) {
          if (receipt) receipt.trackingCleanupError = error.message;
        }
      }
      return receipt;
    };
    return captured ? Word.run([captured], batch) : Word.run(batch);
  }
  async function excelExecute(method, args) {
    return Excel.run(async (context) => {
      const expected = args.expected;
      if (method === "applyEdit") assertInstance(expected);
      const target = expected?.target ?? args.target;
      const range = target
        ? context.workbook.worksheets.getItem(target.sheetId).getRange(target.address)
        : context.workbook.getSelectedRange();
      range.load("address,cellCount,rowCount,columnCount");
      range.worksheet.load("id");
      await context.sync();
      if (range.cellCount < 1 || range.cellCount > MAX_CELLS)
        throw new Error("Select one contiguous range of at most 1000 cells");
      range.load("values,formulas,text");
      await context.sync();
      const snapshot = boundedSnapshot({
        host,
        documentInstanceId: instanceId,
        target: { sheetId: range.worksheet.id, address: range.address.split("!").at(-1) },
        data: { values: range.values, formulas: range.formulas, text: range.text },
        rows: range.rowCount,
        columns: range.columnCount,
      });
      if (method === "readSelection" || method === "readTarget") return snapshot;
      if (method === "locate") {
        range.worksheet.activate();
        range.select();
        await context.sync();
        return { status: "located" };
      }
      if (method !== "applyEdit") throw new Error("Unsupported Excel operation");
      if (!sameOfficeData(expected.data, snapshot.data))
        return { status: "refused", reason: "Range changed since proposal" };
      validateExcelPatch(args.patch, range.rowCount, range.columnCount);
      if (!Office.context.requirements.isSetSupported("ExcelApi", "1.13"))
        return {
          status: "refused",
          reason: "ExcelApi 1.13 is required to validate writable targets",
        };
      const merged = range.getMergedAreasOrNullObject();
      merged.load("isNullObject");
      range.worksheet.protection.load("protected");
      range.load("hasSpill,savedAsArray,values,formulas,text");
      await context.sync();
      if (
        !merged.isNullObject ||
        range.worksheet.protection.protected ||
        range.hasSpill !== false ||
        range.savedAsArray !== false
      )
        return {
          status: "refused",
          reason: "Merged, protected, array or spill ranges are not supported for writes",
        };
      if (
        !sameOfficeData(expected.data, {
          values: range.values,
          formulas: range.formulas,
          text: range.text,
        })
      )
        return { status: "refused", reason: "Range changed during target validation" };
      if (args.patch.kind === "values") range.values = args.patch.data;
      else range.formulas = args.patch.data;
      await context.sync();
      range.load(args.patch.kind);
      await context.sync();
      return {
        status: sameOfficeData(range[args.patch.kind], args.patch.data) ? "applied" : "partial",
        target: snapshot.target,
        data: range[args.patch.kind],
      };
    });
  }
  return {
    descriptor,
    async execute(method, args = {}) {
      if (method !== "readSelection" && method !== "applyEdit") assertInstance(args);
      if (method === "applyEdit") {
        if (!args.operationId || attempts.has(args.operationId))
          throw new Error("Operation already attempted or has no identity");
        attempts.set(args.operationId, "attempted");
      }
      return host === "excel" ? excelExecute(method, args) : wordExecute(method, args);
    },
  };
}
