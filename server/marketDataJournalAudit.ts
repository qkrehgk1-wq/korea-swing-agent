import type { OhlcvRow } from "./koreaStockMcp";
import type { RecommendationEntry } from "./recommendationJournalAgent";

export type HistoricalAuditCheck = {
  date: string;
  asOfDate: string;
  referenceDate: string | null;
  ticker: string;
  companyName: string;
  priceDriftPct: number | null;
  issues: string[];
};

export type HistoricalAuditOptions = {
  maxPriceDriftPct?: number;
};

export function auditHistoricalRecommendationEntry(
  entry: RecommendationEntry,
  rows: OhlcvRow[] | null,
  verifiedName: string | undefined,
  options: HistoricalAuditOptions = {}
): HistoricalAuditCheck {
  const issues: string[] = [];
  if (verifiedName && normalizeName(entry.companyName) !== normalizeName(verifiedName)) {
    issues.push("종목명 불일치");
  }
  const asOfDate = marketDataCutoffDate(entry);
  const signalBar = latestBarOnOrBefore(rows, asOfDate);
  let priceDriftPct: number | null = null;
  if (!signalBar) {
    issues.push("참조 거래일 OHLCV 없음");
  } else {
    if (entry.triggerPrice < signalBar.종가 * 0.99) {
      issues.push("기준가가 참조 종가보다 낮음");
    }
    if (Number.isFinite(entry.currentPrice)) {
      priceDriftPct = Math.abs((entry.currentPrice as number) - signalBar.종가) / signalBar.종가 * 100;
      const maxPriceDriftPct = Math.max(0.1, options.maxPriceDriftPct ?? 1);
      if (priceDriftPct > maxPriceDriftPct) {
        issues.push("현재가가 참조 종가와 불일치");
      }
    }
  }
  if (!(entry.triggerPrice > entry.stopLossPrice && entry.stopLossPrice > 0)) {
    issues.push("기준가/주의가격 관계 오류");
  }
  if (!(entry.targetPrice > entry.triggerPrice)) {
    issues.push("목표가가 기준가보다 낮음");
  }
  return {
    date: entry.date,
    asOfDate,
    referenceDate: signalBar?.날짜 ?? null,
    ticker: entry.ticker,
    companyName: entry.companyName,
    priceDriftPct: priceDriftPct === null ? null : Number(priceDriftPct.toFixed(3)),
    issues,
  };
}

export function marketDataCutoffDate(entry: RecommendationEntry): string {
  const recordedAt = new Date(entry.recordedAt);
  if (!Number.isFinite(recordedAt.getTime())) return entry.date;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(recordedAt);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const localDate = `${values.year}-${values.month}-${values.day}`;
  const localHour = Number(values.hour);
  if (localHour >= 16) return localDate;
  const date = new Date(`${localDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

export function latestBarOnOrBefore(rows: OhlcvRow[] | null, date: string): OhlcvRow | null {
  if (!rows?.length) return null;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index].날짜 <= date) return rows[index];
  }
  return null;
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/[\s()（）·・\-]/g, "");
}
