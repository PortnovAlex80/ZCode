import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { seedProviderReadinessHistoryFixture } from "../packages/desktop/test/e2e/helpers/provider-readiness-history-fixture.ts";
const require = createRequire(resolve("packages/desktop/package.json"));
const { _electron, chromium } = require("playwright-core");
const root = await mkdtemp(join(tmpdir(), "zcode-discussion-recovery-"));
const project = join(root, "project");
const home = join(root, "home");
await mkdir(join(project, "docs"), { recursive: true });
await mkdir(home);
execFileSync(
  process.execPath,
  [
    resolve("apps/zcode-cli/packages/cli/dist/zcode.cjs"),
    "--cwd",
    project,
    "app-server",
    "--stdio",
    "--prepare-storage",
  ],
  {
    env: { ...process.env, HOME: home, USERPROFILE: home, ZCODE_DATA_BASE_DIR: home },
    input: JSON.stringify({ method: "startup/storagePathReady", reuse: false }) + "\n",
    windowsHide: true,
    timeout: 30000,
  },
);
const content = "# Recovery document\n\nDocument discussion recovery fixture.\n";
await writeFile(join(project, "docs/a.md"), content);
await writeFile(join(project, "docs/b.md"), "# Another document\n");
for (const [sessionId, title] of [
  ["sess_recovery_parent", "Recovery parent"],
  ["sess_recovery_child", "Recovery discussion"],
  ["sess_recovery_other", "Unrelated conversation"],
]) {
  seedProviderReadinessHistoryFixture({
    cliEntryPoint: resolve("apps/zcode-cli/packages/cli/dist/zcode.cjs"),
    e2eHomeDir: home,
    workspacePath: project,
    history: {
      sessionId,
      title,
      assistantInputTokens: 0,
      assistantOutputTokens: 0,
      assistantText: "Saved response for " + title,
      userText: "Saved question for " + title,
      modelId: "missing-model",
      runtimeProviderId: "missing-provider",
      taskProviderId: "glm",
    },
  });
}
const env = {
  ...process.env,
  NODE_ENV: "production",
  ZCODE_SESSION_DB_PATH: join(home, ".zcode/cli/db/db.sqlite"),
  ZCODE_STORAGE_DIR: join(home, ".zcode/cli"),
  ZCODE_DESKTOP_USER_DATA_DIR: join(root, "profile"),
  ZCODE_DESKTOP_HOME_DIR: home,
  ZCODE_DATA_BASE_DIR: home,
  ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT: "1",
  ZCODE_AUTO_UPDATE: "0",
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_RENDERER_URL;
const executableIndex = process.argv.indexOf("--executable");
if (executableIndex >= 0 && !process.argv[executableIndex + 1])
  throw new Error("--executable requires a path");
const packaged = executableIndex >= 0;
const executablePath = packaged ? resolve(process.argv[executableIndex + 1]) : require("electron");
let app, browser, child, page;
try {
  if (packaged) {
    // Packaged startup does not expose the Node inspector used by _electron.launch.
    child = spawn(executablePath, ["--remote-debugging-port=0", "--open-workspace", project], {
      env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.resume();
    const endpoint = await new Promise((accept, reject) => {
      const timer = setTimeout(() => reject(new Error("Packaged CDP startup timed out")), 60000);
      child.stderr.on("data", data => {
        const match = data.toString().match(/DevTools listening on (ws:\/\/\S+)/);
        if (match) { clearTimeout(timer); accept(match[1]); }
      });
      child.once("error", reject);
      child.once("exit", code => { clearTimeout(timer); reject(new Error("Packaged process exited: " + code)); });
    });
    browser = await chromium.connectOverCDP(endpoint, { timeout: 60000 });
    const context = browser.contexts()[0];
    page = context.pages()[0] ?? await context.waitForEvent("page", { timeout: 60000 });
    console.log(JSON.stringify({ packagedExecutable: executablePath }));
  } else {
    app = await _electron.launch({ executablePath, args: [resolve("packages/desktop"), "--open-workspace", project], env, timeout: 60000 });
    page = await app.firstWindow();
  }
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.getByTestId("login-use-api-key-button").click({ timeout: 60000 });
  await page.getByTestId("login-api-key-skip-button").click();
  for (let i = 0; i < 3; i++) {
    const skip = page.getByRole("button", { name: "Skip", exact: true });
    if (
      !(await skip.waitFor({ state: "visible", timeout: 1500 }).then(
        () => true,
        () => false,
      ))
    )
      break;
    await skip.click();
  }
  console.log("GUI onboarding complete");
  const thread = {
    id: "recovery-thread",
    scope: "document",
    documentPath: "docs/a.md",
    parentSessionId: "sess_recovery_parent",
    sessionId: "sess_recovery_child",
    discussionStartRowId: 1,
    anchor: {
      quote: content,
      prefix: "",
      suffix: "",
      start: 0,
      sha256: createHash("sha256").update(content).digest("hex"),
    },
  };
  await page.evaluate(
    ({ project, thread }) => {
      localStorage.setItem("spec-harness-native:v1:" + project, JSON.stringify([thread]));
    },
    { project, thread },
  );
  const select = async (title) => {
    await page.getByText(title, { exact: true }).first().click();
  };
  await select("Recovery parent");
  console.log("GUI parent selected");
  await page.getByTestId("side-pane-toggle").click();
  await page.getByRole("button", { name: "Open doc", exact: true }).click();
  await page.getByLabel("Choose project document", { exact: true }).click();
  await page.locator('[data-picker-path="docs/a.md"]').click();
  await page.getByRole("button", { name: "Discussions", exact: true }).click();
  await page.getByLabel("Fragment discussion", { exact: true }).selectOption(thread.id);
  const native = page.locator('[data-native-discussion-owner="sess_recovery_child"]');
  await native.waitFor({ state: "visible" });
  console.log("GUI initial native discussion ready");
  await native.getByText("Saved response for Recovery discussion", { exact: true }).waitFor();
  const editor = native.locator('[contenteditable="true"]').first();
  await editor.fill("Recovery unsent draft");
  await select("Unrelated conversation");
  await select("Recovery discussion");
  await native.waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Open existing discussion", exact: true }).first().click();
  await native.waitFor({ state: "visible" });
  await native.getByText("Saved response for Recovery discussion", { exact: true }).waitFor();
  await page.screenshot({ path: resolve(".tmp/discussion-recovery-mounted.png") });
  // Closing the document exercises the durable route without an in-memory owner.
  const tabs = await page
    .locator("[data-side-pane-tab-id]")
    .evaluateAll((nodes) =>
      nodes.map((n) => ({ id: n.getAttribute("data-side-pane-tab-id"), text: n.textContent })),
    );
  console.log(JSON.stringify({ phase: "mounted-return", tabs, root, errors }));
  // Use the existing document header close action; no session-delete command is sent.
  await page
    .locator("[data-side-pane-tab-id]")
    .filter({ hasText: "a.md" })
    .first()
    .click({ button: "middle" });
  await native.waitFor({ state: "detached" });
  const reopen = page
    .getByRole("button", { name: "Open existing discussion", exact: true })
    .first();
  if (!(await reopen.isEnabled())) throw new Error("Recovery button disabled after close");
  await reopen.click();
  await native.waitFor({ state: "visible" });
  await native.getByText("Saved response for Recovery discussion", { exact: true }).waitFor();
  if (
    !(await native
      .locator('[contenteditable="true"]')
      .first()
      .innerText()
      .then((text) => text.includes("Recovery unsent draft")))
  )
    throw new Error("Draft lost after close");
  await page.screenshot({ path: resolve(".tmp/discussion-recovery-closed.png") });
  await page.reload();
  // Skip is intentionally renderer-local; the fixture has no account/credentials.
  const welcome = page.getByTestId("login-use-api-key-button");
  if (
    await welcome.waitFor({ state: "visible", timeout: 5000 }).then(
      () => true,
      () => false,
    )
  ) {
    await welcome.click();
    await page.getByTestId("login-api-key-skip-button").click();
    for (let i = 0; i < 3; i++) {
      const skip = page.getByRole("button", { name: "Skip", exact: true });
      if (
        !(await skip.waitFor({ state: "visible", timeout: 1500 }).then(
          () => true,
          () => false,
        ))
      )
        break;
      await skip.click();
    }
  }
  await native.waitFor({ state: "visible", timeout: 60000 });
  await native.getByText("Saved response for Recovery discussion", { exact: true }).waitFor();
  if (errors.length) throw new Error("Renderer errors: " + JSON.stringify(errors));
  if ((await native.count()) !== 1) throw new Error("Duplicate native discussion composers");
  if (
    !(await native.locator('[contenteditable="true"]').first().innerText()).includes(
      "Recovery unsent draft",
    )
  )
    throw new Error("Draft lost after reload");
  console.log(
    JSON.stringify({
      mountedReturn: true,
      closedReturn: true,
      reloadReturn: true,
      sameChildSession: true,
      modelPrompts: 0,
      root,
    }),
  );
} catch (error) {
  if (page) {
    console.log((await page.locator("body").innerText()).slice(-7000));
    await page
      .screenshot({ path: resolve(".tmp/discussion-recovery-failure.png") })
      .catch(() => {});
  }
  throw error;
} finally {
  if (app) await app.close();
  if (browser) {
    const session = await browser.newBrowserCDPSession().catch(() => null);
    await session?.send("Browser.close").catch(() => {});
    await browser.close().catch(() => {});
  }
  if (child && child.exitCode === null) {
    await new Promise(resolve => setTimeout(resolve, 1500));
    if (child.exitCode === null) await new Promise(resolve =>
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).once("exit", resolve));
  }
}
