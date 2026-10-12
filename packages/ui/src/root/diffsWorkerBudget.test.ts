import { describe, expect, it } from "vitest";
import { resolveDiffsWorkerBudget } from "./diffsWorkerBudget.js";

describe("renderer worker budget", () => {
  it("bounds auxiliary windows independently of a large CPU count", () => {
    expect(resolveDiffsWorkerBudget(32, 2)).toBe(2);
    expect(resolveDiffsWorkerBudget(32)).toBe(4);
    expect(resolveDiffsWorkerBudget(1, 2)).toBe(1);
  });
  it("keeps invalid capacities finite and retains the minimum worker", () => {
    expect(resolveDiffsWorkerBudget(NaN, 2)).toBe(2);
    expect(resolveDiffsWorkerBudget(Infinity, 2)).toBe(2);
    expect(resolveDiffsWorkerBudget(0, 2)).toBe(2);
    expect(resolveDiffsWorkerBudget(8, NaN)).toBe(1);
    expect(resolveDiffsWorkerBudget(8, 0)).toBe(1);
  });
});
