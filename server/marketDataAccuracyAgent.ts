import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  fetchKoreanOhlcvRowsBatch,
  getKoreanStockName,
  type OhlcvRow,
} from "./koreaStockMcp";

export type MarketPriceCandidate = {
  ticker: string;
  companyName: string;
  market: "코스피" | "코스닥";
  currentPrice: number;
  triggerPrice: number;
  stopLossPrice: number;
};

export type MarketDataAccuracyIssue = {
  ticker: string;
  companyName: string;
  code:
    | "invalid_ticker"
    | "invalid_market"
    | "name_mismatch"
    | "missing_ohlcv"
    | "bad_ohlcv"
    | "future_quote"
    | "stale_quote"
    | "price_mismatch"
    | "invalid_plan";
  message: string;
};

export type MarketDataAccuracyRecord = {
  ticker: string;
  companyName: string;
  latestDate: string | null;
  sourceClose: number | null;
  candidatePrice: number;
  priceDriftPct: number | null;
  status: "verified" | "rejected";
  issues: MarketDataAccuracyIssue[];
};

export type MarketDataAccuracyReport = {
  generatedAt: string;
  source: string;
  rules: {
    maxStaleDays: number;
    maxPriceDriftPct: number;
  };
  checked: number;
  verified: number;
  rejected: number;
  records: MarketDataAccuracyRecord[];
};

export type MarketDataAccuracyOptions = {
  now?: Date;
  maxStaleDays?: number;
  maxPriceDriftPct?: number;
  rowsByTicker?: Record<string, OhlcvRow[] | null>;
  namesByTicker?: Record<string, string>;
  writeReport?: boolean;
};

const REPORT_DIR = path.join(process.cwd(), ".data", "quality", "market-data");
const REPORT_JSON_PATH = path.join(REPORT_DIR, "latest-report.json");
const REPORT_MD_PATH = path.join(REPORT_DIR, "latest-report.md");

function kstDate(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function daysBetween(from: string, to: string): number | null {
  const fromTime = Date.parse(`${from}T00:00:00Z`);
  const toTime = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(fromTime) || !Number.isFinite(toTime)) return null;
  return Math.round((toTime - fromTime) / 86400000);
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/[\s()（）·・\-]/g, "");
}

function issue(
  candidate: MarketPriceCandidate,
  code: MarketDataAccuracyIssue["code"],
  message: string
): MarketDataAccuracyIssue {
  return { ticker: candidate.ticker, companyName: candidate.companyName, code, message };
}

export function validateOhlcvRows(
  rows: OhlcvRow[] | null,
  today: string
): { latest: OhlcvRow | null; issues: string[] } {
  if (!rows?.length) return { latest: null, issues: ["최근 OHLCV 시세가 없습니다."] };
  const issues: string[] = [];
  const dates = new Set<string>();
  let previousDate = "";

  for (const row of rows) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.날짜)) {
      issues.push("시세 날짜 형식이 올바르지 않습니다.");
      continue;
    }
    if (dates.has(row.날짜)) issues.push(`중복 시세 날짜: ${row.날짜}`);
    dates.add(row.날짜);
    if (previousDate && row.날짜 < previousDate) issues.push("시세가 날짜순으로 정렬되지 않았습니다.");
    previousDate = row.날짜;
    if (row.날짜 > today) issues.push(`미래 날짜 시세: ${row.날짜}`);
    const prices = [row.시가, row.고가, row.저가, row.종가];
    if (prices.some(value => !Number.isFinite(value) || value <= 0)) {
      issues.push(`가격 값이 비정상입니다: ${row.날짜}`);
    }
    if (row.고가 < Math.max(row.시가, row.종가, row.저가)) {
      issues.push(`고가가 다른 가격보다 낮습니다: ${row.날짜}`);
    }
    if (row.저가 > Math.min(row.시가, row.종가, row.고가)) {
      issues.push(`저가가 다른 가격보다 높습니다: ${row.날짜}`);
    }
    if (!Number.isFinite(row.거래량) || row.거래량 < 0) {
      issues.push(`거래량 값이 비정상입니다: ${row.날짜}`);
    }
  }

  return { latest: rows.at(-1) ?? null, issues };
}

function validateCandidate(
  candidate: MarketPriceCandidate,
  rows: OhlcvRow[] | null,
  verifiedName: string | undefined,
  options: Required<Pick<MarketDataAccuracyOptions, "maxStaleDays" | "maxPriceDriftPct">>,
  today: string
): MarketDataAccuracyRecord {
  const issues: MarketDataAccuracyIssue[] = [];
  const ticker = candidate.ticker.trim();
  if (!/^\d{6}$/.test(ticker)) {
    issues.push(issue(candidate, "invalid_ticker", "티커가 한국 주식 6자리 형식이 아닙니다."));
  }
  if (candidate.market !== "코스피" && candidate.market !== "코스닥") {
    issues.push(issue(candidate, "invalid_market", "시장 구분이 올바르지 않습니다."));
  }
  if (!verifiedName || verifiedName === ticker) {
    issues.push(issue(candidate, "name_mismatch", "공식 종목명을 확인하지 못했습니다."));
  } else if (normalizeName(candidate.companyName) !== normalizeName(verifiedName)) {
    issues.push(issue(candidate, "name_mismatch", `종목명 불일치: 확인값 ${verifiedName}`));
  }

  const ohlcv = validateOhlcvRows(rows, today);
  if (ohlcv.issues.length) {
    const code = ohlcv.latest?.날짜 && ohlcv.latest.날짜 > today ? "future_quote" : "bad_ohlcv";
    issues.push(...ohlcv.issues.slice(0, 3).map(message => issue(candidate, code, message)));
  }
  const latest = ohlcv.latest;
  if (!latest) {
    issues.push(issue(candidate, "missing_ohlcv", "최신 시세를 확인하지 못했습니다."));
  }

  let priceDriftPct: number | null = null;
  if (latest) {
    const ageDays = daysBetween(latest.날짜, today);
    if (ageDays === null || ageDays < 0) {
      issues.push(issue(candidate, "future_quote", `시세 날짜가 현재 기준과 맞지 않습니다: ${latest.날짜}`));
    } else if (ageDays > options.maxStaleDays) {
      issues.push(issue(candidate, "stale_quote", `시세가 ${ageDays}일 지났습니다: ${latest.날짜}`));
    }
    priceDriftPct = latest.종가
      ? Math.abs(candidate.currentPrice - latest.종가) / latest.종가 * 100
      : null;
    if (
      priceDriftPct === null ||
      !Number.isFinite(candidate.currentPrice) ||
      candidate.currentPrice <= 0 ||
      priceDriftPct > options.maxPriceDriftPct
    ) {
      issues.push(
        issue(
          candidate,
          "price_mismatch",
          `알림 현재가 ${candidate.currentPrice}원과 최신 종가 ${latest.종가}원의 차이가 큽니다.`
        )
      );
    }
  }

  if (
    !Number.isFinite(candidate.triggerPrice) ||
    !Number.isFinite(candidate.stopLossPrice) ||
    candidate.triggerPrice <= 0 ||
    candidate.stopLossPrice <= 0 ||
    candidate.stopLossPrice >= candidate.triggerPrice ||
    (Number.isFinite(candidate.currentPrice) && candidate.triggerPrice < candidate.currentPrice)
  ) {
    issues.push(issue(candidate, "invalid_plan", "기준가와 주의가격 관계가 올바르지 않습니다."));
  }

  return {
    ticker,
    companyName: candidate.companyName,
    latestDate: latest?.날짜 ?? null,
    sourceClose: latest?.종가 ?? null,
    candidatePrice: candidate.currentPrice,
    priceDriftPct: priceDriftPct === null ? null : Number(priceDriftPct.toFixed(3)),
    status: issues.length ? "rejected" : "verified",
    issues,
  };
}

export async function verifyMarketDataCandidates<T extends MarketPriceCandidate>(
  candidates: T[],
  options: MarketDataAccuracyOptions = {}
): Promise<{ accepted: T[]; rejected: T[]; report: MarketDataAccuracyReport }> {
  const now = options.now ?? new Date();
  const today = kstDate(now);
  const maxStaleDays = Math.max(
    1,
    options.maxStaleDays ?? (Number(process.env.MARKET_DATA_MAX_STALE_DAYS) || 5)
  );
  const maxPriceDriftPct = Math.max(
    0.1,
    options.maxPriceDriftPct ?? (Number(process.env.MARKET_DATA_MAX_PRICE_DRIFT_PCT) || 1)
  );
  const uniqueTickers = Array.from(new Set(candidates.map(candidate => candidate.ticker.trim())));
  const rowsByTicker = options.rowsByTicker ?? await fetchKoreanOhlcvRowsBatch(uniqueTickers, 365);
  const namesByTicker = options.namesByTicker ?? Object.fromEntries(
    await Promise.all(uniqueTickers.map(async ticker => [ticker, await getKoreanStockName(ticker)] as const))
  );
  const records = candidates.map(candidate =>
    validateCandidate(candidate, rowsByTicker[candidate.ticker.trim()] ?? null, namesByTicker[candidate.ticker.trim()], { maxStaleDays, maxPriceDriftPct }, today)
  );
  const rejectedTickers = new Set(records.filter(record => record.status === "rejected").map(record => record.ticker));
  const accepted = candidates.filter(candidate => !rejectedTickers.has(candidate.ticker.trim()));
  const rejected = candidates.filter(candidate => rejectedTickers.has(candidate.ticker.trim()));
  const report: MarketDataAccuracyReport = {
    generatedAt: now.toISOString(),
    source: "Naver OHLCV (pykrx fallback) + Naver 종목명",
    rules: { maxStaleDays, maxPriceDriftPct },
    checked: candidates.length,
    verified: accepted.length,
    rejected: rejected.length,
    records,
  };
  if (options.writeReport !== false) await writeAccuracyReport(report);
  return { accepted, rejected, report };
}

async function writeAccuracyReport(report: MarketDataAccuracyReport) {
  await mkdir(REPORT_DIR, { recursive: true });
  const lines = [
    "# Market Data Accuracy Agent",
    "",
    `- 확인시각: ${report.generatedAt}`,
    `- 확인 ${report.checked}건 · 통과 ${report.verified}건 · 제외 ${report.rejected}건`,
    `- 규칙: 시세 ${report.rules.maxStaleDays}일 이내 · 현재가 차이 ${report.rules.maxPriceDriftPct}% 이내`,
    "",
    "## 결과",
    "",
    ...report.records.map(record => {
      const drift = record.priceDriftPct === null ? "n/a" : `${record.priceDriftPct}%`;
      const issues = record.issues.map(item => item.message).join(" / ");
      return `- ${record.status === "verified" ? "🟢" : "🔴"} ${record.companyName}(${record.ticker}) · 최신 ${record.latestDate ?? "없음"} · 종가 ${record.sourceClose ?? "없음"} · 알림 현재가 ${record.candidatePrice} · 차이 ${drift}${issues ? ` · ${issues}` : ""}`;
    }),
  ].join("\n");
  await Promise.all([
    writeFile(REPORT_JSON_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8"),
    writeFile(REPORT_MD_PATH, `${lines}\n`, "utf8"),
  ]);
}
