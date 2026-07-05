import "dotenv/config";

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { deriveElliottFractalInsightFromRows } from "./agentTeams/elliottFractalAgent";
import { fetchKoreanOhlcvRowsBatch, type OhlcvRow } from "./koreaStockMcp";
import { runSwingAdaptiveLearning } from "./swingAdaptiveLearning";
import { runSwingPredictionQualityAgent } from "./swingPredictionQualityAgent";
import { FIRST_LIMIT_UP_UNIVERSE } from "./firstLimitUpFollowThroughAgent";
import { LIMIT_UP_UNIVERSE } from "./limitUpPredictionAgent";
import {
  DEFAULT_SWING_UNIVERSE,
  resolveSwingUniverse,
  screenTechnicalSwingCandidatesFromRows,
  type InjectedSwingOverrides,
  type TechnicalSwingCandidate,
  type TechnicalSwingRowsByTicker,
} from "./technicalSwingScreener";

type BacktestTrade = {
  signalDate: string;
  ticker: string;
  companyName: string;
  patterns: string[];
  triggerPrice: number;
  stopLossPrice: number;
  targetPrice: number;
  entryDate?: string;
  entryPrice?: number;
  exitDate?: string;
  exitPrice?: number;
  outcome: "target" | "stop" | "time_exit" | "not_triggered";
  returnPct: number;
  maxFavorableExcursionPct: number;
  maxAdverseExcursionPct: number;
  elliottLabel?: string;
  elliottScore?: number;
  fractalCompressionScore?: number;
  waveCountEstimate?: string;
  swingScore?: number;
  volumeRatio?: number;
  rsi14?: number;
  volatility20?: number;
  marketRegimeLabel?: "강세" | "중립" | "약세";
  marketRegimeScore?: number;
};

type PatternStat = {
  pattern: string;
  trades: number;
  wins: number;
  losses: number;
  noTriggers: number;
  winRate: number;
  avgReturnPct: number;
};

type ElliottLabelStat = {
  label: string;
  trades: number;
  wins: number;
  losses: number;
  noTriggers: number;
  winRate: number;
  avgReturnPct: number;
};

type BacktestReport = {
  generatedAt: string;
  intervalDays: number;
  lookbackDays: number;
  signalStepDays: number;
  holdingDays: number;
  entryLookaheadDays: number;
  universeSize: number;
  signalWindows: number;
  totalSignals: number;
  totalTrades: number;
  winRate: number;
  avgReturnPct: number;
  medianReturnPct: number;
  stopRate: number;
  targetRate: number;
  noTriggerRate: number;
  patternStats: PatternStat[];
  elliottLabelStats: ElliottLabelStat[];
  recommendations: string[];
  trades: BacktestTrade[];
  splitSample?: SplitSample;
};

type BacktestState = {
  lastRunAt?: string;
};

const REPORT_DIR = path.join(process.cwd(), ".data", "backtests");
const REPORT_JSON_PATH = path.join(REPORT_DIR, "latest-swing-backtest.json");
const REPORT_MD_PATH = path.join(REPORT_DIR, "latest-swing-backtest.md");
const STATE_PATH = path.join(REPORT_DIR, "state.json");
const DEFAULT_INTERVAL_DAYS = Number(process.env.SWING_BACKTEST_INTERVAL_DAYS ?? "7");
const LOOKBACK_DAYS = Number(process.env.SWING_BACKTEST_LOOKBACK_DAYS ?? "420");
const HOLDING_DAYS = Number(process.env.SWING_BACKTEST_HOLDING_DAYS ?? "15");
const ENTRY_LOOKAHEAD_DAYS = Number(process.env.SWING_BACKTEST_ENTRY_LOOKAHEAD_DAYS ?? "5");
const SIGNAL_STEP_DAYS = Number(process.env.SWING_BACKTEST_SIGNAL_STEP_DAYS ?? "5");
const WARMUP_BARS = 160;
const FORCE_RUN = process.env.SWING_BACKTEST_FORCE === "true";

async function resolveBacktestUniverse(): Promise<string[]> {
  // Optimize on the SAME universe we trade live (dynamic top market-cap), capped
  // for backtest performance. Benchmarks + curated lists are always included.
  const cap = Number(process.env.SWING_BACKTEST_UNIVERSE_SIZE) || 120;
  let dynamic: string[] = [];
  try {
    dynamic = await resolveSwingUniverse();
  } catch (error) {
    console.warn("[Swing Backtest] dynamic universe unavailable, using curated only:", error);
  }
  const curated = [...DEFAULT_SWING_UNIVERSE, ...LIMIT_UP_UNIVERSE, ...FIRST_LIMIT_UP_UNIVERSE];
  const extra = (process.env.SWING_BACKTEST_EXTRA_TICKERS ?? "")
    .split(",")
    .map(item => item.trim())
    .filter(Boolean);

  return Array.from(new Set(["069500", "229200", ...dynamic.slice(0, cap), ...curated, ...extra]));
}

function percentChange(base: number, current: number) {
  if (!base) {
    return 0;
  }
  return ((current - base) / base) * 100;
}

function median(values: number[]) {
  if (!values.length) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Number(((sorted[middle - 1] + sorted[middle]) / 2).toFixed(2))
    : Number(sorted[middle].toFixed(2));
}

function round(value: number, digits = 2) {
  return Number(value.toFixed(digits));
}

async function loadState(): Promise<BacktestState> {
  try {
    const raw = await readFile(STATE_PATH, "utf8");
    return JSON.parse(raw) as BacktestState;
  } catch {
    return {};
  }
}

async function saveState(state: BacktestState) {
  await mkdir(REPORT_DIR, { recursive: true });
  await writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function shouldRun(lastRunAt: string | undefined, intervalDays: number) {
  if (!lastRunAt) {
    return true;
  }
  const last = Date.parse(lastRunAt);
  if (!Number.isFinite(last)) {
    return true;
  }
  return Date.now() - last >= intervalDays * 24 * 60 * 60 * 1000;
}

function sliceRowsAtIndex(rows: OhlcvRow[] | null, endIndex: number) {
  if (!rows?.length || endIndex < 0) {
    return null;
  }
  return rows.slice(0, endIndex + 1);
}

function buildRowsSnapshot(rowsByTicker: TechnicalSwingRowsByTicker, signalIndex: number): TechnicalSwingRowsByTicker {
  return Object.fromEntries(
    Object.entries(rowsByTicker).map(([ticker, rows]) => [ticker, sliceRowsAtIndex(rows, signalIndex)])
  );
}

function evaluateTrade(
  candidate: TechnicalSwingCandidate,
  signalDate: string,
  futureRows: OhlcvRow[],
  elliottInsight?: {
    label: string;
    score: number;
    fractalCompressionScore: number;
    waveCountEstimate: string;
  }
): BacktestTrade {
  const targetPrice = Math.round(candidate.triggerPrice * 1.08);
  const entryWindow = futureRows.slice(0, ENTRY_LOOKAHEAD_DAYS);
  let entryRow: OhlcvRow | undefined;

  for (const row of entryWindow) {
    if (row.고가 >= candidate.triggerPrice) {
      entryRow = row;
      break;
    }
  }

  if (!entryRow) {
    return {
      signalDate,
      ticker: candidate.ticker,
      companyName: candidate.companyName,
      patterns: candidate.patterns,
      triggerPrice: candidate.triggerPrice,
      stopLossPrice: candidate.stopLossPrice,
      targetPrice,
      outcome: "not_triggered",
      returnPct: 0,
      maxFavorableExcursionPct: 0,
      maxAdverseExcursionPct: 0,
      elliottLabel: elliottInsight?.label,
      elliottScore: elliottInsight?.score,
      fractalCompressionScore: elliottInsight?.fractalCompressionScore,
      waveCountEstimate: elliottInsight?.waveCountEstimate,
      swingScore: candidate.swingScore,
      volumeRatio: candidate.volumeRatio,
      rsi14: candidate.rsi14,
      volatility20: candidate.volatility20,
      marketRegimeLabel: candidate.marketRegimeLabel,
      marketRegimeScore: candidate.marketRegimeScore,
    };
  }

  const entryIndex = futureRows.findIndex(row => row.날짜 === entryRow?.날짜);
  const holdingRows = futureRows.slice(entryIndex, entryIndex + HOLDING_DAYS);
  let exitRow = holdingRows[holdingRows.length - 1] ?? entryRow;
  let outcome: BacktestTrade["outcome"] = "time_exit";
  let maxFavorableExcursionPct = 0;
  let maxAdverseExcursionPct = 0;

  for (const row of holdingRows) {
    maxFavorableExcursionPct = Math.max(
      maxFavorableExcursionPct,
      percentChange(candidate.triggerPrice, row.고가)
    );
    maxAdverseExcursionPct = Math.min(
      maxAdverseExcursionPct,
      percentChange(candidate.triggerPrice, row.저가)
    );

    if (row.저가 <= candidate.stopLossPrice) {
      exitRow = row;
      outcome = "stop";
      break;
    }
    if (row.고가 >= targetPrice) {
      exitRow = row;
      outcome = "target";
      break;
    }
  }

  const exitPrice =
    outcome === "stop" ? candidate.stopLossPrice :
    outcome === "target" ? targetPrice :
    exitRow.종가;

  return {
    signalDate,
    ticker: candidate.ticker,
    companyName: candidate.companyName,
    patterns: candidate.patterns,
    triggerPrice: candidate.triggerPrice,
    stopLossPrice: candidate.stopLossPrice,
    targetPrice,
    entryDate: entryRow.날짜,
    entryPrice: candidate.triggerPrice,
    exitDate: exitRow.날짜,
    exitPrice,
    outcome,
    returnPct: round(percentChange(candidate.triggerPrice, exitPrice)),
    maxFavorableExcursionPct: round(maxFavorableExcursionPct),
    maxAdverseExcursionPct: round(maxAdverseExcursionPct),
    elliottLabel: elliottInsight?.label,
    elliottScore: elliottInsight?.score,
    fractalCompressionScore: elliottInsight?.fractalCompressionScore,
    waveCountEstimate: elliottInsight?.waveCountEstimate,
    swingScore: candidate.swingScore,
    volumeRatio: candidate.volumeRatio,
    rsi14: candidate.rsi14,
    volatility20: candidate.volatility20,
    marketRegimeLabel: candidate.marketRegimeLabel,
    marketRegimeScore: candidate.marketRegimeScore,
  };
}

function buildRecommendations(
  patternStats: PatternStat[],
  elliottLabelStats: ElliottLabelStat[],
  report: Omit<BacktestReport, "recommendations">
) {
  const notes: string[] = [];

  if (report.winRate < 45) {
    notes.push("전체 적중률이 낮습니다. 승인 후보 수를 더 줄이고 워크플로우 합의 하한을 높이는 쪽이 유리합니다.");
  } else if (report.winRate >= 58) {
    notes.push("전체 적중률이 양호합니다. 현재 보수적 승인 구조를 유지하되, 표본이 더 쌓이면 상위 패턴 비중 확대를 검토할 수 있습니다.");
  }

  for (const stat of patternStats) {
    if (stat.trades < 5) {
      continue;
    }
    if (stat.winRate >= 60 && stat.avgReturnPct > 2) {
      notes.push(`${stat.pattern} 패턴은 표본 ${stat.trades}건에서 강했습니다. 우선순위 유지 또는 소폭 가점 검토가 가능합니다.`);
    }
    if (stat.winRate < 40 || stat.avgReturnPct < 0) {
      notes.push(`${stat.pattern} 패턴은 표본 ${stat.trades}건에서 약했습니다. 거래량/RSI 필터를 강화하거나 우선순위를 낮추는 것이 좋습니다.`);
    }
  }

  for (const stat of elliottLabelStats) {
    if (stat.trades < 5) {
      continue;
    }
    if ((stat.label === "강한 상승 5파 진행" || stat.label === "초기 3파 확장") && stat.winRate >= 60) {
      notes.push(`${stat.label} 구조는 표본 ${stat.trades}건에서 양호했습니다. 엘리엇 점수 하한 유지 또는 소폭 강화가 가능합니다.`);
    }
    if (stat.label === "교정/혼조" && (stat.winRate < 45 || stat.avgReturnPct < 0)) {
      notes.push(`${stat.label} 구조는 성과가 약했습니다. 혼조 파동 차단 기준을 더 엄격히 보는 편이 유리합니다.`);
    }
  }

  if (!notes.length) {
    notes.push("표본은 쌓였지만 뚜렷한 패턴 편차는 아직 작습니다. 다음 백테스트까지 현재 규칙을 유지합니다.");
  }

  return notes;
}

function toMarkdown(report: BacktestReport) {
  return [
    "# Swing Backtest Report",
    "",
    `- Generated: ${report.generatedAt}`,
    `- Universe size: ${report.universeSize}`,
    `- Signal windows: ${report.signalWindows}`,
    `- Total signals: ${report.totalSignals}`,
    `- Triggered trades: ${report.totalTrades}`,
    `- Win rate: ${report.winRate.toFixed(1)}%`,
    `- Avg return: ${report.avgReturnPct.toFixed(2)}%`,
    `- Median return: ${report.medianReturnPct.toFixed(2)}%`,
    `- Stop rate: ${report.stopRate.toFixed(1)}%`,
    `- Target rate: ${report.targetRate.toFixed(1)}%`,
    `- No trigger rate: ${report.noTriggerRate.toFixed(1)}%`,
    "",
    "## Recommendations",
    ...report.recommendations.map(item => `- ${item}`),
    "",
    "## Pattern Stats",
    ...report.patternStats.map(
      stat => `- ${stat.pattern}: trades ${stat.trades}, winRate ${stat.winRate.toFixed(1)}%, avgReturn ${stat.avgReturnPct.toFixed(2)}%`
    ),
    "",
    "## Elliott / Fractal Stats",
    ...report.elliottLabelStats.map(
      stat => `- ${stat.label}: trades ${stat.trades}, winRate ${stat.winRate.toFixed(1)}%, avgReturn ${stat.avgReturnPct.toFixed(2)}%`
    ),
  ].join("\n");
}

async function writeReport(report: BacktestReport) {
  await mkdir(REPORT_DIR, { recursive: true });
  await Promise.all([
    writeFile(REPORT_JSON_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8"),
    writeFile(REPORT_MD_PATH, `${toMarkdown(report)}\n`, "utf8"),
  ]);
}

export async function fetchBacktestRows(): Promise<TechnicalSwingRowsByTicker> {
  return fetchKoreanOhlcvRowsBatch(await resolveBacktestUniverse(), LOOKBACK_DAYS);
}

/**
 * Replays the screener over historical snapshots and returns the resulting
 * trades. `injected` lets the evolution agent score a candidate strategy
 * variant without writing the live override files.
 */
export async function collectBacktestTrades(
  rowsByTicker: TechnicalSwingRowsByTicker,
  injected?: InjectedSwingOverrides
): Promise<{ trades: BacktestTrade[]; signalWindows: number }> {
  const benchmarkRows = rowsByTicker["069500"] ?? rowsByTicker["229200"] ?? [];
  const maxSignalIndex = Math.max(0, benchmarkRows.length - HOLDING_DAYS - 1);
  const signalIndexes: number[] = [];
  for (let index = WARMUP_BARS; index <= maxSignalIndex; index += SIGNAL_STEP_DAYS) {
    signalIndexes.push(index);
  }

  const trades: BacktestTrade[] = [];
  // Per-ticker cooldown: once a name is in a (triggered) position it is not
  // re-entered until the holding window passes — otherwise a stock that keeps a
  // setup across many signal dates is over-counted as many correlated trades.
  const lastTradeIndexByTicker: Record<string, number> = {};

  for (const signalIndex of signalIndexes) {
    const signalDate = benchmarkRows[signalIndex]?.날짜;
    if (!signalDate) {
      continue;
    }

    const snapshotRows = buildRowsSnapshot(rowsByTicker, signalIndex);
    const result = await screenTechnicalSwingCandidatesFromRows(snapshotRows, undefined, injected);

    for (const candidate of result.candidates) {
      const priorIndex = lastTradeIndexByTicker[candidate.ticker];
      if (priorIndex !== undefined && signalIndex - priorIndex < HOLDING_DAYS) {
        continue;
      }
      const fullRows = rowsByTicker[candidate.ticker] ?? [];
      const fullIndex = fullRows.findIndex(row => row.날짜 === signalDate);
      if (fullIndex === -1) {
        continue;
      }
      const futureRows = fullRows.slice(fullIndex + 1, fullIndex + 1 + ENTRY_LOOKAHEAD_DAYS + HOLDING_DAYS);
      if (!futureRows.length) {
        continue;
      }
      const elliottInsight = deriveElliottFractalInsightFromRows(
        {
          ticker: candidate.ticker,
          companyName: candidate.companyName,
        },
        snapshotRows[candidate.ticker] ?? null
      );
      const trade = evaluateTrade(
        candidate,
        signalDate,
        futureRows,
        elliottInsight
          ? {
              label: elliottInsight.label,
              score: elliottInsight.score,
              fractalCompressionScore: elliottInsight.fractalCompressionScore,
              waveCountEstimate: elliottInsight.waveCountEstimate,
            }
          : undefined
      );
      trades.push(trade);
      if (trade.outcome !== "not_triggered") {
        lastTradeIndexByTicker[candidate.ticker] = signalIndex;
      }
    }
  }

  return { trades, signalWindows: signalIndexes.length };
}

export type BacktestSummary = {
  totalSignals: number;
  totalTrades: number;
  winRate: number;
  avgReturnPct: number;
  medianReturnPct: number;
  stopRate: number;
  targetRate: number;
  noTriggerRate: number;
  patternStats: PatternStat[];
  elliottLabelStats: ElliottLabelStat[];
};

export function summarizeBacktestTrades(trades: BacktestTrade[]): BacktestSummary {
  const triggeredTrades = trades.filter(trade => trade.outcome !== "not_triggered");
  const winningTrades = triggeredTrades.filter(trade => trade.returnPct > 0);
  const stopTrades = triggeredTrades.filter(trade => trade.outcome === "stop");
  const targetTrades = triggeredTrades.filter(trade => trade.outcome === "target");
  const noTriggerTrades = trades.filter(trade => trade.outcome === "not_triggered");
  const patternMap = new Map<string, BacktestTrade[]>();
  const elliottLabelMap = new Map<string, BacktestTrade[]>();

  for (const trade of trades) {
    for (const pattern of trade.patterns) {
      const current = patternMap.get(pattern) ?? [];
      current.push(trade);
      patternMap.set(pattern, current);
    }
    if (trade.elliottLabel) {
      const current = elliottLabelMap.get(trade.elliottLabel) ?? [];
      current.push(trade);
      elliottLabelMap.set(trade.elliottLabel, current);
    }
  }

  const patternStats: PatternStat[] = Array.from(patternMap.entries()).map(([pattern, patternTrades]) => {
    const activeTrades = patternTrades.filter(item => item.outcome !== "not_triggered");
    const wins = activeTrades.filter(item => item.returnPct > 0).length;
    const losses = activeTrades.filter(item => item.returnPct <= 0).length;

    return {
      pattern,
      trades: activeTrades.length,
      wins,
      losses,
      noTriggers: patternTrades.filter(item => item.outcome === "not_triggered").length,
      winRate: activeTrades.length ? round((wins / activeTrades.length) * 100, 1) : 0,
      avgReturnPct: activeTrades.length ? round(activeTrades.reduce((sum, item) => sum + item.returnPct, 0) / activeTrades.length) : 0,
    };
  }).sort((a, b) => b.winRate - a.winRate || b.avgReturnPct - a.avgReturnPct);
  const elliottLabelStats: ElliottLabelStat[] = Array.from(elliottLabelMap.entries()).map(([label, labelTrades]) => {
    const activeTrades = labelTrades.filter(item => item.outcome !== "not_triggered");
    const wins = activeTrades.filter(item => item.returnPct > 0).length;
    const losses = activeTrades.filter(item => item.returnPct <= 0).length;

    return {
      label,
      trades: activeTrades.length,
      wins,
      losses,
      noTriggers: labelTrades.filter(item => item.outcome === "not_triggered").length,
      winRate: activeTrades.length ? round((wins / activeTrades.length) * 100, 1) : 0,
      avgReturnPct: activeTrades.length ? round(activeTrades.reduce((sum, item) => sum + item.returnPct, 0) / activeTrades.length) : 0,
    };
  }).sort((a, b) => b.winRate - a.winRate || b.avgReturnPct - a.avgReturnPct);

  return {
    totalSignals: trades.length,
    totalTrades: triggeredTrades.length,
    winRate: triggeredTrades.length ? round((winningTrades.length / triggeredTrades.length) * 100, 1) : 0,
    avgReturnPct: triggeredTrades.length ? round(triggeredTrades.reduce((sum, item) => sum + item.returnPct, 0) / triggeredTrades.length) : 0,
    medianReturnPct: median(triggeredTrades.map(item => item.returnPct)),
    stopRate: triggeredTrades.length ? round((stopTrades.length / triggeredTrades.length) * 100, 1) : 0,
    targetRate: triggeredTrades.length ? round((targetTrades.length / triggeredTrades.length) * 100, 1) : 0,
    noTriggerRate: trades.length ? round((noTriggerTrades.length / trades.length) * 100, 1) : 0,
    patternStats,
    elliottLabelStats,
  };
}

function tradeStats(trades: BacktestTrade[]): { trades: number; winRate: number; avgReturnPct: number } {
  const active = trades.filter(trade => trade.outcome !== "not_triggered");
  const wins = active.filter(trade => trade.returnPct > 0).length;
  return {
    trades: active.length,
    winRate: active.length ? round((wins / active.length) * 100, 1) : 0,
    avgReturnPct: active.length ? round(active.reduce((sum, trade) => sum + trade.returnPct, 0) / active.length) : 0,
  };
}

export type SplitSample = {
  splitDate: string | null;
  distinctTickers: number;
  inSample: { trades: number; winRate: number; avgReturnPct: number };
  outOfSample: { trades: number; winRate: number; avgReturnPct: number };
};

/**
 * Walk-forward honesty check: split triggered trades chronologically (first ~60%
 * in-sample vs last ~40% out-of-sample). If out-of-sample holds up near
 * in-sample the edge is trustworthy; a big drop flags overfitting / look-ahead.
 */
export function splitSampleStats(trades: BacktestTrade[]): SplitSample {
  const triggered = trades
    .filter(trade => trade.outcome !== "not_triggered")
    .sort((a, b) => a.signalDate.localeCompare(b.signalDate));
  const distinctTickers = new Set(trades.map(trade => trade.ticker)).size;
  if (triggered.length < 4) {
    return {
      splitDate: null,
      distinctTickers,
      inSample: tradeStats(triggered),
      outOfSample: { trades: 0, winRate: 0, avgReturnPct: 0 },
    };
  }
  const splitDate = triggered[Math.floor(triggered.length * 0.6)].signalDate;
  return {
    splitDate,
    distinctTickers,
    inSample: tradeStats(triggered.filter(trade => trade.signalDate < splitDate)),
    outOfSample: tradeStats(triggered.filter(trade => trade.signalDate >= splitDate)),
  };
}

async function runBacktest() {
  const rowsByTicker = await fetchBacktestRows();
  const { trades, signalWindows } = await collectBacktestTrades(rowsByTicker);
  const summary = summarizeBacktestTrades(trades);
  const split = splitSampleStats(trades);

  const baseReport = {
    generatedAt: new Date().toISOString(),
    intervalDays: DEFAULT_INTERVAL_DAYS,
    lookbackDays: LOOKBACK_DAYS,
    signalStepDays: SIGNAL_STEP_DAYS,
    holdingDays: HOLDING_DAYS,
    entryLookaheadDays: ENTRY_LOOKAHEAD_DAYS,
    universeSize: Object.keys(rowsByTicker).length - 2,
    signalWindows,
    totalSignals: summary.totalSignals,
    totalTrades: summary.totalTrades,
    winRate: summary.winRate,
    avgReturnPct: summary.avgReturnPct,
    medianReturnPct: summary.medianReturnPct,
    stopRate: summary.stopRate,
    targetRate: summary.targetRate,
    noTriggerRate: summary.noTriggerRate,
    patternStats: summary.patternStats,
    elliottLabelStats: summary.elliottLabelStats,
    trades: trades.slice(-200),
    splitSample: split,
  };
  const report: BacktestReport = {
    ...baseReport,
    recommendations: buildRecommendations(summary.patternStats, summary.elliottLabelStats, baseReport),
  };

  await writeReport(report);
  const learnedOverrides = await runSwingAdaptiveLearning(REPORT_JSON_PATH);
  const qualityOverrides = await runSwingPredictionQualityAgent(REPORT_JSON_PATH);
  await saveState({ lastRunAt: report.generatedAt });

  console.log("[Swing Backtest Agent] Report written:", REPORT_JSON_PATH);
  console.log(`[Swing Backtest Agent] Universe size ${report.universeSize}, signal windows ${report.signalWindows}`);
  console.log(
    `[Swing Backtest Agent] Trades ${report.totalTrades}, winRate ${report.winRate.toFixed(1)}%, avgReturn ${report.avgReturnPct.toFixed(2)}%`
  );
  console.log(
    `[Swing Backtest Agent] 고유종목 ${split.distinctTickers} · OOS(최근) 승률 ${split.outOfSample.winRate}%(${split.outOfSample.trades}건) vs IS(과거) ${split.inSample.winRate}%(${split.inSample.trades}건)`
  );
  console.log(
    `[Swing Backtest Agent] Learned adjustments: ${JSON.stringify(learnedOverrides.patternWeightAdjustments)}`
  );
  console.log(
    `[Swing Backtest Agent] Quality filters: score ${qualityOverrides.minDefaultSwingScore}/${qualityOverrides.minEarlyBowlSwingScore}, volume ${qualityOverrides.minVolumeRatio.toFixed(2)}x, RSI ${qualityOverrides.maxRsi14}, vol ${qualityOverrides.maxVolatility20}`
  );
}

async function main() {
  const state = await loadState();
  if (!FORCE_RUN && !shouldRun(state.lastRunAt, DEFAULT_INTERVAL_DAYS)) {
    console.log(
      `[Swing Backtest Agent] Skipped. Last run ${state.lastRunAt}, interval ${DEFAULT_INTERVAL_DAYS} days`
    );
    return;
  }

  await runBacktest();
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch(error => {
    console.error("[Swing Backtest Agent] Fatal error:", error);
    process.exit(1);
  });
}
