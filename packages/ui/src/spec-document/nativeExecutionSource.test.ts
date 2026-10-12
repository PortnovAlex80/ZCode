import assert from "node:assert/strict";
import { test } from "vitest";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import {
  getNativeExecutionSource,
  nativeExecutionSource,
  publishNativeExecutionSource,
  resolveSpecExecutionSessionId,
  subscribeNativeExecutionSource,
} from "./nativeExecutionSource.js";

test("actual upstream draft prewarm creates a configured session without starting a prompt", async () => {
  const text = await readFile(
    new URL("../v4/composer/useDraftSessionPrewarm.ts", import.meta.url),
    "utf8",
  );
  const source = ts.createSourceFile("prewarm.ts", text, ts.ScriptTarget.Latest, true);
  const declaration = source.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === "startDraftSessionPrewarm",
  );
  assert.ok(declaration);
  const executable = ts.transpileModule(
    `${declaration.getText(source).replace(/^export\s+/, "")}\nstartDraftSessionPrewarm;`,
    {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    },
  ).outputText;
  const start = runInNewContext(executable, { logger: { info() {}, warn() {} } }) as (params: {
    workspaceKey: string;
    resolveInitialConfig: () => object;
    dispatchCommand: (type: string, payload: object, sessionId: string | null) => Promise<object>;
    onReady: (sessionId: string) => void;
    onSettled: () => void;
  }) => { dispose(): void };
  const calls: { type: string; payload: object; sessionId: string | null }[] = [];
  let ready: string | null = null;
  let settled!: () => void;
  const completion = new Promise<void>((resolve) => {
    settled = resolve;
  });
  const controller = start({
    workspaceKey: "D:/test-native-draft",
    resolveInitialConfig: () => ({
      provider: "actual-provider",
      model: "actual-model",
      mode: "default",
    }),
    dispatchCommand: async (type, payload, sessionId) => {
      calls.push({ type, payload, sessionId });
      return {
        status: "accepted",
        result: { type: "createSession", sessionId: "unpromoted-draft" },
      };
    },
    onReady: (sessionId) => {
      ready = sessionId;
    },
    onSettled: settled,
  });
  await completion;
  assert.equal(ready, "unpromoted-draft");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.type, "createSession");
  assert.equal(calls[0]!.sessionId, null);
  const payload = calls[0]!.payload as Record<string, unknown>;
  assert.deepEqual(Object.keys(payload).sort(), ["config", "workspaceId"]);
  assert.equal(payload.workspaceId, "D:/test-native-draft");
  assert.equal("firstInput" in payload, false);
  controller.dispose();
  assert.equal(
    calls[1]!.type,
    "deleteSession",
    "cleanup still belongs to the native prewarm owner",
  );
  assert.equal(calls[1]!.sessionId, "unpromoted-draft");
});

test("ready native draft identity needs a matching live projection and actual configured model", () => {
  const input = {
    paneId: "main",
    sessionId: "unpromoted-native-draft",
    snapshotSessionId: "unpromoted-native-draft",
    projectionStatus: "live",
    provider: "native",
    model: "actual-model",
  };
  const ready = nativeExecutionSource(input);
  assert.equal(resolveSpecExecutionSessionId(null, ready), input.sessionId);
  assert.equal(resolveSpecExecutionSessionId("shell-session", ready), "shell-session");
  for (const change of [
    { snapshotSessionId: "stale" },
    { projectionStatus: "connecting" },
    { provider: "" },
    { model: "" },
    { sessionId: null },
  ]) {
    assert.equal(
      resolveSpecExecutionSessionId(null, nativeExecutionSource({ ...input, ...change })),
      null,
    );
  }
  const failed = nativeExecutionSource({ ...input, error: "Native draft creation was rejected." });
  assert.equal(failed.phase, "error");
  assert.equal(failed.error, "Native draft creation was rejected.");
  assert.equal(resolveSpecExecutionSessionId(null, failed), null);
  assert.deepEqual(
    Object.keys(ready).sort(),
    ["paneId", "phase", "sessionId"],
    "no transcript/config/permission receipt crosses the seam",
  );
});

test("execution identity is workspace scoped, owner-safe and refuses ambiguous focused panes", () => {
  const workspace = "test-draft-source-one";
  const otherWorkspace = "test-draft-source-two";
  let notifications = 0;
  const off = subscribeNativeExecutionSource(workspace, () => {
    notifications++;
  });
  const releaseOld = publishNativeExecutionSource(workspace, {
    paneId: "main",
    sessionId: "old",
    phase: "ready",
  });
  const releaseNew = publishNativeExecutionSource(workspace, {
    paneId: "main",
    sessionId: "new",
    phase: "ready",
  });
  releaseOld();
  assert.equal(
    getNativeExecutionSource(workspace)?.sessionId,
    "new",
    "stale cleanup cannot remove current identity",
  );
  assert.equal(getNativeExecutionSource(otherWorkspace), null);
  const releaseAmbiguous = publishNativeExecutionSource(workspace, {
    paneId: "second-focused",
    sessionId: "other",
    phase: "ready",
  });
  assert.equal(getNativeExecutionSource(workspace), null);
  releaseAmbiguous();
  assert.equal(getNativeExecutionSource(workspace)?.sessionId, "new");
  releaseNew();
  assert.equal(getNativeExecutionSource(workspace), null);
  assert.ok(notifications >= 4);
  off();
});
