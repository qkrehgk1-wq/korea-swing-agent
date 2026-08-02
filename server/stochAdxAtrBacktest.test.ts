import { describe, expect, it } from "vitest";

import {
  summarizeStochAdxAtrTrades,
  type StochAdxAtrTrade,
} from "./stochAdxAtrBacktest";

function trade(
  signalDate: string,
  ticker: string,
  outcome: StochAdxAtrTrade["outcome"],
  returnPct: number
): StochAdxAtrTrade {
  return {
    signalDate,
    ticker,
    triggerPrice: 100,
    stopLossPrice: 95,
    targetPrice: 110,
    atr: 2,
    adx: 25,
    plusDi: 30,
    minusDi: 15,
    stochasticK: 60,
    stochasticD: 55,
    volumeRatio: 1,
    outcome,
    returnPct,
    maxFavorableExcursionPct: 0,
    maxAdverseExcursionPct: 0,
  };
}

describe("summarizeStochAdxAtrTrades", () => {
  it("excludes unfilled signals from trade statistics", () => {
    const summary = summarizeStochAdxAtrTrades([
      trade("2026-01-01", "A", "target", 5),
      trade("2026-02-01", "B", "stop", -2),
      trade("2026-03-01", "C", "not_triggered", 0),
    ]);

    expect(summary.totalSignals).toBe(3);
    expect(summary.totalTrades).toBe(2);
    expect(summary.winRate).toBe(50);
    expect(summary.avgReturnPct).toBe(1.5);
    expect(summary.noTriggerRate).toBe(33.3);
    expect(summary.profitFactor).toBe(2.5);
    expect(summary.inSample.trades + summary.outOfSample.trades).toBe(2);
  });
});
