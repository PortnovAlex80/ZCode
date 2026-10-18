/* oxlint-disable eslint(max-lines) -- One isolated Electron fixture owns document, linked-window and restart lifecycle checks. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { seedProviderReadinessHistoryFixture } from "../packages/desktop/test/e2e/helpers/provider-readiness-history-fixture.ts";

const require = createRequire(resolve("packages/desktop/package.json"));
const { _electron } = require("playwright-core");
const root = await mkdtemp(join(tmpdir(), "zcode-independent-document-"));
const home = join(root, "home");
const projectA = join(root, "project-a");
const projectB = join(root, "project-b");
for (const directory of [home, projectA, projectB]) await mkdir(directory);
await mkdir(join(projectA, "docs"));
await writeFile(join(projectA, "docs/a.md"), "# Independent document\n\nOriginal file.\n");
await writeFile(join(projectA, "docs/b.md"), "# Second document\n\nSecond source.\n");
await mkdir(join(projectB, "docs"));
await writeFile(join(projectB, "docs/a.md"), "# Other project document\n");
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
const sessions = [
  [projectA, "sess_document_a1", "Document A1"],
  [projectA, "sess_document_a2", "Document A2"],
  [projectB, "sess_document_b1", "Document B1"],
];
for (const [workspacePath, sessionId, title] of sessions) {
  seedProviderReadinessHistoryFixture({
    cliEntryPoint: cli,
    e2eHomeDir: home,
    workspacePath,
    history: {
      sessionId,
      title,
      assistantInputTokens: 1200,
      assistantOutputTokens: 0,
      assistantText: "Saved reply " + title,
      userText: "Saved question " + title,
      modelId: "glm-5.3",
      runtimeProviderId: "missing-provider",
      taskProviderId: "glm",
    },
  });
}
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
let nativeContextRingChecked = false;
const errors = [];
const waitFor = async (predicate, label) => {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await new Promise((accept) => setTimeout(accept, 100));
  }
  throw new Error("Timed out: " + label);
};
const launch = async () => {
  app = await _electron.launch({
    executablePath: require("electron"),
    args: [resolve("packages/desktop"), "--open-workspace", projectA],
    env,
    timeout: 60000,
  });
  main = await app.firstWindow();
  console.log("Electron main ready: " + root);
  main.setDefaultTimeout(60000);
  main.on("pageerror", (error) => errors.push(error.message));
  await main.getByTestId("login-use-api-key-button").click();
  await main.getByTestId("login-api-key-skip-button").click();
  for (let index = 0; index < 3; index++) {
    const skip = main.getByRole("button", { name: "Skip", exact: true });
    await skip.waitFor({ timeout: 1000 }).catch(() => {});
    if (!(await skip.isVisible().catch(() => false))) break;
    await skip.click();
  }
};
const surface = (selector) =>
  waitFor(async () => {
    for (const page of app.windows()) {
      if (page === main || page.isClosed()) continue;
      if (
        await page
          .locator(selector)
          .count()
          .catch(() => 0)
      ) {
        page.setDefaultTimeout(60000);
        return page;
      }
    }
  }, selector);
const chat = async (sessionId, title) => {
  const page = await surface(`[data-floating-session="${sessionId}"]`);
  await page.getByText("Saved reply " + title, { exact: true }).waitFor();
  return page;
};
const select = (title) => main.getByText(title, { exact: true }).first().click();
const nativeBounds = async (page) =>
  (await app.browserWindow(page)).evaluate((win) => win.getNormalBounds());
const move = async (page, bounds) =>
  (await app.browserWindow(page)).evaluate((win, value) => win.setBounds(value), bounds);
const restart = async () => {
  await app.evaluate(({ app }) => app.quit());
  await app.close();
  app = null;
  await launch();
  console.log("Onboarding complete");
};
const switchProject = async (path) => {
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
  }, path);
  await main.evaluate(() => window.zcode.executeDesktopCommand("openWorkspace"));
};
let documentDraft = "# Independent document\n\nUnsaved draft belongs to project A.\n";
try {
  await launch();
  await select("Document A1");
  await main.getByText("Saved reply Document A1", { exact: true }).waitFor();
  await main.getByLabel("Вынести чат в окно", { exact: true }).click();
  let a1 = await chat("sess_document_a1", "Document A1");
  console.log("Detached A1 ready");
  const contextRing = a1.getByTestId("chat-context-usage-trigger");
  if (await contextRing.count()) {
    await contextRing.hover();
    const contextPopup = a1.locator('[data-slot="hover-card-content"][data-state="open"]').first();
    await contextPopup.waitFor({ state: "visible" });
    assert.equal(await contextPopup.evaluate((node) => node.ownerDocument === document), true);
    assert.equal(
      await main.locator('[data-slot="hover-card-content"][data-state="open"]').count(),
      0,
    );
    const triggerBounds = await contextRing.boundingBox(),
      popupBounds = await contextPopup.boundingBox();
    assert.ok(triggerBounds && popupBounds);
    assert.ok(Math.abs(popupBounds.x - triggerBounds.x) <= popupBounds.width + 20);
    assert.ok(Math.abs(popupBounds.y - triggerBounds.y) <= popupBounds.height + 20);
    nativeContextRingChecked = true;
    await a1.mouse.move(1, 1);
    await contextPopup.waitFor({ state: "hidden" });
    console.log("Real context ring hover stayed in detached chat document beside trigger");
  } else
    console.log("Context ring unavailable in missing-provider history fixture; no GUI ring claim");
  await a1.getByRole("button", { name: "Open doc", exact: true }).click();
  let doc = await surface("[data-document-window]");
  console.log("Independent document picker ready");
  await doc.getByLabel("Choose project document", { exact: true }).click();
  await doc.locator('[data-picker-path="docs/a.md"]').click();
  await doc.getByLabel("Edit", { exact: true }).click();
  await doc.getByLabel("Document source editor", { exact: true }).fill(documentDraft);
  assert.equal(await main.locator("[data-document-window] [data-spec-document-pane]").count(), 0);
  await move(a1, { x: 80, y: 100, width: 480, height: 600 });
  await move(doc, { x: 600, y: 100, width: 560, height: 600 });
  await select("Document A2");
  await main.getByText("Saved reply Document A2", { exact: true }).waitFor();
  await main.getByLabel("Вынести чат в окно", { exact: true }).click();
  await chat("sess_document_a2", "Document A2");
  await switchProject(projectB);
  await select("Document B1");
  await main.getByText("Saved reply Document B1", { exact: true }).waitFor();
  await main.getByLabel("Вынести чат в окно", { exact: true }).click();
  await chat("sess_document_b1", "Document B1");
  assert.equal(
    await doc.getByLabel("Document source editor", { exact: true }).inputValue(),
    documentDraft,
  );
  // Main is in B: changing A's detached document must update its addressed descriptor.
  await doc.getByLabel("Choose project document", { exact: true }).click();
  await doc.locator('[data-picker-path="docs/b.md"]').click();
  await doc.getByLabel("View", { exact: true }).waitFor();
  console.log("Project A docs/b.md selected while editor mode remained active in B");
  await waitFor(
    async () =>
      (await doc.getByLabel("Document source editor", { exact: true }).inputValue()).includes(
        "Second source",
      ),
    "switch original project document while main is in another project",
  );
  documentDraft = "# Second document\n\nUnsaved second document belongs to project A.\n";
  await doc.getByLabel("Document source editor", { exact: true }).fill(documentDraft);
  console.log("Document path changed to project A docs/b.md while main remained in B");
  // Returning to A1 and opening its document must focus the existing surface.
  await select("Document A1");
  a1 = await chat("sess_document_a1", "Document A1");
  const documentCount = async () => {
    let count = 0;
    for (const page of app.windows())
      if (page !== main && !page.isClosed())
        count += await page
          .locator("[data-document-window]")
          .count()
          .catch(() => 0);
    return count;
  };
  await a1.getByRole("button", { name: "Open doc", exact: true }).click();
  assert.equal(await documentCount(), 1, "Repeated Open doc must not duplicate the document");
  console.log(
    "Three chats from two projects plus one independent document; original draft and owner preserved",
  );

  await doc.locator('[data-document-link-control="attach"]').click();
  await waitFor(async () => {
    const left = await nativeBounds(a1),
      right = await nativeBounds(doc);
    return Math.abs(right.x - (left.x + left.width)) <= 2 && Math.abs(right.y - left.y) <= 2;
  }, "attach document beside addressed conversation");
  const beforeChat = await nativeBounds(a1),
    beforeDoc = await nativeBounds(doc);
  await move(a1, { ...beforeChat, x: beforeChat.x + 35, y: beforeChat.y + 25 });
  await waitFor(async () => {
    const next = await nativeBounds(doc);
    return next.x === beforeDoc.x + 35 && next.y === beforeDoc.y + 25;
  }, "moving chat moves attached document");
  const chatBeforeDocMove = await nativeBounds(a1),
    docBeforeMove = await nativeBounds(doc);
  await move(doc, { ...docBeforeMove, x: docBeforeMove.x - 20, y: docBeforeMove.y + 20 });
  await waitFor(async () => {
    const next = await nativeBounds(a1);
    return next.x === chatBeforeDocMove.x - 20 && next.y === chatBeforeDocMove.y + 20;
  }, "moving document moves attached chat");
  console.log("Explicit link follows movement from either independent OS window");
  const linkedDocBounds = await nativeBounds(doc);
  await main.reload();
  a1 = await chat("sess_document_a1", "Document A1");
  doc = await surface("[data-document-window]");
  await doc.getByLabel("Document source editor", { exact: true }).waitFor();
  assert.equal(
    await doc.getByLabel("Document source editor", { exact: true }).inputValue(),
    documentDraft,
  );
  await doc.locator('[data-document-link-control="detach"]').waitFor();
  assert.deepEqual(await nativeBounds(doc), linkedDocBounds);
  await restart();
  a1 = await chat("sess_document_a1", "Document A1");
  console.log("Cold restart A1 history restored");
  await chat("sess_document_a2", "Document A2");
  console.log("Cold restart A2 history restored");
  await chat("sess_document_b1", "Document B1");
  console.log("Cold restart B1 history restored");
  doc = await surface("[data-document-window]");
  await doc.getByLabel("Document source editor", { exact: true }).waitFor();
  assert.equal(
    await doc.getByLabel("Document source editor", { exact: true }).inputValue(),
    documentDraft,
  );
  assert.deepEqual(await nativeBounds(doc), linkedDocBounds);
  console.log("Cold restart document draft and geometry restored");
  await doc.locator('[data-document-link-control="detach"]').click();
  const fixedDoc = await nativeBounds(doc),
    unlinkedChat = await nativeBounds(a1);
  await move(a1, { ...unlinkedChat, x: unlinkedChat.x + 30 });
  await new Promise((accept) => setTimeout(accept, 400));
  assert.deepEqual(await nativeBounds(doc), fixedDoc);
  await doc.locator('[data-document-link-control="attach"]').click();
  await doc.locator('[data-document-link-control="detach"]').waitFor();
  // Even when attached, closing chat must retain its independent document.
  await (await app.browserWindow(a1)).evaluate((win) => win.close());
  await waitFor(async () => a1.isClosed(), "close chat A1");
  console.log("Linked parent chat closed; checking remaining document");
  assert.equal(
    await doc.getByLabel("Document source editor", { exact: true }).inputValue(),
    documentDraft,
  );
  await chat("sess_document_a2", "Document A2");
  await chat("sess_document_b1", "Document B1");
  await (await app.browserWindow(doc)).evaluate((win) => win.close());
  await waitFor(async () => doc.isClosed(), "close independent document");
  console.log("Document native X closed; checking main tab accessibility");
  const returnedEditor = main.getByLabel("Document source editor", { exact: true });
  await returnedEditor.waitFor({ state: "visible" });
  assert.equal(await returnedEditor.inputValue(), documentDraft);
  assert.match(
    await main.getByLabel("Choose project document", { exact: true }).innerText(),
    /b\.md/,
  );
  await select("Document B1");
  await chat("sess_document_b1", "Document B1");
  await select("Document A1");
  await returnedEditor.waitFor({ state: "visible" });
  assert.equal(await returnedEditor.inputValue(), documentDraft);
  assert.equal(
    await documentCount(),
    0,
    "Returning native window must not reopen on project navigation",
  );
  await main.getByRole("button", { name: "Show document window", exact: true }).click();
  console.log("Explicit document reopen requested");
  doc = await surface("[data-document-window]");
  await doc.getByLabel("Document source editor", { exact: true }).waitFor();
  assert.equal(
    await doc.getByLabel("Document source editor", { exact: true }).inputValue(),
    documentDraft,
  );
  assert.equal(await documentCount(), 1, "Explicit reopen restores one original document owner");
  await (await app.browserWindow(doc)).evaluate((win) => win.close());
  await waitFor(async () => doc.isClosed(), "close reopened independent document");
  await returnedEditor.waitFor({ state: "visible" });
  await chat("sess_document_a2", "Document A2");
  await chat("sess_document_b1", "Document B1");
  assert.equal(await readFile(join(projectB, "docs/a.md"), "utf8"), "# Other project document\n");
  assert.equal(
    await readFile(join(projectA, "docs/a.md"), "utf8"),
    "# Independent document\n\nOriginal file.\n",
  );
  assert.equal(
    await readFile(join(projectA, "docs/b.md"), "utf8"),
    "# Second document\n\nSecond source.\n",
  );
  assert.deepEqual(errors, [], "Renderer must not throw");
  console.log(
    JSON.stringify({
      independentDocument: true,
      conversations: 3,
      projects: 2,
      duplicateSuppression: true,
      bidirectionalLinkedMovement: true,
      reload: true,
      coldRestart: true,
      draftPreserved: true,
      closeIsolation: true,
      returnReachableAndExplicitReopen: true,
      backgroundDocumentPathSwitch: true,
      nativeContextRingChecked,
      modelPrompts: 0,
      root,
    }),
  );
} catch (error) {
  console.error(error);
  console.log("Fixture: " + root);
  if (main && !main.isClosed()) {
    const mainState = await main
      .evaluate(() => ({
        popouts: Array.from(document.querySelectorAll("[data-spec-popout-state]")).map((node) => ({
          attributes: Array.from(node.attributes).map((attribute) => [
            attribute.name,
            attribute.value,
          ]),
          text: node.textContent?.slice(0, 300),
        })),
        documents: Array.from(document.querySelectorAll("[data-document-window]")).map((node) => ({
          attributes: Array.from(node.attributes).map((attribute) => [
            attribute.name,
            attribute.value,
          ]),
          ownerUrl: node.ownerDocument.URL,
          ancestors: [node.parentElement, node.parentElement?.parentElement].map(
            (parent) => parent?.className,
          ),
        })),
      }))
      .catch(() => "Main diagnostics unavailable");
    console.log("Main surface state: " + JSON.stringify(mainState));
  }
  if (app)
    console.log(
      "Native windows: " +
        JSON.stringify(
          await app
            .evaluate(({ BrowserWindow }) =>
              BrowserWindow.getAllWindows()
                .filter((win) => !win.isDestroyed())
                .map((win) => ({
                  id: win.id,
                  title: win.getTitle(),
                  bounds: win.getBounds(),
                  visible: win.isVisible(),
                })),
            )
            .catch(() => "Native diagnostics unavailable"),
        ),
    );
  if (app)
    for (const page of app.windows()) {
      console.log(
        "Window " +
          (await page.title().catch(() => "closed")) +
          ": " +
          (
            await page
              .locator("body")
              .innerText({ timeout: 3000 })
              .catch(() => "closed")
          ).slice(-4000),
      );
    }
  if (main && !main.isClosed())
    await main
      .screenshot({ path: resolve(".tmp/independent-document-failure.png") })
      .catch(() => {});
  throw error;
} finally {
  if (app) {
    await app.evaluate(({ app }) => app.quit()).catch(() => {});
    await app.close().catch(() => {});
  }
}
