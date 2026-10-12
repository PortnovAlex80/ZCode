import { createRequire } from "node:module";
import { mkdir, readFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(process.env.LOCALAPPDATA, "SpecHarness");
const require = createRequire(path.join(root, "word-preview-tools", "package.json"));
const { OfficeAddinManifest, OfficeApp } = require("office-addin-manifest");
const { registerAddIn, setWebView, WebViewType } = require("office-addin-dev-settings");
const { generateSideloadFile } = require("office-addin-dev-settings/lib/sideload");
const AdmZip = require("adm-zip");
const manifestPath = path.join(here, "manifest.xml");
const manifest = await OfficeAddinManifest.readManifestFile(manifestPath);
await registerAddIn(manifestPath);
await setWebView(manifest.id, WebViewType.EdgeChromium);
const outputDir = path.join(root, "excel-preview");
await mkdir(outputDir, { recursive: true });
const output = path.join(outputDir, "Excel-Preview.xlsx");
let exists = false;
try {
  await access(output);
  exists = true;
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
if (exists) {
  console.info(output);
  process.exit(0);
}
const generated = await generateSideloadFile(OfficeApp.Excel, manifest);
const template = new AdmZip(await readFile(generated));
const zip = new AdmZip();
for (const entry of template.getEntries())
  zip.addFile(entry.entryName, entry.getData(), entry.comment, entry.attr);
const rows = [
  ["Товар", "Количество", "Цена", "Сумма"],
  ["Книги", 3, 500, { formula: "B2*C2", value: 1500 }],
  ["Блокноты", 4, 200, { formula: "B3*C3", value: 800 }],
  ["Итого", "", "", { formula: "SUM(D2:D3)", value: 2300 }],
  ["Выберите A1:D4 → ПКМ → ZCODE → Обсудить отдельно"],
  ["Локальный UI-прототип: модель, транспорт и макросы отключены."],
];
const escape = (value) =>
  String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const rowXml = rows
  .map(
    (row, i) =>
      `<row r="${i + 1}">${row
        .map((value, c) => {
          const address = `${String.fromCharCode(65 + c)}${i + 1}`;
          if (typeof value === "number") return `<c r="${address}"><v>${value}</v></c>`;
          if (typeof value === "object")
            return `<c r="${address}"><f>${escape(value.formula)}</f><v>${value.value}</v></c>`;
          return `<c r="${address}" t="inlineStr"><is><t>${escape(value)}</t></is></c>`;
        })
        .join("")}</row>`,
  )
  .join("");
zip.updateFile(
  "xl/worksheets/sheet.xml",
  Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:D6"/><sheetViews><sheetView workbookViewId="0"><selection activeCell="A1" sqref="A1:D4"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="22"/><cols><col min="1" max="1" width="28" customWidth="1"/><col min="2" max="4" width="18" customWidth="1"/></cols><sheetData>${rowXml}</sheetData></worksheet>`,
  ),
);
await zip.writeZipPromise(output);
console.info(output);
