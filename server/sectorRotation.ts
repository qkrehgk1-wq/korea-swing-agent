/**
 * Sector rotation engine.
 *
 * The screener historically had no sector dimension at all: it ranked individual
 * charts and was blind to the fact that Korean money rotates by 업종. A stock in
 * a leading sector and the same chart in a lagging sector were scored identically.
 *
 * Two halves, deliberately separated so the maths stays testable:
 *   - IO: scrape 업종 definitions (name + member tickers) from Naver, cached.
 *   - Pure: rebuild each sector as an equal-weight index from member OHLCV, then
 *     rank sectors by relative strength and detect rotation (RS improving vs
 *     decaying). Because the index is rebuilt from raw bars, the whole thing is
 *     point-in-time replayable in the backtest — not just a live-only feature.
 *
 * Known limitation: membership is today's snapshot applied to history, so a
 * sector's past index carries slight membership drift. Documented rather than
 * hidden — it biases nothing directionally, it only blurs old sector levels.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { isLikelyEtf, type OhlcvRow } from "./koreaStockMcp";

const SECTOR_LIST_URL =
  "https://finance.naver.com/sise/sise_group.naver?type=upjong";
const SECTOR_DETAIL_URL =
  "https://finance.naver.com/sise/sise_group_detail.naver?type=upjong&no=";
const CACHE_PATH = path.join(
  process.cwd(),
  ".data",
  "sectors",
  "definitions.json"
);
const CACHE_TTL_HOURS = Number(process.env.SECTOR_CACHE_TTL_HOURS) || 24 * 7;
const FETCH_TIMEOUT_MS = 12000;
const DETAIL_CONCURRENCY = 4;

export type SectorDefinition = {
  no: string;
  name: string;
  /** Naver's same-day 업종 change, kept only as a freshness sanity check. */
  changePct: number | null;
  tickers: string[];
};

export type SectorSeries = {
  name: string;
  dates: string[];
  /** Equal-weight normalized index level (starts at 1.0). */
  closes: number[];
  members: number;
};

export type SectorStrength = {
  name: string;
  members: number;
  return5d: number;
  return20d: number;
  return60d: number;
  /** Sector return minus benchmark return over the same window, in points. */
  relativeStrength20: number;
  relativeStrength60: number;
  /** RS20 now minus RS20 as of `rotationLookback` bars ago — the rotation signal. */
  rotationDelta: number;
  aboveMa20: boolean;
};

export type SectorRanking = {
  asOfDate: string;
  ranked: SectorStrength[];
  leaders: string[];
  laggards: string[];
  /** Sectors whose relative strength is improving fastest — money rotating in. */
  rotatingIn: string[];
  rotatingOut: string[];
};

// ── IO: sector definitions ──

async function fetchEucKr(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "Mozilla/5.0",
        referer: "https://finance.naver.com/sise/",
      },
    });
    if (!response.ok) return null;
    return new TextDecoder("euc-kr").decode(await response.arrayBuffer());
  } catch (error) {
    console.warn(`[Sector] fetch failed ${url}:`, error);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Pure: pull (no, name, changePct) rows out of the 업종별 시세 page. */
export function parseSectorList(html: string): Array<Omit<SectorDefinition, "tickers">> {
  const rows: Array<Omit<SectorDefinition, "tickers">> = [];
  const seen = new Set<string>();
  const trPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  let tr: RegExpExecArray | null;
  while ((tr = trPattern.exec(html)) !== null) {
    const block = tr[1];
    const nameMatch =
      /sise_group_detail\.naver\?type=upjong&no=(\d+)"[^>]*>([^<]+)<\/a>/.exec(block);
    if (!nameMatch) continue;
    const no = nameMatch[1];
    if (seen.has(no)) continue;
    seen.add(no);
    const changeMatch = /([+-]?\d+\.\d+)%/.exec(block);
    rows.push({
      no,
      name: nameMatch[2].trim(),
      changePct: changeMatch ? Number(changeMatch[1]) : null,
    });
  }
  return rows;
}

/** Pure: pull member tickers out of a 업종 detail page. */
export function parseSectorMembers(html: string): string[] {
  const tickers: string[] = [];
  const seen = new Set<string>();
  const pattern = /item\/main\.(?:naver|nhn)\?code=(\d{6})"[^>]*>([^<]+)<\/a>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    const ticker = match[1];
    const name = match[2].trim();
    if (seen.has(ticker) || isLikelyEtf(name)) continue;
    seen.add(ticker);
    tickers.push(ticker);
  }
  return tickers;
}

async function readCache(): Promise<SectorDefinition[] | null> {
  try {
    const raw = await readFile(CACHE_PATH, "utf8");
    const parsed = JSON.parse(raw) as {
      fetchedAt?: string;
      sectors?: SectorDefinition[];
    };
    if (!parsed.fetchedAt || !parsed.sectors?.length) return null;
    const ageHours =
      (Date.now() - new Date(parsed.fetchedAt).getTime()) / 3_600_000;
    if (ageHours > CACHE_TTL_HOURS) return null;
    return parsed.sectors;
  } catch {
    return null;
  }
}

/**
 * Sector definitions with member tickers. Cached for a week — 업종 membership
 * barely moves, and a live scrape costs ~70 page loads.
 */
export async function fetchSectorDefinitions(
  options: { force?: boolean } = {}
): Promise<SectorDefinition[]> {
  if (!options.force) {
    const cached = await readCache();
    if (cached) return cached;
  }

  const listHtml = await fetchEucKr(SECTOR_LIST_URL);
  if (!listHtml) {
    console.warn("[Sector] list page unavailable — falling back to cache");
    return (await readCache()) ?? [];
  }
  const heads = parseSectorList(listHtml);
  const sectors: SectorDefinition[] = [];

  for (let i = 0; i < heads.length; i += DETAIL_CONCURRENCY) {
    const chunk = heads.slice(i, i + DETAIL_CONCURRENCY);
    const detailed = await Promise.all(
      chunk.map(async head => {
        const html = await fetchEucKr(`${SECTOR_DETAIL_URL}${head.no}`);
        return {
          ...head,
          tickers: html ? parseSectorMembers(html) : [],
        };
      })
    );
    for (const sector of detailed) {
      if (sector.tickers.length) sectors.push(sector);
    }
  }

  if (sectors.length) {
    await mkdir(path.dirname(CACHE_PATH), { recursive: true });
    await writeFile(
      CACHE_PATH,
      `${JSON.stringify({ fetchedAt: new Date().toISOString(), sectors }, null, 2)}\n`,
      "utf8"
    );
  }
  return sectors;
}

// ── Pure: sector index construction and ranking ──

/**
 * Rebuild a sector as an equal-weight index from its members' bars.
 *
 * Members whose history is materially shorter than the sector's longest member
 * are dropped: letting a late listing enter mid-series steps the average and
 * fakes a sector move that never happened.
 */
export function buildSectorIndex(
  name: string,
  tickers: string[],
  rowsByTicker: Record<string, OhlcvRow[] | null | undefined>,
  options: { minMembers?: number; coverage?: number } = {}
): SectorSeries | null {
  const minMembers = options.minMembers ?? 3;
  const coverage = options.coverage ?? 0.9;

  const usable: OhlcvRow[][] = [];
  let longest = 0;
  for (const ticker of tickers) {
    const rows = rowsByTicker[ticker];
    if (rows && rows.length > 1) longest = Math.max(longest, rows.length);
  }
  if (!longest) return null;
  for (const ticker of tickers) {
    const rows = rowsByTicker[ticker];
    if (!rows || rows.length < Math.floor(longest * coverage)) continue;
    if (!rows[0]?.종가) continue;
    usable.push(rows);
  }
  if (usable.length < minMembers) return null;

  const byDate = new Map<string, { sum: number; count: number }>();
  for (const rows of usable) {
    const base = rows[0].종가;
    for (const row of rows) {
      const normalized = row.종가 / base;
      if (!Number.isFinite(normalized) || normalized <= 0) continue;
      const bucket = byDate.get(row.날짜) ?? { sum: 0, count: 0 };
      bucket.sum += normalized;
      bucket.count += 1;
      byDate.set(row.날짜, bucket);
    }
  }

  const dates: string[] = [];
  const closes: number[] = [];
  const sortedDates = Array.from(byDate.keys()).sort();
  for (const date of sortedDates) {
    const bucket = byDate.get(date);
    if (!bucket || bucket.count < minMembers) continue;
    dates.push(date);
    closes.push(bucket.sum / bucket.count);
  }
  if (!dates.length) return null;
  return { name, dates, closes, members: usable.length };
}

function returnOver(closes: number[], endIndex: number, bars: number): number {
  const start = endIndex - bars;
  if (start < 0 || endIndex >= closes.length) return 0;
  const base = closes[start];
  if (!base) return 0;
  return ((closes[endIndex] - base) / base) * 100;
}

function sma(values: number[], endIndex: number, period: number): number {
  const start = Math.max(0, endIndex - period + 1);
  const slice = values.slice(start, endIndex + 1);
  if (!slice.length) return 0;
  return slice.reduce((sum, value) => sum + value, 0) / slice.length;
}

/** Index into a series at (or just before) a date — point-in-time safe. */
export function indexAtOrBefore(dates: string[], asOfDate: string): number {
  let found = -1;
  for (let i = 0; i < dates.length; i += 1) {
    if (dates[i] <= asOfDate) found = i;
    else break;
  }
  return found;
}

export function computeSectorStrength(
  series: SectorSeries,
  benchmark: SectorSeries,
  asOfDate: string,
  rotationLookback = 20
): SectorStrength | null {
  const index = indexAtOrBefore(series.dates, asOfDate);
  const benchIndex = indexAtOrBefore(benchmark.dates, asOfDate);
  if (index < 60 || benchIndex < 60) return null;

  const return5d = returnOver(series.closes, index, 5);
  const return20d = returnOver(series.closes, index, 20);
  const return60d = returnOver(series.closes, index, 60);
  const benchReturn20 = returnOver(benchmark.closes, benchIndex, 20);
  const benchReturn60 = returnOver(benchmark.closes, benchIndex, 60);
  const relativeStrength20 = return20d - benchReturn20;
  const relativeStrength60 = return60d - benchReturn60;

  const priorIndex = index - rotationLookback;
  const priorBenchIndex = benchIndex - rotationLookback;
  let rotationDelta = 0;
  if (priorIndex >= 20 && priorBenchIndex >= 20) {
    const priorRs =
      returnOver(series.closes, priorIndex, 20) -
      returnOver(benchmark.closes, priorBenchIndex, 20);
    rotationDelta = relativeStrength20 - priorRs;
  }

  return {
    name: series.name,
    members: series.members,
    return5d: Number(return5d.toFixed(2)),
    return20d: Number(return20d.toFixed(2)),
    return60d: Number(return60d.toFixed(2)),
    relativeStrength20: Number(relativeStrength20.toFixed(2)),
    relativeStrength60: Number(relativeStrength60.toFixed(2)),
    rotationDelta: Number(rotationDelta.toFixed(2)),
    aboveMa20: series.closes[index] > sma(series.closes, index, 20),
  };
}

export function rankSectors(
  strengths: SectorStrength[],
  asOfDate: string,
  options: { topN?: number } = {}
): SectorRanking {
  const topN = options.topN ?? 5;
  const ranked = [...strengths].sort(
    (a, b) => b.relativeStrength20 - a.relativeStrength20
  );
  const byRotation = [...strengths].sort(
    (a, b) => b.rotationDelta - a.rotationDelta
  );
  return {
    asOfDate,
    ranked,
    leaders: ranked.slice(0, topN).map(item => item.name),
    laggards: ranked.slice(-topN).map(item => item.name),
    // Rotating in: RS improving AND already back above its own MA20, so we catch
    // sectors turning up rather than ones merely falling slower than the market.
    rotatingIn: byRotation
      .filter(item => item.rotationDelta > 0 && item.aboveMa20)
      .slice(0, topN)
      .map(item => item.name),
    rotatingOut: byRotation
      .filter(item => item.rotationDelta < 0)
      .slice(-topN)
      .map(item => item.name),
  };
}

/** Ticker → sector name, for tagging candidates. */
export function buildTickerSectorMap(
  definitions: SectorDefinition[]
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const sector of definitions) {
    for (const ticker of sector.tickers) {
      // First sector wins — Naver lists a stock under one 업종 in practice.
      if (!map[ticker]) map[ticker] = sector.name;
    }
  }
  return map;
}
