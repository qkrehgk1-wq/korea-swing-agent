import "dotenv/config";

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { routeToCommander } from "./commanderChannel";
import { fetchKoreanOhlcvRowsBatch, type OhlcvRow } from "./koreaStockMcp";
import type { TechnicalSwingCandidate } from "./technicalSwingScreener";

/**
 * Live recommendation journal + outcome scorer. Records each day's swing picks
 * to a tracked file, then — once enough forward price data exists — scores how
 * they actually played out (target / stop / time-exit / no-entry) and reports
 * real-world performance. This grounds the agent in its own live calls, not
 * just historical backtests.
 */

export type RecommendationStatus = "open" | "target" | "stop" | "time_exit" | "no_entry";

export type RecommendationEntry = {
  date: string; // signal date, KST yyyy-mm-dd
  ticker: string;
  companyName: string;
  market?: string;
  source: "swing";
  championAt?: string;
  triggerPrice: number;
  stopLossPrice: number;
  targetPrice: number;
  swingScore?: number;
  qualityScore?: number;
  relativeStrength?: number;
  supplyState?: "accumulating" | "distributing" | "neutral";
  newsState?: "positive" | "negative" | "neutral";
  recordedAt: string;
  status: RecommendationStatus;
  entryDate?: string;
  exitDate?: string;
  exitPrice?: number;
  returnPct?: number;
  scoredAt?: string;
};

export type JournalConfig = { entryWindow: number; holdingDays: number };

export type JournalSummary = {
  total: number;
  settled: number;
  open: number;
  triggered: number;
  noEntry: number;
  wins: number;
  losses: number;
  winRate: number;
  avgReturnPct: number;
  targetRate: number;
  stopRate: number;
};

const JOURNAL_PATH = path.join(process.cwd(), "data", "journal", "recommendations.json");
const REPORT_DIR = path.join(process.cwd(), ".data", "journal");
const REPORT_JSON_PATH = path.join(REPORT_DIR, "latest-report.json");
const REPORT_MD_PATH = path.join(REPORT_DIR, "latest-report.md");

function journalConfig(): JournalConfig {
  return {
    entryWindow: Number(process.env.JOURNAL_ENTRY_WINDOW) || 5,
    holdingDays: Number(process.env.JOURNAL_HOLDING_DAYS) || 15,
  };
}

function targetMultiple(): number {
  return Number(process.env.JOURNAL_TARGET_R) || 2;
}

export function kstDate(now = new Date()): string {
  const kst = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Seoul" }));
  const year = kst.getFullYear();
  const month = `${kst.getMonth() + 1}`.padStart(2, "0");
  const day = `${kst.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

async function readJournal(): Promise<RecommendationEntry[]> {
  try {
    const parsed = JSON.parse(await readFile(JOURNAL_PATH, "utf8"));
    return Array.isArray(parsed) ? (parsed as RecommendationEntry[]) : [];
  } catch {
    return [];
  }
}

async function writeJournal(entries: RecommendationEntry[]): Promise<void> {
  await mkdir(path.dirname(JOURNAL_PATH), { recursive: true });
  await writeFile(JOURNAL_PATH, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
}

/** Exposes the journal so the evolution agent can learn from realized outcomes. */
export async function loadRecommendationJournal(): Promise<RecommendationEntry[]> {
  return readJournal();
}

const CHAMPION_PATH = path.join(process.cwd(), "data", "evolution", "champion.json");

/**
 * Fingerprint (champion timestamp) live when a pick is recorded, so realized
 * outcomes can later be attributed to the champion strategy that produced them.
 */
async function readChampionFingerprint(): Promise<string | undefined> {
  try {
    const champion = JSON.parse(await readFile(CHAMPION_PATH, "utf8")) as { generatedAt?: string };
    return typeof champion.generatedAt === "string" ? champion.generatedAt : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Pure outcome scorer. Given an open entry and the forward daily rows strictly
 * after its signal date, returns the entry updated with a terminal status once
 * enough data exists, or unchanged (still "open") while it is maturing.
 */
export function scoreEntry(
  entry: RecommendationEntry,
  forwardRows: OhlcvRow[],
  config: JournalConfig
): RecommendationEntry {
  if (entry.status !== "open") {
    return entry;
  }
  const rows = forwardRows
    .filter(row => row.날짜 > entry.date)
    .sort((a, b) => a.날짜.localeCompare(b.날짜));

  const entrySlice = rows.slice(0, config.entryWindow);
  const triggeredIndex = entrySlice.findIndex(row => row.고가 >= entry.triggerPrice);

  if (triggeredIndex === -1) {
    // No entry within the window — only settle once the window has fully passed.
    if (rows.length >= config.entryWindow) {
      return { ...entry, status: "no_entry", returnPct: 0, scoredAt: new Date().toISOString() };
    }
    return entry;
  }

  const entryRow = entrySlice[triggeredIndex];
  const holdingRows = rows.slice(triggeredIndex + 1, triggeredIndex + 1 + config.holdingDays);

  for (const row of holdingRows) {
    if (row.저가 <= entry.stopLossPrice) {
      return settle(entry, entryRow.날짜, row.날짜, entry.stopLossPrice, "stop");
    }
    if (row.고가 >= entry.targetPrice) {
      return settle(entry, entryRow.날짜, row.날짜, entry.targetPrice, "target");
    }
  }

  if (holdingRows.length >= config.holdingDays) {
    const last = holdingRows[holdingRows.length - 1];
    return settle(entry, entryRow.날짜, last.날짜, last.종가, "time_exit");
  }

  return entry; // triggered but still within the holding window — keep open
}

function settle(
  entry: RecommendationEntry,
  entryDate: string,
  exitDate: string,
  exitPrice: number,
  status: Exclude<RecommendationStatus, "open" | "no_entry">
): RecommendationEntry {
  const returnPct = round(((exitPrice - entry.triggerPrice) / entry.triggerPrice) * 100);
  return { ...entry, status, entryDate, exitDate, exitPrice, returnPct, scoredAt: new Date().toISOString() };
}

export function summarizeJournal(entries: RecommendationEntry[]): JournalSummary {
  const open = entries.filter(entry => entry.status === "open");
  const noEntry = entries.filter(entry => entry.status === "no_entry");
  const triggered = entries.filter(
    entry => entry.status === "target" || entry.status === "stop" || entry.status === "time_exit"
  );
  const wins = triggered.filter(entry => (entry.returnPct ?? 0) > 0);
  const targets = triggered.filter(entry => entry.status === "target");
  const stops = triggered.filter(entry => entry.status === "stop");
  const avgReturnPct = triggered.length
    ? round(triggered.reduce((sum, entry) => sum + (entry.returnPct ?? 0), 0) / triggered.length)
    : 0;

  return {
    total: entries.length,
    settled: triggered.length + noEntry.length,
    open: open.length,
    triggered: triggered.length,
    noEntry: noEntry.length,
    wins: wins.length,
    losses: triggered.length - wins.length,
    winRate: triggered.length ? round((wins.length / triggered.length) * 100, 1) : 0,
    avgReturnPct,
    targetRate: triggered.length ? round((targets.length / triggered.length) * 100, 1) : 0,
    stopRate: triggered.length ? round((stops.length / triggered.length) * 100, 1) : 0,
  };
}

/** yyyy-mm-dd shifted back by `days` (pure, for the per-ticker cooldown window). */
export function isoDateMinusDays(dateStr: string, days: number): string {
  const date = new Date(`${dateStr}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

/**
 * Append today's swing picks to the journal. A per-ticker cooldown (≈ holding
 * window) prevents the same name being re-recorded every day it keeps the setup,
 * so the journal holds roughly independent bets instead of correlated duplicates.
 */
export async function recordRecommendations(
  candidates: TechnicalSwingCandidate[],
  now = new Date()
): Promise<number> {
  if (!candidates.length) {
    return 0;
  }
  const journal = await readJournal();
  const date = kstDate(now);
  const recordedAt = now.toISOString();
  const cooldownDays = Number(process.env.JOURNAL_COOLDOWN_DAYS) || 20;
  const cooldownCutoff = isoDateMinusDays(date, cooldownDays);
  // Names recorded within the cooldown window are still "in a position".
  const onCooldown = new Set(
    journal.filter(entry => entry.date > cooldownCutoff).map(entry => entry.ticker)
  );
  const r = targetMultiple();
  const championAt = await readChampionFingerprint();

  let added = 0;
  for (const candidate of candidates) {
    if (onCooldown.has(candidate.ticker)) {
      continue;
    }
    onCooldown.add(candidate.ticker);
    const targetPrice = Math.round(
      candidate.triggerPrice + r * (candidate.triggerPrice - candidate.stopLossPrice)
    );
    journal.push({
      date,
      ticker: candidate.ticker,
      companyName: candidate.companyName,
      market: candidate.market,
      source: "swing",
      triggerPrice: candidate.triggerPrice,
      stopLossPrice: candidate.stopLossPrice,
      targetPrice,
      swingScore: candidate.swingScore,
      qualityScore: candidate.qualityScore,
      relativeStrength: candidate.relativeStrength,
      supplyState: candidate.supplyState,
      newsState: candidate.newsState,
      championAt,
      recordedAt,
      status: "open",
    });
    added += 1;
  }

  if (added) {
    await writeJournal(journal);
  }
  return added;
}

/** Score every open entry that now has enough forward data; persists updates. */
export async function scoreMaturedRecommendations(now = new Date()): Promise<{
  scored: number;
  summary: JournalSummary;
}> {
  const journal = await readJournal();
  const config = journalConfig();
  const openEntries = journal.filter(entry => entry.status === "open");

  if (!openEntries.length) {
    return { scored: 0, summary: summarizeJournal(journal) };
  }

  const tickers = Array.from(new Set(openEntries.map(entry => entry.ticker)));
  const oldest = openEntries.reduce((min, entry) => (entry.date < min ? entry.date : min), openEntries[0].date);
  const ageDays = Math.ceil((now.getTime() - new Date(`${oldest}T00:00:00+09:00`).getTime()) / 86400000);
  const lookback = Math.min(400, Math.max(60, ageDays + 30));
  const rowsByTicker = await fetchKoreanOhlcvRowsBatch(tickers, lookback);

  let scored = 0;
  for (let i = 0; i < journal.length; i += 1) {
    const entry = journal[i];
    if (entry.status !== "open") {
      continue;
    }
    const rows = rowsByTicker[entry.ticker];
    if (!rows?.length) {
      continue;
    }
    const updated = scoreEntry(entry, rows, config);
    if (updated.status !== "open") {
      journal[i] = updated;
      scored += 1;
    }
  }

  if (scored) {
    await writeJournal(journal);
  }
  return { scored, summary: summarizeJournal(journal) };
}

export type FactorBucket = { label: string; settled: number; winRate: number; avgReturnPct: number };

function bucketStats(label: string, subset: RecommendationEntry[]): FactorBucket {
  const wins = subset.filter(entry => (entry.returnPct ?? 0) > 0).length;
  const avg = subset.length
    ? subset.reduce((sum, entry) => sum + (entry.returnPct ?? 0), 0) / subset.length
    : 0;
  return {
    label,
    settled: subset.length,
    winRate: subset.length ? round((wins / subset.length) * 100, 1) : 0,
    avgReturnPct: round(avg),
  };
}

/**
 * Realized performance bucketed by the factor snapshot recorded at signal time —
 * tells us whether supply (매집/분산) and news (호재/악재) actually predicted
 * outcomes. The validation loop the council asked for, made concrete.
 */
export function summarizeByFactor(entries: RecommendationEntry[]): {
  supply: FactorBucket[];
  news: FactorBucket[];
} {
  const triggered = entries.filter(
    entry => entry.status === "target" || entry.status === "stop" || entry.status === "time_exit"
  );
  const supply = (["accumulating", "distributing", "neutral"] as const).map(state =>
    bucketStats(
      state === "accumulating" ? "매집" : state === "distributing" ? "분산" : "수급중립",
      triggered.filter(entry => (entry.supplyState ?? "neutral") === state)
    )
  );
  const news = (["positive", "negative", "neutral"] as const).map(state =>
    bucketStats(
      state === "positive" ? "호재" : state === "negative" ? "악재" : "뉴스중립",
      triggered.filter(entry => (entry.newsState ?? "neutral") === state)
    )
  );
  return { supply, news };
}

function factorLines(factors: { supply: FactorBucket[]; news: FactorBucket[] }): string[] {
  const fmt = (bucket: FactorBucket) =>
    `${bucket.label} ${bucket.settled}건·승률 ${bucket.winRate}%·평균 ${bucket.avgReturnPct}%`;
  return [
    `- 수급: ${factors.supply.filter(b => b.settled).map(fmt).join(" / ") || "표본 없음"}`,
    `- 뉴스: ${factors.news.filter(b => b.settled).map(fmt).join(" / ") || "표본 없음"}`,
  ];
}

function toMarkdown(
  summary: JournalSummary,
  recent: RecommendationEntry[],
  factors: { supply: FactorBucket[]; news: FactorBucket[] }
): string {
  return [
    "# Live Recommendation Journal",
    "",
    `- Generated: ${new Date().toISOString()}`,
    "",
    "## Realized performance (triggered picks)",
    `- Triggered: ${summary.triggered} (open ${summary.open}, no-entry ${summary.noEntry})`,
    `- Win rate: ${summary.winRate}% (${summary.wins}W / ${summary.losses}L)`,
    `- Avg return: ${summary.avgReturnPct}%`,
    `- Target hit: ${summary.targetRate}% · Stop hit: ${summary.stopRate}%`,
    "",
    "## Factor attribution (realized)",
    ...factorLines(factors),
    "",
    "## Recently settled",
    ...(recent.length
      ? recent.map(
          entry =>
            `- ${entry.date} ${entry.companyName}(${entry.ticker}) → ${entry.status} ${
              entry.returnPct != null ? `${entry.returnPct}%` : ""
            }`
        )
      : ["- 없음"]),
  ].join("\n");
}

export async function runRecommendationJournal(now = new Date()): Promise<JournalSummary> {
  const { scored, summary } = await scoreMaturedRecommendations(now);
  const journal = await readJournal();
  const recentSettled = journal
    .filter(entry => entry.scoredAt)
    .sort((a, b) => (b.scoredAt ?? "").localeCompare(a.scoredAt ?? ""))
    .slice(0, 8);

  const factors = summarizeByFactor(journal);
  await mkdir(REPORT_DIR, { recursive: true });
  await Promise.all([
    writeFile(
      REPORT_JSON_PATH,
      `${JSON.stringify({ generatedAt: now.toISOString(), summary, factors, journal }, null, 2)}\n`,
      "utf8"
    ),
    writeFile(REPORT_MD_PATH, `${toMarkdown(summary, recentSettled, factors)}\n`, "utf8"),
  ]);

  console.log(
    `[Recommendation Journal] scored ${scored} | triggered ${summary.triggered}, winRate ${summary.winRate}%, avgReturn ${summary.avgReturnPct}% (open ${summary.open})`
  );

  if (scored > 0 && summary.triggered >= Number(process.env.JOURNAL_MIN_REPORT_TRADES || 5)) {
    await routeToCommander({
      ticker: "JOURNAL",
      companyName: "라이브 추천 성과",
      kind: "high_conviction",
      headline: `실현 승률 ${summary.winRate}% · 평균수익 ${summary.avgReturnPct}% (체결 ${summary.triggered}건)`,
      detail: [
        `타겟 ${summary.targetRate}% · 손절 ${summary.stopRate}% · 진행중 ${summary.open}건`,
        ...factorLines(factors),
        `이번 채점 ${scored}건 신규 정산.`,
      ],
    }).catch(error => console.warn("[Recommendation Journal] commander notify failed:", error));
  }

  return summary;
}

async function runFromCli() {
  await runRecommendationJournal();
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  runFromCli().catch(error => {
    console.error("[Recommendation Journal] Failed:", error);
    process.exit(1);
  });
}
