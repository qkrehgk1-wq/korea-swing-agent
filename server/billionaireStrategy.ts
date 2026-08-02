import type { OhlcvRow } from "./koreaStockMcp";
import {
  computeAdx,
  computeVolumeFlow,
  macdBullish,
} from "./technicalConfluence";
import {
  computeExpectancy,
  computeRiskBudget,
  type RTrade,
} from "./expectancy";

/**
 * Billionaire Core v1
 *
 * A market-agnostic trend/pullback strategy assembled from the existing
 * system's strongest ideas: leadership (relative strength), trend alignment,
 * ADX/MACD confirmation, volume-flow confirmation, anti-chase protection,
 * ATR exits, R-based evaluation, and a live-edge risk gate.
 *
 * Patterns, news, LLM opinions, and supply labels are deliberately not part of
 * the historical signal formula. They can explain or veto a live candidate,
 * but adding them to the score without point-in-time history creates leakage
 * and is exactly how a positive backtest can diverge from the live journal.
 */

export type BillionaireStrategyConfig = {
  warmupBars: number;
  signalStepBars: number;
  holdingBars: number;
  entryLookaheadBars: number;
  roundTripCostPct: number;
  fastMaPeriod: number;
  slowMaPeriod: number;
  atrPeriod: number;
  adxPeriod: number;
  minAdx: number;
  minRelativeStrength: number;
  minVolumeRatio: number;
  minRegimeScore: number;
  minSignalScore: number;
  maxRsi: number;
  maxVolatilityPct: number;
  maxExtensionPct: number;
  stopAtrMultiple: number;
  maxRiskPct: number;
  targetR: number;
  entryBufferPct: number;
  breakevenAtR: number;
  trailGivebackR: number;
  stochasticConfirmation: "off" | "boost" | "required";
};

export const DEFAULT_BILLIONAIRE_STRATEGY_CONFIG: BillionaireStrategyConfig = {
  warmupBars: 160,
  signalStepBars: 5,
  holdingBars: 15,
  entryLookaheadBars: 5,
  roundTripCostPct: 0.35,
  fastMaPeriod: 20,
  slowMaPeriod: 60,
  atrPeriod: 14,
  adxPeriod: 14,
  minAdx: 20,
  minRelativeStrength: 0,
  minVolumeRatio: 0.8,
  minRegimeScore: 45,
  minSignalScore: 65,
  maxRsi: 75,
  maxVolatilityPct: 55,
  maxExtensionPct: 15,
  stopAtrMultiple: 2,
  maxRiskPct: 15,
  targetR: 2.5,
  entryBufferPct: 0.5,
  breakevenAtR: 0.6,
  trailGivebackR: 0.5,
  stochasticConfirmation: "boost",
};

export type BillionaireSignalMode = "pullback" | "breakout";
export type BillionaireRegime = "강세" | "중립" | "약세";

export type BillionaireSignal = {
  ticker: string;
  signalDate: string;
  mode: BillionaireSignalMode;
  close: number;
  triggerPrice: number;
  stopLossPrice: number;
  targetPrice: number;
  atr: number;
  adx: number;
  rsi14: number;
  volumeRatio: number;
  relativeStrength20: number;
  relativeStrength60: number;
  volatility20: number;
  regime: BillionaireRegime;
  regimeScore: number;
  signalScore: number;
  reasons: string[];
};

export type BillionaireTrade = BillionaireSignal & {
  entryDate?: string;
  entryPrice?: number;
  exitDate?: string;
  exitPrice?: number;
  outcome: "target" | "stop" | "trail_exit" | "time_exit" | "not_triggered";
  returnPct: number;
  maxFavorableExcursionPct: number;
  maxAdverseExcursionPct: number;
};

export type BillionaireSummary = {
  totalSignals: number;
  totalTrades: number;
  winRate: number;
  avgReturnPct: number;
  medianReturnPct: number;
  stopRate: number;
  targetRate: number;
  noTriggerRate: number;
  grossProfit: number;
  grossLoss: number;
  /** null means profitable with no observed losing trade (display as ∞). */
  profitFactor: number | null;
  expectancyR: number;
  distinctTickers: number;
  inSample: { trades: number; winRate: number; avgReturnPct: number };
  outOfSample: { trades: number; winRate: number; avgReturnPct: number };
};

export type BillionaireBacktestResult = {
  config: BillionaireStrategyConfig;
  benchmarkTicker: string;
  signalWindows: number;
  trades: BillionaireTrade[];
  summary: BillionaireSummary;
  riskBudget: ReturnType<typeof computeRiskBudget>;
};

type Bar = { close: number; high: number; low: number; volume: number };

function toBars(rows: OhlcvRow[]): Bar[] {
  return rows.map(row => ({
    close: row.종가,
    high: row.고가,
    low: row.저가,
    volume: row.거래량,
  }));
}

function average(values: number[]) {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
}

function sma(values: number[], period: number) {
  return average(values.slice(-period));
}

function round(value: number, digits = 2) {
  return Number(value.toFixed(digits));
}

function percentChange(base: number, current: number) {
  return base ? ((current - base) / base) * 100 : 0;
}

function trueRange(bars: Bar[], index: number) {
  if (index === 0) return bars[index].high - bars[index].low;
  const previous = bars[index - 1].close;
  return Math.max(
    bars[index].high - bars[index].low,
    Math.abs(bars[index].high - previous),
    Math.abs(bars[index].low - previous)
  );
}

function atr(bars: Bar[], period: number) {
  return average(
    bars
      .slice(-period)
      .map((_, index) => trueRange(bars, bars.length - period + index))
  );
}

function rsi(closes: number[], period = 14) {
  if (closes.length < period + 1) return 50;
  const changes = closes.slice(1).map((close, index) => close - closes[index]);
  const gains = changes.slice(-period).map(value => Math.max(value, 0));
  const losses = changes.slice(-period).map(value => Math.max(-value, 0));
  const avgGain = average(gains);
  const avgLoss = average(losses);
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function annualizedVolatility(closes: number[]) {
  const returns = closes
    .slice(1)
    .map((close, index) =>
      closes[index] ? (close - closes[index]) / closes[index] : 0
    )
    .slice(-20);
  if (!returns.length) return 0;
  const mean = average(returns);
  const variance = average(returns.map(value => (value - mean) ** 2));
  return Math.sqrt(variance) * Math.sqrt(252) * 100;
}

function stochasticCross(bars: Bar[]) {
  if (bars.length < 20) return false;
  const rawK: number[] = [];
  for (let index = 13; index < bars.length; index += 1) {
    const window = bars.slice(index - 13, index + 1);
    const low = Math.min(...window.map(bar => bar.low));
    const high = Math.max(...window.map(bar => bar.high));
    rawK.push(
      high === low ? 50 : ((bars[index].close - low) / (high - low)) * 100
    );
  }
  const smoothK = rawK.map((_, index) =>
    average(rawK.slice(Math.max(0, index - 2), index + 1))
  );
  const smoothD = smoothK.map((_, index) =>
    average(smoothK.slice(Math.max(0, index - 2), index + 1))
  );
  const last = smoothK.length - 1;
  return (
    last > 0 &&
    smoothK[last - 1] <= smoothD[last - 1] &&
    smoothK[last] > smoothD[last]
  );
}

function regimeSnapshot(benchmarkRows: OhlcvRow[], index: number) {
  const bars = toBars(benchmarkRows.slice(0, index + 1));
  const closes = bars.map(bar => bar.close);
  if (closes.length < 60)
    return { label: "중립" as BillionaireRegime, score: 50 };
  let score = 50;
  const close = closes.at(-1) ?? 0;
  const ma20 = sma(closes, 20);
  const ma60 = sma(closes, 60);
  const return20 = percentChange(closes.at(-21) ?? 0, close);
  const benchmarkRsi = rsi(closes);
  if (close > ma20) score += 10;
  else score -= 10;
  if (ma20 > ma60) score += 12;
  else score -= 12;
  if (return20 > 0) score += 10;
  else score -= 10;
  if (benchmarkRsi >= 50 && benchmarkRsi <= 68) score += 6;
  else if (benchmarkRsi > 72) score -= 4;
  const bounded = Math.max(0, Math.min(100, score));
  return {
    label:
      bounded >= 62
        ? ("강세" as const)
        : bounded >= 45
          ? ("중립" as const)
          : ("약세" as const),
    score: bounded,
  };
}

function benchmarkCloseAtOrBefore(
  benchmarkRows: OhlcvRow[],
  targetDate: string
) {
  for (let index = benchmarkRows.length - 1; index >= 0; index -= 1) {
    if (benchmarkRows[index].날짜 <= targetDate) return benchmarkRows[index].종가;
  }
  return null;
}

function relativeStrength(rows: OhlcvRow[], benchmarkRows: OhlcvRow[]) {
  const currentRow = rows.at(-1);
  const stock20Row = rows.at(-21);
  const stock60Row = rows.at(-61);
  if (!currentRow || !stock20Row || !stock60Row) return null;
  const benchmarkCurrent = benchmarkCloseAtOrBefore(
    benchmarkRows,
    currentRow.날짜
  );
  const benchmark20Start = benchmarkCloseAtOrBefore(
    benchmarkRows,
    stock20Row.날짜
  );
  const benchmark60Start = benchmarkCloseAtOrBefore(
    benchmarkRows,
    stock60Row.날짜
  );
  if (
    benchmarkCurrent === null ||
    benchmark20Start === null ||
    benchmark60Start === null
  ) {
    return null;
  }
  const stock20 = percentChange(stock20Row.종가, currentRow.종가);
  const stock60 = percentChange(stock60Row.종가, currentRow.종가);
  const benchmark20 = percentChange(benchmark20Start, benchmarkCurrent);
  const benchmark60 = percentChange(benchmark60Start, benchmarkCurrent);
  return {
    relativeStrength20: stock20 - benchmark20,
    relativeStrength60: stock60 - benchmark60,
  };
}

function buildSignal(
  ticker: string,
  signalDate: string,
  rows: OhlcvRow[],
  benchmarkRows: OhlcvRow[],
  config: BillionaireStrategyConfig
): BillionaireSignal | null {
  const bars = toBars(rows);
  const closes = bars.map(bar => bar.close);
  const volumes = bars.map(bar => bar.volume);
  const close = closes.at(-1) ?? 0;
  const ma20 = sma(closes, config.fastMaPeriod);
  const ma60 = sma(closes, config.slowMaPeriod);
  const atrValue = atr(bars, config.atrPeriod);
  const adx = computeAdx(bars, config.adxPeriod);
  const rsi14 = rsi(closes);
  const volumeRatio = (volumes.at(-1) ?? 0) / Math.max(sma(volumes, 20), 1);
  const volatility20 = annualizedVolatility(closes);
  const rs = relativeStrength(rows, benchmarkRows);
  if (!rs) return null;
  const regime = regimeSnapshot(benchmarkRows, benchmarkRows.length - 1);
  const priorRangeHigh = Math.max(...closes.slice(-65, -5));
  const pullback =
    close >= ma20 && close <= ma20 * 1.04 && rsi14 >= 45 && rsi14 <= 68;
  const breakout =
    close >= priorRangeHigh * 0.995 &&
    volumeRatio >= 1.35 &&
    rsi14 >= 55 &&
    rsi14 <= config.maxRsi;
  const trendAligned = close > ma20 && ma20 > ma60;
  const notExtended = close <= ma20 * (1 + config.maxExtensionPct / 100);
  const macdUp = macdBullish(closes);
  const volumeFlow = computeVolumeFlow(bars);
  const stochasticBullish = stochasticCross(bars);

  if (
    !trendAligned ||
    !notExtended ||
    regime.score < config.minRegimeScore ||
    adx < config.minAdx ||
    rs.relativeStrength60 < config.minRelativeStrength ||
    volumeRatio < config.minVolumeRatio ||
    rsi14 > config.maxRsi ||
    volatility20 > config.maxVolatilityPct ||
    (pullback &&
      config.stochasticConfirmation === "required" &&
      !stochasticBullish) ||
    (!pullback && !breakout)
  ) {
    return null;
  }

  let signalScore = 0;
  const reasons: string[] = [];
  if (trendAligned) {
    signalScore += 20;
    reasons.push("20일선 위·20일선이 60일선 위");
  }
  if (rs.relativeStrength60 >= 0) {
    signalScore += 20;
    reasons.push(`지수 대비 RS60 ${round(rs.relativeStrength60)}%`);
  }
  if (adx >= 30) signalScore += 15;
  else signalScore += 10;
  reasons.push(`ADX ${round(adx, 1)}`);
  if (volumeRatio >= 1.2) signalScore += 15;
  else signalScore += 10;
  reasons.push(`거래량 ${round(volumeRatio)}배`);
  if (macdUp) {
    signalScore += 10;
    reasons.push("MACD 상승");
  }
  if (
    pullback &&
    stochasticBullish &&
    config.stochasticConfirmation !== "off"
  ) {
    signalScore += 5;
    reasons.push("스토캐스틱 K/D 골든크로스");
  }
  if (volumeFlow.flowRising) {
    signalScore += 5;
    reasons.push("누적 거래흐름 상승");
  }
  if (regime.label === "강세") {
    signalScore += 10;
    reasons.push(`시장 강세 레짐 ${regime.score}점`);
  } else {
    signalScore += 5;
    reasons.push(`시장 중립 레짐 ${regime.score}점`);
  }
  if (pullback) {
    signalScore += 10;
    reasons.push("20일선 근처 눌림목");
  } else if (breakout) {
    signalScore += 10;
    reasons.push("거래량 동반 박스 상단 돌파");
  }
  if (signalScore < config.minSignalScore) return null;

  const mode: BillionaireSignalMode = pullback ? "pullback" : "breakout";
  const triggerPrice =
    mode === "pullback"
      ? close * (1 + config.entryBufferPct / 100)
      : Math.max(close, priorRangeHigh * 1.002);
  const atrStop = triggerPrice - config.stopAtrMultiple * atrValue;
  const riskCapStop = triggerPrice * (1 - config.maxRiskPct / 100);
  const stopLossPrice = Math.max(atrStop, riskCapStop);
  const risk = Math.max(triggerPrice - stopLossPrice, triggerPrice * 0.01);
  const targetPrice = triggerPrice + config.targetR * risk;

  return {
    ticker,
    signalDate,
    mode,
    close: round(close),
    triggerPrice: round(triggerPrice),
    stopLossPrice: round(stopLossPrice),
    targetPrice: round(targetPrice),
    atr: round(atrValue),
    adx: round(adx),
    rsi14: round(rsi14),
    volumeRatio: round(volumeRatio),
    relativeStrength20: round(rs.relativeStrength20),
    relativeStrength60: round(rs.relativeStrength60),
    volatility20: round(volatility20),
    regime: regime.label,
    regimeScore: regime.score,
    signalScore,
    reasons,
  };
}

function evaluateTrade(
  signal: BillionaireSignal,
  futureRows: OhlcvRow[],
  config: BillionaireStrategyConfig
): BillionaireTrade {
  const entryRow = futureRows
    .slice(0, config.entryLookaheadBars)
    .find(row => row.고가 >= signal.triggerPrice);
  const base = {
    ...signal,
    maxFavorableExcursionPct: 0,
    maxAdverseExcursionPct: 0,
  };
  if (!entryRow) return { ...base, outcome: "not_triggered", returnPct: 0 };

  const entryIndex = futureRows.findIndex(row => row.날짜 === entryRow.날짜);
  const holdingRows = futureRows.slice(
    entryIndex,
    entryIndex + config.holdingBars
  );
  let exitRow = holdingRows.at(-1) ?? entryRow;
  let outcome: BillionaireTrade["outcome"] = "time_exit";
  const risk = Math.max(
    signal.triggerPrice - signal.stopLossPrice,
    signal.triggerPrice * 0.01
  );
  let effectiveStop = signal.stopLossPrice;
  let peakR = 0;
  let maxFavorableExcursionPct = 0;
  let maxAdverseExcursionPct = 0;

  for (let index = 0; index < holdingRows.length; index += 1) {
    const row = holdingRows[index];
    maxFavorableExcursionPct = Math.max(
      maxFavorableExcursionPct,
      percentChange(signal.triggerPrice, row.고가)
    );
    maxAdverseExcursionPct = Math.min(
      maxAdverseExcursionPct,
      percentChange(signal.triggerPrice, row.저가)
    );
    if (row.저가 <= effectiveStop) {
      exitRow = row;
      outcome = effectiveStop > signal.stopLossPrice ? "trail_exit" : "stop";
      break;
    }
    if (row.고가 >= signal.targetPrice) {
      exitRow = row;
      outcome = "target";
      break;
    }
    if (index > 0) {
      peakR = Math.max(peakR, (row.고가 - signal.triggerPrice) / risk);
      if (peakR >= config.breakevenAtR) {
        const breakeven =
          signal.triggerPrice * (1 + config.roundTripCostPct / 100);
        const trail =
          signal.triggerPrice + (peakR - config.trailGivebackR) * risk;
        effectiveStop = Math.max(effectiveStop, breakeven, trail);
      }
    }
  }

  const exitPrice =
    outcome === "stop" || outcome === "trail_exit"
      ? effectiveStop
      : outcome === "target"
        ? signal.targetPrice
        : exitRow.종가;
  return {
    ...base,
    entryDate: entryRow.날짜,
    entryPrice: round(signal.triggerPrice),
    exitDate: exitRow.날짜,
    exitPrice: round(exitPrice),
    outcome,
    returnPct: round(
      percentChange(signal.triggerPrice, exitPrice) - config.roundTripCostPct
    ),
    maxFavorableExcursionPct: round(maxFavorableExcursionPct),
    maxAdverseExcursionPct: round(maxAdverseExcursionPct),
  };
}

function tradeStats(trades: BillionaireTrade[]) {
  const active = trades.filter(trade => trade.outcome !== "not_triggered");
  const wins = active.filter(trade => trade.returnPct > 0).length;
  return {
    trades: active.length,
    winRate: active.length ? round((wins / active.length) * 100, 1) : 0,
    avgReturnPct: active.length
      ? round(average(active.map(trade => trade.returnPct)))
      : 0,
  };
}

function summary(trades: BillionaireTrade[]): BillionaireSummary {
  const active = trades.filter(trade => trade.outcome !== "not_triggered");
  const wins = active.filter(trade => trade.returnPct > 0);
  const losses = active.filter(trade => trade.returnPct <= 0);
  const grossProfit = wins.reduce((sum, trade) => sum + trade.returnPct, 0);
  const grossLoss = Math.abs(
    losses.reduce((sum, trade) => sum + trade.returnPct, 0)
  );
  const sorted = active.map(trade => trade.returnPct).sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const medianReturnPct =
    sorted.length === 0
      ? 0
      : sorted.length % 2
        ? sorted[middle]
        : (sorted[middle - 1] + sorted[middle]) / 2;
  const chronological = [...active].sort((a, b) =>
    a.signalDate.localeCompare(b.signalDate)
  );
  const split = Math.floor(chronological.length * 0.6);
  const rTrades: RTrade[] = active.map(trade => ({
    triggerPrice: trade.triggerPrice,
    stopLossPrice: trade.stopLossPrice,
    returnPct: trade.returnPct,
    outcome: trade.outcome,
  }));
  const expectancy = computeExpectancy(rTrades);
  return {
    totalSignals: trades.length,
    totalTrades: active.length,
    winRate: active.length ? round((wins.length / active.length) * 100, 1) : 0,
    avgReturnPct: active.length
      ? round(average(active.map(trade => trade.returnPct)))
      : 0,
    medianReturnPct: round(medianReturnPct),
    stopRate: active.length
      ? round(
          (active.filter(trade => trade.outcome === "stop").length /
            active.length) *
            100,
          1
        )
      : 0,
    targetRate: active.length
      ? round(
          (active.filter(trade => trade.outcome === "target").length /
            active.length) *
            100,
          1
        )
      : 0,
    noTriggerRate: trades.length
      ? round(((trades.length - active.length) / trades.length) * 100, 1)
      : 0,
    grossProfit: round(grossProfit),
    grossLoss: round(grossLoss),
    profitFactor: grossLoss
      ? round(grossProfit / grossLoss)
      : grossProfit > 0
        ? null
        : 0,
    expectancyR: expectancy.expectancyR,
    distinctTickers: new Set(trades.map(trade => trade.ticker)).size,
    inSample: tradeStats(chronological.slice(0, split)),
    outOfSample: tradeStats(chronological.slice(split)),
  };
}

export function runBillionaireStrategyBacktest(
  rowsByTicker: Record<string, OhlcvRow[] | null>,
  overrides: Partial<BillionaireStrategyConfig> = {},
  options: { benchmarkTicker: string; excludedTickers?: string[] } = {
    benchmarkTicker: "069500",
  }
): BillionaireBacktestResult {
  const config = { ...DEFAULT_BILLIONAIRE_STRATEGY_CONFIG, ...overrides };
  const benchmarkRows = rowsByTicker[options.benchmarkTicker] ?? [];
  const excluded = new Set(
    options.excludedTickers ?? [
      options.benchmarkTicker,
      "069500",
      "229200",
      "SPY",
    ]
  );
  const maxSignalIndex = Math.max(
    0,
    benchmarkRows.length - config.holdingBars - config.entryLookaheadBars - 1
  );
  const trades: BillionaireTrade[] = [];
  const lastTradeIndex = new Map<string, number>();
  let signalWindows = 0;

  for (
    let signalIndex = config.warmupBars;
    signalIndex <= maxSignalIndex;
    signalIndex += config.signalStepBars
  ) {
    const signalDate = benchmarkRows[signalIndex]?.날짜;
    if (!signalDate) continue;
    signalWindows += 1;
    for (const [ticker, fullRows] of Object.entries(rowsByTicker)) {
      if (excluded.has(ticker) || !fullRows?.length) continue;
      const tickerIndex = fullRows.findIndex(row => row.날짜 === signalDate);
      if (tickerIndex < 0) continue;
      const snapshotRows = fullRows.slice(0, tickerIndex + 1);
      const signal = buildSignal(
        ticker,
        signalDate,
        snapshotRows,
        benchmarkRows.slice(0, signalIndex + 1),
        config
      );
      if (!signal) continue;
      const previous = lastTradeIndex.get(ticker);
      if (previous !== undefined && tickerIndex - previous < config.holdingBars)
        continue;
      const futureRows = fullRows.slice(
        tickerIndex + 1,
        tickerIndex + 1 + config.entryLookaheadBars + config.holdingBars
      );
      if (!futureRows.length) continue;
      const trade = evaluateTrade(signal, futureRows, config);
      trades.push(trade);
      if (trade.outcome !== "not_triggered")
        lastTradeIndex.set(ticker, tickerIndex);
    }
  }

  const resultSummary = summary(trades);
  const rTrades: RTrade[] = trades
    .filter(trade => trade.outcome !== "not_triggered")
    .map(trade => ({
      triggerPrice: trade.triggerPrice,
      stopLossPrice: trade.stopLossPrice,
      returnPct: trade.returnPct,
      outcome: trade.outcome,
    }));
  return {
    config,
    benchmarkTicker: options.benchmarkTicker,
    signalWindows,
    trades,
    summary: resultSummary,
    riskBudget: computeRiskBudget(computeExpectancy(rTrades)),
  };
}

export function calculatePositionSizePct(
  accountEquity: number,
  entryPrice: number,
  stopLossPrice: number,
  riskBudgetPct: number,
  maxPositionPct = 25
) {
  if (
    !(accountEquity > 0) ||
    !(entryPrice > stopLossPrice) ||
    !(riskBudgetPct > 0)
  )
    return 0;
  const riskAmount = accountEquity * (riskBudgetPct / 100);
  const shares = riskAmount / (entryPrice - stopLossPrice);
  return round(
    Math.min(maxPositionPct, ((shares * entryPrice) / accountEquity) * 100),
    2
  );
}
