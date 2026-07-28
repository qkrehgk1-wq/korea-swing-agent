/**
 * Expectancy & risk-unit math — the part of trading that is provable rather than
 * predictive. Pure functions, no IO.
 *
 * Selection skill has a ceiling and decays as other agents crowd the same
 * signals; the arithmetic of edge-per-risk and bet sizing does not. Two systems
 * with identical picks compound very differently depending on sizing, so we
 * measure the strategy in R-multiples (profit ÷ risk taken) instead of raw %,
 * and derive a risk budget from the strategy's OWN measured statistics.
 *
 * Definitions:
 *   R          = (exit − entry) ÷ (entry − stop). One unit of planned risk.
 *   Expectancy = mean R per trade. Positive ⇒ mathematical edge exists.
 *   Kelly f*   = (p·B − q·A) ÷ (A·B), the growth-optimal fraction of risk
 *                capital, where p = win rate, B = avg win (R), A = avg loss (R).
 *                We report HALF-Kelly and hard-cap it: full Kelly is famously
 *                over-aggressive under parameter uncertainty, and our win rate
 *                is estimated from a small sample.
 */

export type RTrade = {
  triggerPrice: number;
  stopLossPrice: number;
  returnPct: number;
  outcome?: string;
};

export type ExpectancyStats = {
  trades: number;
  winRate: number; // %
  avgWinR: number;
  avgLossR: number; // positive magnitude
  expectancyR: number; // mean R per trade — the headline number
  profitFactor: number; // gross win R ÷ gross loss R
  edgeVerdict: "positive" | "breakeven" | "negative" | "insufficient";
};

export type RiskBudget = {
  kellyFraction: number; // full Kelly, fraction of risk capital
  halfKellyPct: number; // half Kelly as %, capped
  cappedBy: "kelly" | "max" | "floor";
  note: string;
};

const MIN_TRADES_FOR_VERDICT = 10;

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * R-multiple of a single trade: profit measured in units of the risk that was
 * planned when the trade was taken. Returns null when risk is undefined
 * (stop above trigger, or missing prices), so bad rows never skew the stats.
 */
export function toRMultiple(trade: RTrade): number | null {
  const risk = trade.triggerPrice - trade.stopLossPrice;
  if (!(risk > 0) || !(trade.triggerPrice > 0)) return null;
  const riskPct = (risk / trade.triggerPrice) * 100;
  if (!(riskPct > 0)) return null;
  return trade.returnPct / riskPct;
}

/** Expectancy in R over a set of settled trades. */
export function computeExpectancy(trades: RTrade[]): ExpectancyStats {
  const rs = trades
    .filter(trade => trade.outcome !== "not_triggered")
    .map(toRMultiple)
    .filter((value): value is number => value !== null);

  if (rs.length === 0) {
    return {
      trades: 0,
      winRate: 0,
      avgWinR: 0,
      avgLossR: 0,
      expectancyR: 0,
      profitFactor: 0,
      edgeVerdict: "insufficient",
    };
  }

  const wins = rs.filter(value => value > 0);
  const losses = rs.filter(value => value <= 0);
  const grossWin = wins.reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
  const expectancyR = rs.reduce((sum, value) => sum + value, 0) / rs.length;

  const edgeVerdict: ExpectancyStats["edgeVerdict"] =
    rs.length < MIN_TRADES_FOR_VERDICT
      ? "insufficient"
      : expectancyR > 0.1
        ? "positive"
        : expectancyR < -0.1
          ? "negative"
          : "breakeven";

  return {
    trades: rs.length,
    winRate: round((wins.length / rs.length) * 100, 1),
    avgWinR: wins.length ? round(grossWin / wins.length) : 0,
    avgLossR: losses.length ? round(grossLoss / losses.length) : 0,
    expectancyR: round(expectancyR, 3),
    profitFactor: grossLoss > 0 ? round(grossWin / grossLoss) : wins.length ? 99 : 0,
    edgeVerdict,
  };
}

/**
 * Half-Kelly risk budget derived from measured statistics. Deliberately
 * conservative: half of the growth-optimal fraction, hard-capped, and zero
 * whenever the measured edge is not positive — sizing up a negative-expectancy
 * strategy is the fastest way to lose, no matter how good the picks look.
 */
export function computeRiskBudget(stats: ExpectancyStats): RiskBudget {
  const maxPct = Number(process.env.RISK_BUDGET_MAX_PCT) || 2;

  if (stats.edgeVerdict === "insufficient") {
    return {
      kellyFraction: 0,
      halfKellyPct: 0,
      cappedBy: "floor",
      note: `표본 ${stats.trades}건 — 기대값 판정 불가(사이징 산출 보류)`,
    };
  }
  if (stats.expectancyR <= 0 || stats.avgWinR <= 0 || stats.avgLossR <= 0) {
    return {
      kellyFraction: 0,
      halfKellyPct: 0,
      cappedBy: "floor",
      note: "기대값이 양수가 아님 — 수학적으로 베팅 크기 확대 금지 구간",
    };
  }

  const p = stats.winRate / 100;
  const q = 1 - p;
  const kelly = (p * stats.avgWinR - q * stats.avgLossR) / (stats.avgWinR * stats.avgLossR);
  const halfKellyPct = (Math.max(0, kelly) / 2) * 100;
  const capped = Math.min(halfKellyPct, maxPct);

  return {
    kellyFraction: round(kelly, 4),
    halfKellyPct: round(capped, 2),
    cappedBy: capped < halfKellyPct ? "max" : "kelly",
    note:
      capped < halfKellyPct
        ? `하프켈리 ${round(halfKellyPct, 2)}% → 상한 ${maxPct}%로 제한(추정오차 방어)`
        : `하프켈리 기준 리스크 예산 ${round(capped, 2)}%`,
  };
}

/** One-line diagnostic for reports/alerts. */
export function formatExpectancy(stats: ExpectancyStats, budget: RiskBudget): string {
  if (stats.edgeVerdict === "insufficient") {
    return `기대값: 표본 ${stats.trades}건으로 판정 보류`;
  }
  const verdict =
    stats.edgeVerdict === "positive" ? "우위 있음" : stats.edgeVerdict === "negative" ? "우위 없음" : "손익분기";
  return `기대값 ${stats.expectancyR}R/거래 (${verdict}) · 손익비 ${stats.profitFactor} · 평균이익 ${stats.avgWinR}R/평균손실 ${stats.avgLossR}R · 리스크예산 ${budget.halfKellyPct}%`;
}
