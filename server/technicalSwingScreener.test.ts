import { describe, expect, it } from "vitest";

import {
  mergeOverflowIntoWatchlist,
  rankBowlFocusedCandidates,
  resolveSwingPatternWeights,
  SWING_PATTERN_BASE_WEIGHTS,
  type TechnicalSwingCandidate,
} from "./technicalSwingScreener";

function candidate(
  ticker: string,
  patterns: TechnicalSwingCandidate["patterns"],
  swingScore: number,
  rsi14: number,
  currentPrice = 100,
  triggerPrice = 101
): TechnicalSwingCandidate {
  return {
    ticker,
    companyName: ticker,
    market: "코스피",
    patterns,
    swingScore,
    swingFit: swingScore >= 78 ? "상" : swingScore >= 62 ? "중" : "관찰",
    currentPrice,
    triggerPrice,
    stopLossPrice: 93,
    volumeRatio: 1.1,
    rsi14,
    reason: [],
  };
}

describe("rankBowlFocusedCandidates", () => {
  it("prioritizes bowl position 1 and 2 candidates ahead of overheated breakout names", () => {
    const ranked = rankBowlFocusedCandidates([
      candidate("breakout", ["돌파매매"], 88, 81, 100, 100),
      candidate("heel", ["하이힐 패턴"], 82, 78, 100, 101),
      candidate("bowl2", ["밥그릇 2번자리"], 64, 58, 100, 102),
      candidate("bowl1", ["밥그릇 1번자리"], 57, 51, 100, 102),
      candidate("complete", ["밥그릇 패턴"], 75, 63, 100, 103),
    ]);

    expect(ranked.slice(0, 2).map(item => item.ticker)).toEqual(["bowl2", "bowl1"]);
    expect(ranked.map(item => item.ticker).indexOf("breakout")).toBeGreaterThan(2);
  });
});

describe("mergeOverflowIntoWatchlist", () => {
  it("does not drop a gate-passing name that lost the top-N cut", () => {
    const ranked = [candidate("kept", ["돌파매매"], 90, 60)];
    const allPassing = [ranked[0], candidate("overflow", ["밥그릇 2번자리"], 85, 55)];

    const watchlist = mergeOverflowIntoWatchlist(ranked, allPassing, [], 5);

    expect(watchlist.map(item => item.ticker)).toContain("overflow");
  });

  it("ranks overflow ahead of a genuine near-miss with a higher raw score", () => {
    // 근접미달(87) vs 상한초과(80) — 상한 넘은 쪽이 모든 하드게이트를 통과했으므로 우선.
    const ranked = [candidate("kept", ["돌파매매"], 95, 60)];
    const allPassing = [ranked[0], candidate("overflow", ["밥그릇 2번자리"], 80, 55)];
    const nearMiss = [candidate("near-miss", ["하이힐 패턴"], 87, 58)];

    const watchlist = mergeOverflowIntoWatchlist(ranked, allPassing, nearMiss, 5);

    expect(watchlist.map(item => item.ticker)).toEqual(["overflow", "near-miss"]);
  });

  it("respects the limit instead of unbounded growth", () => {
    const allPassing = Array.from({ length: 20 }, (_, i) => candidate(`t${i}`, ["돌파매매"], 50 + i, 55));
    const watchlist = mergeOverflowIntoWatchlist([], allPassing, [], 12);
    expect(watchlist).toHaveLength(12);
  });

  it("returns nothing when every gate-passer made the cut and there is no watch backlog", () => {
    const ranked = [candidate("kept", ["돌파매매"], 90, 60)];
    expect(mergeOverflowIntoWatchlist(ranked, ranked, [], 5)).toEqual([]);
  });
});

describe("resolveSwingPatternWeights", () => {
  it("clamps learned overrides and falls back to base weights", () => {
    const resolved = resolveSwingPatternWeights({
      "밥그릇 2번자리": 99,
      "하이힐 패턴": -5,
    });

    expect(resolved["밥그릇 2번자리"]).toBe(26);
    expect(resolved["하이힐 패턴"]).toBe(3);
    expect(resolved["돌파매매"]).toBe(SWING_PATTERN_BASE_WEIGHTS["돌파매매"]);
  });
});
