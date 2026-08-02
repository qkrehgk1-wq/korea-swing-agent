import { config as loadEnv } from "dotenv";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { computeExpectancy } from "../server/expectancy";
import {
  isSettledStatus,
  loadRecommendationJournal,
} from "../server/recommendationJournalAgent";
import { fetchBacktestRows } from "../server/swingBacktestAgent";
import type { OhlcvRow } from "../server/koreaStockMcp";
import { runBillionaireStrategyBacktest } from "../server/billionaireStrategy";

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
const apiKey = process.env.ALPACA_API_KEY;
const secretKey = process.env.ALPACA_SECRET_KEY;

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

async function fetchAlpacaBars(symbol: string) {
  if (!apiKey || !secretKey) throw new Error("Alpaca credentials are required");
  const rows: OhlcvRow[] = [];
  let pageToken: string | undefined;
  do {
    const query = new URLSearchParams({
      timeframe: "1Day",
      start: `${startDate}T00:00:00Z`,
      end: `${endDate}T23:59:59Z`,
      feed: "iex",
      sort: "asc",
      limit: "10000",
    });
    if (pageToken) query.set("page_token", pageToken);
    const response = await fetch(
      `https://data.alpaca.markets/v2/stocks/${encodeURIComponent(symbol)}/bars?${query.toString()}`,
      {
        headers: {
          "APCA-API-KEY-ID": apiKey,
          "APCA-API-SECRET-KEY": secretKey,
        },
      }
    );
    if (!response.ok)
      throw new Error(`Alpaca ${symbol} request failed: ${response.status}`);
    const body = (await response.json()) as {
      bars?: Record<string, unknown>[];
      next_page_token?: string | null;
    };
    rows.push(...(body.bars ?? []).map(mapBar));
    pageToken = body.next_page_token ?? undefined;
  } while (pageToken);
  return rows;
}

async function fetchUsRows() {
  const pairs = await Promise.all(
    symbols.map(
      async symbol => [symbol, await fetchAlpacaBars(symbol)] as const
    )
  );
  return Object.fromEntries(pairs) as Record<string, OhlcvRow[]>;
}

function dataShape(rowsByTicker: Record<string, OhlcvRow[] | null>) {
  const entries = Object.entries(rowsByTicker).map(([ticker, rows]) => ({
    ticker,
    rows: rows?.length ?? 0,
    duplicateDates: rows
      ? rows.length - new Set(rows.map(row => row.날짜)).size
      : 0,
    from: rows?.[0]?.날짜 ?? null,
    to: rows?.at(-1)?.날짜 ?? null,
  }));
  const dates = entries
    .flatMap(item => [item.from, item.to])
    .filter((value): value is string => Boolean(value))
    .sort();
  return {
    symbols: entries.length,
    rows: entries.reduce((sum, item) => sum + item.rows, 0),
    duplicateRows: entries.reduce((sum, item) => sum + item.duplicateDates, 0),
    actualDateRange: { from: dates[0] ?? null, to: dates.at(-1) ?? null },
    perTicker: entries,
  };
}

async function main() {
  const krxRows = await fetchBacktestRows();
  const usRows = await fetchUsRows();
  const krxOptions = {
    benchmarkTicker: "069500",
    excludedTickers: ["069500", "229200"],
  };
  const usOptions = { benchmarkTicker: "SPY", excludedTickers: ["SPY"] };
  const variants = {
    core: {},
    stochasticRequired: { stochasticConfirmation: "required" as const },
    neutralRegimeAllowed: { minRegimeScore: 0 },
    weakerRsAllowed: { minRelativeStrength: -10 },
  };
  const variantResults = Object.fromEntries(
    Object.entries(variants).map(([name, overrides]) => [
      name,
      {
        krx: runBillionaireStrategyBacktest(krxRows, overrides, krxOptions),
        us: runBillionaireStrategyBacktest(usRows, overrides, usOptions),
      },
    ])
  );
  const krx = variantResults.core.krx;
  const us = variantResults.core.us;
  const journal = await loadRecommendationJournal();
  const liveSettled = journal
    .filter(entry => !entry.watchOnly && isSettledStatus(entry.status))
    .map(entry => ({
      triggerPrice: entry.triggerPrice,
      stopLossPrice: entry.stopLossPrice,
      returnPct: entry.returnPct ?? 0,
      outcome: entry.status,
    }));
  const liveExpectancy = computeExpectancy(liveSettled);
  const report = {
    generatedAt: new Date().toISOString(),
    strategy: {
      name: "Billionaire Core v1",
      posture:
        liveExpectancy.edgeVerdict === "positive"
          ? "candidate_for_promotion"
          : "shadow_only",
      components: [
        "relative strength versus market benchmark",
        "20/60 moving-average trend alignment",
        "ADX and MACD confirmation",
        "volume ratio and cumulative volume-flow confirmation",
        "pullback or volume-backed breakout entry",
        "anti-chase and volatility gates",
        "ATR stop, 2.5R target, break-even and trailing exit",
        "R-based expectancy and live-edge risk gate",
      ],
      excludedFromHistoricalScore: [
        "LLM opinions",
        "news sentiment",
        "supply labels",
        "future fundamentals",
      ],
    },
    data: {
      krx: dataShape(krxRows),
      us: dataShape(usRows),
      usFeed: "Alpaca IEX daily bars",
      usRequestedDateRange: { from: startDate, to: endDate },
    },
    liveEvidence: {
      settledTrades: liveSettled.length,
      expectancy: liveExpectancy,
      decision:
        liveExpectancy.edgeVerdict === "positive"
          ? "실현 기대값이 양수일 때만 제한적 승격 검토"
          : "실현 기대값이 양수가 아니므로 자동 실행·사이징 금지, 섀도 검증 유지",
    },
    results: { krx, us, variants: variantResults },
    caveats: [
      "KRX와 미국 표본은 각각 다른 시장 데이터 공급원과 거래비용을 사용합니다.",
      "OOS 표본과 라이브 표본이 충분하지 않으면 전략 승격을 하지 않습니다.",
      "SPY 단순 보유수익률과 거래별 평균수익률은 포트폴리오 성과 비교가 아닙니다.",
    ],
  };
  const outputDir = path.join(process.cwd(), ".data", "backtests");
  const outputJson = path.join(outputDir, "billionaire-core-v1.json");
  const outputMd = path.join(outputDir, "billionaire-core-v1.md");
  const row = (label: string, result: typeof krx) => {
    const s = result.summary;
    const profitFactor = s.profitFactor === null ? "∞" : s.profitFactor.toFixed(2);
    return `| ${label} | ${s.totalTrades} | ${s.winRate.toFixed(1)}% | ${s.avgReturnPct.toFixed(2)}% | ${profitFactor} | ${s.expectancyR.toFixed(3)}R | ${s.outOfSample.trades} | ${s.outOfSample.winRate.toFixed(1)}% | ${s.outOfSample.avgReturnPct.toFixed(2)}% |`;
  };
  const variantRow = (name: string, result: typeof krx) => {
    const s = result.summary;
    const profitFactor = s.profitFactor === null ? "∞" : s.profitFactor.toFixed(2);
    return `| ${name} | ${s.totalTrades} | ${s.winRate.toFixed(1)}% | ${s.avgReturnPct.toFixed(2)}% | ${profitFactor} | ${s.expectancyR.toFixed(3)}R | ${s.outOfSample.trades} | ${s.outOfSample.winRate.toFixed(1)}% | ${s.outOfSample.avgReturnPct.toFixed(2)}% |`;
  };
  const markdown = [
    "# Billionaire Core v1 — 통합 전략 백테스트",
    "",
    `- Generated: ${report.generatedAt}`,
    `- 운영 판정: **${report.strategy.posture}**`,
    "",
    "## 전략 구성",
    "",
    ...report.strategy.components.map(item => `- ${item}`),
    "",
    "과거 신호 점수에서 뉴스·수급·LLM 의견을 제외하고, 라이브에서는 이를 보조 위험 경고로만 사용합니다.",
    "",
    "## 결과",
    "",
    "| 시장 | 거래 | 승률 | 평균/거래 | PF | 기대값 | OOS 거래 | OOS 승률 | OOS 평균 |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    row("KRX", krx),
    row("US Alpaca", us),
    "",
    "## 후보 변형 비교 (US Alpaca)",
    "",
    "| Variant | 거래 | 승률 | 평균/거래 | PF | 기대값 | OOS 거래 | OOS 승률 | OOS 평균 |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...Object.entries(variantResults).map(([name, result]) =>
      variantRow(name, result.us)
    ),
    "",
    "## 라이브 게이트",
    "",
    `- 정산 거래: ${liveSettled.length}건 · 기대값 ${liveExpectancy.expectancyR}R · 판정 ${liveExpectancy.edgeVerdict}`,
    `- ${report.liveEvidence.decision}`,
    "",
    "## 데이터 품질 / 한계",
    "",
    `- KRX: ${report.data.krx.symbols}종목, ${report.data.krx.duplicateRows}개 중복행, ${report.data.krx.actualDateRange.from ?? "n/a"} ~ ${report.data.krx.actualDateRange.to ?? "n/a"}`,
    `- US: ${report.data.us.symbols}종목, ${report.data.us.duplicateRows}개 중복행, ${report.data.us.actualDateRange.from ?? "n/a"} ~ ${report.data.us.actualDateRange.to ?? "n/a"}`,
    ...report.caveats.map(item => `- ${item}`),
  ].join("\n");
  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeFile(outputJson, `${JSON.stringify(report, null, 2)}\n`, "utf8"),
    writeFile(outputMd, `${markdown}\n`, "utf8"),
  ]);
  console.log(
    JSON.stringify(
      {
        outputJson,
        outputMd,
        posture: report.strategy.posture,
        krx: krx.summary,
        us: us.summary,
      },
      null,
      2
    )
  );
}

main().catch(error => {
  console.error("[Billionaire Core] Fatal:", error);
  process.exit(1);
});
