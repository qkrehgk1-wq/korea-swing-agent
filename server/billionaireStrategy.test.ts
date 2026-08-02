import { describe, expect, it } from "vitest";

import {
  calculatePositionSizePct,
  runBillionaireStrategyBacktest,
} from "./billionaireStrategy";

describe("Billionaire Core v1", () => {
  it("uses risk budget to calculate capped position exposure", () => {
    expect(calculatePositionSizePct(100_000, 100, 90, 1)).toBe(10);
    expect(calculatePositionSizePct(100_000, 100, 90, 5, 25)).toBe(25);
    expect(calculatePositionSizePct(100_000, 100, 110, 1)).toBe(0);
  });

  it("returns a safe insufficient result when there is no benchmark data", () => {
    const result = runBillionaireStrategyBacktest(
      { AAA: [], BENCH: [] },
      {},
      { benchmarkTicker: "BENCH", excludedTickers: ["BENCH"] }
    );
    expect(result.summary.totalTrades).toBe(0);
    expect(result.riskBudget.halfKellyPct).toBe(0);
    expect(result.riskBudget.cappedBy).toBe("floor");
  });
});
