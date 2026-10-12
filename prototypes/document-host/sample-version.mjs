// Upgrade only this add-in's package reference; never replace the sample document content.
import { readFile, rename } from "node:fs/promises";
export async function updateSampleVersion(AdmZip, file, manifest) {
  const original = new AdmZip(await readFile(file));
  const zip = new AdmZip();
  let changed = false;
  for (const entry of original.getEntries()) {
    zip.addFile(entry.entryName, entry.getData(), entry.comment, entry.attr);
    if (!/\/webextension\d*\.xml$/.test(entry.entryName)) continue;
    const text = entry.getData().toString("utf8");
    const updated = text.replace(
      /(<we:reference\s+id="([^"]+)"\s+version=")[^"]+(")/g,
      (all, prefix, id, suffix) => (id === manifest.id ? prefix + manifest.version + suffix : all),
    );
    if (updated !== text) {
      zip.updateFile(entry.entryName, Buffer.from(updated));
      changed = true;
    }
  }
  if (changed) {
    const temporary = file + ".new";
    await zip.writeZipPromise(temporary);
    await rename(temporary, file);
  }
}
