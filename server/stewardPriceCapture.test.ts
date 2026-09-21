import { describe, expect, it } from "vitest";

import { countMissingCurrentPrice } from "./dataStewardAgent";
import type { RecommendationEntry } from "./recommendationJournalAgent";

function entry(date: string, currentPrice?: number): RecommendationEntry {
  return {
    date,
    ticker: "005930",
    companyName: "테스트",
    market: "코스피",
    source: "swing",
    triggerPrice: 100,
    stopLossPrice: 90,
    targetPrice: 125,
    swingScore: 70,
    recordedAt: `${date}T00:00:00.000Z`,
    status: "open",
    currentPrice,
  } as RecommendationEntry;
}

describe("countMissingCurrentPrice", () => {
  const today = "2026-09-21";

  it("does not count old entries that predate the field — they can never be filled in", () => {
    // Shape of the real journal: every Jun–Jul entry lacks the price, all recent ones have it.
    const entries = [
      ...Array.from({ length: 73 }, () => entry("2026-07-10")),
      ...Array.from({ length: 99 }, () => entry("2026-09-15", 50_000)),
    ];
    expect(countMissingCurrentPrice(entries, today, 14)).toEqual({
      recentMissing: 0,
      recentTotal: 99,
      legacyMissing: 73,
    });
  });

  it("fires when price capture breaks now", () => {
    const entries = [entry("2026-09-20", 50_000), entry("2026-09-20"), entry("2026-09-19")];
    const result = countMissingCurrentPrice(entries, today, 14);
    expect(result.recentMissing).toBe(2);
    expect(result.recentTotal).toBe(3);
  });

  it("puts the window edge on the recent side", () => {
    // 14 days before 2026-09-21 is 2026-09-07.
    expect(countMissingCurrentPrice([entry("2026-09-07")], today, 14).recentMissing).toBe(1);
    expect(countMissingCurrentPrice([entry("2026-09-06")], today, 14).recentMissing).toBe(0);
  });
});
