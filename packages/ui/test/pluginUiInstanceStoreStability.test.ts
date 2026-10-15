import { afterEach, expect, it, vi } from "vitest";
import {
  getPluginUiRowDisposition,
  resetPluginUiInstancesForTest,
  setPluginUiInstanceDerivation,
  subscribePluginUiInstances,
} from "../src/plugin-ui/app/pluginUiInstanceStore.js";
import type { PluginUiInstanceDerivation } from "../src/plugin-ui/domain/pluginUiInstancePolicy.js";

function derivation(): PluginUiInstanceDerivation {
  return {
    instances: [],
    byToolCallId: {
      first: { key: "widget-a", superseded: false, autoExpand: true, forcedInline: false },
      second: { key: "widget-b", superseded: false, autoExpand: true, forcedInline: false },
    },
  };
}
afterEach(resetPluginUiInstancesForTest);

it("does not mutate published inputs and keeps sessions isolated", () => {
  const input = derivation();
  Object.values(input.byToolCallId).forEach(Object.freeze);
  Object.freeze(input.byToolCallId);
  Object.freeze(input);
  setPluginUiInstanceDerivation("a", input);
  const first = getPluginUiRowDisposition("a", "first");
  setPluginUiInstanceDerivation("b", derivation());
  setPluginUiInstanceDerivation("a", input);
  expect(getPluginUiRowDisposition("a", "first")).toBe(first);
  setPluginUiInstanceDerivation("b", { instances: [], byToolCallId: {} });
  expect(getPluginUiRowDisposition("a", "first")).toBe(first);
});

it("keeps equivalent card snapshots stable across token updates and notifies real changes/removals", () => {
  const listener = vi.fn();
  subscribePluginUiInstances(listener);
  setPluginUiInstanceDerivation("s", derivation());
  const first = getPluginUiRowDisposition("s", "first");
  const second = getPluginUiRowDisposition("s", "second");
  listener.mockClear();
  for (let frame = 0; frame < 100; frame++) setPluginUiInstanceDerivation("s", derivation());
  expect(listener).not.toHaveBeenCalled();
  expect(getPluginUiRowDisposition("s", "first")).toBe(first);
  const changed = derivation();
  changed.byToolCallId = {
    ...changed.byToolCallId,
    first: { ...changed.byToolCallId.first!, superseded: true },
  };
  setPluginUiInstanceDerivation("s", changed);
  expect(listener).toHaveBeenCalledTimes(1);
  expect(getPluginUiRowDisposition("s", "first")?.superseded).toBe(true);
  expect(getPluginUiRowDisposition("s", "second")).toBe(second);
  setPluginUiInstanceDerivation("s", { instances: [], byToolCallId: {} });
  expect(listener).toHaveBeenCalledTimes(2);
  expect(getPluginUiRowDisposition("s", "first")).toBeUndefined();
  expect(getPluginUiRowDisposition("s", "second")).toBeUndefined();
});
