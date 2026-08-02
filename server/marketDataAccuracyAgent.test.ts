import { describe, expect, it } from "vitest";

import { validateOhlcvRows, verifyMarketDataCandidates } from "./marketDataAccuracyAgent";
import type { OhlcvRow } from "./koreaStockMcp";

function row(date: string, close: number): OhlcvRow {
  return {
    날짜: date,
    시가: close - 1,
    고가: close + 2,
    저가: close - 2,
    종가: close,
    거래량: 1000,
    등락률: 0,
  };
}

const candidate = {
  ticker: "005930",
  companyName: "삼성전자",
  market: "코스피" as const,
  currentPrice: 70000,
  triggerPrice: 70500,
  stopLossPrice: 66000,
};

describe("Market Data Accuracy Agent", () => {
  it("rejects duplicate, unordered, or impossible OHLCV rows", () => {
    const result = validateOhlcvRows(
      [row("2026-07-29", 100), row("2026-07-29", 101), row("2026-07-28", 99)],
      "2026-07-30"
    );
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it("accepts a fresh candidate whose name and price agree with the source", async () => {
    const result = await verifyMarketDataCandidates([candidate], {
      now: new Date("2026-07-30T03:00:00.000Z"),
      rowsByTicker: { "005930": [row("2026-07-30", 70000)] },
      namesByTicker: { "005930": "삼성전자" },
      writeReport: false,
    });
    expect(result.accepted).toHaveLength(1);
    expect(result.report.rejected).toBe(0);
  });

  it("rejects stale prices and mismatched company names", async () => {
    const result = await verifyMarketDataCandidates(
      [{ ...candidate, companyName: "잘못된종목", currentPrice: 85000 }],
      {
        now: new Date("2026-07-30T03:00:00.000Z"),
        rowsByTicker: { "005930": [row("2026-07-20", 70000)] },
        namesByTicker: { "005930": "삼성전자" },
        writeReport: false,
      }
    );
    expect(result.accepted).toHaveLength(0);
    expect(result.report.records[0].issues.map(item => item.code)).toEqual(
      expect.arrayContaining(["name_mismatch", "stale_quote", "price_mismatch"])
    );
  });
});
