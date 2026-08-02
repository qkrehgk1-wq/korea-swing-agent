import "dotenv/config";

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  collectBacktestTrades,
  fetchBacktestRows,
  splitSampleStats,
  summarizeBacktestTrades,
} from "../server/swingBacktestAgent";
import { runStochAdxAtrBacktest } from "../server/stochAdxAtrBacktest";

const outputDir = path.join(process.cwd(), ".data", "backtests");
const outputJson = path.join(outputDir, "stoch-adx-atr-comparison.json");
const outputMd = path.join(outputDir, "stoch-adx-atr-comparison.md");

const rowsByTicker = await fetchBacktestRows();
const baselineTrades = await collectBacktestTrades(rowsByTicker);
const baselineSummary = summarizeBacktestTrades(baselineTrades.trades);
const baselineSplit = splitSampleStats(baselineTrades.trades);
const challenger = runStochAdxAtrBacktest(rowsByTicker);
const allDates = Object.values(rowsByTicker)
  .flatMap(rows => rows?.map(row => row.날짜) ?? [])
  .sort();

const report = {
  generatedAt: new Date().toISOString(),
  methodology: {
    sharedUniverse: true,
    sharedRows: true,
    lookbackDays: Number(process.env.SWING_BACKTEST_LOOKBACK_DAYS ?? 420),
    note: "TraderDev Stoch-ADX-ATR concept adapted to Korean daily OHLCV; ADX is a rolling DX-strength proxy and no TraderDev crypto parameters were copied.",
  },
  data: {
    tickers: Object.keys(rowsByTicker).length,
    usableTickers: Object.values(rowsByTicker).filter(
      rows => rows && rows.length > 0
    ).length,
    benchmark: rowsByTicker["069500"]?.length ? "069500" : "229200",
    dateRange: { from: allDates[0] ?? null, to: allDates.at(-1) ?? null },
  },
  baseline: {
    signalWindows: baselineTrades.signalWindows,
    summary: baselineSummary,
    splitSample: baselineSplit,
  },
  challenger,
};

const fmt = (value: number) =>
  Number.isFinite(value) ? value.toFixed(2) : "∞";
const b = report.baseline.summary;
const c = challenger.summary;
const markdown = [
  "# Stoch–ADX–ATR Strategy Comparison",
  "",
  `- Generated: ${report.generatedAt}`,
  `- Shared usable tickers: ${report.data.usableTickers}/${report.data.tickers}`,
  `- Data range: ${report.data.dateRange.from} to ${report.data.dateRange.to}`,
  `- Lookback: ${report.methodology.lookbackDays} days`,
  "",
  "## Results",
  "",
  "| Metric | Existing screener | Stoch–ADX–ATR |",
  "|---|---:|---:|",
  `| Triggered trades | ${b.totalTrades} | ${c.totalTrades} |`,
  `| Win rate | ${b.winRate.toFixed(1)}% | ${c.winRate.toFixed(1)}% |`,
  `| Avg return | ${b.avgReturnPct.toFixed(2)}% | ${c.avgReturnPct.toFixed(2)}% |`,
  `| Median return | ${b.medianReturnPct.toFixed(2)}% | ${c.medianReturnPct.toFixed(2)}% |`,
  `| Profit factor | n/a | ${fmt(c.profitFactor)} |`,
  `| Stop rate | ${b.stopRate.toFixed(1)}% | ${c.stopRate.toFixed(1)}% |`,
  `| Target rate | ${b.targetRate.toFixed(1)}% | ${c.targetRate.toFixed(1)}% |`,
  `| OOS win rate | ${baselineSplit.outOfSample.winRate.toFixed(1)}% | ${c.outOfSample.winRate.toFixed(1)}% |`,
  `| OOS avg return | ${baselineSplit.outOfSample.avgReturnPct.toFixed(2)}% | ${c.outOfSample.avgReturnPct.toFixed(2)}% |`,
  "",
  "## Challenger configuration",
  ...Object.entries(challenger.config).map(
    ([key, value]) => `- ${key}: ${value}`
  ),
  "",
  "## Caveats",
  "",
  "- Existing screener produced only 3 triggered trades, so its OOS statistics are not reliable.",
  "- Challenger ADX is a rolling DX-strength proxy for this daily-data adaptation; it is not a direct copy of TraderDev's crypto implementation.",
  "- Do not promote to live trading without expanding the history and running walk-forward / parameter-sensitivity checks.",
  "",
  "해석 기준: 표본 수가 작거나 IS/OOS 괴리가 크면 실전 승격하지 않고 후보 전략으로만 유지합니다.",
].join("\n");

await mkdir(outputDir, { recursive: true });
await Promise.all([
  writeFile(outputJson, `${JSON.stringify(report, null, 2)}\n`, "utf8"),
  writeFile(outputMd, `${markdown}\n`, "utf8"),
]);

console.log(
  JSON.stringify(
    { outputJson, outputMd, data: report.data, baseline: b, challenger: c },
    null,
    2
  )
);
