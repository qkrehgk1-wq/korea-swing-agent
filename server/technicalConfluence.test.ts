import { describe, expect, it } from "vitest";

import {
  analyzeTechnicalConfluence,
  computeAdx,
  computeVolumeFlow,
  fibonacciLeg,
  macdBullish,
  type ConfluenceBar,
} from "./technicalConfluence";

function bar(close: number, high = close * 1.01, low = close * 0.99, volume = 1000): ConfluenceBar {
  return { close, high, low, volume };
}

function trend(start: number, step: number, n: number): ConfluenceBar[] {
  return Array.from({ length: n }, (_, i) => bar(start + step * i));
}

const flatBenchmark = Array.from({ length: 150 }, () => bar(100));

describe("macdBullish", () => {
  it("is true for a rising series and false for a falling one", () => {
    expect(macdBullish(trend(100, 0.6, 80).map(b => b.close))).toBe(true);
    expect(macdBullish(trend(160, -0.6, 80).map(b => b.close))).toBe(false);
  });
});

describe("computeAdx", () => {
  it("reports a strong trend as high ADX and a flat tape as low", () => {
    expect(computeAdx(trend(100, 1, 80))).toBeGreaterThan(25);
    const flat = Array.from({ length: 80 }, (_, i) => bar(100 + (i % 2 === 0 ? 0.2 : -0.2)));
    expect(computeAdx(flat)).toBeLessThan(25);
  });
});

describe("fibonacciLeg", () => {
  it("detects a golden-ratio pullback and projects a 1.618 extension", () => {
    const up = trend(100, 1, 31); // 100 -> 130
    const pullback = [bar(126), bar(124), bar(121), bar(119), bar(118)]; // ~0.4 retrace
    const leg = fibonacciLeg([...up, ...pullback]);
    expect(leg.retracement).not.toBeNull();
    expect(leg.nearGolden).toBe(true);
    expect(leg.extensionTarget).toBeGreaterThan(130);
  });
});

describe("computeVolumeFlow", () => {
  it("detects rising accumulation when up-day volume outweighs down-day volume recently", () => {
    // 40 flat/mixed bars, then 20 bars trending up on rising volume (accumulation).
    const quiet = Array.from({ length: 40 }, (_, i) => bar(100 + (i % 2 === 0 ? 0.1 : -0.1), undefined, undefined, 500));
    const accumulating = Array.from({ length: 20 }, (_, i) => bar(101 + i * 0.5, undefined, undefined, 800 + i * 40));
    const result = computeVolumeFlow([...quiet, ...accumulating]);
    expect(result.flowRising).toBe(true);
    expect(result.flowSlope).toBeGreaterThan(0);
  });

  it("does not flag distribution (falling prices) as rising flow", () => {
    const falling = trend(150, -0.5, 60).map(b => ({ ...b, volume: 1000 }));
    const result = computeVolumeFlow(falling);
    expect(result.flowRising).toBe(false);
  });

  it("returns a neutral result when there is not enough history", () => {
    expect(computeVolumeFlow(trend(100, 1, 10))).toEqual({ flowRising: false, flowSlope: 0 });
  });
});

describe("analyzeTechnicalConfluence", () => {
  it("scores a leading uptrend far above a lagging downtrend", () => {
    const upTrend = analyzeTechnicalConfluence(trend(100, 0.5, 150), flatBenchmark);
    const downTrend = analyzeTechnicalConfluence(trend(180, -0.4, 150), flatBenchmark);

    expect(upTrend.trendAligned).toBe(true);
    expect(upTrend.relativeStrength60).toBeGreaterThan(0);
    expect(upTrend.macdBullish).toBe(true);
    expect(upTrend.adx).toBeGreaterThan(20);

    expect(downTrend.trendAligned).toBe(false);
    expect(downTrend.relativeStrength60).toBeLessThan(0);
    expect(upTrend.qualityScore).toBeGreaterThan(downTrend.qualityScore + 20);
  });

  it("flags an over-extended stock", () => {
    const base = trend(100, 0.2, 140);
    const blowoff = [bar(118), bar(124), bar(132), bar(140), bar(150)]; // spikes above 20MA
    const result = analyzeTechnicalConfluence([...base, ...blowoff], flatBenchmark);
    expect(result.overExtended).toBe(true);
  });
});
