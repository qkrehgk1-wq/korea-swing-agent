/**
 * Watchlist Monitor Service (Korean equities)
 *
 * Detects meaningful changes on watchlisted Korean stocks — large daily moves,
 * volume surges, and 52-week-high proximity — using real OHLCV data. State is
 * persisted between runs so the same trading day is never alerted twice
 * (no more "latest row" spam on every scheduled run).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { notifyOwner } from "./_core/notification";
import {
  calculateSnapshot,
  fetchKoreanOhlcvRows,
  getKoreanStockName,
  isKoreanTicker,
  type OhlcvRow,
} from "./koreaStockMcp";

interface WatchlistItem {
  userId: number;
  ticker: string;
  addedAt: Date;
}

export interface WatchlistAlertSummary {
  ticker: string;
  companyName: string;
  alerts: number;
  headlines: string[];
}

type MonitorState = Record<string, { lastDate: string; lastClose: number }>;

const STATE_DIR = path.join(process.cwd(), ".data");
const STATE_PATH = path.join(STATE_DIR, "watchlist-monitor-state.json");

const PRICE_MOVE_THRESHOLD = 7; // |daily change| % considered notable
const VOLUME_SURGE_RATIO = 2.5; // latest volume vs 20d average
const NEAR_HIGH_THRESHOLD = 1.5; // within % of 52-week high

async function loadState(): Promise<MonitorState> {
  try {
    const raw = await readFile(STATE_PATH, "utf8");
    return JSON.parse(raw) as MonitorState;
  } catch {
    return {};
  }
}

async function saveState(state: MonitorState): Promise<void> {
  try {
    await mkdir(STATE_DIR, { recursive: true });
    await writeFile(STATE_PATH, JSON.stringify(state, null, 2), "utf8");
  } catch (error) {
    console.warn("[Watchlist Monitor] Failed to persist state:", error);
  }
}

/**
 * Build alert headlines for a single ticker from its latest OHLCV window.
 * Returns an empty array when nothing noteworthy happened.
 */
function detectChangeHeadlines(rows: OhlcvRow[]): string[] {
  const snapshot = calculateSnapshot(rows);
  if (!snapshot) {
    return [];
  }

  const headlines: string[] = [];

  if (Math.abs(snapshot.changePercent) >= PRICE_MOVE_THRESHOLD) {
    const direction = snapshot.changePercent > 0 ? "급등" : "급락";
    headlines.push(
      `전일 대비 ${snapshot.changePercent > 0 ? "+" : ""}${snapshot.changePercent.toFixed(1)}% ${direction}`
    );
  }

  if (snapshot.volumeRatio >= VOLUME_SURGE_RATIO) {
    headlines.push(`거래량 급증 (20일 평균 대비 ${snapshot.volumeRatio.toFixed(1)}배)`);
  }

  if (Math.abs(snapshot.distanceFromHigh) <= NEAR_HIGH_THRESHOLD) {
    headlines.push(`52주 신고가 근접 (고점 대비 ${snapshot.distanceFromHigh.toFixed(1)}%)`);
  }

  return headlines;
}

/**
 * Monitor every watchlisted Korean stock once. Deduplicates by trading day:
 * a ticker whose latest bar was already processed is skipped. Returns a
 * per-ticker summary so the caller does not need a second pass.
 */
export async function monitorWatchlist(
  watchlist: WatchlistItem[]
): Promise<WatchlistAlertSummary[]> {
  const tickers = Array.from(
    new Set(watchlist.map((item) => item.ticker.trim()).filter(isKoreanTicker))
  );

  if (tickers.length === 0) {
    console.log("[Watchlist Monitor] No Korean tickers to monitor.");
    return [];
  }

  console.log(`[Watchlist Monitor] Monitoring ${tickers.length} Korean tickers...`);
  const state = await loadState();
  const summaries: WatchlistAlertSummary[] = [];

  for (const ticker of tickers) {
    try {
      const rows = await fetchKoreanOhlcvRows(ticker);
      if (!rows || rows.length === 0) {
        continue;
      }

      const latest = rows[rows.length - 1];
      const latestDate = latest.날짜;
      const previous = state[ticker];

      // Same trading day already processed → no duplicate alert.
      if (previous && previous.lastDate === latestDate) {
        summaries.push({ ticker, companyName: ticker, alerts: 0, headlines: [] });
        continue;
      }

      const headlines = detectChangeHeadlines(rows);
      const companyName = await getKoreanStockName(ticker);

      if (headlines.length > 0) {
        await notifyOwner({
          title: `${companyName}(${ticker}) 관심종목 변동 감지`,
          content: [
            `**종목:** ${companyName} (${ticker})`,
            `**기준일:** ${latestDate}`,
            "",
            ...headlines.map((line) => `- ${line}`),
            "",
            "대시보드에서 상세 분석을 확인하세요.",
          ].join("\n"),
        });
      }

      state[ticker] = { lastDate: latestDate, lastClose: latest.종가 };
      summaries.push({ ticker, companyName, alerts: headlines.length, headlines });

      // Gentle pacing to avoid hammering the MCP backend.
      await new Promise((resolve) => setTimeout(resolve, 400));
    } catch (error) {
      console.error(`[Watchlist Monitor] Error monitoring ${ticker}:`, error);
    }
  }

  await saveState(state);
  console.log("[Watchlist Monitor] Watchlist monitoring completed");
  return summaries;
}
