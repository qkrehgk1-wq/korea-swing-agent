import { describe, expect, it } from "vitest";

import {
  rankBottomLimitUpCandidates,
  type LimitUpPredictionCandidate,
} from "./limitUpPredictionAgent";

function candidate(
  ticker: string,
  setup: string[],
  limitUpScore: number,
  rsi14: number,
  dayReturn: number,
  volumeRatio: number
): LimitUpPredictionCandidate {
  return {
    ticker,
    companyName: ticker,
    market: "코스피",
    limitUpScore,
    limitUpFit: limitUpScore >= 78 ? "상" : limitUpScore >= 66 ? "중" : "관찰",
    currentPrice: 100,
    triggerPrice: 103,
    stopLossPrice: 92,
    estimatedLimitPrice: 130,
    dayReturn,
    volumeRatio,
    turnoverPulse: volumeRatio,
    rsi14,
    setup,
    reason: [],
  };
}

describe("rankBottomLimitUpCandidates", () => {
  it("prioritizes bottom-zone ignition candidates over already extended limit-up setups", () => {
    const ranked = rankBottomLimitUpCandidates([
      candidate("extended", ["20일 신고가 근접", "거래량 급증", "종가 고가권 마감"], 88, 84, 16, 3.2),
      candidate("bottom1", ["바닥권 거래량 점화", "20일선 회복 초입"], 64, 52, 4.5, 1.6),
      candidate("bottom2", ["바닥권 거래량 점화", "저점 대비 초기 반등"], 59, 47, 2.8, 1.35),
    ]);

    expect(ranked.slice(0, 2).map(item => item.ticker)).toEqual(["bottom1", "bottom2"]);
    expect(ranked.map(item => item.ticker).indexOf("extended")).toBeGreaterThan(1);
  });
});
