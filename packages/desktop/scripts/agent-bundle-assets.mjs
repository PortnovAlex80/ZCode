// Packaging contract for the bundled agent (resources/glm).
//
// The agent needs @napi-rs/keyring next to its JS bundle to decrypt enc:v2:os:
// credentials. electron-builder drops the root node_modules of any copied
// directory before filters run (app-builder-lib/out/util/filter.js), so the tree
// and its node_modules must be mapped as two separate extraResources entries —
// the same workaround already used for the Windows CUA helper.
import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { keyringPlatformPackage } from "../../../scripts/stage-credential-keyring.mjs";

export function resolveAgentBundleExtraResources(platformKey) {
  return [
    {
      from: `bundled-agents/${platformKey}/glm`,
      to: "glm",
      filter: ["**/*", "!**/*.map", "!node_modules{,/**/*}"],
    },
    {
      from: `bundled-agents/${platformKey}/glm/node_modules`,
      to: "glm/node_modules",
      filter: ["**/*", "!**/*.map"],
    },
  ];
}

function hasNativeBinary(dir) {
  if (!existsSync(dir)) return false;
  return readdirSync(dir).some((name) => {
    if (!name.endsWith(".node")) return false;
    return statSync(resolve(dir, name)).size > 0;
  });
}

export function verifyPackagedAgentKeyring({ resourcesDir, platformKey }) {
  const nativeName = keyringPlatformPackage(platformKey);
  const nodeModulesRoot = resolve(resourcesDir, "glm", "node_modules");
  const wrapperRoot = resolve(nodeModulesRoot, "@napi-rs", "keyring");
  const nativeRoot = resolve(nodeModulesRoot, nativeName);
  const problems = [];
  if (!existsSync(resolve(wrapperRoot, "package.json"))) {
    problems.push(`missing @napi-rs/keyring wrapper at ${wrapperRoot}`);
  }
  if (!existsSync(resolve(nativeRoot, "package.json"))) {
    problems.push(`missing ${nativeName} package at ${nativeRoot}`);
  } else if (!hasNativeBinary(nativeRoot)) {
    problems.push(`missing ${nativeName} native binary in ${nativeRoot}`);
  }
  return problems;
}
