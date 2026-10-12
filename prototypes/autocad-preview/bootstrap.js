import { mountDocumentPane } from "./pane.js";
const pending = new Map();
const adapter = {
  descriptor: () => native("descriptor", {}),
  execute: (method, args) => native(method, args),
};
function native(method, args) {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("Native result unknown; do not repeat a write")); }, 24000);
    pending.set(id, { resolve, reject, timer });
    window.chrome.webview.postMessage({ id, method, args });
  });
}
window.chrome.webview.addEventListener("message", (event) => {
  const message = event.data;
  if (message.event === "documentChanged") { location.reload(); return; }
  const request = pending.get(message.id); if (!request) return;
  clearTimeout(request.timer); pending.delete(message.id);
  if (message.error) request.reject(new Error(message.error)); else request.resolve(message.result);
});
await mountDocumentPane(adapter, "AutoCAD");
