import { createRequire } from "node:module";
import { mkdir, readFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(process.env.LOCALAPPDATA, "SpecHarness");
const require = createRequire(path.join(root, "word-preview-tools", "package.json"));
const { OfficeAddinManifest, OfficeApp } = require("office-addin-manifest");
const { registerAddIn } = require("office-addin-dev-settings");
const { generateSideloadFile } = require("office-addin-dev-settings/lib/sideload");
const AdmZip = require("adm-zip");
const manifestPath = path.join(here, "manifest.xml");
const manifest = await OfficeAddinManifest.readManifestFile(manifestPath);
await registerAddIn(manifestPath);
const outputDir = path.join(root, "word-preview");
await mkdir(outputDir, { recursive: true });
const output = path.join(outputDir, "Word-Preview.docx");
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
const generated = await generateSideloadFile(OfficeApp.Word, manifest);
const template = new AdmZip(await readFile(generated));
const zip = new AdmZip();
for (const entry of template.getEntries()) {
  zip.addFile(entry.entryName, entry.getData(), entry.comment, entry.attr);
}
const paragraphs = [
  "Spec Harness — документ в Word",
  "Локальный прототип встроенной панели",
  "Выделите этот абзац в Word, нажмите «Взять из Word» в панели справа, затем «Обсудить отдельно». Обсуждение будет связано с выделенным фрагментом.",
  "Общий разговор о документе и независимые обсуждения имеют разные истории. Интерфейс располагается внутри Word и не требует открытия отдельного окна ZCODE.",
  "В этом прототипе отправка показывает только демонстрационный ответ. Модель не вызывается, документ не изменяется, подключение к ZCODE отсутствует.",
  "Требования: панель читает выделение; обсуждения можно переключать и удалять; исходный документ остаётся под контролем автора.",
];
const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.map((text, i) => `<w:p><w:pPr>${i === 0 ? '<w:pStyle w:val="Title"/>' : ""}</w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`).join("")}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`;
zip.updateFile("word/document.xml", Buffer.from(xml));
await zip.writeZipPromise(output);
console.info(output);
