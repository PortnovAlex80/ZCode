import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { seedProviderReadinessHistoryFixture } from "../packages/desktop/test/e2e/helpers/provider-readiness-history-fixture.ts";

const require = createRequire(resolve("packages/desktop/package.json"));
const { _electron } = require("playwright-core");
const root = await mkdtemp(join(tmpdir(), "zcode-window-layout-"));
const home = join(root, "home");
const projectA = join(root, "project-a");
const projectB = join(root, "project-b");
for (const directory of [home, projectA, projectB]) await mkdir(directory);
const cli = resolve("apps/zcode-cli/packages/cli/dist/zcode.cjs");
execFileSync(
  process.execPath,
  [cli, "--cwd", projectA, "app-server", "--stdio", "--prepare-storage"],
  {
    env: { ...process.env, HOME: home, USERPROFILE: home, ZCODE_DATA_BASE_DIR: home },
    input: JSON.stringify({ method: "startup/storagePathReady", reuse: false }) + "\n",
    windowsHide: true,
    timeout: 30000,
  },
);
for (const [workspacePath, sessionId, title] of [
  [projectA, "sess_layout_a1", "Layout A1"],
  [projectA, "sess_layout_a2", "Layout A2"],
  [projectB, "sess_layout_b1", "Layout B1"],
])
  seedProviderReadinessHistoryFixture({
    cliEntryPoint: cli,
    e2eHomeDir: home,
    workspacePath,
    history: {
      sessionId,
      title,
      assistantInputTokens: 0,
      assistantOutputTokens: 0,
      assistantText: "Saved reply " + title,
      userText: "Saved question " + title,
      modelId: "missing-model",
      runtimeProviderId: "missing-provider",
      taskProviderId: "glm",
    },
  });
const env = {
  ...process.env,
  NODE_ENV: "production",
  ZCODE_AUTO_UPDATE: "0",
  ZCODE_SESSION_DB_PATH: join(home, ".zcode/cli/db/db.sqlite"),
  ZCODE_STORAGE_DIR: join(home, ".zcode/cli"),
  ZCODE_DESKTOP_USER_DATA_DIR: join(root, "profile"),
  ZCODE_DESKTOP_HOME_DIR: home,
  ZCODE_DATA_BASE_DIR: home,
  ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT: "1",
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_RENDERER_URL;
let app, main;
const errors = [];
const launch = async () => {
  app = await _electron.launch({
    executablePath: require("electron"),
    args: [resolve("packages/desktop"), "--open-workspace", projectA],
    env,
    timeout: 60000,
  });
  main = await app.firstWindow();
  main.setDefaultTimeout(60000);
  main.on("pageerror", (error) => errors.push(error.message));
};
const waitFor = async (predicate, label) => {
  const start = Date.now();
  while (Date.now() - start < 60000) {
    const result = await predicate();
    if (result) return result;
    await new Promise((accept) => setTimeout(accept, 100));
  }
  throw new Error("Timed out: " + label);
};
const floating = (session) =>
  waitFor(async () => {
    for (const page of app.windows()) {
      if (page === main || page.isClosed()) continue;
      if (
        await page
          .locator(`[data-floating-session="${session}"]`)
          .count()
          .catch(() => 0)
      )
        return page;
    }
  }, session);
const ready = async (session, title) => {
  const page = await floating(session);
  await page.getByText("Saved reply " + title, { exact: true }).waitFor({ timeout: 60000 });
  return page;
};
const select = (title) => main.getByText(title, { exact: true }).first().click({ timeout: 60000 });
const detach = () => main.getByLabel("Вынести чат в окно", { exact: true }).click();
const finishOnboarding = async () => {
  await main.getByTestId("login-use-api-key-button").click({ timeout: 60000 });
  await main.getByTestId("login-api-key-skip-button").click();
  for (let i = 0; i < 3; i++) {
    const skip = main.getByRole("button", { name: "Skip", exact: true });
    if (!(await skip.isVisible().catch(() => false))) {
      await skip.waitFor({ timeout: 1000 }).catch(() => {});
      if (!(await skip.isVisible().catch(() => false))) break;
    }
    await skip.click();
  }
};
try {
  await launch();
  await finishOnboarding();
  await select("Layout A1");
  await main.getByText("Saved reply Layout A1", { exact: true }).waitFor();
  await main.locator('[contenteditable="true"]').first().fill("Draft A1");
  await detach();
  const a1 = await ready("sess_layout_a1", "Layout A1");
  await waitFor(
    async () =>
      (await a1.locator('[contenteditable="true"]').first().innerText()).includes("Draft A1"),
    "detach draft",
  );
  const a1Window = await app.browserWindow(a1);
  await a1Window.evaluate((win) => win.setBounds({ x: 100, y: 120, width: 540, height: 660 }));
  await select("Layout A2");
  await main.getByText("Saved reply Layout A2", { exact: true }).waitFor();
  await detach();
  const a2 = await ready("sess_layout_a2", "Layout A2");
  await a2.locator('[contenteditable="true"]').first().fill("Draft A2");
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, projectB);
  await main.evaluate(() => window.zcode.executeDesktopCommand("openWorkspace"));
  await select("Layout B1");
  await main.getByText("Saved reply Layout B1", { exact: true }).waitFor();
  await detach();
  const b1 = await ready("sess_layout_b1", "Layout B1");
  await b1.locator('[contenteditable="true"]').first().fill("Draft B1");
  for (const [session, title] of [
    ["sess_layout_a1", "Layout A1"],
    ["sess_layout_a2", "Layout A2"],
    ["sess_layout_b1", "Layout B1"],
  ]) {
    await select(title);
    const page = await ready(session, title);
    if ((await page.locator('[contenteditable="true"]').count()) !== 1)
      throw new Error("Duplicate composer " + session);
  }
  if (
    (await main.evaluate(() => JSON.parse(localStorage.getItem("zcode-conversation-windows:v1"))))
      .length !== 3
  )
    throw new Error("Wrong open roster");
  console.log("A1+A2+B1 simultaneously open; sidebar focuses without duplicates");
  await main.reload();
  for (const [session, title, draft] of [
    ["sess_layout_a1", "Layout A1", "Draft A1"],
    ["sess_layout_a2", "Layout A2", "Draft A2"],
    ["sess_layout_b1", "Layout B1", "Draft B1"],
  ]) {
    const page = await ready(session, title);
    await waitFor(
      async () =>
        (await page.locator('[contenteditable="true"]').first().innerText()).includes(draft),
      "reload draft " + session,
    );
  }
  const restoredA1 = await app.browserWindow(await floating("sess_layout_a1"));
  const bounds = await restoredA1.evaluate((win) => win.getNormalBounds());
  if (bounds.x !== 100 || bounds.y !== 120 || bounds.width !== 540 || bounds.height !== 660)
    throw new Error("Wrong restored bounds " + JSON.stringify(bounds));
  console.log("Reload restored all three drafts and A1 native bounds");
  console.log("Before quit: " + JSON.stringify(await main.evaluate(() => ({ url: location.href, roster: localStorage.getItem("zcode-conversation-windows:v1") }))));
  await app.evaluate(({ app }) => {
    app.quit();
  });
  await app.close();
  app = null;
  await launch();
  // The isolated fixture has no real account; local API-key skip is session-only.
  await finishOnboarding();
  console.log(
    "Restart roster: " + JSON.stringify(await main.evaluate(() => ({ url: location.href, roster: localStorage.getItem("zcode-conversation-windows:v1") }))),
  );
  for (const [session, title] of [
    ["sess_layout_a1", "Layout A1"],
    ["sess_layout_a2", "Layout A2"],
    ["sess_layout_b1", "Layout B1"],
  ])
    await ready(session, title);
  const closed = await app.browserWindow(await floating("sess_layout_a2"));
  await closed.evaluate((win) => win.close());
  await waitFor(
    async () =>
      (await main.evaluate(() => JSON.parse(localStorage.getItem("zcode-conversation-windows:v1"))))
        .length === 2,
    "close only A2",
  );
  await ready("sess_layout_a1", "Layout A1");
  await ready("sess_layout_b1", "Layout B1");
  const geometry = JSON.parse(
    await readFile(join(root, "profile/conversation-window-geometry.json"), "utf8"),
  );
  if (errors.length) throw new Error("Renderer errors: " + JSON.stringify(errors));
  console.log(
    JSON.stringify({
      simultaneous: 3,
      projects: 2,
      reload: true,
      restart: true,
      drafts: true,
      bounds,
      geometryVersion: geometry.version,
      closeIsolated: true,
      modelPrompts: 0,
      root,
    }),
  );
} catch (error) {
  console.log("Fixture: " + root);
  if (main && !main.isClosed()) {
    console.log((await main.locator("body").innerText()).slice(-6000));
    await main
      .screenshot({ path: resolve(".tmp/conversation-window-failure.png") })
      .catch(() => {});
  }
  if (app)
    for (const page of app.windows()) {
      console.log(
        "Window " +
          (await page.title().catch(() => "closed")) +
          ": " +
          (
            await page
              .locator("body")
              .innerText()
              .catch(() => "closed")
          ).slice(-3000),
      );
    }
  throw error;
} finally {
  if (app) {
    await app
      .evaluate(({ app }) => {
        app.quit();
      })
      .catch(() => {});
    await app.close().catch(() => {});
  }
}
