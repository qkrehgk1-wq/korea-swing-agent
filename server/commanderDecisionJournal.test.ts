import { describe, expect, it } from "vitest";

import {
  buildCallbackData,
  buildCommanderScorecard,
  formatScorecardLine,
  mergeDecisions,
  parseCallbackData,
  parseTextDecision,
  type CommanderDecision,
} from "./commanderDecisionJournal";
import type { RecommendationEntry } from "./recommendationJournalAgent";

function decision(overrides: Partial<CommanderDecision> = {}): CommanderDecision {
  return {
    date: "2026-08-06",
    ticker: "005930",
    action: "entered",
    decidedAt: "2026-08-06T10:00:00.000Z",
    source: "tap",
    ...overrides,
  };
}

function pick(overrides: Partial<RecommendationEntry> = {}): RecommendationEntry {
  return {
    date: "2026-08-06",
    ticker: "005930",
    companyName: "삼성전자",
    source: "swing",
    triggerPrice: 100,
    stopLossPrice: 90,
    targetPrice: 125,
    recordedAt: "2026-08-06T00:00:00.000Z",
    status: "target",
    returnPct: 20,
    ...overrides,
  };
}

describe("callback data round-trip", () => {
  it("survives encode → decode for every action", () => {
    for (const action of ["entered", "watching", "passed"] as const) {
      const encoded = buildCallbackData(action, "005930", "2026-08-06");
      expect(parseCallbackData(encoded)).toEqual({
        action,
        ticker: "005930",
        date: "2026-08-06",
      });
    }
  });

  it("stays inside Telegram's 64-byte callback_data limit", () => {
    const encoded = buildCallbackData("watching", "005930", "2026-08-06");
    expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(64);
  });

  it("rejects malformed or foreign payloads instead of guessing", () => {
    expect(parseCallbackData("garbage")).toBeNull();
    expect(parseCallbackData("d|x|005930|2026-08-06")).toBeNull();
    expect(parseCallbackData("d|e|ABC|2026-08-06")).toBeNull();
    expect(parseCallbackData("d|e|005930|8/6")).toBeNull();
  });
});

describe("parseTextDecision", () => {
  it("reads a typed decision for a stock that was never in the alert", () => {
    expect(parseTextDecision("005930 진입", "2026-08-06")).toEqual({
      action: "entered",
      ticker: "005930",
      date: "2026-08-06",
    });
    expect(parseTextDecision("패스 000660", "2026-08-06")?.action).toBe("passed");
  });

  it("ignores chatter with no ticker or no action word", () => {
    expect(parseTextDecision("오늘 뭐 사지", "2026-08-06")).toBeNull();
    expect(parseTextDecision("005930", "2026-08-06")).toBeNull();
  });
});

describe("mergeDecisions", () => {
  it("lets a later tap replace an earlier one for the same pick", () => {
    const merged = mergeDecisions(
      [decision({ action: "passed" })],
      [decision({ action: "entered", decidedAt: "2026-08-06T12:00:00.000Z" })]
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].action).toBe("entered");
  });

  it("keeps decisions for different days and tickers apart", () => {
    const merged = mergeDecisions(
      [decision()],
      [decision({ ticker: "000660" }), decision({ date: "2026-08-07" })]
    );
    expect(merged).toHaveLength(3);
  });
});

describe("buildCommanderScorecard", () => {
  it("separates what was taken from what was passed, against the system baseline", () => {
    const journal = [
      pick({ ticker: "005930", returnPct: 20 }),
      pick({ ticker: "000660", returnPct: -10, status: "stop" }),
      pick({ ticker: "035720", returnPct: 5, status: "time_exit" }),
    ];
    const decisions = [
      decision({ ticker: "005930", action: "entered" }),
      decision({ ticker: "000660", action: "passed" }),
    ];

    const card = buildCommanderScorecard(decisions, journal);
    expect(card.taken).toEqual({ count: 1, winRate: 100, avgReturnPct: 20 });
    expect(card.passed).toEqual({ count: 1, winRate: 0, avgReturnPct: -10 });
    expect(card.system.count).toBe(3);
    // Took the winner, skipped the loser → selection beat the system average.
    expect(card.selectionEdgePct).toBeGreaterThan(0);
    expect(card.undecided).toBe(1);
  });

  it("excludes shadow (watch-only) picks so it matches headline stats", () => {
    const journal = [
      pick({ ticker: "005930", returnPct: 20 }),
      pick({ ticker: "000660", returnPct: 50, watchOnly: true }),
    ];
    expect(buildCommanderScorecard([], journal).system.count).toBe(1);
  });

  it("reports zeros rather than dividing by zero on an empty journal", () => {
    const card = buildCommanderScorecard([], []);
    expect(card.taken.count).toBe(0);
    expect(card.selectionEdgePct).toBe(0);
  });
});

describe("formatScorecardLine", () => {
  const card = (takenAvg: number, systemAvg: number, count: number) => ({
    taken: { count, winRate: 60, avgReturnPct: takenAvg },
    passed: { count: 0, winRate: 0, avgReturnPct: 0 },
    system: { count: 10, winRate: 50, avgReturnPct: systemAvg },
    selectionEdgePct: Number((takenAvg - systemAvg).toFixed(2)),
    undecided: 0,
  });

  it("stays quiet until the sample can mean something", () => {
    expect(formatScorecardLine(card(5, 3, 0))).toBe("");
    expect(formatScorecardLine(card(5, 3, 2))).toContain("축적 중");
  });

  it("states plainly whether the commander beat the system", () => {
    expect(formatScorecardLine(card(5, 3, 8))).toContain("선택이 시스템보다 좋음");
    expect(formatScorecardLine(card(1, 3, 8))).toContain("시스템 평균보다 낮음");
  });
});
