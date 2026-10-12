import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSpawnRuntimeOptions } from "./spawn-command.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktop = join(root, "packages/desktop");
const manifestPath = join(desktop, "out/spec-harness-production.json");
const outputs = ["main/index.js", "host/index.js", "preload/index.cjs", "renderer/index.html"];

export async function outputHashes(directory = root) {
  const hashes = {};
  const outputRoot = join(directory, "packages/desktop/out");
  async function visit(relative) {
    for (const entry of (await readdir(join(outputRoot, relative), { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const file = join(relative, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Unexpected linked build output: ${file}`);
      if (entry.isDirectory()) await visit(file);
      else
        hashes[file.replaceAll("\\", "/")] = createHash("sha256")
          .update(await readFile(join(outputRoot, file)))
          .digest("hex");
    }
  }
  for (const part of ["main", "host", "preload", "renderer", "plugin-sandbox", "metadata"])
    await visit(part);
  for (const entry of outputs)
    if (!hashes[entry]) throw new Error(`Missing production output: ${entry}`);
  return hashes;
}

export function productionEnvironment(base) {
  const env = { ...base, NODE_ENV: "production", ZCODE_SPEC_HARNESS_WINDOWS: "1" };
  // 开发服务器地址会覆盖 loadFile；生产启动只读取本次构建的 renderer。
  delete env.ELECTRON_RENDERER_URL;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ZCODE_SPEC_HARNESS_ICON_PATH;
  return env;
}

export async function sourceFingerprint(directory = root) {
  const hash = createHash("sha256");
  async function visit(relative) {
    const absolute = join(directory, relative);
    const info = await stat(absolute);
    if (info.isDirectory()) {
      for (const entry of (await readdir(absolute)).sort()) {
        if (["node_modules", "out", "dist", ".git"].includes(entry)) continue;
        await visit(join(relative, entry));
      }
    } else {
      hash.update(relative.replaceAll("\\", "/"));
      hash.update(await readFile(absolute));
    }
  }
  for (const relative of [
    "packages",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "scripts/build-time-config.mjs",
    "scripts/spec-harness-production.mjs",
    "apps/zcode-cli/packages/visualize-plugin/skills/visualize/assets",
  ]) {
    await visit(relative);
  }
  return hash.digest("hex");
}

export async function validateProductionBuild({ directory = root, manifest = manifestPath } = {}) {
  const receipt = JSON.parse(await readFile(manifest, "utf8"));
  if (receipt.version !== 1 || receipt.source !== (await sourceFingerprint(directory))) {
    throw new Error("Production build is stale. Run Build-Harness.cmd first.");
  }
  if (JSON.stringify(await outputHashes(directory)) !== JSON.stringify(receipt.outputs))
    throw new Error("Production output tree changed. Rebuild before starting.");
  return receipt;
}

function run(command, args, cwd, env) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: "inherit",
      ...resolveSpawnRuntimeOptions(command),
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolveRun() : reject(new Error(`${command} exited with ${code}`)),
    );
  });
}

async function build() {
  const env = productionEnvironment(process.env);
  const before = await sourceFingerprint();
  // Only compile this checkout; no dev watcher, Host, Electron or application profile is started.
  await run("pnpm", ["--filter", "@zcode/desktop", "build:no-runtime-assets"], root, env);
  const after = await sourceFingerprint();
  if (before !== after) throw new Error("Sources changed during build; rebuild a stable checkout.");
  const hashes = await outputHashes();
  await writeFile(
    manifestPath,
    JSON.stringify({ version: 1, source: after, outputs: hashes }, null, 2) + "\n",
  );
}

async function start() {
  await validateProductionBuild();
  const executable = (await import("electron")).default;
  await run(executable, [desktop], desktop, productionEnvironment(process.env));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  if (command === "build") await build();
  else if (command === "start") await start();
  else throw new Error("Usage: node scripts/spec-harness-production.mjs <build|start>");
}
