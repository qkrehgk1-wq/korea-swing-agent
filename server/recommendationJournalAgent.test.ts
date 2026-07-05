import { describe, expect, it } from "vitest";

import type { OhlcvRow } from "./koreaStockMcp";
import {
  isoDateMinusDays,
  kstDate,
  scoreEntry,
  summarizeByFactor,
  summarizeJournal,
  type JournalConfig,
  type RecommendationEntry,
} from "./recommendationJournalAgent";

describe("isoDateMinusDays", () => {
  it("shifts a yyyy-mm-dd back by N days across month boundaries", () => {
    expect(isoDateMinusDays("2026-06-21", 20)).toBe("2026-06-01");
    expect(isoDateMinusDays("2026-03-05", 10)).toBe("2026-02-23");
  });
});

function row(date: string, high: number, low: number, close: number): OhlcvRow {
  return { 날짜: date, 시가: close, 고가: high, 저가: low, 종가: close, 거래량: 1000 };
}

function openEntry(overrides: Partial<RecommendationEntry> = {}): RecommendationEntry {
  return {
    date: "2026-01-01",
    ticker: "005930",
    companyName: "삼성전자",
    source: "swing",
    triggerPrice: 100,
    stopLossPrice: 90,
    targetPrice: 120,
    recordedAt: "2026-01-01T00:00:00.000Z",
    status: "open",
    ...overrides,
  };
}

const config: JournalConfig = { entryWindow: 5, holdingDays: 15 };

describe("kstDate", () => {
  it("formats as yyyy-mm-dd", () => {
    expect(kstDate(new Date("2026-06-16T20:00:00Z"))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("scoreEntry", () => {
  it("records a target hit", () => {
    const rows = [
      row("2026-01-02", 105, 98, 102), // triggers (high >= 100)
      row("2026-01-03", 125, 119, 124), // target (high >= 120)
    ];
    const scored = scoreEntry(openEntry(), rows, config);
    expect(scored.status).toBe("target");
    expect(scored.returnPct).toBe(20);
    expect(scored.entryDate).toBe("2026-01-02");
    expect(scored.exitDate).toBe("2026-01-03");
  });

  it("records a stop hit", () => {
    const rows = [
      row("2026-01-02", 105, 98, 100), // triggers
      row("2026-01-03", 101, 88, 92), // stop (low <= 90)
    ];
    const scored = scoreEntry(openEntry(), rows, config);
    expect(scored.status).toBe("stop");
    expect(scored.returnPct).toBe(-10);
  });

  it("records a time exit at the last close", () => {
    const rows = [
      row("2026-01-02", 105, 98, 100), // triggers
      row("2026-01-03", 110, 96, 105),
      row("2026-01-04", 112, 99, 107),
      row("2026-01-05", 111, 98, 108), // last close
    ];
    const scored = scoreEntry(openEntry(), rows, { entryWindow: 5, holdingDays: 3 });
    expect(scored.status).toBe("time_exit");
    expect(scored.returnPct).toBe(8);
  });

  it("marks no-entry once the entry window passes without triggering", () => {
    const rows = [
      row("2026-01-02", 95, 90, 93),
      row("2026-01-03", 96, 91, 94),
      row("2026-01-04", 97, 92, 95),
      row("2026-01-05", 96, 91, 94),
      row("2026-01-06", 95, 90, 93),
    ];
    expect(scoreEntry(openEntry(), rows, config).status).toBe("no_entry");
  });

  it("stays open while still maturing", () => {
    const notEnough = [row("2026-01-02", 95, 90, 93), row("2026-01-03", 96, 91, 94)];
    expect(scoreEntry(openEntry(), notEnough, config).status).toBe("open");

    const triggeredButShort = [row("2026-01-02", 105, 98, 100), row("2026-01-03", 110, 96, 105)];
    expect(scoreEntry(openEntry(), triggeredButShort, config).status).toBe("open");
  });

  it("leaves already-settled entries untouched", () => {
    const settled = openEntry({ status: "target", returnPct: 20 });
    expect(scoreEntry(settled, [row("2026-01-02", 200, 80, 150)], config)).toBe(settled);
  });
});

describe("summarizeJournal", () => {
  it("aggregates realized performance over triggered picks", () => {
    const entries: RecommendationEntry[] = [
      openEntry({ status: "target", returnPct: 20 }),
      openEntry({ status: "stop", returnPct: -10 }),
      openEntry({ status: "time_exit", returnPct: 5 }),
      openEntry({ status: "no_entry", returnPct: 0 }),
      openEntry({ status: "open" }),
    ];
    const summary = summarizeJournal(entries);
    expect(summary.total).toBe(5);
    expect(summary.triggered).toBe(3);
    expect(summary.open).toBe(1);
    expect(summary.noEntry).toBe(1);
    expect(summary.wins).toBe(2);
    expect(summary.losses).toBe(1);
    expect(summary.winRate).toBe(66.7);
    expect(summary.avgReturnPct).toBe(5);
    expect(summary.targetRate).toBe(33.3);
    expect(summary.stopRate).toBe(33.3);
  });

  it("handles an empty journal", () => {
    const summary = summarizeJournal([]);
    expect(summary.total).toBe(0);
    expect(summary.winRate).toBe(0);
    expect(summary.avgReturnPct).toBe(0);
  });
});

describe("summarizeByFactor", () => {
  it("buckets realized performance by supply and news state", () => {
    const entries: RecommendationEntry[] = [
      openEntry({ status: "target", returnPct: 10, supplyState: "accumulating", newsState: "positive" }),
      openEntry({ status: "target", returnPct: 8, supplyState: "accumulating", newsState: "neutral" }),
      openEntry({ status: "stop", returnPct: -5, supplyState: "distributing", newsState: "negative" }),
      openEntry({ status: "open", supplyState: "accumulating" }), // not settled → ignored
    ];
    const { supply, news } = summarizeByFactor(entries);

    const accumulating = supply.find(bucket => bucket.label === "매집")!;
    expect(accumulating.settled).toBe(2);
    expect(accumulating.winRate).toBe(100);
    expect(accumulating.avgReturnPct).toBe(9);

    const distributing = supply.find(bucket => bucket.label === "분산")!;
    expect(distributing.settled).toBe(1);
    expect(distributing.winRate).toBe(0);

    expect(news.find(bucket => bucket.label === "악재")!.settled).toBe(1);
  });
});
