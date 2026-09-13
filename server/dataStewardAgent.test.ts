import { describe, expect, it } from "vitest";

import {
  classifyHealth,
  currentChampionEntries,
  detectRunGap,
  pickBudgetBasis,
  toReport,
  type SystemAnalysis,
} from "./dataStewardAgent";
import type { ExpectancyStats } from "./expectancy";
import type { RecommendationEntry } from "./recommendationJournalAgent";

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
        lifetime: {
          trades: 40,
          winRate: 30,
          avgWinR: 0.86,
          avgLossR: 0.86,
          expectancyR: -0.345,
          profitFactor: 0.43,
          edgeVerdict: "negative",
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
    expect(md).toContain("현 챔피언");
    expect(md).toContain("전체 이력");
  });
});

function stats(edgeVerdict: ExpectancyStats["edgeVerdict"], expectancyR: number): ExpectancyStats {
  return { trades: 20, winRate: 50, avgWinR: 1, avgLossR: 1, expectancyR, profitFactor: 1, edgeVerdict };
}

function entry(ticker: string, championAt?: string): RecommendationEntry {
  return {
    date: "2026-09-01",
    ticker,
    companyName: ticker,
    market: "코스피",
    source: "swing",
    triggerPrice: 100,
    stopLossPrice: 90,
    targetPrice: 125,
    swingScore: 70,
    recordedAt: "2026-09-01T00:00:00.000Z",
    status: "stop",
    championAt,
  } as RecommendationEntry;
}

describe("currentChampionEntries", () => {
  it("keeps only picks made under the current champion", () => {
    const entries = [entry("A", "2026-06-20"), entry("B", "2026-08-01"), entry("C")];
    expect(currentChampionEntries(entries, "2026-08-01").map(e => e.ticker)).toEqual(["B"]);
  });

  it("returns nothing when no champion is known, rather than falling back to everything", () => {
    // Falling back to the whole journal is exactly how replaced rules ended up
    // driving a daily "negative" alert.
    expect(currentChampionEntries([entry("A", "2026-06-20"), entry("B")], null)).toEqual([]);
  });
});

describe("detectRunGap", () => {
  it("flags the real 2026-08-30..09-01 outage on the first run that came back", () => {
    // Last successful run before GitHub stopped assigning runners, then the
    // first one after: ~96h with no alert, no scoring, no data commit.
    expect(detectRunGap("2026-08-29T21:08:37Z", new Date("2026-09-02T21:13:39Z"), 36)).toBe(96);
  });

  it("stays quiet through normal cron jitter", () => {
    // The widest normal spacing observed (a delayed, not missed, run) was ~29h.
    expect(detectRunGap("2026-08-26T21:08:20Z", new Date("2026-08-28T02:17:53Z"), 36)).toBeNull();
  });

  it("does nothing on the very first run or an unreadable heartbeat", () => {
    expect(detectRunGap(null, new Date("2026-09-13T00:00:00Z"), 36)).toBeNull();
    expect(detectRunGap("not-a-date", new Date("2026-09-13T00:00:00Z"), 36)).toBeNull();
  });
});

describe("pickBudgetBasis", () => {
  const backtest = stats("positive", 0.33);

  it("uses the current champion once it has a verdict", () => {
    expect(pickBudgetBasis(stats("breakeven", 0.04), stats("negative", -0.26), backtest).expectancyR).toBe(0.04);
  });

  it("falls back to lifetime evidence, not the backtest, while a new champion is unproven", () => {
    expect(pickBudgetBasis(stats("insufficient", 0.5), stats("negative", -0.26), backtest).expectancyR).toBe(-0.26);
  });

  it("uses the backtest only when there is no live verdict at all", () => {
    expect(pickBudgetBasis(stats("insufficient", 0), stats("insufficient", 0), backtest).expectancyR).toBe(0.33);
  });
});
