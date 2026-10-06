/**
 * Naver Finance 업종(industry) data source.
 *
 * Naver replaced the server-rendered finance.naver.com/sise/sise_group pages with
 * a React app (observed 2026-10-07: the old HTML no longer contains a single
 * sise_group_detail link), which silently turned the old scraper into "0 sectors".
 * The mobile site's JSON API serves the same data and is far easier to parse:
 *   list    GET /api/stocks/industry?page=1&pageSize=100        → { groups: [{no,name,changeRate,...}], totalCount }
 *   members GET /api/stocks/industry/{no}?page=N&pageSize=100   → { stocks: [{itemCode,stockName,stockEndType,...}], totalCount }
 * pageSize above 100 is rejected (empty body), so members are fetched page by page.
 */

const API_BASE = "https://m.stock.naver.com/api/stocks/industry";
const FETCH_TIMEOUT_MS = 12000;
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

export const INDUSTRY_LIST_URL = `${API_BASE}?page=1&pageSize=${PAGE_SIZE}`;
export const industryMembersUrl = (no: string, page = 1) => `${API_BASE}/${no}?page=${page}&pageSize=${PAGE_SIZE}`;

async function fetchText(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "user-agent": "Mozilla/5.0", accept: "application/json" },
    });
    if (!response.ok) return null;
    const text = await response.text();
    return text.trim() ? text : null;
  } catch (error) {
    console.warn(`[Sector] fetch failed ${url}:`, error);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function fetchIndustryGroupsText(): Promise<string | null> {
  return fetchText(INDUSTRY_LIST_URL);
}

/**
 * All members of one 업종 as a single JSON document `{ stocks: [...] , totalCount }`.
 * Returns null when the first page is unavailable; a later page failing yields what
 * was collected so far with `truncated: true` rather than silently pretending it is complete.
 */
export async function fetchIndustryMembersText(no: string): Promise<string | null> {
  const first = await fetchText(industryMembersUrl(no, 1));
  if (!first) return null;
  let parsed: { stocks?: unknown[]; totalCount?: number };
  try {
    parsed = JSON.parse(first);
  } catch {
    return null;
  }
  const stocks = [...(parsed.stocks ?? [])];
  const total = Number(parsed.totalCount) || stocks.length;
  let truncated = false;
  for (let page = 2; stocks.length < total && page <= MAX_PAGES; page += 1) {
    const text = await fetchText(industryMembersUrl(no, page));
    let more: unknown[] = [];
    try {
      more = text ? (JSON.parse(text).stocks ?? []) : [];
    } catch {
      more = [];
    }
    if (!more.length) {
      truncated = true;
      break;
    }
    stocks.push(...more);
  }
  if (stocks.length < total) truncated = true;
  return JSON.stringify({ stocks, totalCount: total, truncated });
}
