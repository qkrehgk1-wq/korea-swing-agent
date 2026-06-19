import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

type TextResult = {
  text: string;
  structuredContent?: Record<string, unknown>;
};

type PykrxResponse<T> = {
  data?: T[];
  row_count?: number;
};

export type OhlcvRow = {
  날짜: string;
  시가: number;
  고가: number;
  저가: number;
  종가: number;
  거래량: number;
  등락률: number;
};

type FundamentalRow = {
  날짜: string;
  PER?: number;
  PBR?: number;
  DIV?: number;
  BPS?: number;
  EPS?: number;
  DPS?: number;
};

export type MarketCapRow = {
  날짜: string;
  시가총액?: number;
  상장주식수?: number;
  거래대금?: number;
};

export type TradingValueRow = {
  날짜: string;
  기관합계?: number;
  외국인합계?: number;
  개인?: number;
};

export type KoreanStockKrxProfile = {
  market?: "KOSPI" | "KOSDAQ" | "KONEX";
  marketCategory?: string;
  listingDate?: string;
  securityGroup?: string;
  stockType?: string;
  parValue?: number;
  sharesOutstanding?: number;
};

export type KoreanStockAnalysisData = {
  companyName: string;
  corpCode?: string;
  ohlcvRows: OhlcvRow[];
  fundamentals: FundamentalRow[];
  marketCaps: MarketCapRow[];
  tradingValues: TradingValueRow[];
  krxProfile?: KoreanStockKrxProfile | null;
  officialFinancials?: OfficialFinancialSnapshot | null;
};

type OfficialCorpInfo = {
  corp_code: string;
  corp_name: string;
  stock_code: string;
};

type OfficialFinancialRow = {
  sj_nm?: string;
  account_nm?: string;
  thstrm_amount?: string;
  frmtrm_amount?: string;
  bfefrmtrm_amount?: string;
  currency?: string;
};

export type OfficialFinancialSnapshot = {
  year: string;
  revenue?: number;
  operatingProfit?: number;
  netIncome?: number;
  equity?: number;
  liabilities?: number;
  revenueYoY?: number;
  operatingProfitYoY?: number;
  netIncomeYoY?: number;
};

type OfficialKrxBaseRow = {
  basDd?: string;
  srtnCd?: string;
  isinCd?: string;
  itmsNm?: string;
  engItmsNm?: string;
  mrktCtg?: string;
  lstgDt?: string;
  secugrpNm?: string;
  stckTpNm?: string;
  parval?: string | number;
  lstgStCnt?: string | number;
  [key: string]: unknown;
};

type OfficialKrxTradeRow = {
  basDd?: string;
  srtnCd?: string;
  isinCd?: string;
  itmsNm?: string;
  mrktCtg?: string;
  clpr?: string | number;
  vs?: string | number;
  fltRt?: string | number;
  mkp?: string | number;
  hipr?: string | number;
  lopr?: string | number;
  trqu?: string | number;
  trPrc?: string | number;
  lstgStCnt?: string | number;
  mkpPrc?: string | number;
  [key: string]: unknown;
};

export type PriceSnapshot = {
  latestClose: number;
  latestOpen: number;
  latestHigh: number;
  latestLow: number;
  latestVolume: number;
  prevClose: number;
  changePercent: number;
  return5d: number;
  return20d: number;
  return60d: number;
  return120d: number;
  return240d: number;
  ma20: number;
  ma60: number;
  ma120: number;
  volumeAverage20: number;
  volumeRatio: number;
  annualHigh: number;
  annualLow: number;
  distanceFromHigh: number;
  distanceFromLow: number;
  annualVolatility: number;
  maxDrawdown: number;
};

const PYKRX_ARGS = ["pykrx-mcp"];
const OFFICIAL_KOREA_MCP_ARGS = ["-y", "korea-stock-mcp@latest"];
const BENCHMARK_TICKERS = new Set(["069500", "229200"]);
const PYKRX_REQUEST_TIMEOUT_MS = Number(process.env.PYKRX_REQUEST_TIMEOUT_MS ?? 120000);
const officialCorpInfoCache = new Map<string, OfficialCorpInfo | null>();
const koreanStockNameCache = new Map<string, string>();
const pythonDirectKrxCache = new Map<string, PythonDirectKrxSnapshot | null>();
const execFileAsync = promisify(execFile);

type PythonDirectKrxSnapshot = {
  ticker: string;
  companyName?: string;
  market?: "KOSPI" | "KOSDAQ" | "KONEX";
  marketCategory?: string;
  marketCap?: number;
  tradingValue?: number;
  sharesOutstanding?: number;
  parValue?: number;
  financials?: OfficialFinancialSnapshot | null;
};

function normalizeToolResult(result: unknown): TextResult {
  const normalized = result as {
    content?: Array<{ type: string; text?: string }>;
    structuredContent?: Record<string, unknown>;
  };

  const text = (normalized.content || [])
    .filter(part => part.type === "text" && typeof part.text === "string")
    .map(part => part.text)
    .join("\n")
    .trim();

  return {
    text,
    structuredContent: normalized.structuredContent,
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function retry<T>(
  operation: (attempt: number) => Promise<T>,
  attempts: number,
  delayMs: number
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await sleep(delayMs * attempt);
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function withPykrxClient<T>(run: (client: Client) => Promise<T>): Promise<T> {
  const transport = new StdioClientTransport({
    command: "uvx",
    args: PYKRX_ARGS,
    cwd: process.cwd(),
    stderr: "pipe",
  });

  const client = new Client({
    name: "billionaire-stock-agent",
    version: "1.0.0",
  });

  transport.stderr?.on("data", chunk => {
    const text = chunk.toString().trim();
    if (text) {
      console.warn("[pykrx-mcp]", text);
    }
  });

  await client.connect(transport);

  try {
    return await run(client);
  } finally {
    await transport.close();
  }
}

async function withOfficialKoreaClient<T>(run: (client: Client) => Promise<T>): Promise<T> {
  const command = process.platform === "win32" ? "npx.cmd" : "npx";
  const childEnv = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
  const transport = new StdioClientTransport({
    command,
    args: OFFICIAL_KOREA_MCP_ARGS,
    cwd: process.cwd(),
    stderr: "pipe",
    env: childEnv,
  });

  const client = new Client({
    name: "billionaire-stock-agent",
    version: "1.0.0",
  });

  transport.stderr?.on("data", chunk => {
    const text = chunk.toString().trim();
    if (text) {
      console.warn("[korea-stock-mcp]", text);
    }
  });

  await client.connect(transport);

  try {
    return await run(client);
  } finally {
    await transport.close();
  }
}

function getDateRange(daysBack = 365) {
  const end = new Date();
  end.setDate(end.getDate() - 1);
  const start = new Date(end);
  start.setDate(end.getDate() - daysBack);

  const toKrxDate = (date: Date) =>
    `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(
      date.getDate()
    ).padStart(2, "0")}`;

  return {
    startDate: toKrxDate(start),
    endDate: toKrxDate(end),
  };
}

function formatNaverDate(date: Date): string {
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(
    date.getDate()
  ).padStart(2, "0")}`;
}

function parseNaverOhlcv(text: string): OhlcvRow[] {
  const rows: OhlcvRow[] = [];
  // Data rows look like: ["20260601", 319500, 354500, 319500, 349000, 45052488, 48.3]
  const pattern = /\["(\d{8})",\s*([\d.]+),\s*([\d.]+),\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)/g;
  let prevClose = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const ymd = match[1];
    const close = Number(match[5]);
    if (!Number.isFinite(close) || close <= 0) continue;
    const changePercent = prevClose > 0 ? ((close - prevClose) / prevClose) * 100 : 0;
    rows.push({
      날짜: `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`,
      시가: Number(match[2]),
      고가: Number(match[3]),
      저가: Number(match[4]),
      종가: close,
      거래량: Number(match[6]),
      등락률: Math.round(changePercent * 100) / 100,
    });
    prevClose = close;
  }
  return rows;
}

/**
 * Pure-Node OHLCV from Naver Finance. Primary source — pykrx needs matplotlib,
 * whose native ft2font DLL fails to load on some Windows boxes, so it can crash
 * locally. Naver is plain HTTP and works everywhere; pykrx stays as the fallback
 * (e.g. if Naver geo-blocks a non-KR CI runner).
 */
async function fetchNaverOhlcvRows(ticker: string, daysBack = 365): Promise<OhlcvRow[] | null> {
  const end = new Date();
  const start = new Date(end);
  start.setDate(end.getDate() - daysBack);
  const url =
    `https://api.finance.naver.com/siseJson.naver?symbol=${ticker}` +
    `&requestType=1&startTime=${formatNaverDate(start)}&endTime=${formatNaverDate(end)}&timeframe=day`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "user-agent": "Mozilla/5.0", referer: "https://finance.naver.com/" },
    });
    if (!response.ok) return null;
    const rows = parseNaverOhlcv(await response.text());
    return rows.length > 0 ? rows : null;
  } catch (error) {
    console.warn(`[Naver OHLCV] Failed for ${ticker}:`, error);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Korean stock name from Naver (pure Node) — pykrx-free, works locally and in CI.
async function fetchNaverStockName(ticker: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(
      `https://polling.finance.naver.com/api/realtime/domestic/stock/${ticker}`,
      {
        signal: controller.signal,
        headers: { "user-agent": "Mozilla/5.0", referer: "https://finance.naver.com/" },
      }
    );
    if (!response.ok) return null;
    const data = (await response.json()) as { datas?: Array<{ stockName?: string }> };
    const name = data?.datas?.[0]?.stockName;
    return typeof name === "string" && name.trim().length > 0 ? name.trim() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export type NaverUniverseEntry = { ticker: string; name: string; market: "코스피" | "코스닥" };

/**
 * Top market-cap universe from Naver, with ticker + name + market in one shot.
 * Two independent live endpoints so a single-endpoint failure still yields fresh
 * data: the mobile JSON API first, then the classic (EUC-KR) market-cap page.
 */
export async function fetchNaverUniverse(
  market: "KOSPI" | "KOSDAQ",
  count: number
): Promise<NaverUniverseEntry[]> {
  const viaApi = await fetchNaverUniverseViaApi(market, count);
  if (viaApi.length >= Math.min(count, 20)) return viaApi;

  console.warn(
    `[Naver Universe] mobile API thin for ${market} (${viaApi.length}); trying classic page`
  );
  const viaClassic = await fetchNaverUniverseViaClassic(market, count);
  return viaClassic.length > viaApi.length ? viaClassic : viaApi;
}

// Primary: Naver mobile market-cap JSON API (UTF-8).
async function fetchNaverUniverseViaApi(
  market: "KOSPI" | "KOSDAQ",
  count: number
): Promise<NaverUniverseEntry[]> {
  const marketLabel: "코스피" | "코스닥" = market === "KOSPI" ? "코스피" : "코스닥";
  const pageSize = 100;
  const pages = Math.max(1, Math.ceil(count / pageSize));
  const entries: NaverUniverseEntry[] = [];

  for (let page = 1; page <= pages; page += 1) {
    const url = `https://m.stock.naver.com/api/stocks/marketValue/${market}?page=${page}&pageSize=${pageSize}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { "user-agent": "Mozilla/5.0", referer: "https://m.stock.naver.com/" },
      });
      if (!response.ok) break;
      const data = (await response.json()) as {
        stocks?: Array<{ itemCode?: string; stockName?: string }>;
      };
      const stocks = data?.stocks ?? [];
      if (stocks.length === 0) break;
      for (const stock of stocks) {
        const ticker = String(stock.itemCode ?? "");
        const name = String(stock.stockName ?? "").trim();
        if (/^\d{6}$/.test(ticker) && name) {
          entries.push({ ticker, name, market: marketLabel });
        }
      }
    } catch (error) {
      console.warn(`[Naver Universe] ${market} page ${page} failed:`, error);
      break;
    } finally {
      clearTimeout(timer);
    }
    if (entries.length >= count) break;
    await sleep(150);
  }

  return entries.slice(0, count);
}

// Fallback: classic Naver market-cap ranking page (EUC-KR HTML). A different
// endpoint than the mobile API, so it survives the mobile API changing/erroring.
async function fetchNaverUniverseViaClassic(
  market: "KOSPI" | "KOSDAQ",
  count: number
): Promise<NaverUniverseEntry[]> {
  const marketLabel: "코스피" | "코스닥" = market === "KOSPI" ? "코스피" : "코스닥";
  const sosok = market === "KOSPI" ? 0 : 1;
  const perPage = 50;
  const pages = Math.max(1, Math.ceil(count / perPage));
  const entries: NaverUniverseEntry[] = [];
  const seen = new Set<string>();
  const pattern = /\/item\/main\.(?:naver|nhn)\?code=(\d{6})"[^>]*class="tltle"[^>]*>([^<]+)<\/a>/g;

  for (let page = 1; page <= pages; page += 1) {
    const url = `https://finance.naver.com/sise/sise_market_sum.naver?sosok=${sosok}&page=${page}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { "user-agent": "Mozilla/5.0", referer: "https://finance.naver.com/" },
      });
      if (!response.ok) break;
      const html = new TextDecoder("euc-kr").decode(await response.arrayBuffer());
      let match: RegExpExecArray | null;
      let found = 0;
      while ((match = pattern.exec(html)) !== null) {
        const ticker = match[1];
        const name = match[2].trim();
        if (ticker && name && !seen.has(ticker)) {
          seen.add(ticker);
          entries.push({ ticker, name, market: marketLabel });
          found += 1;
        }
      }
      pattern.lastIndex = 0;
      if (found === 0) break;
    } catch (error) {
      console.warn(`[Naver Universe classic] ${market} page ${page} failed:`, error);
      break;
    } finally {
      clearTimeout(timer);
    }
    if (entries.length >= count) break;
    await sleep(150);
  }

  return entries.slice(0, count);
}

export type SupplyTrend = {
  foreignNet5: number;
  institutionNet5: number;
  foreignNet20: number;
  institutionNet20: number;
  state: "accumulating" | "distributing" | "neutral";
  note: string;
};

type RawSupplyEntry = { foreignerPureBuyQuant?: string; organPureBuyQuant?: string };

function parseSignedInt(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Number(value.replace(/[,\s]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Pure: fold daily foreign + institutional net buying into an accumulation /
 * distribution signal. Net buying by both "smart money" cohorts is one of the
 * strongest Korean-market swing factors. Entries are newest-first.
 */
export function assessSupplyTrend(entries: RawSupplyEntry[]): SupplyTrend {
  const foreign = entries.map(entry => parseSignedInt(entry.foreignerPureBuyQuant));
  const organ = entries.map(entry => parseSignedInt(entry.organPureBuyQuant));
  const sum = (values: number[], days: number) => values.slice(0, days).reduce((acc, value) => acc + value, 0);
  const foreignNet5 = sum(foreign, 5);
  const institutionNet5 = sum(organ, 5);
  const foreignNet20 = sum(foreign, 20);
  const institutionNet20 = sum(organ, 20);
  const combined5 = foreignNet5 + institutionNet5;
  const combined20 = foreignNet20 + institutionNet20;

  let state: SupplyTrend["state"] = "neutral";
  let note = "수급 중립(외국인·기관 방향성 약함)";
  if (combined5 > 0 && combined20 > 0) {
    state = "accumulating";
    note = "외국인·기관 순매수 누적(스마트머니 매집)";
  } else if (combined5 < 0 && combined20 < 0) {
    state = "distributing";
    note = "⚠ 외국인·기관 순매도(분산) — 수급 부담";
  }
  return { foreignNet5, institutionNet5, foreignNet20, institutionNet20, state, note };
}

/** Recent foreign/institutional net buying from Naver's pure-Node JSON API. */
export async function fetchSupplyTrend(ticker: string): Promise<SupplyTrend | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(`https://m.stock.naver.com/api/stock/${ticker}/trend`, {
      signal: controller.signal,
      headers: { "user-agent": "Mozilla/5.0", referer: "https://m.stock.naver.com/" },
    });
    if (!response.ok) return null;
    const data = (await response.json()) as RawSupplyEntry[];
    if (!Array.isArray(data) || data.length === 0) return null;
    return assessSupplyTrend(data);
  } catch (error) {
    console.warn(`[Supply] ${ticker} trend fetch failed:`, error);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function parseJsonText<T>(text: string): T | null {
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function parseNumberLike(value: string | number | undefined) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }

  if (!value) {
    return undefined;
  }

  const normalized = value.replace(/,/g, "").trim();
  if (!normalized || normalized === "-" || normalized.toLowerCase() === "nan") {
    return undefined;
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeKrxDate(value?: string) {
  if (!value) {
    return undefined;
  }
  const digits = value.replace(/\D/g, "");
  if (digits.length !== 8) {
    return value;
  }
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
}

async function fetchPythonDirectKrxSnapshot(ticker: string): Promise<PythonDirectKrxSnapshot | null> {
  if (pythonDirectKrxCache.has(ticker)) {
    return pythonDirectKrxCache.get(ticker) ?? null;
  }

  const scriptPath = path.join(process.cwd(), "server", "scripts", "fetch_krx_snapshot.py");

  try {
    const { stdout } = await execFileAsync("python", ["-X", "utf8", scriptPath, ticker], {
      timeout: 30000,
      maxBuffer: 1024 * 1024,
      cwd: process.cwd(),
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
      },
    });
    const parsed = parseJsonText<PythonDirectKrxSnapshot>(stdout.trim());
    const normalized = parsed?.ticker ? parsed : null;
    pythonDirectKrxCache.set(ticker, normalized);
    return normalized;
  } catch (error) {
    console.warn(`[Korean Stock Python] Failed to fetch direct KRX snapshot for ${ticker}:`, error);
    pythonDirectKrxCache.set(ticker, null);
    return null;
  }
}

async function fetchPythonDirectKrxSnapshots(
  tickers: string[]
): Promise<Record<string, PythonDirectKrxSnapshot | null>> {
  const uniqueTickers = Array.from(new Set(tickers.filter(isKoreanTicker)));
  const uncachedTickers = uniqueTickers.filter(ticker => !pythonDirectKrxCache.has(ticker));
  const snapshotByTicker: Record<string, PythonDirectKrxSnapshot | null> = {};

  if (uncachedTickers.length) {
    const scriptPath = path.join(process.cwd(), "server", "scripts", "fetch_krx_snapshot.py");

    try {
      const { stdout } = await execFileAsync("python", ["-X", "utf8", scriptPath, ...uncachedTickers], {
        timeout: Math.max(30000, uncachedTickers.length * 5000),
        maxBuffer: 8 * 1024 * 1024,
        cwd: process.cwd(),
        env: {
          ...process.env,
          PYTHONIOENCODING: "utf-8",
        },
      });
      const parsed = parseJsonText<PythonDirectKrxSnapshot[] | PythonDirectKrxSnapshot>(stdout.trim());
      const rows = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
      const seen = new Set<string>();

      for (const row of rows) {
        if (!row?.ticker) {
          continue;
        }
        pythonDirectKrxCache.set(row.ticker, row);
        seen.add(row.ticker);
      }

      for (const ticker of uncachedTickers) {
        if (!seen.has(ticker)) {
          pythonDirectKrxCache.set(ticker, null);
        }
      }
    } catch (error) {
      console.warn("[Korean Stock Python] Failed to fetch direct KRX snapshots batch:", error);
      await Promise.all(
        uncachedTickers.map(async ticker => {
          const snapshot = await fetchPythonDirectKrxSnapshot(ticker);
          pythonDirectKrxCache.set(ticker, snapshot);
        })
      );
    }
  }

  for (const ticker of uniqueTickers) {
    snapshotByTicker[ticker] = pythonDirectKrxCache.get(ticker) ?? null;
  }

  return snapshotByTicker;
}

function isValidArrayPayload<T>(payload: PykrxResponse<T> | null | undefined): payload is PykrxResponse<T> {
  return Boolean(payload && Array.isArray(payload.data) && payload.data.length > 0);
}

function percentChange(base: number, current: number) {
  if (!base) {
    return 0;
  }
  return ((current - base) / base) * 100;
}

function average(values: number[]) {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values: number[]) {
  if (values.length === 0) {
    return 0;
  }
  const mean = average(values);
  const variance = average(values.map(value => (value - mean) ** 2));
  return Math.sqrt(variance);
}

function formatPrice(value: number) {
  return `${Math.round(value).toLocaleString("ko-KR")}원`;
}

function formatShares(value: number) {
  return `${Math.round(value).toLocaleString("ko-KR")}주`;
}

function formatPercent(value: number, digits = 1) {
  const fixed = value.toFixed(digits);
  return `${value > 0 ? "+" : ""}${fixed}%`;
}

function formatTimes(value: number, digits = 2) {
  return `${value.toFixed(digits)}배`;
}

function formatMarketCap(value: number) {
  if (!value) {
    return "데이터 없음";
  }

  const trillion = 1_000_000_000_000;
  const billion = 100_000_000;

  if (value >= trillion) {
    return `${(value / trillion).toFixed(2)}조원`;
  }

  return `${(value / billion).toFixed(0)}억원`;
}

function formatMoney(value?: number) {
  if (value === undefined || !Number.isFinite(value)) {
    return "데이터 없음";
  }

  const trillion = 1_000_000_000_000;
  const billion = 100_000_000;

  if (Math.abs(value) >= trillion) {
    return `${(value / trillion).toFixed(2)}조원`;
  }

  return `${(value / billion).toFixed(0)}억원`;
}

function getRowAtDistance<T>(rows: T[], distance: number) {
  return rows[Math.max(0, rows.length - 1 - distance)];
}

export function calculateSnapshot(rows: OhlcvRow[]): PriceSnapshot | null {
  if (rows.length < 30) {
    return null;
  }

  const closes = rows.map(row => row.종가);
  const volumes = rows.map(row => row.거래량);
  const latest = rows[rows.length - 1];
  const prev = rows[rows.length - 2] ?? latest;
  const dailyReturns = rows.slice(1).map((row, index) => percentChange(rows[index].종가, row.종가) / 100);
  let peak = closes[0];
  let worstDrawdown = 0;

  for (const close of closes) {
    peak = Math.max(peak, close);
    worstDrawdown = Math.min(worstDrawdown, (close - peak) / peak);
  }

  return {
    latestClose: latest.종가,
    latestOpen: latest.시가,
    latestHigh: latest.고가,
    latestLow: latest.저가,
    latestVolume: latest.거래량,
    prevClose: prev.종가,
    changePercent: percentChange(prev.종가, latest.종가),
    return5d: percentChange(getRowAtDistance(rows, 5)?.종가 ?? latest.종가, latest.종가),
    return20d: percentChange(getRowAtDistance(rows, 20)?.종가 ?? latest.종가, latest.종가),
    return60d: percentChange(getRowAtDistance(rows, 60)?.종가 ?? latest.종가, latest.종가),
    return120d: percentChange(getRowAtDistance(rows, 120)?.종가 ?? latest.종가, latest.종가),
    return240d: percentChange(getRowAtDistance(rows, 240)?.종가 ?? rows[0].종가, latest.종가),
    ma20: average(closes.slice(-20)),
    ma60: average(closes.slice(-60)),
    ma120: average(closes.slice(-120)),
    volumeAverage20: average(volumes.slice(-20)),
    volumeRatio: latest.거래량 / Math.max(average(volumes.slice(-20)), 1),
    annualHigh: Math.max(...closes),
    annualLow: Math.min(...closes),
    distanceFromHigh: percentChange(Math.max(...closes), latest.종가),
    distanceFromLow: percentChange(Math.min(...closes), latest.종가),
    annualVolatility: standardDeviation(dailyReturns.slice(-20)) * Math.sqrt(252) * 100,
    maxDrawdown: worstDrawdown * 100,
  };
}

function getTrendSummary(snapshot: PriceSnapshot) {
  const isStrongUptrend =
    snapshot.latestClose > snapshot.ma20 &&
    snapshot.ma20 > snapshot.ma60 &&
    snapshot.ma60 > snapshot.ma120;
  const isRecovery =
    snapshot.latestClose > snapshot.ma60 &&
    snapshot.latestClose < snapshot.ma20 &&
    snapshot.return60d > 0;
  const isWeak =
    snapshot.latestClose < snapshot.ma20 &&
    snapshot.ma20 < snapshot.ma60 &&
    snapshot.return20d < 0;

  if (isStrongUptrend) {
    return {
      label: "상승 추세 유지",
      action: "추격매수보다 눌림목 분할 접근",
      score: 82,
    };
  }

  if (isRecovery) {
    return {
      label: "중기 회복 구간",
      action: "20일선 회복 여부를 확인한 뒤 분할 진입",
      score: 71,
    };
  }

  if (isWeak) {
    return {
      label: "약세 추세",
      action: "성급한 매수보다 관망 우선",
      score: 46,
    };
  }

  return {
    label: "박스권 탐색",
    action: "방향성 확인 전까지 비중을 낮게 유지",
    score: 61,
  };
}

function getVolumeSummary(snapshot: PriceSnapshot) {
  if (snapshot.volumeRatio >= 1.8) {
    return "거래량이 20일 평균 대비 크게 증가해 수급 변화 가능성을 시사합니다.";
  }
  if (snapshot.volumeRatio <= 0.8) {
    return "거래량이 평균보다 약해 방향성 신뢰도가 낮습니다.";
  }
  return "거래량은 평균권으로, 가격 움직임만으로 과도하게 해석할 구간은 아닙니다.";
}

function getValuationSummary(
  latestFundamental: FundamentalRow | undefined,
  latestMarketCap: MarketCapRow | undefined
) {
  if (!latestFundamental && !latestMarketCap) {
    return [
      "- 밸류에이션 MCP 세부 데이터는 현재 안정적으로 확보되지 않았습니다.",
      "- 가격 구조 중심으로 먼저 판단하고, 실적 발표 전후 재확인이 필요합니다.",
    ].join("\n");
  }

  const lines: string[] = [];

  if (latestFundamental?.PER) {
    lines.push(`- PER: ${formatTimes(latestFundamental.PER)} 수준`);
  }
  if (latestFundamental?.PBR) {
    lines.push(`- PBR: ${formatTimes(latestFundamental.PBR)} 수준`);
  }
  if (latestFundamental?.DIV) {
    lines.push(`- 배당수익률: ${latestFundamental.DIV.toFixed(2)}%`);
  }
  if (latestMarketCap?.시가총액) {
    lines.push(`- 시가총액: ${formatMarketCap(latestMarketCap.시가총액)}`);
  }
  if (latestMarketCap?.상장주식수) {
    lines.push(`- 상장주식수: ${formatShares(latestMarketCap.상장주식수)}`);
  }

  return lines.join("\n");
}

function getSupplyDemandSummary(latestTradingValue: TradingValueRow | undefined) {
  if (!latestTradingValue) {
    return [
      "- 수급 세부 데이터는 안정적으로 확보되지 않았습니다.",
      "- 대신 가격과 거래량 조합으로 수급 변화를 추적하는 접근이 현실적입니다.",
    ].join("\n");
  }

  const lines: string[] = [];
  if (typeof latestTradingValue.외국인합계 === "number") {
    lines.push(`- 외국인 순매수 추정: ${latestTradingValue.외국인합계.toLocaleString("ko-KR")}원`);
  }
  if (typeof latestTradingValue.기관합계 === "number") {
    lines.push(`- 기관 순매수 추정: ${latestTradingValue.기관합계.toLocaleString("ko-KR")}원`);
  }
  if (typeof latestTradingValue.개인 === "number") {
    lines.push(`- 개인 순매수 추정: ${latestTradingValue.개인.toLocaleString("ko-KR")}원`);
  }

  return lines.length > 0 ? lines.join("\n") : "- 수급 데이터 해석 가능한 항목이 없습니다.";
}

function getExecutionPlan(snapshot: PriceSnapshot, trendScore: number) {
  if (trendScore >= 80) {
    return [
      "- 진입 전략: 급등일 추격보다 5일~20일선 눌림목에서 2~3회 분할",
      "- 비중 전략: 초기 30% 이내, 20일선 재지지 확인 시 확대",
      "- 철회 조건: 20일선과 60일선을 동시에 이탈하며 거래량이 늘어나는 경우",
    ];
  }

  if (trendScore >= 60) {
    return [
      "- 진입 전략: 방향 확인 전 소액 탐색, 20일선 회복 시 추가",
      "- 비중 전략: 초기 20% 내외의 보수적 접근",
      "- 철회 조건: 60일선 이탈 고착화 또는 1개월 수익률 재악화",
    ];
  }

  return [
    "- 진입 전략: 바닥 예측 매수보다 관망",
    "- 비중 전략: 매수하더라도 테스트 비중만 허용",
    "- 철회 조건: 약세 추세가 지속되면 빠르게 정리",
  ];
}

export function inferTechnicalPatterns(snapshot: PriceSnapshot) {
  const patterns: string[] = [];

  if (
    snapshot.return60d > 12 &&
    snapshot.latestClose > snapshot.ma20 &&
    snapshot.ma20 > snapshot.ma60 &&
    Math.abs(snapshot.distanceFromHigh) <= 12
  ) {
    patterns.push("밥그릇 패턴 후보");
  }

  if (
    snapshot.return20d >= 12 &&
    snapshot.return20d <= 45 &&
    snapshot.volumeRatio >= 1.1 &&
    snapshot.latestClose > snapshot.ma20
  ) {
    patterns.push("하이힐 패턴 후보");
  }

  if (Math.abs(snapshot.distanceFromHigh) <= 2.5 && snapshot.volumeRatio >= 1.3) {
    patterns.push("돌파매매 후보");
  }

  if (
    Math.abs(snapshot.distanceFromHigh) <= 6 &&
    snapshot.latestClose > snapshot.ma20 &&
    snapshot.ma20 > snapshot.ma60 &&
    snapshot.return60d > 8
  ) {
    patterns.push("컵앤핸들 유사 구조");
  }

  return patterns;
}

function hasOfficialDartApiKey() {
  return Boolean(process.env.DART_API_KEY);
}

function hasOfficialKrxApiKey() {
  return Boolean(process.env.KRX_API_KEY);
}

function findFinancialAmount(rows: OfficialFinancialRow[], section: string, candidates: string[]) {
  const row = rows.find(
    item =>
      item.sj_nm === section &&
      candidates.some(candidate => (item.account_nm || "").includes(candidate))
  );

  return parseNumberLike(row?.thstrm_amount);
}

function findPreviousFinancialAmount(rows: OfficialFinancialRow[], section: string, candidates: string[]) {
  const row = rows.find(
    item =>
      item.sj_nm === section &&
      candidates.some(candidate => (item.account_nm || "").includes(candidate))
  );

  return parseNumberLike(row?.frmtrm_amount);
}

function buildOfficialFinancialSnapshot(year: string, rows: OfficialFinancialRow[]): OfficialFinancialSnapshot {
  const revenue = findFinancialAmount(rows, "포괄손익계산서", ["매출액", "영업수익", "수익(매출액)"]);
  const operatingProfit = findFinancialAmount(rows, "포괄손익계산서", [
    "영업이익",
    "영업손익",
  ]);
  const netIncome = findFinancialAmount(rows, "포괄손익계산서", ["당기순이익", "반기순이익", "분기순이익"]);
  const equity = findFinancialAmount(rows, "재무상태표", ["자본총계"]);
  const liabilities = findFinancialAmount(rows, "재무상태표", ["부채총계"]);

  const prevRevenue = findPreviousFinancialAmount(rows, "포괄손익계산서", [
    "매출액",
    "영업수익",
    "수익(매출액)",
  ]);
  const prevOperatingProfit = findPreviousFinancialAmount(rows, "포괄손익계산서", [
    "영업이익",
    "영업손익",
  ]);
  const prevNetIncome = findPreviousFinancialAmount(rows, "포괄손익계산서", [
    "당기순이익",
    "반기순이익",
    "분기순이익",
  ]);

  return {
    year,
    revenue,
    operatingProfit,
    netIncome,
    equity,
    liabilities,
    revenueYoY: revenue !== undefined && prevRevenue ? percentChange(prevRevenue, revenue) : undefined,
    operatingProfitYoY:
      operatingProfit !== undefined && prevOperatingProfit
        ? percentChange(prevOperatingProfit, operatingProfit)
        : undefined,
    netIncomeYoY:
      netIncome !== undefined && prevNetIncome ? percentChange(prevNetIncome, netIncome) : undefined,
  };
}

function parseToolArray<T>(text: string): T[] {
  const parsed = parseJsonText<T[] | { data?: T[]; list?: T[] }>(text);
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (parsed?.data && Array.isArray(parsed.data)) {
    return parsed.data;
  }
  if (parsed?.list && Array.isArray(parsed.list)) {
    return parsed.list;
  }
  return [];
}

function toMarketCapRow(date: string, row: OfficialKrxTradeRow, baseRow?: OfficialKrxBaseRow): MarketCapRow {
  return {
    날짜: date,
    시가총액: parseNumberLike(row.mkpPrc) ?? undefined,
    상장주식수: parseNumberLike(row.lstgStCnt) ?? parseNumberLike(baseRow?.lstgStCnt) ?? undefined,
    거래대금: parseNumberLike(row.trPrc) ?? undefined,
  };
}

function toTradingValueRow(date: string): TradingValueRow {
  return {
    날짜: date,
  };
}

async function findOfficialKrxMarket(
  client: Client,
  date: string,
  ticker: string
): Promise<"KOSPI" | "KOSDAQ" | "KONEX" | null> {
  const markets: Array<"KOSPI" | "KOSDAQ" | "KONEX"> = ["KOSPI", "KOSDAQ", "KONEX"];

  for (const market of markets) {
    try {
      const result = await client.callTool({
        name: "get_stock_trade_info",
        arguments: {
          basDdList: [date],
          market,
          codeList: [ticker],
        },
      });
      const rows = parseToolArray<OfficialKrxTradeRow>(normalizeToolResult(result).text);
      if (rows.length) {
        return market;
      }
    } catch {
      // Try next market.
    }
  }

  return null;
}

async function fetchOfficialKrxSupplement(
  ticker: string
): Promise<{
  marketCaps: MarketCapRow[];
  tradingValues: TradingValueRow[];
  krxProfile: KoreanStockKrxProfile | null;
} | null> {
  if (!hasOfficialKrxApiKey()) {
    return null;
  }

  const { endDate } = getDateRange(7);

  try {
    return await withTimeout(
      withOfficialKoreaClient(async client => {
        const market = await findOfficialKrxMarket(client, endDate, ticker);
        if (!market) {
          return null;
        }

        const [tradeResult, baseResult] = await Promise.all([
          client.callTool({
            name: "get_stock_trade_info",
            arguments: {
              basDdList: [endDate],
              market,
              codeList: [ticker],
            },
          }),
          client.callTool({
            name: "get_stock_base_info",
            arguments: {
              basDdList: [endDate],
              market,
              codeList: [ticker],
            },
          }),
        ]);

        const tradeRows = parseToolArray<OfficialKrxTradeRow>(normalizeToolResult(tradeResult).text);
        const baseRows = parseToolArray<OfficialKrxBaseRow>(normalizeToolResult(baseResult).text);
        if (!tradeRows.length) {
          return null;
        }

        const baseRow = baseRows[0];
        return {
          marketCaps: tradeRows.map(row => toMarketCapRow(endDate, row, baseRow)),
          tradingValues: tradeRows.map(() => toTradingValueRow(endDate)),
          krxProfile: {
            market,
            marketCategory: baseRow?.mrktCtg ?? tradeRows[0]?.mrktCtg,
            listingDate: normalizeKrxDate(baseRow?.lstgDt),
            securityGroup: baseRow?.secugrpNm,
            stockType: baseRow?.stckTpNm,
            parValue: parseNumberLike(baseRow?.parval),
            sharesOutstanding:
              parseNumberLike(baseRow?.lstgStCnt) ?? parseNumberLike(tradeRows[0]?.lstgStCnt),
          },
        };
      }),
      30000
    );
  } catch (error) {
    console.warn(`[Korean Stock MCP] Failed to fetch KRX supplement for ${ticker}:`, error);
    return null;
  }
}

async function fetchPythonDirectKrxSupplement(
  ticker: string
): Promise<{
  companyName?: string;
  marketCaps: MarketCapRow[];
  tradingValues: TradingValueRow[];
  krxProfile: KoreanStockKrxProfile | null;
  officialFinancials?: OfficialFinancialSnapshot | null;
} | null> {
  const snapshot = await fetchPythonDirectKrxSnapshot(ticker);
  if (!snapshot) {
    return null;
  }

  const { endDate } = getDateRange(7);
  return {
    companyName: snapshot.companyName,
    marketCaps: [
      {
        날짜: endDate,
        시가총액: snapshot.marketCap,
        상장주식수: snapshot.sharesOutstanding,
        거래대금: snapshot.tradingValue,
      },
    ],
    tradingValues: [{ 날짜: endDate }],
    krxProfile: {
      market: snapshot.market,
      marketCategory: snapshot.marketCategory,
      parValue: snapshot.parValue,
      sharesOutstanding: snapshot.sharesOutstanding,
    },
    officialFinancials: snapshot.financials ?? null,
  };
}

function buildPythonDirectKrxSupplement(
  ticker: string,
  snapshot: PythonDirectKrxSnapshot | null
): {
  companyName?: string;
  marketCaps: MarketCapRow[];
  tradingValues: TradingValueRow[];
  krxProfile: KoreanStockKrxProfile | null;
  officialFinancials?: OfficialFinancialSnapshot | null;
} | null {
  if (!snapshot) {
    return null;
  }

  const { endDate } = getDateRange(7);
  return {
    companyName: snapshot.companyName,
    marketCaps: [
      {
        날짜: endDate,
        시가총액: snapshot.marketCap,
        상장주식수: snapshot.sharesOutstanding,
        거래대금: snapshot.tradingValue,
      },
    ],
    tradingValues: [{ 날짜: endDate }],
    krxProfile: {
      market: snapshot.market,
      marketCategory: snapshot.marketCategory,
      parValue: snapshot.parValue,
      sharesOutstanding: snapshot.sharesOutstanding,
    },
    officialFinancials: snapshot.financials ?? null,
  };
}

async function resolveOfficialCorpInfo(ticker: string): Promise<OfficialCorpInfo | null> {
  if (officialCorpInfoCache.has(ticker)) {
    return officialCorpInfoCache.get(ticker) ?? null;
  }

  try {
    const resolved = await withTimeout(
      withOfficialKoreaClient(async client => {
        const result = await client.callTool({
          name: "get_corp_code",
          arguments: { stock_code: ticker },
        });
        const normalized = normalizeToolResult(result);
        const parsed = parseJsonText<OfficialCorpInfo[]>(normalized.text);
        return parsed?.[0] ?? null;
      }),
      20000
    );
    officialCorpInfoCache.set(ticker, resolved);
    return resolved;
  } catch (error) {
    console.warn(`[Korean Stock MCP] Failed to resolve official corp info for ${ticker}:`, error);
    officialCorpInfoCache.set(ticker, null);
    return null;
  }
}

async function fetchOfficialFinancialSnapshot(corpCode: string): Promise<OfficialFinancialSnapshot | null> {
  if (!hasOfficialDartApiKey()) {
    return null;
  }

  const currentYear = new Date().getFullYear();
  const targetYear = String(currentYear - 1);

  try {
    return await withTimeout(
      withOfficialKoreaClient(async client => {
        const result = await client.callTool({
          name: "get_financial_statement",
          arguments: {
            corp_code: corpCode,
            bsns_year: targetYear,
            reprt_code: "11011",
            fs_div: "CFS",
          },
        });

        const normalized = normalizeToolResult(result);
        const parsed = parseJsonText<{ list?: OfficialFinancialRow[] } | OfficialFinancialRow[]>(
          normalized.text
        );

        const rows = Array.isArray(parsed) ? parsed : parsed?.list;
        if (!rows?.length) {
          return null;
        }

        return buildOfficialFinancialSnapshot(targetYear, rows);
      }),
      30000
    );
  } catch (error) {
    console.warn(`[Korean Stock MCP] Failed to fetch DART financials for ${corpCode}:`, error);
    return null;
  }
}

export function isKoreanTicker(ticker: string) {
  return /^\d{6}$/.test(ticker.trim());
}

export async function getKoreanStockName(ticker: string): Promise<string> {
  if (process.env.NODE_ENV === "test") {
    return ticker;
  }

  const cached = koreanStockNameCache.get(ticker);
  if (cached) {
    return cached;
  }

  try {
    // Primary: Naver (pure Node). Fall back to pykrx/official only if it fails.
    const naverName = await fetchNaverStockName(ticker);
    if (naverName) {
      koreanStockNameCache.set(ticker, naverName);
      return naverName;
    }

    const pythonSnapshot = await fetchPythonDirectKrxSnapshot(ticker);
    if (pythonSnapshot?.companyName) {
      koreanStockNameCache.set(ticker, pythonSnapshot.companyName);
      return pythonSnapshot.companyName;
    }

    const officialCorpInfo =
      hasOfficialDartApiKey() || hasOfficialKrxApiKey()
        ? await resolveOfficialCorpInfo(ticker)
        : null;
    if (officialCorpInfo?.corp_name) {
      koreanStockNameCache.set(ticker, officialCorpInfo.corp_name);
      return officialCorpInfo.corp_name;
    }

    const resolved = await withTimeout(
      withPykrxClient(async client => {
        const result = await client.callTool({
          name: "get_market_ticker_name",
          arguments: { ticker },
        });
        const text = normalizeToolResult(result).text;
        const parsed = parseJsonText<{ name?: string }>(text);
        return parsed?.name || ticker;
      }),
      20000
    );
    koreanStockNameCache.set(ticker, resolved);
    return resolved;
  } catch (error) {
    console.warn(`[Korean Stock MCP] Failed to resolve name for ${ticker}:`, error);
    return ticker;
  }
}

export async function fetchKoreanStockAnalysisData(
  ticker: string
): Promise<KoreanStockAnalysisData | null> {
  if (process.env.NODE_ENV === "test" || process.env.KOREAN_STOCK_MCP_ENABLED === "false") {
    return null;
  }

  const needsOfficialCorpInfo = hasOfficialDartApiKey() || hasOfficialKrxApiKey();
  const officialCorpInfo = needsOfficialCorpInfo ? await resolveOfficialCorpInfo(ticker) : null;
  const pythonDirectSupplement = !hasOfficialKrxApiKey()
    ? await fetchPythonDirectKrxSupplement(ticker)
    : null;
  const companyName =
    officialCorpInfo?.corp_name || pythonDirectSupplement?.companyName || (await getKoreanStockName(ticker));
  const dartFinancials = officialCorpInfo?.corp_code
    ? await fetchOfficialFinancialSnapshot(officialCorpInfo.corp_code)
    : null;
  const officialFinancials = dartFinancials ?? pythonDirectSupplement?.officialFinancials ?? null;
  const officialKrxSupplement = hasOfficialKrxApiKey()
    ? await fetchOfficialKrxSupplement(ticker)
    : pythonDirectSupplement;
  const ohlcvRows = await fetchKoreanOhlcvRows(ticker, 365);
  if (!ohlcvRows || ohlcvRows.length === 0) {
    return null;
  }

  return {
    companyName,
    corpCode: officialCorpInfo?.corp_code,
    ohlcvRows,
    fundamentals: [],
    marketCaps: officialKrxSupplement?.marketCaps ?? [],
    tradingValues: officialKrxSupplement?.tradingValues ?? [],
    krxProfile: officialKrxSupplement?.krxProfile ?? null,
    officialFinancials,
  };
}

export async function fetchKoreanStockAnalysisDataBatch(
  tickers: string[]
): Promise<Record<string, KoreanStockAnalysisData | null>> {
  const uniqueTickers = Array.from(new Set(tickers.filter(isKoreanTicker)));
  const results: Record<string, KoreanStockAnalysisData | null> = {};

  if (process.env.NODE_ENV === "test" || process.env.KOREAN_STOCK_MCP_ENABLED === "false") {
    for (const ticker of uniqueTickers) {
      results[ticker] = null;
    }
    return results;
  }

  if (hasOfficialDartApiKey() || hasOfficialKrxApiKey()) {
    const rows = await Promise.all(
      uniqueTickers.map(async ticker => [ticker, await fetchKoreanStockAnalysisData(ticker)] as const)
    );
    for (const [ticker, data] of rows) {
      results[ticker] = data;
    }
    return results;
  }

  const [rowsByTicker, pythonSnapshots] = await Promise.all([
    fetchKoreanOhlcvRowsBatch(uniqueTickers),
    fetchPythonDirectKrxSnapshots(uniqueTickers),
  ]);

  for (const ticker of uniqueTickers) {
    const pythonSupplement = buildPythonDirectKrxSupplement(ticker, pythonSnapshots[ticker] ?? null);
    const companyName =
      pythonSupplement?.companyName || koreanStockNameCache.get(ticker) || ticker;
    if (companyName) {
      koreanStockNameCache.set(ticker, companyName);
    }

    results[ticker] = rowsByTicker[ticker]?.length
      ? {
          companyName,
          corpCode: undefined,
          ohlcvRows: rowsByTicker[ticker] ?? [],
          fundamentals: [],
          marketCaps: pythonSupplement?.marketCaps ?? [],
          tradingValues: pythonSupplement?.tradingValues ?? [],
          krxProfile: pythonSupplement?.krxProfile ?? null,
          officialFinancials: pythonSupplement?.officialFinancials ?? null,
        }
      : null;
  }

  return results;
}

export async function fetchKoreanOhlcvRows(
  ticker: string,
  daysBack = 365
): Promise<OhlcvRow[] | null> {
  if (process.env.NODE_ENV === "test" || process.env.KOREAN_STOCK_MCP_ENABLED === "false") {
    return null;
  }

  // Primary: Naver (pure Node). Fall back to pykrx only if it fails.
  const naverRows = await fetchNaverOhlcvRows(ticker, daysBack);
  if (naverRows && naverRows.length > 0) {
    return naverRows;
  }

  const { startDate, endDate } = getDateRange(daysBack);
  const isBenchmarkTicker = BENCHMARK_TICKERS.has(ticker);
  const timeoutMs = Math.max(PYKRX_REQUEST_TIMEOUT_MS, isBenchmarkTicker ? 35000 : 20000);
  const attempts = isBenchmarkTicker ? 2 : 1;

  try {
    return await retry(
      attempt =>
        withTimeout(
          withPykrxClient(async client => {
            const ohlcvResult = await client.callTool({
              name: "get_stock_ohlcv",
              arguments: { ticker, start_date: startDate, end_date: endDate, adjusted: true },
            }, undefined, {
              timeout: PYKRX_REQUEST_TIMEOUT_MS,
              maxTotalTimeout: PYKRX_REQUEST_TIMEOUT_MS,
            });
            const ohlcvParsed = parseJsonText<PykrxResponse<OhlcvRow>>(normalizeToolResult(ohlcvResult).text);
            return isValidArrayPayload(ohlcvParsed) ? ohlcvParsed.data ?? [] : null;
          }),
          timeoutMs
        ).catch(error => {
          if (attempt < attempts) {
            console.warn(
              `[Korean Stock MCP] Retry ${attempt}/${attempts - 1} for ${ticker} after OHLCV fetch failure:`,
              error
            );
          }
          throw error;
        }),
      attempts,
      1500
    );
  } catch (error) {
    console.warn(`[Korean Stock MCP] Failed to fetch OHLCV for ${ticker}:`, error);
    return null;
  }
}

export async function fetchKoreanOhlcvRowsBatch(
  tickers: string[],
  daysBack = 365
): Promise<Record<string, OhlcvRow[] | null>> {
  const uniqueTickers = Array.from(new Set(tickers.filter(isKoreanTicker)));
  const rowsByTicker: Record<string, OhlcvRow[] | null> = {};

  if (process.env.NODE_ENV === "test" || process.env.KOREAN_STOCK_MCP_ENABLED === "false") {
    for (const ticker of uniqueTickers) {
      rowsByTicker[ticker] = null;
    }
    return rowsByTicker;
  }

  // Primary: Naver, concurrency-limited.
  const CONCURRENCY = 6;
  for (let i = 0; i < uniqueTickers.length; i += CONCURRENCY) {
    const chunk = uniqueTickers.slice(i, i + CONCURRENCY);
    const fetched = await Promise.all(chunk.map(ticker => fetchNaverOhlcvRows(ticker, daysBack)));
    chunk.forEach((ticker, index) => {
      rowsByTicker[ticker] = fetched[index];
    });
    if (i + CONCURRENCY < uniqueTickers.length) {
      await sleep(150);
    }
  }

  // Fallback: pykrx for any tickers Naver couldn't return (e.g. Naver geo-block on a CI runner).
  const failed = uniqueTickers.filter(ticker => !rowsByTicker[ticker]?.length);
  if (failed.length) {
    const { startDate, endDate } = getDateRange(daysBack);
    try {
      await withTimeout(
        withPykrxClient(async client => {
          for (const ticker of failed) {
            const attempts = BENCHMARK_TICKERS.has(ticker) ? 2 : 1;
            const perTickerTimeoutMs = Math.max(
              PYKRX_REQUEST_TIMEOUT_MS,
              BENCHMARK_TICKERS.has(ticker) ? 35000 : 20000
            );
            rowsByTicker[ticker] = await retry(
              async attempt => {
                try {
                  const ohlcvResult = await withTimeout(
                    client.callTool({
                      name: "get_stock_ohlcv",
                      arguments: { ticker, start_date: startDate, end_date: endDate, adjusted: true },
                    }, undefined, {
                      timeout: PYKRX_REQUEST_TIMEOUT_MS,
                      maxTotalTimeout: PYKRX_REQUEST_TIMEOUT_MS,
                    }),
                    perTickerTimeoutMs
                  );
                  const ohlcvParsed = parseJsonText<PykrxResponse<OhlcvRow>>(
                    normalizeToolResult(ohlcvResult).text
                  );
                  return isValidArrayPayload(ohlcvParsed) ? ohlcvParsed.data ?? [] : null;
                } catch (error) {
                  if (attempt < attempts) {
                    console.warn(
                      `[Korean Stock MCP] Batch retry ${attempt}/${attempts - 1} for ${ticker}:`,
                      error
                    );
                  }
                  throw error;
                }
              },
              attempts,
              1500
            ).catch(error => {
              console.warn(`[Korean Stock MCP] pykrx fallback failed for ${ticker}:`, error);
              return null;
            });
          }
        }),
        Math.max(60000, failed.length * 25000)
      );
    } catch (error) {
      console.warn("[Korean Stock MCP] pykrx fallback batch failed:", error);
    }
  }

  for (const ticker of uniqueTickers) {
    rowsByTicker[ticker] ??= null;
  }

  return rowsByTicker;
}

export function buildKoreanAnalyses(ticker: string, data: KoreanStockAnalysisData | null) {
  const companyName = data?.companyName || ticker;
  const snapshot = data ? calculateSnapshot(data.ohlcvRows) : null;
  const latestTradingValue = data?.tradingValues.at(-1);
  const trendSummary = snapshot ? getTrendSummary(snapshot) : null;
  const technicalPatterns = snapshot ? inferTechnicalPatterns(snapshot) : [];
  const executionPlan = snapshot ? getExecutionPlan(snapshot, trendSummary?.score ?? 0) : [];

  const fundamentalAnalysis =
    data && snapshot
      ? [
          "### 패턴 구조 결론",
          `${companyName}(${ticker})는 현재 ${trendSummary?.label} 구간이며, 스윙 관점에서는 ${technicalPatterns.join(", ") || "명확한 대표 패턴 없음"}으로 해석됩니다.`,
          "",
          "### 패턴 체크 숫자",
          `- 종가: ${formatPrice(snapshot.latestClose)} / 전일 대비 ${formatPercent(snapshot.changePercent)}`,
          `- 1개월 수익률: ${formatPercent(snapshot.return20d)} / 3개월 수익률: ${formatPercent(snapshot.return60d)}`,
          `- 52주 고점 대비: ${formatPercent(snapshot.distanceFromHigh)} / 저점 대비: ${formatPercent(snapshot.distanceFromLow)}`,
          "",
          "### 패턴 해석 포인트",
          `- 20일선: ${formatPrice(snapshot.ma20)} / 60일선: ${formatPrice(snapshot.ma60)} / 120일선: ${formatPrice(snapshot.ma120)}`,
          `- 최근 거래량 배수: ${snapshot.volumeRatio.toFixed(2)}배`,
          `- RSI/과열 판단 대신 실제 매매에서는 고점 돌파 이후 종가 유지 여부가 더 중요합니다.`,
          "",
          "### 해석",
          "- 이 분석은 차트와 거래량, 인디케이터만 사용한 기술적 스윙 기준입니다.",
          "- 종목의 좋고 나쁨보다 '지금 타점이 나오는가'에 집중해 읽어야 합니다.",
        ].join("\n")
      : [
          "### 패턴 구조 결론",
          `${companyName}(${ticker})는 현재 안정적인 한국 주식 가격 데이터를 확보하지 못했습니다.`,
          "",
          "### 아쉬운 점",
          "- 차트 패턴과 거래량 구조를 판독할 만큼의 데이터가 부족합니다.",
        ].join("\n");

  const technicalAnalysis =
    data && snapshot
      ? [
          "### 인디케이터 요약",
          `- 20일선: ${formatPrice(snapshot.ma20)} / 60일선: ${formatPrice(snapshot.ma60)} / 120일선: ${formatPrice(snapshot.ma120)}`,
          `- 현재 위치: 종가가 20일선 대비 ${formatPercent(percentChange(snapshot.ma20, snapshot.latestClose))}, 60일선 대비 ${formatPercent(percentChange(snapshot.ma60, snapshot.latestClose))}`,
          `- 최근 수익률: 1주 ${formatPercent(snapshot.return5d)}, 1개월 ${formatPercent(snapshot.return20d)}, 6개월 ${formatPercent(snapshot.return120d)}`,
          "",
          "### 거래량과 변동성",
          `- 거래량 배수: ${snapshot.volumeRatio.toFixed(2)}배`,
          `- RSI 성격: ${snapshot.return20d > 15 ? "모멘텀 강세 구간" : snapshot.return20d < 0 ? "약세/정리 구간" : "중립에서 상방 시도 구간"}`,
          `- 20일 연환산 변동성: ${snapshot.annualVolatility.toFixed(1)}%`,
          `- 최대 낙폭(1년 기준): ${snapshot.maxDrawdown.toFixed(1)}%`,
          "",
          "### 해석",
          `- ${getVolumeSummary(snapshot)}`,
          `- 기술적 액션: ${trendSummary?.action}`,
        ].join("\n")
      : "한국 종목 가격 데이터를 안정적으로 읽지 못해 차트 분석을 제공하지 못했습니다.";

  const insiderAnalysis =
    data && snapshot
      ? [
          "### 거래량 / 수급 해석",
          getSupplyDemandSummary(latestTradingValue),
          "",
          "### 거래량을 차트로 읽는 법",
          `- 최근 거래량은 평균 대비 ${snapshot.volumeRatio.toFixed(2)}배입니다.`,
          `- 종가가 52주 고점 대비 ${Math.abs(snapshot.distanceFromHigh).toFixed(1)}% 떨어져 있어 수급 회복이 붙는지 확인이 필요합니다.`,
          "- 수급 수치가 비어 있더라도 거래량 급증과 종가 돌파가 함께 나오면 기술적으로 의미가 커집니다.",
        ].join("\n")
      : "수급 데이터를 확보하지 못했습니다.";

  const riskAnalysis =
    data && snapshot
      ? [
          "### 지금 가장 큰 리스크",
          trendSummary?.score && trendSummary.score < 60
            ? "- 추세가 약해 기술적 반등을 추세 전환으로 착각할 위험이 큽니다."
            : "- 추세가 살아 있어도 단기 과열 구간에서는 추격매수 손실 위험이 있습니다.",
          `- 최근 20일 변동성이 ${snapshot.annualVolatility.toFixed(1)}%로, 비중 관리가 중요합니다.`,
          `- 1년 기준 최대 낙폭이 ${snapshot.maxDrawdown.toFixed(1)}% 수준이라 손절 기준 없이 들고 가기 어렵습니다.`,
          "",
          "### 확인해야 할 리스크 이벤트",
          "- 실적 발표 전후 갭 하락 여부",
          "- 업종 전반의 모멘텀 둔화",
          "- 거래량 없이 상승하는 허약한 반등",
        ].join("\n")
      : "리스크 분석에 필요한 가격 구조 데이터를 확보하지 못했습니다.";

  const marketIntelligenceAnalysis =
    data && snapshot
      ? [
          "### 스윙 매매 메모",
          `- ${companyName}의 최근 3개월 수익률은 ${formatPercent(snapshot.return60d)}입니다.`,
          `- 52주 고점은 ${formatPrice(snapshot.annualHigh)}, 52주 저점은 ${formatPrice(snapshot.annualLow)}입니다.`,
          `- 현재 주가는 고점 대비 ${Math.abs(snapshot.distanceFromHigh).toFixed(1)}% 아래에 있습니다.`,
          `- 포착된 패턴: ${technicalPatterns.join(", ") || "대표 패턴 없음"}`,
          "",
          "### 실전 해석",
          trendSummary?.score && trendSummary.score >= 80
            ? "- 시장은 이미 이 종목을 다시 보기 시작했습니다. 다만 좋은 종목과 좋은 가격은 다르므로 눌림목이 중요합니다."
            : trendSummary?.score && trendSummary.score >= 60
              ? "- 회복 가능성은 보이지만 확신 구간은 아닙니다. 강한 거래량 동반 재상승이 필요한 자리입니다."
              : "- 아직 시장이 확실히 받아주는 흐름은 아닙니다. 싸 보여도 약세 종목일 수 있습니다.",
        ].join("\n")
      : "시장 인텔리전스 분석을 위한 핵심 가격 데이터를 확보하지 못했습니다.";

  const framework = snapshot
    ? {
        systemThinking: `${companyName}는 지금 차트 위치, 거래량, 이평선 구조가 동시에 맞아떨어지는지로 판단해야 합니다.`,
        longTermVision: `${companyName}의 현재 전략은 장기투자보다 2주~8주 스윙 시나리오에 맞춰 대응하는 것이 더 적절합니다.`,
        leverageFactors: [
          "20일선 지지",
          "거래량 동반 돌파",
          "60일선 우상향",
          "패턴 완성도",
        ],
        asymmetricGrowthScore: trendSummary?.score ?? 58,
        asymmetricOpportunities:
          (trendSummary?.score ?? 0) >= 70
            ? [
                "추세 유지 시 눌림목 매수가 유리할 수 있음",
                "한국 시장 할인 완화 시 밸류 재평가 가능",
                "거래량 재확대 시 추세 강화 가능",
              ]
            : [
                "데이터상 아직 확실한 비대칭 기회는 제한적",
                "추세 전환 확인 후 접근하는 편이 유리",
              ],
      }
    : {
        systemThinking: `${companyName}는 한국 시장 데이터 재확인 후 판단이 필요합니다.`,
        longTermVision: `${companyName}의 장기 매력은 아직 검증 전입니다.`,
        leverageFactors: ["데이터 확보 필요"],
        asymmetricGrowthScore: 42,
        asymmetricOpportunities: ["한국 주식 MCP 안정화 후 재평가 필요"],
      };

  const investmentInsight =
    data && snapshot
      ? [
          "## 최종 판단",
          `- 의견: ${trendSummary?.action}`,
          `- 확신도: ${framework.asymmetricGrowthScore}/100`,
          `- 한줄 요약: ${companyName}(${ticker})는 현재 ${trendSummary?.label} 구간이며, 스윙 관점의 핵심 가격은 ${formatPrice(snapshot.ma20)} 부근입니다.`,
          "## 왜 지금 볼 만한가",
          `- 최근 1개월 수익률이 ${formatPercent(snapshot.return20d)}, 3개월 수익률이 ${formatPercent(snapshot.return60d)}입니다.`,
          `- 가격은 52주 저점 대비 ${formatPercent(snapshot.distanceFromLow)} 올라와 있어 바닥 탈출 여부를 읽을 수 있습니다.`,
          `- 거래량은 최근 평균 대비 ${snapshot.volumeRatio.toFixed(2)}배로, 수급 변화 단서가 있습니다.`,
          `- 대표 패턴 후보는 ${technicalPatterns.join(", ") || "아직 명확하지 않음"}입니다.`,
          "## 지금 바로 사기 전에 확인할 것",
          `- 종가가 20일선 ${formatPrice(snapshot.ma20)} 위에서 안착하는지`,
          `- 거래량이 20일 평균 ${Math.round(snapshot.volumeAverage20).toLocaleString("ko-KR")}주를 웃도는지`,
          "- 돌파 시가 아닌 종가 기준으로 패턴이 살아 있는지",
          "## 실행 계획",
          ...executionPlan,
          "## 장기 관점",
          `- 10년 포인트: ${framework.longTermVision}`,
        ].join("\n")
      : [
          "## 최종 판단",
          "- 의견: 데이터 확보 전 관망",
          "- 확신도: 42/100",
          `- 한줄 요약: ${companyName}(${ticker})는 한국 주식 전용 실데이터가 충분하지 않아 보수적으로 접근해야 합니다.`,
        ].join("\n");

  return {
    companyName,
    fundamentalAnalysis,
    technicalAnalysis,
    insiderAnalysis,
    riskAnalysis,
    marketIntelligenceAnalysis,
    framework,
    investmentInsight,
    dataQuality: {
      usedFallbackData: !snapshot,
      sources: {
        profile: data ? "live" : "fallback",
        chart: snapshot ? "live" : "fallback",
        insights: snapshot ? "live" : "fallback",
      } as const,
      warnings: snapshot
        ? [
            ...(data?.tradingValues.length
              ? []
              : ["외국인·기관 수급 세부 수치는 불안정해 거래량과 추세 기반으로 보완했습니다."]),
            "이 분석은 차트, 거래량, 인디케이터만 사용한 기술적 스윙 분석입니다.",
          ]
        : ["한국 주식 MCP 데이터를 가져오지 못해 보수적 기본 분석만 제공했습니다."],
    },
  };
}
