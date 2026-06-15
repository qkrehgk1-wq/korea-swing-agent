import { describe, expect, it } from "vitest";

import { rankKosdaqFocusCandidates } from "./kosdaqSwingTeam";

describe("rankKosdaqFocusCandidates", () => {
  it("keeps only Kosdaq candidates and prioritizes focused setups", () => {
    const ranked = rankKosdaqFocusCandidates([
      {
        ticker: "A",
        companyName: "Kosdaq Alpha",
        market: "코스닥",
        patterns: ["밥그릇 2번자리"],
        swingScore: 72,
        swingFit: "상",
        currentPrice: 1000,
        triggerPrice: 1020,
        stopLossPrice: 940,
        volumeRatio: 1.4,
        rsi14: 58,
        volatility20: 32,
        marketRegimeLabel: "강세",
        marketRegimeScore: 70,
        reason: ["우측 회복"],
      },
      {
        ticker: "B",
        companyName: "Kosdaq Beta",
        market: "코스닥",
        patterns: ["돌파매매"],
        swingScore: 76,
        swingFit: "중",
        currentPrice: 2000,
        triggerPrice: 2040,
        stopLossPrice: 1910,
        volumeRatio: 0.9,
        rsi14: 74,
        volatility20: 58,
        marketRegimeLabel: "중립",
        marketRegimeScore: 55,
        reason: ["상단 압박"],
      },
      {
        ticker: "C",
        companyName: "Kospi Gamma",
        market: "코스피",
        patterns: ["밥그릇 1번자리"],
        swingScore: 90,
        swingFit: "상",
        currentPrice: 3000,
        triggerPrice: 3040,
        stopLossPrice: 2800,
        volumeRatio: 1.2,
        rsi14: 51,
        volatility20: 30,
        marketRegimeLabel: "강세",
        marketRegimeScore: 74,
        reason: ["코스피 후보"],
      },
    ]);

    expect(ranked).toHaveLength(2);
    expect(ranked.every(candidate => candidate.market === "코스닥")).toBe(true);
    expect(ranked[0]?.ticker).toBe("A");
  });
});
