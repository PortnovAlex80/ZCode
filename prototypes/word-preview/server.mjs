import { createRequire } from "node:module";
import { createServer } from "node:https";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const toolRoot = path.join(process.env.LOCALAPPDATA, "SpecHarness", "word-preview-tools");
const require = createRequire(path.join(toolRoot, "package.json"));
const { getHttpsServerOptions } = require("office-addin-dev-certs");
const files = new Map([
  ["/", ["../document-host/index.html", "text/html"]],
  ["/bootstrap.js", ["../document-host/office-bootstrap.js", "text/javascript"]],
  ["/pane.js", ["../document-host/pane.js", "text/javascript"]],
  ["/interactions.js", ["../document-host/interactions.js", "text/javascript"]],
  ["/pane.css", ["../document-host/pane.css", "text/css"]],
  ["/office-adapter.js", ["../document-host/office-adapter.js", "text/javascript"]],
  ["/demo", ["index.html", "text/html"]],
  ["/panel.css", ["panel.css", "text/css"]],
  ["/panel.js", ["panel.js", "text/javascript"]],
  ["/model.js", ["model.js", "text/javascript"]],
  ["/commands.js", ["commands.js", "text/javascript"]],
  ["/excel-selection.js", ["excel-selection.js", "text/javascript"]],
  ["/icon.png", ["../../packages/desktop/build/icon.png", "image/png"]],
]);
export async function startPreviewServer({ port = 43481, host = "Word" } = {}) {
  const tls = await getHttpsServerOptions();
  let wordReady = false;
  return createServer(tls, async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (request.url === "/ready" && request.method === "POST") {
      wordReady = true;
      request.resume();
      response.writeHead(204).end();
      return;
    }
    if (request.url === "/health" && request.method === "GET") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ preview: true, documentHostVersion: 2, host, wordReady }));
      return;
    }
    const pathname = new URL(request.url, "https://localhost:43481").pathname;
    const file =
      pathname === "/client.js"
        ? [
            path.join(
              process.env.LOCALAPPDATA,
              "SpecHarness",
              "document-host",
              "assets",
              "client.js",
            ),
            "text/javascript",
          ]
        : files.get(pathname);
    if (!file || request.method !== "GET") {
      response.writeHead(404).end();
      return;
    }
    try {
      let bytes = await readFile(path.resolve(here, file[0]));
      if (file[0] === "../document-host/index.html")
        bytes = Buffer.from(
          bytes
            .toString()
            .replace(
              "<!--HOST_SCRIPT-->",
              '<script src="https://appsforoffice.microsoft.com/lib/1/hosted/office.js"></script>',
            ),
        );
      if (host === "Excel" && file[0] === "index.html")
        bytes = Buffer.from(bytes.toString().replaceAll("Word", "Excel"));
      response.writeHead(200, { "Content-Type": `${file[1]}; charset=utf-8` });
      response.end(bytes);
    } catch {
      response.writeHead(500).end("Preview asset unavailable");
    }
  }).listen(port, "127.0.0.1", () => console.info(`${host} preview: https://localhost:${port}`));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--certificates-only")) await getHttpsServerOptions();
  else await startPreviewServer();
}
