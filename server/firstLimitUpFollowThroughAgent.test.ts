import { describe, expect, it } from "vitest";

import {
  rankFirstLimitUpFollowThroughCandidates,
  shouldAttemptDynamicFirstLimitUpSeedCollection,
  type FirstLimitUpFollowThroughCandidate,
} from "./firstLimitUpFollowThroughAgent";

function candidate(
  ticker: string,
  strategy: FirstLimitUpFollowThroughCandidate["strategy"],
  score: number,
  rsi14: number,
  daysSinceFirstLimitUp: number,
  pullbackPct: number,
  volumeRatio: number
): FirstLimitUpFollowThroughCandidate {
  return {
    ticker,
    companyName: ticker,
    market: "코스닥",
    firstLimitUpScore: score,
    strategy,
    currentPrice: 100,
    triggerPrice: 104,
    stopLossPrice: 92,
    firstLimitUpDate: "2026-05-01",
    firstLimitUpClose: 100,
    daysSinceFirstLimitUp,
    pullbackPct,
    volumeRatio,
    turnoverPulse: volumeRatio,
    rsi14,
    setup: [strategy],
    reason: [],
  };
}

describe("rankFirstLimitUpFollowThroughCandidates", () => {
  it("prioritizes first-limit-up pullback and continuation setups over overheated late chasers", () => {
    const ranked = rankFirstLimitUpFollowThroughCandidates([
      candidate("late", "후발 추격 제외", 91, 88, 7, 0, 4.2),
      candidate("pullback", "첫 상한가 눌림목", 66, 61, 3, -8, 1.4),
      candidate("continuation", "연속 상한가 후보", 74, 70, 1, 2, 2.1),
    ]);

    expect(ranked.slice(0, 2).map(item => item.ticker)).toEqual(["pullback", "continuation"]);
    expect(ranked[2].ticker).toBe("late");
  });
});

describe("shouldAttemptDynamicFirstLimitUpSeedCollection", () => {
  it("requires both KRX login environment variables", () => {
    expect(shouldAttemptDynamicFirstLimitUpSeedCollection({})).toBe(false);
    expect(shouldAttemptDynamicFirstLimitUpSeedCollection({ KRX_ID: "demo" })).toBe(false);
    expect(shouldAttemptDynamicFirstLimitUpSeedCollection({ KRX_PW: "demo" })).toBe(false);
    expect(
      shouldAttemptDynamicFirstLimitUpSeedCollection({
        KRX_ID: "demo",
        KRX_PW: "secret",
      })
    ).toBe(true);
  });
});
