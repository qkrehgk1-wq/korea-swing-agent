import { describe, expect, it } from "vitest";

import type { OhlcvRow } from "./koreaStockMcp";
import {
  classifyMarketState,
  computeBreadth,
  toLegacyRegimeLabel,
} from "./marketState";

function isoDay(offset: number): string {
  const date = new Date(Date.UTC(2026, 0, 1));
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

/** Bars from a close series; high/low hug the close unless widened. */
function bars(closes: number[], spread = 0.005): OhlcvRow[] {
  return closes.map((close, i) => ({
    날짜: isoDay(i),
    시가: close,
    고가: close * (1 + spread),
    저가: close * (1 - spread),
    종가: close,
    거래량: 1000,
  }));
}

function ramp(from: number, to: number, count: number): number[] {
  const step = (to - from) / Math.max(1, count - 1);
  return Array.from({ length: count }, (_, i) => from + step * i);
}

/** A universe of `count` symbols that all follow the same shape. */
function universe(closes: number[], count = 20): Record<string, OhlcvRow[]> {
  const out: Record<string, OhlcvRow[]> = {};
  for (let i = 0; i < count; i += 1) out[`T${i}`] = bars(closes);
  return out;
}

describe("computeBreadth", () => {
  it("measures participation across the universe", () => {
    const rising = bars(ramp(100, 160, 80));
    const falling = bars(ramp(160, 100, 80));
    const breadth = computeBreadth({ UP1: rising, UP2: rising, DOWN1: falling });

    expect(breadth.measured).toBe(3);
    expect(breadth.aboveMa20Pct).toBeCloseTo(66.7, 0);
    expect(breadth.advancing5dPct).toBeCloseTo(66.7, 0);
  });

  it("ignores symbols without enough history", () => {
    expect(computeBreadth({ SHORT: bars(ramp(100, 110, 10)) }).measured).toBe(0);
  });

  it("is point-in-time safe — a past date cannot see later bars", () => {
    // Rises for 80 bars, then collapses. As of the pre-collapse date, breadth
    // must still read healthy.
    const closes = [...ramp(100, 160, 80), ...ramp(160, 90, 40)];
    const rows = bars(closes);
    const asOf = rows[79].날짜;

    expect(computeBreadth({ A: rows }, asOf).aboveMa20Pct).toBe(100);
    expect(computeBreadth({ A: rows }).aboveMa20Pct).toBe(0);
  });
});

describe("classifyMarketState", () => {
  it("calls a healthy uptrend 상승추세 with full risk posture", () => {
    const closes = ramp(100, 170, 120);
    const state = classifyMarketState(bars(closes), universe(closes));

    expect(state.label).toBe("상승추세");
    expect(state.riskPosture).toBe(1);
    expect(state.evidence.ma20AboveMa60).toBe(true);
  });

  it("calls a violent drop 급락 and pins risk posture to zero", () => {
    // Calm uptrend, then a fast high-volatility collapse.
    const closes = [...ramp(100, 150, 100)];
    for (let i = 0; i < 12; i += 1) {
      closes.push(closes[closes.length - 1] * (i % 2 === 0 ? 0.94 : 0.98));
    }
    const state = classifyMarketState(bars(closes), universe(closes));

    expect(state.label).toBe("급락");
    expect(state.riskPosture).toBe(0);
    expect(state.evidence.drawdownFromHigh60).toBeLessThan(-12);
  });

  it("separates a breadth-confirmed rebound from a dead-cat bounce", () => {
    // Same index shape for both: deep drop, then a sharp 5-day bounce.
    const indexCloses = [...ramp(100, 150, 90), ...ramp(150, 110, 25), ...ramp(110, 122, 6)];

    // Confirmed: the whole universe bounces with the index.
    const confirmed = classifyMarketState(
      bars(indexCloses),
      universe(indexCloses)
    );

    // Dead-cat: the index bounces but constituents keep sliding.
    const deadUniverse: Record<string, OhlcvRow[]> = {};
    const stillFalling = [...ramp(100, 150, 90), ...ramp(150, 100, 31)];
    for (let i = 0; i < 20; i += 1) deadUniverse[`D${i}`] = bars(stillFalling);
    const deadCat = classifyMarketState(bars(indexCloses), deadUniverse);

    expect(confirmed.label).toBe("반등확인");
    expect(deadCat.label).toBe("반등초기");
    // The unconfirmed bounce must carry materially less risk.
    expect(deadCat.riskPosture).toBeLessThan(confirmed.riskPosture);
  });

  it("reports insufficient data instead of guessing", () => {
    const state = classifyMarketState(bars(ramp(100, 110, 10)), {});
    expect(state.confidence).toBe(0);
    expect(state.riskPosture).toBe(0);
  });
});

describe("toLegacyRegimeLabel", () => {
  it("maps new states onto the legacy three labels", () => {
    const make = (label: string) => ({ label }) as never;
    expect(toLegacyRegimeLabel(make("상승추세"))).toBe("강세");
    expect(toLegacyRegimeLabel(make("반등확인"))).toBe("강세");
    expect(toLegacyRegimeLabel(make("급락"))).toBe("약세");
    expect(toLegacyRegimeLabel(make("조정"))).toBe("약세");
    expect(toLegacyRegimeLabel(make("반등초기"))).toBe("중립");
    expect(toLegacyRegimeLabel(make("횡보"))).toBe("중립");
  });
});
