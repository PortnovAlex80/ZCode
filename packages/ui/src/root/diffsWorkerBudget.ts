/** Auxiliary surfaces share execution, but each renderer owns its highlighting workers. */
export function resolveDiffsWorkerBudget(hardwareConcurrency: number, maximum = 4): number {
  const capacity =
    Number.isFinite(hardwareConcurrency) && hardwareConcurrency > 0
      ? Math.floor(hardwareConcurrency / 2)
      : 2;
  const ceiling = Number.isFinite(maximum) && maximum >= 1 ? Math.floor(maximum) : 1;
  return Math.max(1, Math.min(ceiling, capacity));
}
