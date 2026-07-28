import { describe, expect, it } from "vitest";

import { classifyHealth, toReport, type SystemAnalysis } from "./dataStewardAgent";

describe("classifyHealth", () => {
  it("classifies by existence and age", () => {
    expect(classifyHealth(false, null, 48)).toBe("missing");
    expect(classifyHealth(true, 10, 48)).toBe("fresh"); // <= half
    expect(classifyHealth(true, 36, 48)).toBe("ok"); // <= staleAfter
    expect(classifyHealth(true, 60, 48)).toBe("stale"); // > staleAfter
  });
});

describe("toReport", () => {
  it("renders catalog, live performance and issues", () => {
    const analysis: SystemAnalysis = {
      generatedAt: "2026-06-21T00:00:00.000Z",
      catalog: [
        {
          key: "추천 저널",
          category: "signals",
          tracked: true,
          exists: true,
          sizeBytes: 2048,
          modifiedAt: "2026-06-21T00:00:00.000Z",
          ageHours: 5,
          records: 13,
          health: "fresh",
        },
        {
          key: "백테스트 리포트",
          category: "learning",
          tracked: false,
          exists: false,
          sizeBytes: 0,
          modifiedAt: null,
          ageHours: null,
          records: null,
          health: "missing",
        },
      ],
      journal: {
        total: 13,
        settled: 0,
        open: 13,
        triggered: 0,
        noEntry: 0,
        wins: 0,
        losses: 0,
        winRate: 0,
        avgReturnPct: 0,
        targetRate: 0,
        stopRate: 0,
      },
      journalByTicker: { settledTickers: 8, winRate: 25, avgReturnPct: -3.4 },
      shadowByTicker: { settledTickers: 3, winRate: 33.3, avgReturnPct: -1.2 },
      expectancy: {
        backtest: {
          trades: 49,
          winRate: 54.7,
          avgWinR: 2.1,
          avgLossR: 1,
          expectancyR: 0.72,
          profitFactor: 1.9,
          edgeVerdict: "positive",
        },
        live: {
          trades: 4,
          winRate: 25,
          avgWinR: 1.2,
          avgLossR: 1,
          expectancyR: -0.45,
          profitFactor: 0.4,
          edgeVerdict: "insufficient",
        },
        budget: { kellyFraction: 0.12, halfKellyPct: 2, cappedBy: "max", note: "상한 2%로 제한" },
      },
      factors: { supply: [], news: [], volumeFlow: [] },
      evolution: { championFitness: null, championAt: null, generations: 0, promotions: 0 },
      backtest: {
        winRate: 76.9,
        avgReturnPct: 2.77,
        totalTrades: 13,
        generatedAt: "x",
        distinctTickers: 30,
        inSampleWinRate: 60.7,
        outOfSampleWinRate: 76.2,
      },
      issues: ["정산 표본 0 — 라이브 검증 데이터 축적 중(진행 13건)"],
    };
    const md = toReport(analysis);
    expect(md).toContain("데이터 카탈로그");
    expect(md).toContain("추천 저널");
    expect(md).toContain("base 시드");
    expect(md).toContain("정산 표본 0");
    expect(md).toContain("종목단위");
    expect(md).toContain("관찰 섀도");
    expect(md).toContain("기대값");
    expect(md).toContain("리스크 예산");
  });
});
