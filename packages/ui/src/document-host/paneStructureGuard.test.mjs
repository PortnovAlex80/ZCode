import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// T-07 结构守卫（DOCUMENT-HOSTS.md:70「Полный React Root/SessionPane не монтируется:
// дополнительные workers не создаются」）：以 node --test 静态遍历 pane.js 与两个 SDK
// 入口（office-bootstrap.js / autocad-preview bootstrap.js）的静态 import 闭包，
// 禁止桌面 Root/SessionPane/DiffsWorkerPool 与任何 worker-spawn 语法进入该闭包，
// 使 compact 表面保持唯一渲染路径。放在 packages/ui/src/document-host/ 是因为
// prototypes/document-host/ 下本 wave 只有 pane.js/pane.test.mjs 可写（独占表）。
// "./client.js" 只存在于部署产物；按 Build-Document-Pane.ps1 的 esbuild 打包源
// （packages/ui/src/document-host/client.ts）继续走 TS 源码图。
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../../..");
const paneDir = path.resolve(repo, "prototypes/document-host");
const pkgExports = (pkg) => JSON.parse(fs.readFileSync(path.join(repo, pkg), "utf8")).exports;
const sharedExports = pkgExports("packages/shared/package.json");
const uiExports = pkgExports("packages/ui/package.json");
const firstExisting = (base) =>
  [
    ...(base.endsWith(".js") ? [`${base.slice(0, -3)}.ts`, `${base.slice(0, -3)}.tsx`] : []),
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.mjs`,
    path.join(base, "index.ts"),
  ].find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
const resolveSpec = (spec, from) => {
  if (spec === "./client.js" && from.startsWith(paneDir))
    return path.resolve(repo, "packages/ui/src/document-host/client.ts");
  if (spec.startsWith("@zcode/shared") || spec.startsWith("@zcode/ui")) {
    const shared = spec.startsWith("@zcode/shared");
    const exports = shared ? sharedExports : uiExports;
    const sub = spec === (shared ? "@zcode/shared" : "@zcode/ui") ? "." : "." + spec.split("/").slice(2).join("/");
    const target = exports[sub];
    return target ? path.resolve(repo, shared ? "packages/shared" : "packages/ui", target) : null;
  }
  if (spec.startsWith("@/")) return firstExisting(path.resolve(repo, "packages/ui/src", spec.slice(2)));
  if (spec.startsWith(".")) return firstExisting(path.resolve(path.dirname(from), spec));
  return null; // 外部裸包（react 等）不在本守卫遍历范围。
};
// 禁止清单：桌面渲染/挂载表面与 spawn worker 的模块。packages/ui/src/index.ts 是
// 导出 Root 的桌面 barrel，replay.ts re-export DiffsWorkerPoolProvider，
// workspaceFileSearchFilterBackend 是仓库里另一个 new Worker 站点。
const forbidden = new Set(
  [
    "packages/ui/src/index.ts",
    "packages/ui/src/Root.tsx",
    "packages/ui/src/App.tsx",
    "packages/ui/src/v4/SessionPane.tsx",
    "packages/ui/src/root/DiffsWorkerPoolProvider.tsx",
    "packages/ui/src/root/lazyDiffsWorkerPool.ts",
    "packages/ui/src/replay.ts",
    "packages/ui/src/workspace-file-search/workspaceFileSearchFilterBackend.ts",
  ].map((p) => path.resolve(repo, p)),
);
const importPattern =
  /\b(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']/g;

test("the pane and its SDK entries never reference desktop Root/SessionPane or worker-spawning modules", () => {
  const walked = new Set();
  const queue = [
    path.join(paneDir, "pane.js"),
    path.join(paneDir, "office-bootstrap.js"),
    path.resolve(repo, "prototypes/autocad-preview/bootstrap.js"),
  ];
  while (queue.length) {
    const file = path.resolve(queue.shift());
    if (walked.has(file)) continue;
    const source = fs.readFileSync(file, "utf8");
    walked.add(file);
    assert.doesNotMatch(source, /\bnew\s+(?:Shared)?Worker\s*\(/, `${file} spawns a worker`);
    for (const match of source.matchAll(importPattern)) {
      const spec = match[1] || match[2] || match[3];
      const resolved = spec ? resolveSpec(spec, file) : null;
      if (!resolved) continue;
      assert.ok(!forbidden.has(resolved), `${file} references desktop surface module ${resolved}`);
      queue.push(resolved);
    }
  }
  // 反空转：解析器必须真的走到引擎侧已知模块，避免“遍历为空即通过”的假绿。
  for (const must of [
    "packages/ui/src/document-host/client.ts",
    "packages/ui/src/v4/agentConversationTransport.ts",
    "packages/ui/src/v4/sessionDataLayer.ts",
    "packages/ui/src/v4/conversationProjectionStore.ts",
    "packages/ui/src/lib/elicitationResponse.ts",
  ])
    assert.ok(walked.has(path.resolve(repo, must)), `structural walk lost ${must}`);
  for (const compact of ["pane.js", "interactions.js"])
    assert.doesNotMatch(
      fs.readFileSync(path.join(paneDir, compact), "utf8"),
      /from\s*["']react(?:-dom)?["']/,
      `${compact} must stay the vanilla compact render surface`,
    );
});
