/**
 * Market state engine — replaces the old 3-label regime score.
 *
 * The previous detector graded the index on four lagging rules (price vs MA20,
 * MA20 vs MA60, 20-day return, RSI band) and collapsed the answer to
 * 강세/중립/약세. Two things went wrong with that in practice:
 *
 *   1. It cannot tell a crash from the rebound that follows one. After a sharp
 *      drop, MA20 stays under MA60 and the 20-day return stays negative for
 *      weeks, so the tape reads "약세" while the market is actually recovering —
 *      measured live on 2026-08-05, four straight sessions of zero picks during
 *      a real rebound.
 *   2. It only ever looked at the index price. Whether a bounce is real is
 *      mostly a question of participation — how many names are joining — and
 *      participation was never measured, even though the scanner already
 *      downloads 200+ symbols every run. Breadth here is free.
 *
 * So this module keeps trend structure but adds breadth, thrust and volatility,
 * and reports a six-way state plus the evidence behind it. Everything is a pure
 * function of bars already fetched, so the backtest can replay states exactly as
 * live saw them — the live/backtest parity rule this project keeps re-learning.
 */

import type { OhlcvRow } from "./koreaStockMcp";

export type MarketStateLabel =
  | "상승추세"
  | "조정"
  | "급락"
  | "반등초기"
  | "반등확인"
  | "횡보";

export type BreadthSnapshot = {
  /** Symbols with a usable bar at this date. */
  measured: number;
  aboveMa20Pct: number;
  aboveMa60Pct: number;
  /** Share of symbols up over the last 5 sessions — short-term participation. */
  advancing5dPct: number;
  /** 20-day new highs minus new lows, as a share of measured symbols. */
  netNewHighPct: number;
};

export type MarketStateEvidence = {
  indexAboveMa20: boolean;
  ma20AboveMa60: boolean;
  return5d: number;
  return20d: number;
  drawdownFromHigh60: number;
  volatilityRatio: number;
  breadth: BreadthSnapshot;
};

export type MarketState = {
  label: MarketStateLabel;
  /**
   * Trend-and-participation composite, 0–100. Informational only — it still
   * carries lagging terms (MA structure, 20-day return), so at a turn it reads
   * low while the state has already flipped. Do NOT size from this; that is what
   * `riskPosture` is for. A confirmed rebound legitimately shows a low score and
   * a high posture at the same time — that gap IS the turn.
   */
  score: number;
  /** 0–1 — how strongly the evidence agrees on this label. */
  confidence: number;
  /**
   * The actionable output: fraction of normal position risk this state warrants.
   * Composes with (does not replace) the expectancy-based budget in
   * `expectancy.ts` — a negative measured edge still forces 0% overall.
   */
  riskPosture: number;
  notes: string[];
  evidence: MarketStateEvidence;
};

function sma(values: number[], period: number): number {
  if (!values.length) return 0;
  const slice = values.slice(-period);
  return slice.reduce((sum, value) => sum + value, 0) / slice.length;
}

function pctChange(from: number, to: number): number {
  if (!from) return 0;
  return ((to - from) / from) * 100;
}

function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    (values.length - 1);
  return Math.sqrt(variance);
}

function dailyReturns(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i += 1) {
    out.push(pctChange(closes[i - 1], closes[i]));
  }
  return out;
}

/**
 * Participation across the scanned universe as of `asOfDate`.
 *
 * Each symbol is sliced to bars at or before the date, so replaying an old date
 * cannot see the future — the same point-in-time discipline the journal audit
 * uses.
 */
export function computeBreadth(
  rowsByTicker: Record<string, OhlcvRow[] | null | undefined>,
  asOfDate?: string
): BreadthSnapshot {
  let measured = 0;
  let aboveMa20 = 0;
  let aboveMa60 = 0;
  let advancing = 0;
  let newHighs = 0;
  let newLows = 0;

  for (const key of Object.keys(rowsByTicker)) {
    const all = rowsByTicker[key];
    if (!all || all.length < 60) continue;
    const rows = asOfDate ? all.filter(row => row.날짜 <= asOfDate) : all;
    if (rows.length < 60) continue;

    const closes = rows.map(row => row.종가);
    const current = closes[closes.length - 1];
    if (!current) continue;
    measured += 1;

    if (current > sma(closes, 20)) aboveMa20 += 1;
    if (current > sma(closes, 60)) aboveMa60 += 1;
    if (closes.length > 5 && pctChange(closes[closes.length - 6], current) > 0) {
      advancing += 1;
    }

    const window = rows.slice(-20);
    const highs = window.map(row => row.고가);
    const lows = window.map(row => row.저가);
    const last = window[window.length - 1];
    if (last.고가 >= Math.max(...highs)) newHighs += 1;
    if (last.저가 <= Math.min(...lows)) newLows += 1;
  }

  const pct = (count: number) =>
    measured ? Number(((count / measured) * 100).toFixed(1)) : 0;

  return {
    measured,
    aboveMa20Pct: pct(aboveMa20),
    aboveMa60Pct: pct(aboveMa60),
    advancing5dPct: pct(advancing),
    netNewHighPct: measured
      ? Number((((newHighs - newLows) / measured) * 100).toFixed(1))
      : 0,
  };
}

/**
 * Classify the tape.
 *
 * Order matters: a crash is checked before a downtrend, and a rebound before a
 * range, because the whole point is to separate states the old score merged.
 * A rebound is only "확인" once breadth confirms it — price alone bouncing while
 * participation stays dead is exactly the dead-cat case that measured worse
 * than staying out (see PROJECT_CHARTER.md, 2026-08-05).
 */
export function classifyMarketState(
  benchmarkRows: OhlcvRow[] | null | undefined,
  rowsByTicker: Record<string, OhlcvRow[] | null | undefined>,
  asOfDate?: string
): MarketState {
  const all = benchmarkRows ?? [];
  const rows = asOfDate ? all.filter(row => row.날짜 <= asOfDate) : all;
  const breadth = computeBreadth(rowsByTicker, asOfDate);

  if (rows.length < 60) {
    return {
      label: "횡보",
      score: 50,
      confidence: 0,
      riskPosture: 0,
      notes: ["지수 데이터가 부족해 상태를 판정할 수 없습니다."],
      evidence: {
        indexAboveMa20: false,
        ma20AboveMa60: false,
        return5d: 0,
        return20d: 0,
        drawdownFromHigh60: 0,
        volatilityRatio: 1,
        breadth,
      },
    };
  }

  const closes = rows.map(row => row.종가);
  const current = closes[closes.length - 1];
  const ma20 = sma(closes, 20);
  const ma60 = sma(closes, 60);
  const return5d =
    closes.length > 5 ? pctChange(closes[closes.length - 6], current) : 0;
  const return20d =
    closes.length > 20 ? pctChange(closes[closes.length - 21], current) : 0;
  const high60 = Math.max(...closes.slice(-60));
  const drawdownFromHigh60 = pctChange(high60, current);

  const returns = dailyReturns(closes);
  const recentVol = stdev(returns.slice(-20));
  const baseVol = stdev(returns.slice(-120, -20));
  const volatilityRatio = baseVol > 0 ? recentVol / baseVol : 1;

  const evidence: MarketStateEvidence = {
    indexAboveMa20: current > ma20,
    ma20AboveMa60: ma20 > ma60,
    return5d: Number(return5d.toFixed(2)),
    return20d: Number(return20d.toFixed(2)),
    drawdownFromHigh60: Number(drawdownFromHigh60.toFixed(2)),
    volatilityRatio: Number(volatilityRatio.toFixed(2)),
    breadth,
  };

  const notes: string[] = [];
  let label: MarketStateLabel;
  let confidence: number;

  const panicking =
    drawdownFromHigh60 <= -12 && return5d < 0 && volatilityRatio >= 1.3;
  const bouncing = return5d > 2 && drawdownFromHigh60 <= -8;
  const breadthAlive =
    breadth.aboveMa20Pct >= 45 && breadth.advancing5dPct >= 55;

  if (panicking) {
    label = "급락";
    confidence = 0.9;
    notes.push(
      `고점 대비 ${evidence.drawdownFromHigh60}% · 변동성 ${evidence.volatilityRatio}배 — 패닉 구간`
    );
  } else if (bouncing) {
    if (breadthAlive) {
      label = "반등확인";
      confidence = 0.75;
      notes.push(
        `5일 ${evidence.return5d}% 반등 · 20일선 위 종목 ${breadth.aboveMa20Pct}% — 참여 폭이 확인됨`
      );
    } else {
      label = "반등초기";
      confidence = 0.5;
      notes.push(
        `5일 ${evidence.return5d}% 반등이나 20일선 위 종목 ${breadth.aboveMa20Pct}% — 참여 폭 미확인(가짜 반등 경계)`
      );
    }
  } else if (evidence.indexAboveMa20 && evidence.ma20AboveMa60 && return20d > 0) {
    label = "상승추세";
    confidence = breadth.aboveMa20Pct >= 50 ? 0.85 : 0.6;
    notes.push(
      `정배열 · 20일 ${evidence.return20d}% · 20일선 위 종목 ${breadth.aboveMa20Pct}%`
    );
  } else if (!evidence.ma20AboveMa60 && return20d < -3) {
    label = "조정";
    confidence = 0.7;
    notes.push(`역배열 · 20일 ${evidence.return20d}% — 추세 훼손 구간`);
  } else {
    label = "횡보";
    confidence = 0.5;
    notes.push(
      `방향성 불명확 · 20일 ${evidence.return20d}% · 20일선 위 종목 ${breadth.aboveMa20Pct}%`
    );
  }

  // Score blends trend, participation and thrust. Breadth is weighted heavily on
  // purpose: it is the input the old detector lacked entirely.
  let score = 50;
  score += evidence.indexAboveMa20 ? 8 : -8;
  score += evidence.ma20AboveMa60 ? 10 : -10;
  score += return20d > 0 ? 6 : -6;
  score += (breadth.aboveMa20Pct - 50) * 0.3;
  score += (breadth.advancing5dPct - 50) * 0.2;
  score += breadth.netNewHighPct * 0.2;
  if (volatilityRatio >= 1.5) score -= 6;
  score = Math.max(0, Math.min(100, Math.round(score)));

  // Risk posture is deliberately not a straight function of score: 급락 and an
  // unconfirmed bounce are the two states that historically ate capital, so they
  // are pinned near zero regardless of how the arithmetic lands.
  const riskPosture =
    label === "급락"
      ? 0
      : label === "반등초기"
        ? 0.25
        : label === "조정"
          ? 0.4
          : label === "횡보"
            ? 0.6
            : label === "반등확인"
              ? 0.8
              : 1;

  notes.push(
    `참여도: 20일선 위 ${breadth.aboveMa20Pct}% · 5일 상승 ${breadth.advancing5dPct}% · 신고가-신저가 ${breadth.netNewHighPct}% (${breadth.measured}종목)`
  );

  return { label, score, confidence, riskPosture, notes, evidence };
}

/** Legacy bridge: map the new state onto the old three labels. */
export function toLegacyRegimeLabel(
  state: MarketState
): "강세" | "중립" | "약세" {
  if (state.label === "상승추세" || state.label === "반등확인") return "강세";
  if (state.label === "급락" || state.label === "조정") return "약세";
  return "중립";
}
