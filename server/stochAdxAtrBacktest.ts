import type { OhlcvRow } from "./koreaStockMcp";

export type StochAdxAtrConfig = {
  warmupBars: number;
  signalStepBars: number;
  holdingBars: number;
  entryLookaheadBars: number;
  roundTripCostPct: number;
  stochasticPeriod: number;
  stochasticSmooth: number;
  stochasticSignal: number;
  adxPeriod: number;
  minAdx: number;
  fastMaPeriod: number;
  slowMaPeriod: number;
  atrPeriod: number;
  stopAtrMultiple: number;
  maxRiskPct: number;
  targetR: number;
  entryBufferPct: number;
  minVolumeRatio: number;
  breakevenAtR: number;
  trailGivebackR: number;
  benchmarkRegimeFilter: "off" | "trend";
  benchmarkFastMaPeriod: number;
  benchmarkSlowMaPeriod: number;
};

export const DEFAULT_STOCH_ADX_ATR_CONFIG: StochAdxAtrConfig = {
  warmupBars: 160,
  signalStepBars: 5,
  holdingBars: 15,
  entryLookaheadBars: 5,
  roundTripCostPct: 0.35,
  stochasticPeriod: 14,
  stochasticSmooth: 3,
  stochasticSignal: 3,
  adxPeriod: 14,
  minAdx: 20,
  fastMaPeriod: 20,
  slowMaPeriod: 60,
  atrPeriod: 14,
  stopAtrMultiple: 2,
  maxRiskPct: 15,
  targetR: 2.5,
  entryBufferPct: 0.5,
  minVolumeRatio: 0.8,
  breakevenAtR: 0.6,
  trailGivebackR: 0.5,
  benchmarkRegimeFilter: "off",
  benchmarkFastMaPeriod: 50,
  benchmarkSlowMaPeriod: 200,
};

export type StochAdxAtrTrade = {
  signalDate: string;
  ticker: string;
  triggerPrice: number;
  stopLossPrice: number;
  targetPrice: number;
  atr: number;
  adx: number;
  plusDi: number;
  minusDi: number;
  stochasticK: number;
  stochasticD: number;
  volumeRatio: number;
  entryDate?: string;
  entryPrice?: number;
  exitDate?: string;
  exitPrice?: number;
  outcome: "target" | "stop" | "trail_exit" | "time_exit" | "not_triggered";
  returnPct: number;
  maxFavorableExcursionPct: number;
  maxAdverseExcursionPct: number;
};

export type StochAdxAtrSummary = {
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
  profitFactor: number;
  expectancyPct: number;
  distinctTickers: number;
  inSample: { trades: number; winRate: number; avgReturnPct: number };
  outOfSample: { trades: number; winRate: number; avgReturnPct: number };
};

type IndicatorSnapshot = {
  close: number;
  atr: number;
  adx: number;
  plusDi: number;
  minusDi: number;
  stochasticK: number;
  stochasticD: number;
  previousK: number;
  previousD: number;
  volumeRatio: number;
};

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

function trueRanges(rows: OhlcvRow[]) {
  return rows.map((row, index) => {
    if (index === 0) return row.고가 - row.저가;
    const previousClose = rows[index - 1].종가;
    return Math.max(
      row.고가 - row.저가,
      Math.abs(row.고가 - previousClose),
      Math.abs(row.저가 - previousClose)
    );
  });
}

function calculateAtr(rows: OhlcvRow[], period: number) {
  return average(trueRanges(rows).slice(-period));
}

function calculateDirectionalStrength(rows: OhlcvRow[], period: number) {
  if (rows.length < period + 1) return { adx: 0, plusDi: 0, minusDi: 0 };

  const trs: number[] = [];
  const plusDm: number[] = [];
  const minusDm: number[] = [];
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    const previous = rows[index - 1];
    const upMove = row.고가 - previous.고가;
    const downMove = previous.저가 - row.저가;
    trs.push(
      Math.max(
        row.고가 - row.저가,
        Math.abs(row.고가 - previous.종가),
        Math.abs(row.저가 - previous.종가)
      )
    );
    plusDm.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDm.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  const dx: number[] = [];
  for (let end = period; end <= trs.length; end += 1) {
    const tr = average(trs.slice(end - period, end)) * period;
    const plus = average(plusDm.slice(end - period, end)) * period;
    const minus = average(minusDm.slice(end - period, end)) * period;
    const plusDi = tr ? (plus / tr) * 100 : 0;
    const minusDi = tr ? (minus / tr) * 100 : 0;
    const denominator = plusDi + minusDi;
    dx.push(denominator ? (Math.abs(plusDi - minusDi) / denominator) * 100 : 0);
  }

  const lastTr = average(trs.slice(-period)) * period;
  const lastPlus = average(plusDm.slice(-period)) * period;
  const lastMinus = average(minusDm.slice(-period)) * period;
  const plusDi = lastTr ? (lastPlus / lastTr) * 100 : 0;
  const minusDi = lastTr ? (lastMinus / lastTr) * 100 : 0;
  return { adx: average(dx.slice(-period)), plusDi, minusDi };
}

function stochasticSeries(rows: OhlcvRow[], config: StochAdxAtrConfig) {
  const rawK: number[] = [];
  const smoothK: number[] = [];
  const smoothD: number[] = [];

  for (
    let index = config.stochasticPeriod - 1;
    index < rows.length;
    index += 1
  ) {
    const window = rows.slice(index - config.stochasticPeriod + 1, index + 1);
    const low = Math.min(...window.map(row => row.저가));
    const high = Math.max(...window.map(row => row.고가));
    rawK.push(
      high === low ? 50 : ((rows[index].종가 - low) / (high - low)) * 100
    );
    smoothK.push(sma(rawK, config.stochasticSmooth));
    smoothD.push(sma(smoothK, config.stochasticSignal));
  }

  return {
    k: smoothK.at(-1) ?? 50,
    d: smoothD.at(-1) ?? 50,
    previousK: smoothK.at(-2) ?? 50,
    previousD: smoothD.at(-2) ?? 50,
  };
}

function snapshot(
  rows: OhlcvRow[],
  config: StochAdxAtrConfig
): IndicatorSnapshot | null {
  const minimumBars = Math.max(
    config.slowMaPeriod + 2,
    config.stochasticPeriod +
      config.stochasticSmooth +
      config.stochasticSignal +
      2,
    config.adxPeriod * 2
  );
  if (rows.length < minimumBars) return null;

  const closes = rows.map(row => row.종가);
  const volumes = rows.map(row => row.거래량);
  const stochastic = stochasticSeries(rows, config);
  const directional = calculateDirectionalStrength(rows, config.adxPeriod);
  return {
    close: closes.at(-1) ?? 0,
    atr: calculateAtr(rows, config.atrPeriod),
    adx: directional.adx,
    plusDi: directional.plusDi,
    minusDi: directional.minusDi,
    stochasticK: stochastic.k,
    stochasticD: stochastic.d,
    previousK: stochastic.previousK,
    previousD: stochastic.previousD,
    volumeRatio: (volumes.at(-1) ?? 0) / Math.max(sma(volumes, 20), 1),
  };
}

function isLongSignal(
  rows: OhlcvRow[],
  config: StochAdxAtrConfig,
  indicator: IndicatorSnapshot
) {
  const closes = rows.map(row => row.종가);
  const fastMa = sma(closes, config.fastMaPeriod);
  const slowMa = sma(closes, config.slowMaPeriod);
  return (
    indicator.close > fastMa &&
    fastMa > slowMa &&
    indicator.adx >= config.minAdx &&
    indicator.plusDi > indicator.minusDi &&
    indicator.previousK <= indicator.previousD &&
    indicator.stochasticK > indicator.stochasticD &&
    indicator.stochasticK >= 20 &&
    indicator.stochasticK <= 80 &&
    indicator.volumeRatio >= config.minVolumeRatio
  );
}

function passesBenchmarkRegimeFilter(
  benchmarkRows: OhlcvRow[],
  signalIndex: number,
  config: StochAdxAtrConfig
) {
  if (config.benchmarkRegimeFilter === "off") return true;
  const snapshotRows = benchmarkRows.slice(0, signalIndex + 1);
  if (snapshotRows.length < config.benchmarkSlowMaPeriod) return false;
  const closes = snapshotRows.map(row => row.종가);
  const close = closes.at(-1) ?? 0;
  const fastMa = sma(closes, config.benchmarkFastMaPeriod);
  const slowMa = sma(closes, config.benchmarkSlowMaPeriod);
  return close > slowMa && fastMa > slowMa;
}

function evaluateTrade(
  ticker: string,
  signalDate: string,
  indicator: IndicatorSnapshot,
  futureRows: OhlcvRow[],
  config: StochAdxAtrConfig
): StochAdxAtrTrade {
  const triggerPrice = indicator.close * (1 + config.entryBufferPct / 100);
  const atrStop = triggerPrice - config.stopAtrMultiple * indicator.atr;
  const riskCapStop = triggerPrice * (1 - config.maxRiskPct / 100);
  const stopLossPrice = Math.max(atrStop, riskCapStop);
  const risk = Math.max(triggerPrice - stopLossPrice, triggerPrice * 0.01);
  const targetPrice = triggerPrice + config.targetR * risk;
  const entryRow = futureRows
    .slice(0, config.entryLookaheadBars)
    .find(row => row.고가 >= triggerPrice);
  const base = {
    signalDate,
    ticker,
    triggerPrice: round(triggerPrice),
    stopLossPrice: round(stopLossPrice),
    targetPrice: round(targetPrice),
    atr: round(indicator.atr),
    adx: round(indicator.adx),
    plusDi: round(indicator.plusDi),
    minusDi: round(indicator.minusDi),
    stochasticK: round(indicator.stochasticK),
    stochasticD: round(indicator.stochasticD),
    volumeRatio: round(indicator.volumeRatio),
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
  let outcome: StochAdxAtrTrade["outcome"] = "time_exit";
  let effectiveStop = stopLossPrice;
  let peakR = 0;
  let maxFavorableExcursionPct = 0;
  let maxAdverseExcursionPct = 0;

  for (let barIndex = 0; barIndex < holdingRows.length; barIndex += 1) {
    const row = holdingRows[barIndex];
    maxFavorableExcursionPct = Math.max(
      maxFavorableExcursionPct,
      percentChange(triggerPrice, row.고가)
    );
    maxAdverseExcursionPct = Math.min(
      maxAdverseExcursionPct,
      percentChange(triggerPrice, row.저가)
    );

    if (row.저가 <= effectiveStop) {
      exitRow = row;
      outcome = effectiveStop > stopLossPrice ? "trail_exit" : "stop";
      break;
    }
    if (row.고가 >= targetPrice) {
      exitRow = row;
      outcome = "target";
      break;
    }

    if (barIndex > 0 && config.breakevenAtR > 0) {
      peakR = Math.max(peakR, (row.고가 - triggerPrice) / risk);
      if (peakR >= config.breakevenAtR) {
        const breakeven = triggerPrice * (1 + config.roundTripCostPct / 100);
        const trailed = triggerPrice + (peakR - config.trailGivebackR) * risk;
        effectiveStop = Math.max(effectiveStop, breakeven, trailed);
      }
    }
  }

  const exitPrice =
    outcome === "stop" || outcome === "trail_exit"
      ? effectiveStop
      : outcome === "target"
        ? targetPrice
        : exitRow.종가;
  return {
    ...base,
    entryDate: entryRow.날짜,
    entryPrice: round(triggerPrice),
    exitDate: exitRow.날짜,
    exitPrice: round(exitPrice),
    outcome,
    returnPct: round(
      percentChange(triggerPrice, exitPrice) - config.roundTripCostPct
    ),
    maxFavorableExcursionPct: round(maxFavorableExcursionPct),
    maxAdverseExcursionPct: round(maxAdverseExcursionPct),
  };
}

function tradeStats(trades: StochAdxAtrTrade[]) {
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

export function summarizeStochAdxAtrTrades(
  trades: StochAdxAtrTrade[]
): StochAdxAtrSummary {
  const active = trades.filter(trade => trade.outcome !== "not_triggered");
  const wins = active.filter(trade => trade.returnPct > 0);
  const grossProfit = wins.reduce((sum, trade) => sum + trade.returnPct, 0);
  const grossLoss = Math.abs(
    active
      .filter(trade => trade.returnPct <= 0)
      .reduce((sum, trade) => sum + trade.returnPct, 0)
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
  const splitIndex = Math.floor(chronological.length * 0.6);
  const inSample = tradeStats(chronological.slice(0, splitIndex));
  const outOfSample = tradeStats(chronological.slice(splitIndex));
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
        ? Infinity
        : 0,
    expectancyPct: active.length
      ? round(average(active.map(trade => trade.returnPct)))
      : 0,
    distinctTickers: new Set(trades.map(trade => trade.ticker)).size,
    inSample,
    outOfSample,
  };
}

export function runStochAdxAtrBacktest(
  rowsByTicker: Record<string, OhlcvRow[] | null>,
  overrides: Partial<StochAdxAtrConfig> = {},
  options: { benchmarkTicker?: string; excludedTickers?: string[] } = {}
) {
  const config = { ...DEFAULT_STOCH_ADX_ATR_CONFIG, ...overrides };
  const benchmarkTicker =
    options.benchmarkTicker ?? (rowsByTicker["069500"] ? "069500" : "229200");
  const excludedTickers = new Set(
    options.excludedTickers ?? ["069500", "229200", benchmarkTicker]
  );
  const benchmark = rowsByTicker[benchmarkTicker] ?? [];
  const maxSignalIndex = Math.max(
    0,
    benchmark.length - config.holdingBars - config.entryLookaheadBars - 1
  );
  const trades: StochAdxAtrTrade[] = [];
  const lastTradeIndex = new Map<string, number>();
  let signalWindows = 0;

  for (
    let signalIndex = config.warmupBars;
    signalIndex <= maxSignalIndex;
    signalIndex += config.signalStepBars
  ) {
    const signalDate = benchmark[signalIndex]?.날짜;
    if (!signalDate) continue;
    signalWindows += 1;
    if (!passesBenchmarkRegimeFilter(benchmark, signalIndex, config)) {
      continue;
    }

    for (const [ticker, fullRows] of Object.entries(rowsByTicker)) {
      if (excludedTickers.has(ticker) || !fullRows?.length) continue;
      const tickerIndex = fullRows.findIndex(row => row.날짜 === signalDate);
      if (tickerIndex < 0) continue;
      const snapshotRows = fullRows.slice(0, tickerIndex + 1);
      const indicator = snapshot(snapshotRows, config);
      if (!indicator || !isLongSignal(snapshotRows, config, indicator))
        continue;
      const prior = lastTradeIndex.get(ticker);
      if (prior !== undefined && signalIndex - prior < config.holdingBars)
        continue;

      const futureRows = fullRows.slice(
        tickerIndex + 1,
        tickerIndex + 1 + config.entryLookaheadBars + config.holdingBars
      );
      if (!futureRows.length) continue;
      const trade = evaluateTrade(
        ticker,
        signalDate,
        indicator,
        futureRows,
        config
      );
      trades.push(trade);
      if (trade.outcome !== "not_triggered")
        lastTradeIndex.set(ticker, signalIndex);
    }
  }

  return {
    config,
    trades,
    signalWindows,
    summary: summarizeStochAdxAtrTrades(trades),
  };
}
