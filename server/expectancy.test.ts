import { describe, expect, it } from "vitest";

import { computeExpectancy, computeRiskBudget, toRMultiple, type RTrade } from "./expectancy";

/** trigger 100, stop 90 → risk 10% ; returnPct N → N/10 R */
function trade(returnPct: number, outcome = "target"): RTrade {
  return { triggerPrice: 100, stopLossPrice: 90, returnPct, outcome };
}

describe("toRMultiple", () => {
  it("expresses profit in units of planned risk", () => {
    expect(toRMultiple(trade(25))).toBeCloseTo(2.5);
    expect(toRMultiple(trade(-10))).toBeCloseTo(-1);
  });

  it("returns null when risk is undefined", () => {
    expect(toRMultiple({ triggerPrice: 100, stopLossPrice: 110, returnPct: 5 })).toBeNull();
    expect(toRMultiple({ triggerPrice: 0, stopLossPrice: 0, returnPct: 5 })).toBeNull();
  });
});

describe("computeExpectancy", () => {
  it("finds a positive edge when winners outweigh losers in R", () => {
    // 4 wins at +2.5R, 6 losses at -1R → expectancy = (10 - 6)/10 = +0.4R
    const trades = [
      ...Array.from({ length: 4 }, () => trade(25)),
      ...Array.from({ length: 6 }, () => trade(-10, "stop")),
    ];
    const stats = computeExpectancy(trades);
    expect(stats.trades).toBe(10);
    expect(stats.winRate).toBe(40);
    expect(stats.avgWinR).toBeCloseTo(2.5);
    expect(stats.avgLossR).toBeCloseTo(1);
    expect(stats.expectancyR).toBeCloseTo(0.4);
    expect(stats.profitFactor).toBeCloseTo(1.67, 1);
    expect(stats.edgeVerdict).toBe("positive");
  });

  it("flags a high win-rate strategy with poor payoff as negative", () => {
    // 8 wins at +0.2R, 2 losses at -1.5R → 80% win rate but negative expectancy
    const trades = [
      ...Array.from({ length: 8 }, () => trade(2)),
      ...Array.from({ length: 2 }, () => trade(-15, "stop")),
    ];
    const stats = computeExpectancy(trades);
    expect(stats.winRate).toBe(80);
    expect(stats.expectancyR).toBeLessThan(0);
    expect(stats.edgeVerdict).toBe("negative");
  });

  it("withholds a verdict on small samples", () => {
    expect(computeExpectancy([trade(25), trade(-10, "stop")]).edgeVerdict).toBe("insufficient");
    expect(computeExpectancy([]).edgeVerdict).toBe("insufficient");
  });

  it("ignores untriggered signals", () => {
    const stats = computeExpectancy([...Array.from({ length: 10 }, () => trade(0, "not_triggered"))]);
    expect(stats.trades).toBe(0);
  });
});

describe("computeRiskBudget", () => {
  it("sizes a positive-expectancy strategy but caps it", () => {
    const stats = computeExpectancy([
      ...Array.from({ length: 4 }, () => trade(25)),
      ...Array.from({ length: 6 }, () => trade(-10, "stop")),
    ]);
    const budget = computeRiskBudget(stats);
    expect(budget.kellyFraction).toBeGreaterThan(0);
    expect(budget.halfKellyPct).toBeGreaterThan(0);
    expect(budget.halfKellyPct).toBeLessThanOrEqual(2); // hard cap
  });

  it("refuses to size a negative-expectancy strategy", () => {
    const stats = computeExpectancy([
      ...Array.from({ length: 8 }, () => trade(2)),
      ...Array.from({ length: 2 }, () => trade(-15, "stop")),
    ]);
    const budget = computeRiskBudget(stats);
    expect(budget.halfKellyPct).toBe(0);
    expect(budget.cappedBy).toBe("floor");
  });

  it("withholds sizing when the sample is too small", () => {
    const budget = computeRiskBudget(computeExpectancy([trade(25)]));
    expect(budget.halfKellyPct).toBe(0);
    expect(budget.note).toContain("판정 불가");
  });
});
