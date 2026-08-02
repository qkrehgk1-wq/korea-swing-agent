import { config as loadEnv } from "dotenv";

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { OhlcvRow } from "../server/koreaStockMcp";
import { runStochAdxAtrBacktest } from "../server/stochAdxAtrBacktest";

loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

const symbols = [
  "SPY",
  "QQQ",
  "DIA",
  "IWM",
  "AAPL",
  "MSFT",
  "NVDA",
  "AMZN",
  "META",
  "GOOGL",
  "TSLA",
  "JPM",
];
const startDate = process.env.ALPACA_BACKTEST_START ?? "2018-01-01";
const endDate =
  process.env.ALPACA_BACKTEST_END ?? new Date().toISOString().slice(0, 10);
const feed = "iex";
const apiKey = process.env.ALPACA_API_KEY;
const secretKey = process.env.ALPACA_SECRET_KEY;
const dataBaseUrl = "https://data.alpaca.markets/v2";

if (!apiKey || !secretKey) {
  throw new Error("ALPACA_API_KEY and ALPACA_SECRET_KEY are required");
}

function asNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function mapBar(bar: Record<string, unknown>): OhlcvRow {
  return {
    날짜: String(bar.t).slice(0, 10),
    시가: asNumber(bar.o),
    고가: asNumber(bar.h),
    저가: asNumber(bar.l),
    종가: asNumber(bar.c),
    거래량: asNumber(bar.v),
  };
}

async function fetchBars(symbol: string) {
  const rows: OhlcvRow[] = [];
  let pageToken: string | undefined;
  do {
    const query = new URLSearchParams({
      timeframe: "1Day",
      start: `${startDate}T00:00:00Z`,
      end: `${endDate}T23:59:59Z`,
      feed,
      sort: "asc",
      limit: "10000",
    });
    if (pageToken) query.set("page_token", pageToken);
    const response = await fetch(
      `${dataBaseUrl}/stocks/${encodeURIComponent(symbol)}/bars?${query.toString()}`,
      {
        headers: {
          "APCA-API-KEY-ID": apiKey,
          "APCA-API-SECRET-KEY": secretKey,
        },
      }
    );
    if (!response.ok) {
      throw new Error(`Alpaca ${symbol} request failed: ${response.status}`);
    }
    const body = (await response.json()) as {
      bars?: Record<string, unknown>[];
      next_page_token?: string | null;
    };
    rows.push(...(body.bars ?? []).map(mapBar));
    pageToken = body.next_page_token ?? undefined;
  } while (pageToken);
  return rows;
}

function uniqueDates(rows: OhlcvRow[]) {
  return new Set(rows.map(row => row.날짜)).size;
}

function buyAndHoldReturn(rows: OhlcvRow[]) {
  const first = rows[0]?.종가;
  const last = rows.at(-1)?.종가;
  return first && last ? ((last - first) / first) * 100 : 0;
}

const rowsEntries = await Promise.all(
  symbols.map(async symbol => [symbol, await fetchBars(symbol)] as const)
);
const rowsByTicker = Object.fromEntries(rowsEntries);
const benchmarkRows = rowsByTicker.SPY ?? [];
const backtestOptions = {
  benchmarkTicker: "SPY",
  excludedTickers: ["SPY"],
};
const variants = {
  base: {
    label: "기존 Stoch–ADX–ATR",
    overrides: {},
  },
  regime: {
    label: "SPY 추세국면 필터",
    overrides: {
      benchmarkRegimeFilter: "trend" as const,
    },
  },
  target2: {
    label: "2R 조기 목표",
    overrides: {
      targetR: 2,
    },
  },
  target175: {
    label: "1.75R 조기 목표",
    overrides: {
      targetR: 1.75,
    },
  },
  quality: {
    label: "국면 + 신호품질 강화",
    overrides: {
      benchmarkRegimeFilter: "trend" as const,
      minAdx: 25,
      minVolumeRatio: 1,
    },
  },
  risk: {
    label: "국면 + 품질 + 2R 목표",
    overrides: {
      benchmarkRegimeFilter: "trend" as const,
      minAdx: 25,
      minVolumeRatio: 1,
      targetR: 2,
    },
  },
};
const results = Object.fromEntries(
  Object.entries(variants).map(([key, variant]) => [
    key,
    {
      label: variant.label,
      ...runStochAdxAtrBacktest(
        rowsByTicker,
        variant.overrides,
        backtestOptions
      ),
    },
  ])
);
const challenger = results.base;
const baseOos = challenger.summary.outOfSample;
const acceptedCandidates = Object.entries(results)
  .filter(([key, result]) => {
    if (key === "base") return false;
    const candidateOos = result.summary.outOfSample;
    const minimumTrades = Math.max(8, Math.floor(baseOos.trades * 0.75));
    return (
      candidateOos.trades >= minimumTrades &&
      candidateOos.avgReturnPct > baseOos.avgReturnPct &&
      result.summary.profitFactor >= challenger.summary.profitFactor
    );
  })
  .sort(
    (left, right) =>
      right[1].summary.outOfSample.avgReturnPct -
      left[1].summary.outOfSample.avgReturnPct
  );
const appliedVariant = acceptedCandidates[0]?.[0] ?? "base";
const applicationDecision =
  appliedVariant === "base"
    ? "OOS 표본에서 기준 전략을 동시에 이긴 후보가 없어 기준 전략을 유지"
    : `${appliedVariant} 후보를 OOS 기준으로 적용`;

const quality = symbols.map(symbol => {
  const rows = rowsByTicker[symbol] ?? [];
  const unique = uniqueDates(rows);
  return {
    symbol,
    rows: rows.length,
    uniqueDates: unique,
    duplicateDates: rows.length - unique,
    from: rows[0]?.날짜 ?? null,
    to: rows.at(-1)?.날짜 ?? null,
  };
});
const actualDates = quality
  .flatMap(item => [item.from, item.to])
  .filter((value): value is string => Boolean(value))
  .sort();
const report = {
  generatedAt: new Date().toISOString(),
  data: {
    provider: "Alpaca Trading API",
    feed,
    symbols,
    startDate,
    endDate,
    requestedSymbols: symbols.length,
    receivedSymbols: quality.filter(item => item.rows > 0).length,
    actualDateRange: {
      from: actualDates[0] ?? null,
      to: actualDates.at(-1) ?? null,
    },
    quality,
    caveats: [
      "Free Alpaca IEX feed; this is not the consolidated SIP feed.",
      "Universe is a liquid hand-picked US stock/ETF sample, not the full US equity universe.",
      "SPY is the benchmark and is excluded from challenger trades.",
      "This is a price/OHLCV backtest; dividends, borrow, tax, and survivorship effects are not modeled.",
    ],
  },
  benchmark: {
    symbol: "SPY",
    priceReturnPct: Number(buyAndHoldReturn(benchmarkRows).toFixed(2)),
  },
  challenger,
  variants: results,
  strategyDecision: {
    appliedVariant,
    acceptanceRule:
      "OOS trades >= max(8, base OOS trades의 75%), OOS 평균수익률 개선, profit factor 하락 없음",
    decision: applicationDecision,
  },
};

const outputDir = path.join(process.cwd(), ".data", "backtests");
const outputJson = path.join(outputDir, "alpaca-us-stoch-adx-atr.json");
const outputMd = path.join(outputDir, "alpaca-us-stoch-adx-atr.md");
const summary = challenger.summary;
const variantRows = Object.entries(results).map(([key, result]) => {
  const variantSummary = result.summary;
  return `| ${key} · ${result.label} | ${variantSummary.totalTrades} | ${variantSummary.winRate.toFixed(1)}% | ${variantSummary.avgReturnPct.toFixed(2)}% | ${Number.isFinite(variantSummary.profitFactor) ? variantSummary.profitFactor.toFixed(2) : "∞"} | ${variantSummary.outOfSample.trades} | ${variantSummary.outOfSample.winRate.toFixed(1)}% | ${variantSummary.outOfSample.avgReturnPct.toFixed(2)}% |`;
});
const markdown = [
  "# Alpaca US Stocks — Stoch–ADX–ATR Backtest",
  "",
  `- Generated: ${report.generatedAt}`,
  `- Data: ${startDate} to ${endDate} · Alpaca ${feed.toUpperCase()} daily bars`,
  `- Actual received range: ${report.data.actualDateRange.from ?? "n/a"} to ${report.data.actualDateRange.to ?? "n/a"}`,
  `- Universe: ${report.data.receivedSymbols}/${report.data.requestedSymbols} symbols`,
  `- SPY price return: ${report.benchmark.priceReturnPct.toFixed(2)}%`,
  `- Applied variant: ${report.strategyDecision.appliedVariant} (${report.strategyDecision.decision})`,
  "",
  "## Strategy variants",
  "",
  "| Variant | Trades | Win rate | Avg/trade | PF | OOS trades | OOS win rate | OOS avg/trade |",
  "|---|---:|---:|---:|---:|---:|---:|---:|",
  ...variantRows,
  "",
  `- Acceptance rule: ${report.strategyDecision.acceptanceRule}`,
  "",
  "## Reference strategy detail",
  "",
  `- Signal windows: ${challenger.signalWindows}`,
  `- Stop rate: ${summary.stopRate.toFixed(1)}% · target rate: ${summary.targetRate.toFixed(1)}% · no-trigger rate: ${summary.noTriggerRate.toFixed(1)}%`,
  "",
  "## Data quality",
  "",
  ...quality.map(
    item =>
      `- ${item.symbol}: ${item.rows} rows, ${item.duplicateDates} duplicate dates, ${item.from ?? "n/a"} to ${item.to ?? "n/a"}`
  ),
  "",
  "## Caveats",
  "",
  ...report.data.caveats.map(item => `- ${item}`),
].join("\n");

await mkdir(outputDir, { recursive: true });
await Promise.all([
  writeFile(outputJson, `${JSON.stringify(report, null, 2)}\n`, "utf8"),
  writeFile(outputMd, `${markdown}\n`, "utf8"),
]);

console.log(
  JSON.stringify(
    { outputJson, outputMd, benchmark: report.benchmark, summary },
    null,
    2
  )
);
