import "dotenv/config";

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { fetchKoreanOhlcvRowsBatch } from "../server/koreaStockMcp";
import { computeExpectancy } from "../server/expectancy";
import {
  scoreEntry,
  summarizeJournal,
  type JournalConfig,
  type RecommendationEntry,
} from "../server/recommendationJournalAgent";

const journalPath = path.join(process.cwd(), "data", "journal", "recommendations.json");
const outputDir = path.join(process.cwd(), ".data", "quality", "journal");
const outputPath = path.join(outputDir, "scoring-alignment-audit.md");

async function main() {
  const entries = JSON.parse(await readFile(journalPath, "utf8")) as RecommendationEntry[];
  const tickers = Array.from(new Set(entries.map(entry => entry.ticker)));
  const rowsByTicker = await fetchKoreanOhlcvRowsBatch(tickers, 365);
  const promoted = await readPromotedExitConfig();
  const config: JournalConfig = {
    entryWindow: Number(process.env.JOURNAL_ENTRY_WINDOW) || 5,
    holdingDays: Number(process.env.JOURNAL_HOLDING_DAYS) || 15,
    breakevenAtR: promoted?.exitBreakevenAtR ?? Number(process.env.EXIT_BREAKEVEN_AT_R ?? "0.6"),
    trailGivebackR: promoted?.exitTrailGivebackR ?? Number(process.env.EXIT_TRAIL_GIVEBACK_R ?? "0.5"),
    roundTripCostPct: Number(process.env.ROUND_TRIP_COST_PCT ?? "0.35"),
  };
  const recomputed = entries.map(entry => {
    const reset: RecommendationEntry = {
      ...entry,
      status: "open",
      entryDate: undefined,
      exitDate: undefined,
      exitPrice: undefined,
      returnPct: undefined,
      scoredAt: undefined,
    };
    return scoreEntry(reset, rowsByTicker[entry.ticker] ?? [], config);
  });
  const changed = entries
    .map((entry, index) => ({
      entry,
      recomputed: recomputed[index],
    }))
    .filter(({ entry, recomputed: next }) =>
      entry.status !== next.status ||
      entry.entryDate !== next.entryDate ||
      entry.exitDate !== next.exitDate ||
      entry.exitPrice !== next.exitPrice ||
      entry.returnPct !== next.returnPct
    );
  const oldSummary = summarizeJournal(entries);
  const recomputedSummary = summarizeJournal(recomputed);
  const toExpectancyTrades = (items: RecommendationEntry[]) =>
    items
      .filter(entry => !entry.watchOnly && ["target", "stop", "trail_exit", "time_exit"].includes(entry.status))
      .map(entry => ({
        triggerPrice: entry.triggerPrice,
        stopLossPrice: entry.stopLossPrice,
        returnPct: entry.returnPct ?? 0,
      }));
  const oldExpectancy = computeExpectancy(toExpectancyTrades(entries));
  const recomputedExpectancy = computeExpectancy(toExpectancyTrades(recomputed));
  const markdown = [
    "# 저널 정산 규칙 일치성 감사",
    "",
    `- 감사시각: ${new Date().toISOString()}`,
    `- 대상: ${entries.length}건 · 종목 ${tickers.length}개`,
    `- 공통 설정: 진입 ${config.entryWindow}봉 · 보유 ${config.holdingDays}봉 · 손익분기 ${config.breakevenAtR}R · 트레일 양보 ${config.trailGivebackR}R · 비용 ${config.roundTripCostPct}%`,
    `- 기존 정산과 백테스트 동일 규칙 재계산 결과가 다른 기록: ${changed.length}건`,
    "",
    "## 성과 비교",
    "",
    `- 기존: 정산 ${oldSummary.triggered}건 · 승률 ${oldSummary.winRate}% · 평균 ${oldSummary.avgReturnPct}%`,
    `- 재계산: 정산 ${recomputedSummary.triggered}건 · 승률 ${recomputedSummary.winRate}% · 평균 ${recomputedSummary.avgReturnPct}%`,
    `- R 기대값: 기존 ${oldExpectancy.expectancyR}R (${oldExpectancy.edgeVerdict}) → 재계산 ${recomputedExpectancy.expectancyR}R (${recomputedExpectancy.edgeVerdict})`,
    "",
    "## 변경 목록",
    "",
    ...(changed.length
      ? changed.slice(0, 40).map(({ entry, recomputed: next }) =>
          `- ${entry.date} ${entry.companyName}(${entry.ticker}) · ${entry.status}/${entry.returnPct ?? "-"}% → ${next.status}/${next.returnPct ?? "-"}%`
        )
      : ["- 변경 없음"]),
    "",
    "## 원칙",
    "",
    "- 원본 저널은 변경하지 않았습니다.",
    "- 신규 정산은 백테스트와 동일하게 진입 당일을 보유 창에 포함합니다.",
    "- 진입 당일 고가·저가가 모두 닿으면 OHLCV 순서를 알 수 없으므로 손절을 먼저 적용합니다.",
  ].join("\n");
  await mkdir(outputDir, { recursive: true });
  await writeFile(outputPath, `${markdown}\n`, "utf8");
  console.log(JSON.stringify({ outputPath, entries: entries.length, tickers: tickers.length, changed: changed.length, oldSummary, recomputedSummary, oldExpectancy, recomputedExpectancy }, null, 2));
}

async function readPromotedExitConfig(): Promise<{
  exitBreakevenAtR?: number;
  exitTrailGivebackR?: number;
} | null> {
  try {
    return JSON.parse(
      await readFile(
        path.join(process.cwd(), ".data", "backtests", "prediction-quality-overrides.json"),
        "utf8"
      )
    );
  } catch {
    return null;
  }
}

main().catch(error => {
  console.error("[Journal Scoring Alignment Audit] Fatal:", error);
  process.exit(1);
});
