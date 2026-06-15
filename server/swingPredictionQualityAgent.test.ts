import { describe, expect, it } from "vitest";

import { deriveSwingPredictionQualityOverrides } from "./swingPredictionQualityAgent";

describe("deriveSwingPredictionQualityOverrides", () => {
  it("tightens quality filters when weak high-rsi and low-volume trades dominate losses", () => {
    const overrides = deriveSwingPredictionQualityOverrides({
      generatedAt: "2026-05-13T00:00:00.000Z",
      totalTrades: 18,
      winRate: 38.9,
      avgReturnPct: -0.8,
      trades: [
        { patterns: ["돌파매매"], outcome: "stop", returnPct: -6, swingScore: 61, volumeRatio: 0.82, rsi14: 78, volatility20: 49, marketRegimeLabel: "약세" },
        { patterns: ["하이힐 패턴"], outcome: "stop", returnPct: -5, swingScore: 60, volumeRatio: 0.9, rsi14: 75, volatility20: 47, marketRegimeLabel: "약세" },
        { patterns: ["돌파매매"], outcome: "time_exit", returnPct: -1, swingScore: 62, volumeRatio: 0.95, rsi14: 73, volatility20: 46, marketRegimeLabel: "약세" },
        { patterns: ["컵앤핸들"], outcome: "stop", returnPct: -4, swingScore: 63, volumeRatio: 0.92, rsi14: 74, volatility20: 48, marketRegimeLabel: "약세" },
        { patterns: ["돌파매매"], outcome: "stop", returnPct: -3, swingScore: 64, volumeRatio: 0.98, rsi14: 76, volatility20: 50, marketRegimeLabel: "약세" },
        { patterns: ["밥그릇 2번자리"], outcome: "target", returnPct: 8, swingScore: 70, volumeRatio: 1.22, rsi14: 58, volatility20: 32, marketRegimeLabel: "중립" },
        { patterns: ["밥그릇 1번자리"], outcome: "target", returnPct: 7, swingScore: 68, volumeRatio: 1.1, rsi14: 54, volatility20: 34, marketRegimeLabel: "중립" },
        { patterns: ["밥그릇 패턴"], outcome: "target", returnPct: 6, swingScore: 69, volumeRatio: 1.18, rsi14: 60, volatility20: 30, marketRegimeLabel: "강세" },
        { patterns: ["컵앤핸들"], outcome: "time_exit", returnPct: 1, swingScore: 67, volumeRatio: 1.12, rsi14: 63, volatility20: 37, marketRegimeLabel: "강세" },
        { patterns: ["돌파매매"], outcome: "target", returnPct: 8, swingScore: 71, volumeRatio: 1.35, rsi14: 64, volatility20: 35, marketRegimeLabel: "강세" },
      ],
    });

    expect(overrides.minDefaultSwingScore).toBeGreaterThanOrEqual(66);
    expect(overrides.minVolumeRatio).toBe(1);
    expect(overrides.maxRsi14).toBeLessThanOrEqual(72);
    expect(overrides.maxVolatility20).toBeLessThanOrEqual(42);
  });

  it("keeps defaults when there is not enough active sample", () => {
    const overrides = deriveSwingPredictionQualityOverrides({
      generatedAt: "2026-05-13T00:00:00.000Z",
      totalTrades: 4,
      winRate: 50,
      avgReturnPct: 0.2,
      trades: [
        { patterns: ["밥그릇 1번자리"], outcome: "target", returnPct: 5, swingScore: 66, volumeRatio: 1.1, rsi14: 55, volatility20: 30, marketRegimeLabel: "중립" },
        { patterns: ["돌파매매"], outcome: "stop", returnPct: -3, swingScore: 61, volumeRatio: 0.9, rsi14: 74, volatility20: 44, marketRegimeLabel: "약세" },
      ],
    });

    expect(overrides.minDefaultSwingScore).toBe(62);
    expect(overrides.minEarlyBowlSwingScore).toBe(48);
    expect(overrides.minVolumeRatio).toBe(0.9);
    expect(overrides.maxRsi14).toBe(76);
    expect(overrides.maxVolatility20).toBe(45);
  });
});
