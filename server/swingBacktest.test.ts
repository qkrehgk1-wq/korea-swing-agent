import { describe, expect, it } from "vitest";

import { splitSampleStats } from "./swingBacktestAgent";

type Trade = Parameters<typeof splitSampleStats>[0][number];

function trade(signalDate: string, ticker: string, outcome: string, returnPct: number): Trade {
  return { signalDate, ticker, outcome, returnPct } as unknown as Trade;
}

describe("splitSampleStats", () => {
  it("splits triggered trades chronologically and counts distinct tickers", () => {
    const stats = splitSampleStats([
      trade("2026-01-01", "A", "target", 8),
      trade("2026-02-01", "A", "target", 8), // same name, later
      trade("2026-03-01", "B", "stop", -5),
      trade("2026-04-01", "C", "target", 8),
      trade("2026-05-01", "D", "not_triggered", 0), // excluded from trades
    ]);
    expect(stats.distinctTickers).toBe(4); // A, B, C, D
    expect(stats.inSample.trades + stats.outOfSample.trades).toBe(4); // triggered only
    expect(stats.splitDate).not.toBeNull();
  });

  it("returns no split when there are too few trades", () => {
    const stats = splitSampleStats([trade("2026-01-01", "A", "target", 8)]);
    expect(stats.splitDate).toBeNull();
    expect(stats.outOfSample.trades).toBe(0);
  });
});
