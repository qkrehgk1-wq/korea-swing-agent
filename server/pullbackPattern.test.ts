import { describe, expect, it } from "vitest";

import { detectPullbackPattern } from "./technicalSwingScreener";

/** Closes only — the detector reads `close`; high/low/volume are unused here. */
function barsFrom(closes: number[]) {
  return closes.map(close => ({ close, high: close, low: close, volume: 1000 }));
}

/** Rises to `peak` over 95 bars, then dips to `end` over the last 5. */
function pullbackCloses(start: number, peak: number, end: number) {
  const closes: number[] = [];
  for (let i = 0; i < 95; i += 1) {
    closes.push(start + ((peak - start) * i) / 94);
  }
  for (let i = 1; i <= 5; i += 1) {
    closes.push(peak + ((end - peak) * i) / 5);
  }
  return closes;
}

const healthy = {
  currentPrice: 122,
  ma20: 120,
  ma60: 110,
  ma120: 100,
  rsi14: 52,
  volumeRatio: 1.0,
  annualHigh: 130,
  annualLow: 90,
  return20d: 4,
  return60d: 15,
  volatility20: 30,
};

describe("detectPullbackPattern", () => {
  it("matches a shallow dip to the 20-day average inside an intact uptrend", () => {
    const result = detectPullbackPattern(barsFrom(pullbackCloses(100, 130, 122)), healthy);
    expect(result.matched).toBe(true);
    expect(result.note).toContain("눌림목");
  });

  it("rejects when there was no prior advance to pull back from", () => {
    // Same shape, but the 60-day run never happened.
    const result = detectPullbackPattern(barsFrom(pullbackCloses(100, 130, 122)), {
      ...healthy,
      return60d: 2,
    });
    expect(result.matched).toBe(false);
  });

  it("rejects a drop too deep to be a pullback", () => {
    // 130 → 105 is −19%, past the −14% floor.
    const result = detectPullbackPattern(barsFrom(pullbackCloses(100, 130, 105)), {
      ...healthy,
      currentPrice: 105,
    });
    expect(result.matched).toBe(false);
  });

  it("rejects when the trend itself is broken (MA20 below MA60)", () => {
    const result = detectPullbackPattern(barsFrom(pullbackCloses(100, 130, 122)), {
      ...healthy,
      ma20: 108,
      ma60: 115,
    });
    expect(result.matched).toBe(false);
  });

  it("rejects a dip sold on heavy volume rather than drying up", () => {
    const result = detectPullbackPattern(barsFrom(pullbackCloses(100, 130, 122)), {
      ...healthy,
      volumeRatio: 2.4,
    });
    expect(result.matched).toBe(false);
  });

  it("rejects when price has fallen away from the 20-day average", () => {
    // Price well under MA20 is no longer resting on support.
    const result = detectPullbackPattern(barsFrom(pullbackCloses(100, 130, 122)), {
      ...healthy,
      ma20: 132,
    });
    expect(result.matched).toBe(false);
  });

  it("reports insufficient data instead of guessing", () => {
    const result = detectPullbackPattern(barsFrom([100, 101, 102]), healthy);
    expect(result.matched).toBe(false);
    expect(result.note).toContain("부족");
  });
});
