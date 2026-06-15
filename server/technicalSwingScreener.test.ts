import { describe, expect, it } from "vitest";

import {
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
