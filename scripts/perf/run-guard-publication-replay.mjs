// Isolated React/jsdom CPU replay. Measures guard subscription + React publication,
// not document rendering, layout, Electron latency, or actual model traffic.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import vm from "node:vm";
import ts from "typescript";
import { JSDOM } from "jsdom";
import React from "react";
import { createRoot } from "react-dom/client";

const sourcePath = "packages/ui/src/spec-document/useSpecDiscussion.ts";
const baselineRef = process.argv[2] ?? "c3a256c0";
const baseline = execFileSync("git", ["show", `${baselineRef}:${sourcePath}`], {
  encoding: "utf8",
});
const candidate = readFileSync(sourcePath, "utf8");
const dom = new JSDOM("<!doctype html><body></body>");
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function loadHook(source, layer) {
  const ast = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true);
  const functions = ast.statements.filter(
    (node) =>
      ts.isFunctionDeclaration(node) &&
      ["nativeSessionHasWriters", "useSpecWriteGuard"].includes(node.name?.text),
  );
  if (functions.length !== 2) throw new Error("Guard source boundary changed");
  const js = ts.transpileModule(functions.map((node) => node.getText(ast)).join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports = {};
  vm.runInNewContext(js, {
    exports,
    useEffect: React.useEffect,
    useState: React.useState,
    useV4Conversation: () => ({ layer }),
  });
  return exports.useSpecWriteGuard;
}

function run(source) {
  const listeners = new Set();
  const state = {
    status: "live",
    snapshot: {
      control: { activeWorks: [], phase: "running", stopState: "none" },
      queue: { items: [] },
      backgroundWorks: [],
    },
    optimisticCommands: [],
  };
  const layer = {
    acquire(sessionId) {
      return {
        sessionId,
        store: {
          getState: () => state,
          subscribe(fn) {
            listeners.add(fn);
            return () => listeners.delete(fn);
          },
        },
        release() {},
      };
    },
  };
  const hook = loadHook(source, layer);
  let renders = 0;
  function Owner() {
    renders++;
    const guard = hook(["project", "discussion-a", "discussion-b"]);
    return React.createElement("div", null, String(guard.blocked));
  }
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  React.act(() => root.render(React.createElement(Owner)));
  const tick = () => React.act(() => listeners.forEach((listener) => listener()));
  for (let i = 0; i < 30; i++) tick();
  const beforeRenders = renders;
  const startCpu = process.cpuUsage();
  const start = performance.now();
  for (let i = 0; i < 1000; i++) tick();
  const elapsedMs = performance.now() - start;
  const cpu = process.cpuUsage(startCpu);
  const ownerRenders = renders - beforeRenders;
  React.act(() => root.unmount());
  node.remove();
  if (listeners.size) throw new Error("Leaked guard subscriptions");
  return {
    elapsedMs: +elapsedMs.toFixed(2),
    cpuMs: +((cpu.user + cpu.system) / 1000).toFixed(2),
    ownerRenders,
  };
}

const trials = [];
for (let trial = 0; trial < 3; trial++) {
  const order = trial % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"];
  const result = { trial: trial + 1, order };
  for (const label of order) result[label] = run(label === "baseline" ? baseline : candidate);
  trials.push(result);
}
console.log(
  JSON.stringify(
    {
      node: process.version,
      baselineRef,
      sessions: 3,
      frames: 1000,
      warmupFrames: 30,
      boundary: "guard subscription plus minimal React owner, jsdom; no GUI latency",
      trials,
    },
    null,
    2,
  ),
);
dom.window.close();
