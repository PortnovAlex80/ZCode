import assert from "node:assert/strict";
import { excelNativeScript, wordNativeScript } from "./office-native-host-checks.mjs";
import { paneFixtureScript, paneNarrowLayoutScript } from "./office-native-pane-checks.mjs";

// Full per-host expectation: word 14 native + 16 pane, excel 17 native + 16 pane.
// A skipped check (for example the desktop-only comment verification on an older
// Word build) is surfaced by name and still counts against the expectation.
const EXPECTED = { word: 30, excel: 33, both: 63 };

async function target(port) {
  for (let attempt = 0; attempt < 240; attempt++) {
    try {
      for (const debugPort of [43482, 43484]) {
        try {
          const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
          const pane = list.find((item) => item.url.startsWith(`https://localhost:${port}/`));
          if (pane) return pane;
        } catch {
          /* Office may share a WebView process between the fixture hosts. */
        }
      }
    } catch {
      /* Only the isolated Office fixture is allowed to start this debug endpoint. */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Office fixture pane not available on ${port}`);
}
async function connect(pane) {
  const socket = new WebSocket(pane.webSocketDebuggerUrl);
  const pending = new Map();
  let sequence = 0;
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const job = pending.get(message.id);
    if (!job) return;
    pending.delete(message.id);
    clearTimeout(job.timer);
    if (message.error) job.reject(new Error(message.error.message));
    else job.resolve(message.result);
  });
  const request = (payload, timeout, label) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(label));
      }, timeout);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, ...payload }));
    });
  return {
    close: () => socket.close(),
    send: (method, params = {}) =>
      request({ method, params }, 25_000, "Office CDP command timed out"),
    evaluate: (expression) =>
      request(
        { method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } },
        120_000,
        "Office evaluation timed out",
      ).then((result) => {
        if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
        return result.result.value;
      }),
  };
}
async function waitUntilReady(connection, host) {
  for (let attempt = 0; attempt < 240; attempt++) {
    const ready = await connection.evaluate(
      "typeof Office !== 'undefined' && Boolean(document.getElementById('title')?.textContent.startsWith('ZCODE'))",
    );
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Office fixture panel did not initialize for ${host}`);
}
// O-04 compact-layout half: emulate a narrow task-pane viewport and verify the pane
// neither overflows horizontally nor hides the composer; the shared media query wraps
// the model row. The override applies only to this fixture WebView and is cleared.
async function narrowLayoutCheck(connection) {
  await connection.send("Emulation.setDeviceMetricsOverride", {
    width: 320,
    height: 780,
    deviceScaleFactor: 0,
    mobile: false,
  });
  try {
    const layout = await connection.evaluate(paneNarrowLayoutScript());
    if (layout.overflow > 1 || !layout.wrapped || !layout.composerReachable)
      throw new Error(`Narrow pane layout broken: ${JSON.stringify(layout)}`);
    return 1;
  } finally {
    await connection.send("Emulation.clearDeviceMetricsOverride");
  }
}

let total = 0;
const skippedAll = [];
for (const [port, host, nativeScript] of [
  [43481, "word", wordNativeScript()],
  [43483, "excel", excelNativeScript()],
].filter(([, host]) => !process.argv[2] || process.argv[2] === "both" || process.argv[2] === host)) {
  const connection = await connect(await target(port));
  try {
    await waitUntilReady(connection, host);
    const native = await connection.evaluate(nativeScript);
    const pane = await connection.evaluate(paneFixtureScript(host));
    const layout = await narrowLayoutCheck(connection);
    total += native.checks + pane.checks + layout;
    skippedAll.push(...native.skipped, ...pane.skipped);
    console.info(
      `${host}: ${native.checks} native Office API + ${pane.checks + layout} shared pane fixture checks passed`,
    );
  } finally {
    connection.close();
  }
}
const scope = ["word", "excel"].includes(process.argv[2]) ? process.argv[2] : "both";
assert.ok(total + skippedAll.length >= EXPECTED[scope]);
if (skippedAll.length) console.info(`Skipped (reported, not passed): ${skippedAll.join(", ")}`);
console.info(`Office native acceptance: ${total} checks, no ZCODE or model connected`);
