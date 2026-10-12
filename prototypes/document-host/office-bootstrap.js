import { createOfficeAdapter } from "./office-adapter.js";
import { mountDocumentPane } from "./pane.js";
import { selectionCommand } from "./commands.js";

Office.onReady(async (info) => {
  const host = info.host === Office.HostType.Excel ? "excel" : "word";
  try {
    await mountDocumentPane(
      createOfficeAdapter({ Office, Word: globalThis.Word, Excel: globalThis.Excel, host }),
      host === "excel" ? "Excel" : "Word",
      (read, report) => {
        Office.actions.associate(
          "addSelection",
          selectionCommand(read, () => Office.addin.showAsTaskpane(), report, "add"),
        );
        Office.actions.associate(
          "discussSelection",
          selectionCommand(read, () => Office.addin.showAsTaskpane(), report, "discuss"),
        );
      },
    );
    const color = Office.context.officeTheme?.bodyBackgroundColor;
    if (/^#[0-9a-f]{6}$/i.test(color ?? "")) {
      const channels = [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16));
      document.documentElement.classList.toggle(
        "dark",
        channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722 < 128,
      );
    }
    await fetch("/ready", { method: "POST" });
  } catch (error) {
    document.getElementById("status").textContent = error.message;
  }
});
