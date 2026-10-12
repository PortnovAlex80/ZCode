import { createRequire } from "node:module";
import { createServer } from "node:https";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const toolRoot = path.join(process.env.LOCALAPPDATA, "SpecHarness", "word-preview-tools");
const require = createRequire(path.join(toolRoot, "package.json"));
const { getHttpsServerOptions } = require("office-addin-dev-certs");
const tls = await getHttpsServerOptions();
if (process.argv.includes("--certificates-only")) process.exit(0);
let wordReady = false;
const files = new Map([
  ["/", ["index.html", "text/html"]],
  ["/panel.css", ["panel.css", "text/css"]],
  ["/panel.js", ["panel.js", "text/javascript"]],
  ["/model.js", ["model.js", "text/javascript"]],
  ["/icon.png", ["../../packages/desktop/build/icon.png", "image/png"]],
]);
createServer(tls, async (request, response) => {
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
    response.end(JSON.stringify({ preview: true, wordReady }));
    return;
  }
  const file = files.get(new URL(request.url, "https://localhost:43481").pathname);
  if (!file || request.method !== "GET") {
    response.writeHead(404).end();
    return;
  }
  try {
    const bytes = await readFile(path.resolve(here, file[0]));
    response.writeHead(200, { "Content-Type": `${file[1]}; charset=utf-8` });
    response.end(bytes);
  } catch {
    response.writeHead(500).end("Preview asset unavailable");
  }
}).listen(43481, "127.0.0.1", () => console.info("Word preview: https://localhost:43481"));
