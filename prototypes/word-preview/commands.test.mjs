import { test } from "node:test";
import assert from "node:assert/strict";
import { selectionCommand } from "./commands.js";

test("context command captures selection before opening the shared pane", async () => {
  const steps = [];
  await selectionCommand(
    async (intent) => {
      await Promise.resolve();
      steps.push(intent);
    },
    async () => steps.push("show"),
    () => assert.fail("unexpected failure"),
    "discuss",
  )({ completed: () => steps.push("complete") });
  assert.deepEqual(steps, ["discuss", "show", "complete"]);
});
test("failed Office command still completes and reports failure", async () => {
  const steps = [];
  await selectionCommand(
    async () => {
      throw new Error("Office refused selection");
    },
    () => assert.fail("must not show before reading"),
    () => steps.push("error"),
    "add",
  )({ completed: () => steps.push("complete") });
  assert.deepEqual(steps, ["error", "complete"]);
});
