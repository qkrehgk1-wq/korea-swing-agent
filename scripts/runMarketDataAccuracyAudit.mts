import "dotenv/config";

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  fetchKoreanOhlcvRowsBatch,
  getKoreanStockName,
} from "../server/koreaStockMcp";
import { auditHistoricalRecommendationEntry } from "../server/marketDataJournalAudit";
import type { RecommendationEntry } from "../server/recommendationJournalAgent";

const journalPath = path.join(process.cwd(), "data", "journal", "recommendations.json");
const outputDir = path.join(process.cwd(), ".data", "quality", "market-data");
const outputPath = path.join(outputDir, "journal-audit.md");
const maxPriceDriftPct = Math.max(
  0.1,
  Number(process.env.MARKET_DATA_MAX_PRICE_DRIFT_PCT) || 1
);

async function main() {
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as RecommendationEntry[];
  const missingVerificationFields = journal.filter(
    entry => !Number.isFinite(entry.currentPrice) || (entry.market !== "코스피" && entry.market !== "코스닥")
  );
  const eligibleEntries = journal.filter(
    entry =>
      Number.isFinite(entry.currentPrice) &&
      (entry.market === "코스피" || entry.market === "코스닥")
  );
  const duplicateKeys = new Set<string>();
  const duplicateEntries = journal.filter(entry => {
    const key = `${entry.date}:${entry.ticker}:${entry.source}`;
    if (duplicateKeys.has(key)) return true;
    duplicateKeys.add(key);
    return false;
  });
  const tickers = Array.from(new Set(journal.map(entry => entry.ticker).filter(ticker => /^\d{6}$/.test(ticker))));
  const rowsByTicker = await fetchKoreanOhlcvRowsBatch(tickers, 365);
  const namesByTicker = Object.fromEntries(
    await Promise.all(tickers.map(async ticker => [ticker, await getKoreanStockName(ticker)] as const))
  );
  const historicalChecks = journal.map(entry =>
    auditHistoricalRecommendationEntry(
      entry,
      rowsByTicker[entry.ticker] ?? null,
      namesByTicker[entry.ticker],
      { maxPriceDriftPct }
    )
  );
  const historicalIssues = historicalChecks.filter(check => check.issues.length > 0);
  const historicalVerified = eligibleEntries.filter(entry => {
    const check = historicalChecks.find(item => item.ticker === entry.ticker && item.date === entry.date);
    return check?.issues.length === 0;
  }).length;
  const historicalRejected = eligibleEntries.length - historicalVerified;
  const missingSignalBar = historicalChecks.filter(check => check.issues.includes("참조 거래일 OHLCV 없음")).length;
  const adjustedSignalDate = historicalChecks.filter(check => check.referenceDate && check.referenceDate !== check.asOfDate).length;
  const triggerBelowClose = historicalChecks.filter(check => check.issues.includes("기준가가 참조 종가보다 낮음")).length;
  const invalidPlan = historicalChecks.filter(check => check.issues.includes("기준가/주의가격 관계 오류")).length;
  const nameMismatch = historicalChecks.filter(check => check.issues.includes("종목명 불일치")).length;
  const currentPriceMismatch = historicalChecks.filter(check => check.issues.includes("현재가가 참조 종가와 불일치")).length;
  const markdown = [
    "# 저널 시세 정확성 소급 감사",
    "",
    `- 감사시각: ${new Date().toISOString()}`,
    `- 전체 저널: ${journal.length}건`,
    `- 현재가·시장 정보가 있어 검증 가능: ${eligibleEntries.length}건`,
    `- 현재가 또는 시장 정보 누락: ${missingVerificationFields.length}건`,
    `- 중복 키(date+ticker+source): ${duplicateEntries.length}건`,
    `- 기록 당시 기준 검증 결과: 통과 ${historicalVerified}건 · 제외 ${historicalRejected}건`,
    `- 참조 거래일 OHLCV 누락: ${missingSignalBar}건 · 기준일 보정: ${adjustedSignalDate}건 · 현재가 불일치: ${currentPriceMismatch}건 · 기준가가 참조 종가보다 낮음: ${triggerBelowClose}건 · 가격계획 오류: ${invalidPlan}건 · 종목명 불일치: ${nameMismatch}건`,
    "",
    "## 해석",
    "",
    missingVerificationFields.length
      ? "- 현재가 또는 시장 정보가 없는 과거 기록은 당시 알림 가격을 소급 판정하지 않고 별도 누락으로 분류했습니다."
      : "- 검증에 필요한 현재가와 시장 정보가 모든 기록에 있습니다.",
    duplicateEntries.length
      ? "- 같은 날짜·종목·출처가 반복되어 성과 집계와 가격 감사에서 중복 가능성을 확인해야 합니다."
      : "- 같은 날짜·종목·출처 중복은 발견되지 않았습니다.",
    "",
    "## 소급 불일치 목록",
    "",
    ...(historicalIssues.length
      ? historicalIssues.slice(0, 30).map(check => `- ${check.date} ${check.companyName}(${check.ticker}) · ${check.issues.join(" / ")}`)
      : ["- 신호일 OHLCV와 가격계획에서 명확한 불일치가 발견되지 않았습니다."]),
    "",
    "## 다음 운영 기준",
    "",
    "- 새 저널 기록은 현재가·기준가·주의가격·시세일자를 함께 저장합니다.",
    "- 검수 실패 후보는 텔레그램과 저널에 남기지 않습니다.",
  ].join("\n");
  await mkdir(outputDir, { recursive: true });
  await writeFile(outputPath, `${markdown}\n`, "utf8");
  console.log(
    JSON.stringify(
      {
        outputPath,
        journal: journal.length,
        eligible: eligibleEntries.length,
        missingVerificationFields: missingVerificationFields.length,
        duplicateEntries: duplicateEntries.length,
        missingSignalBar,
        adjustedSignalDate,
        triggerBelowClose,
        invalidPlan,
        nameMismatch,
        currentPriceMismatch,
        historicalIssues: historicalIssues.length,
        verified: historicalVerified,
        rejected: historicalRejected,
      },
      null,
      2
    )
  );
}

main().catch(error => {
  console.error("[Market Data Accuracy Audit] Fatal:", error);
  process.exit(1);
});
