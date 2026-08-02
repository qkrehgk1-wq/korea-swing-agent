import { describe, expect, it } from "vitest";

import type { OhlcvRow } from "./koreaStockMcp";
import {
  auditHistoricalRecommendationEntry,
  marketDataCutoffDate,
} from "./marketDataJournalAudit";
import type { RecommendationEntry } from "./recommendationJournalAgent";

function row(date: string, close: number): OhlcvRow {
  return {
    날짜: date,
    시가: close,
    고가: close + 5,
    저가: close - 5,
    종가: close,
    거래량: 1000,
  };
}

function entry(overrides: Partial<RecommendationEntry> = {}): RecommendationEntry {
  return {
    date: "2026-07-30",
    ticker: "005930",
    companyName: "삼성전자",
    market: "코스피",
    source: "swing",
    currentPrice: 100,
    triggerPrice: 105,
    stopLossPrice: 90,
    targetPrice: 130,
    recordedAt: "2026-07-30T03:37:00.000Z",
    status: "open",
    ...overrides,
  };
}

describe("marketDataJournalAudit", () => {
  const rows = [row("2026-07-29", 100), row("2026-07-30", 200)];

  it("uses the previous trading bar for a pre-close KST record", () => {
    const candidate = entry();
    expect(marketDataCutoffDate(candidate)).toBe("2026-07-29");
    const check = auditHistoricalRecommendationEntry(candidate, rows, "삼성전자");
    expect(check.referenceDate).toBe("2026-07-29");
    expect(check.priceDriftPct).toBe(0);
    expect(check.issues).toEqual([]);
  });

  it("uses the same-day bar after the KST close and catches price drift", () => {
    const candidate = entry({
      currentPrice: 190,
      recordedAt: "2026-07-30T09:00:00.000Z",
    });
    expect(marketDataCutoffDate(candidate)).toBe("2026-07-30");
    const check = auditHistoricalRecommendationEntry(candidate, rows, "삼성전자");
    expect(check.referenceDate).toBe("2026-07-30");
    expect(check.priceDriftPct).toBe(5);
    expect(check.issues).toContain("현재가가 참조 종가와 불일치");
  });
});
