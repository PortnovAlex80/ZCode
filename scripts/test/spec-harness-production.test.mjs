import assert from "node:assert/strict";
import { test } from "node:test";
import {
  productionEnvironment,
  outputHashes,
  sourceFingerprint,
  validateProductionBuild,
} from "../spec-harness-production.mjs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("receipt refuses altered lazy chunks and changed sources before launch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-build-receipt-"));
  try {
    const out = join(directory, "packages/desktop/out");
    for (const part of ["main", "host", "preload", "renderer", "plugin-sandbox", "metadata"]) {
      await mkdir(join(out, part), { recursive: true });
      await writeFile(
        join(
          out,
          part,
          part === "renderer" ? "index.html" : part === "preload" ? "index.cjs" : "index.js",
        ),
        "built",
      );
    }
    await mkdir(join(directory, "scripts"));
    await mkdir(
      join(directory, "apps/zcode-cli/packages/visualize-plugin/skills/visualize/assets"),
      { recursive: true },
    );
    for (const file of [
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "scripts/build-time-config.mjs",
      "scripts/spec-harness-production.mjs",
      "scripts/build-desktop-agent-cli.mjs",
    ]) {
      await writeFile(join(directory, file), "source");
    }
    const lazy = join(out, "renderer/lazy.js");
    await writeFile(lazy, "original");
    const manifest = join(out, "receipt.json");
    await writeFile(
      manifest,
      JSON.stringify({
        version: 1,
        source: await sourceFingerprint(directory),
        outputs: await outputHashes(directory),
      }),
    );
    await validateProductionBuild({ directory, manifest });
    const authSource = join(directory, "apps/zcode-cli/auth.ts");
    await writeFile(authSource, "changed authentication runtime");
    await assert.rejects(validateProductionBuild({ directory, manifest }), /stale/);
    await rm(authSource);
    await validateProductionBuild({ directory, manifest });
    await writeFile(lazy, "altered");
    await assert.rejects(validateProductionBuild({ directory, manifest }), /output tree changed/);
    await writeFile(lazy, "original");
    await rm(lazy);
    await assert.rejects(validateProductionBuild({ directory, manifest }), /output tree changed/);
    await writeFile(lazy, "original");
    await writeFile(join(directory, "package.json"), "changed source");
    await assert.rejects(validateProductionBuild({ directory, manifest }), /stale/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("production launch removes development overrides without rewriting profile selection", () => {
  const base = {
    ELECTRON_RENDERER_URL: "http://localhost:5173",
    ELECTRON_RUN_AS_NODE: "1",
    ZCODE_SPEC_HARNESS_ICON_PATH: "custom.ico",
    ZCODE_DATA_BASE_DIR: "existing-data",
    HOME: "existing-home",
  };
  const env = productionEnvironment(base);
  assert.equal(env.NODE_ENV, "production");
  assert.equal(env.ZCODE_SPEC_HARNESS_WINDOWS, "1");
  assert.equal(env.ZCODE_DATA_BASE_DIR, "existing-data");
  assert.equal(env.HOME, "existing-home");
  for (const field of [
    "ELECTRON_RENDERER_URL",
    "ELECTRON_RUN_AS_NODE",
    "ZCODE_SPEC_HARNESS_ICON_PATH",
  ]) {
    assert.equal(field in env, false);
    assert.equal(field in base, true);
  }
});
