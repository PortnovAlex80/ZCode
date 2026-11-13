import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { build } from "esbuild";
import { REMOTE_SERVER_NATIVE_EXTERNALS } from "../../server/buildRemoteValidation.js";
import {
  keyringPlatformPackage,
  stageCredentialKeyring,
} from "../../../scripts/stage-credential-keyring.mjs";
import {
  resolveAgentBundleExtraResources,
  verifyPackagedAgentKeyring,
} from "../scripts/agent-bundle-assets.mjs";

test("remote CJS build preserves the native keyring dependency without bundling platform binaries", async () => {
  const result = await build({
    stdin: {
      contents: 'export const open = () => import("@napi-rs/keyring");',
      resolveDir: join(import.meta.dirname, ".."),
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    metafile: true,
    external: REMOTE_SERVER_NATIVE_EXTERNALS,
  });
  assert.match(result.outputFiles[0]!.text, /@napi-rs\/keyring/);
  assert.equal(
    Object.keys(result.metafile!.inputs).some((name) => name.endsWith(".node")),
    false,
  );
});

test("keyring platform selection covers supported desktop architectures", () => {
  for (const arch of ["x64", "arm64"]) {
    assert.equal(keyringPlatformPackage(`darwin-${arch}`), `@napi-rs/keyring-darwin-${arch}`);
    assert.equal(keyringPlatformPackage(`win32-${arch}`), `@napi-rs/keyring-win32-${arch}-msvc`);
    assert.equal(keyringPlatformPackage(`linux-${arch}`), `@napi-rs/keyring-linux-${arch}-gnu`);
  }
  assert.throws(() => keyringPlatformPackage("unknown-x64"));
});

test("packaged agent maps node_modules separately so electron-builder keeps the keyring", () => {
  const [agentTree, agentNodeModules] = resolveAgentBundleExtraResources("win32-x64");
  assert.equal(agentTree!.from, "bundled-agents/win32-x64/glm");
  assert.equal(agentTree!.to, "glm");
  assert.deepEqual(agentTree!.filter, ["**/*", "!**/*.map", "!node_modules{,/**/*}"]);
  assert.equal(agentNodeModules!.from, "bundled-agents/win32-x64/glm/node_modules");
  assert.equal(agentNodeModules!.to, "glm/node_modules");
});

test("packaged agent keyring verification detects a dropped native package", async () => {
  const dir = await mkdtemp(join(tmpdir(), "keyring-packaged-"));
  try {
    const resourcesDir = join(dir, "resources");
    const nativeName = keyringPlatformPackage("win32-x64");
    const nativeRoot = join(resourcesDir, "glm", "node_modules", nativeName);
    for (const root of [
      join(resourcesDir, "glm", "node_modules", "@napi-rs/keyring"),
      nativeRoot,
    ]) {
      await mkdir(root, { recursive: true });
      await writeFile(join(root, "package.json"), JSON.stringify({ name: "fixture" }));
    }
    await writeFile(join(nativeRoot, "keyring.win32-x64-msvc.node"), "fixture-native");
    assert.deepEqual(verifyPackagedAgentKeyring({ resourcesDir, platformKey: "win32-x64" }), []);

    await rm(nativeRoot, { recursive: true, force: true });
    const problems = verifyPackagedAgentKeyring({ resourcesDir, platformKey: "win32-x64" });
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /win32-x64-msvc/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stages wrapper and target binary with licenses, omitting other platform binaries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "keyring-assets-"));
  try {
    const packageName = keyringPlatformPackage("linux-arm64");
    for (const name of ["@napi-rs/keyring", packageName, "@napi-rs/keyring-win32-x64-msvc"]) {
      const root = join(dir, "source", "node_modules", name);
      await mkdir(root, { recursive: true });
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({
          name,
          main: name === packageName ? "keyring.linux-arm64-gnu.node" : "index.js",
        }),
      );
      await writeFile(join(root, "index.js"), "module.exports = {}");
      await writeFile(join(root, "LICENSE"), "fixture-license");
    }
    await writeFile(
      join(dir, "source/node_modules", packageName, "keyring.linux-arm64-gnu.node"),
      "fixture-native",
    );
    await stageCredentialKeyring({
      sourceRoot: join(dir, "source"),
      targetRoot: join(dir, "output"),
      platformKey: "linux-arm64",
    });
    assert.equal(
      await readFile(join(dir, "output/node_modules", packageName, "LICENSE"), "utf8"),
      "fixture-license",
    );
    await assert.rejects(
      readFile(join(dir, "output/node_modules/@napi-rs/keyring-win32-x64-msvc/package.json")),
      { code: "ENOENT" },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
