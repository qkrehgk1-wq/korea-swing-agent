import {
  fetchKoreanOhlcvRowsBatch,
  isKoreanTicker,
  type OhlcvRow,
} from "./koreaStockMcp";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

export type FirstLimitUpFollowThroughCandidate = {
  ticker: string;
  companyName: string;
  market: "코스피" | "코스닥";
  firstLimitUpScore: number;
  strategy: "첫 상한가 눌림목" | "연속 상한가 후보" | "후발 추격 제외";
  currentPrice: number;
  triggerPrice: number;
  stopLossPrice: number;
  firstLimitUpDate: string;
  firstLimitUpClose: number;
  daysSinceFirstLimitUp: number;
  pullbackPct: number;
  volumeRatio: number;
  turnoverPulse: number;
  rsi14: number;
  setup: string[];
  reason: string[];
};

export type FirstLimitUpFollowThroughResult = {
  candidates: FirstLimitUpFollowThroughCandidate[];
  scannedTickers: string[];
  notes: string[];
};

type PriceBar = {
  date: string;
  close: number;
  high: number;
  low: number;
  volume: number;
};

type FirstLimitUpSnapshot = {
  current: PriceBar;
  prev: PriceBar;
  firstLimitUp: PriceBar;
  firstLimitUpIndex: number;
  daysSinceFirstLimitUp: number;
  firstLimitUpReturn: number;
  pullbackPct: number;
  volumeRatio: number;
  turnoverPulse: number;
  rsi14: number;
  ma5: number;
  ma20: number;
  closeLocation: number;
  upperWickRatio: number;
};

type DynamicFirstLimitUpSeed = {
  ticker: string;
  name: string;
  market: "코스피" | "코스닥";
  date: string;
};

const execFileAsync = promisify(execFile);

export function shouldAttemptDynamicFirstLimitUpSeedCollection(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env
) {
  return Boolean(env.KRX_ID && env.KRX_PW);
}

function summarizeCommandFailure(error: unknown) {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const extra = error as Error & { stderr?: string; stdout?: string };
  const lines = `${extra.stderr ?? ""}\n${extra.stdout ?? ""}`
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  const tail = lines.slice(-4).join(" | ");

  return tail ? `${error.message.split("\n")[0]} | ${tail}` : error.message.split("\n")[0];
}

export const FIRST_LIMIT_UP_UNIVERSE = [
  "005930",
  "000660",
  "012450",
  "034020",
  "009150",
  "064350",
  "010140",
  "042660",
  "003670",
  "042700",
  "214150",
  "247540",
  "086520",
  "028300",
  "196170",
  "277810",
  "141080",
  "145020",
  "112040",
  "240810",
  "058470",
  "215000",
  "348370",
  "950160",
];

const FIRST_LIMIT_UP_NAMES: Record<string, string> = {
  "005930": "삼성전자",
  "000660": "SK하이닉스",
  "012450": "한화에어로스페이스",
  "034020": "두산에너빌리티",
  "009150": "삼성전기",
  "064350": "현대로템",
  "010140": "삼성중공업",
  "042660": "한화오션",
  "003670": "포스코퓨처엠",
  "042700": "한미반도체",
  "214150": "클래시스",
  "247540": "에코프로비엠",
  "086520": "에코프로",
  "028300": "HLB",
  "196170": "알테오젠",
  "277810": "레인보우로보틱스",
  "141080": "리가켐바이오",
  "145020": "휴젤",
  "112040": "위메이드",
  "240810": "원익IPS",
  "058470": "리노공업",
  "215000": "골프존",
  "348370": "엔켐",
  "950160": "코오롱티슈진",
};

const FIRST_LIMIT_UP_MARKETS: Record<string, "코스피" | "코스닥"> = {
  "005930": "코스피",
  "000660": "코스피",
  "012450": "코스피",
  "034020": "코스피",
  "009150": "코스피",
  "064350": "코스피",
  "010140": "코스피",
  "042660": "코스피",
  "003670": "코스닥",
  "042700": "코스닥",
  "214150": "코스닥",
  "247540": "코스닥",
  "086520": "코스닥",
  "028300": "코스닥",
  "196170": "코스닥",
  "277810": "코스닥",
  "141080": "코스닥",
  "145020": "코스닥",
  "112040": "코스닥",
  "240810": "코스닥",
  "058470": "코스닥",
  "215000": "코스닥",
  "348370": "코스닥",
  "950160": "코스닥",
};

async function collectRecentLimitUpSeeds(limit = 18): Promise<DynamicFirstLimitUpSeed[]> {
  if (!shouldAttemptDynamicFirstLimitUpSeedCollection()) {
    return [];
  }

  const command = "uvx";
  const script = String.raw`
import json
from datetime import datetime, timedelta
from pykrx import stock

frames = []
today = datetime.now()
for offset in range(1, 45):
    date = (today - timedelta(days=offset)).strftime("%Y%m%d")
    try:
        df = stock.get_market_ohlcv_by_ticker(date, market="ALL")
    except Exception:
        continue
    if df is None or df.empty or "등락률" not in df.columns:
        continue
    frames.append((date, df))
    if len(frames) >= 24:
        break

seeds = []
seen = set()
for i, (date, df) in enumerate(frames[:12]):
    upper = df[(df["등락률"] >= 24) & (df["거래량"] > 0)]
    if upper.empty:
        continue
    try:
        kosdaq_tickers = set(stock.get_market_ticker_list(date, market="KOSDAQ"))
    except Exception:
        kosdaq_tickers = set()
    for ticker, row in upper.sort_values("거래량", ascending=False).iterrows():
        ticker = str(ticker).zfill(6)
        if ticker in seen:
            continue
        try:
            name = stock.get_market_ticker_name(ticker)
        except Exception:
            name = ticker
        market = "코스닥" if ticker in kosdaq_tickers else "코스피"
        seeds.append({"ticker": ticker, "name": name, "market": market, "date": date})
        seen.add(ticker)
        if len(seeds) >= ${limit}:
            print(json.dumps(seeds, ensure_ascii=False))
            raise SystemExit

print(json.dumps(seeds, ensure_ascii=False))
`;

  try {
    const tempDir = await mkdtemp(path.join(tmpdir(), "first-limit-up-"));
    const scriptPath = path.join(tempDir, "collect_first_limit_up.py");

    try {
      await writeFile(scriptPath, script, "utf8");
      const { stdout } = await execFileAsync(command, ["--from", "pykrx", "python", scriptPath], {
        timeout: 45000,
        maxBuffer: 1024 * 1024,
        cwd: process.cwd(),
      });
      const jsonText = stdout.match(/(\[[\s\S]*\])\s*$/)?.[1] ?? "[]";
      const parsed = JSON.parse(jsonText) as DynamicFirstLimitUpSeed[];
      return parsed.filter(seed => isKoreanTicker(seed.ticker));
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  } catch (error) {
    console.warn("[First Limit-Up Agent] Dynamic seed collection failed:", summarizeCommandFailure(error));
    return [];
  }
}

async function resolveFirstLimitUpUniverse(inputTickers?: string[]) {
  if (inputTickers?.length) {
    return {
      tickers: inputTickers.filter(isKoreanTicker),
      names: { ...FIRST_LIMIT_UP_NAMES },
      markets: { ...FIRST_LIMIT_UP_MARKETS },
      seedCount: 0,
    };
  }

  const seeds = await collectRecentLimitUpSeeds();
  const names = { ...FIRST_LIMIT_UP_NAMES };
  const markets = { ...FIRST_LIMIT_UP_MARKETS };

  for (const seed of seeds) {
    names[seed.ticker] = seed.name;
    markets[seed.ticker] = seed.market;
  }

  return {
    tickers: Array.from(new Set([...seeds.map(seed => seed.ticker), ...FIRST_LIMIT_UP_UNIVERSE])).slice(0, 36),
    names,
    markets,
    seedCount: seeds.length,
  };
}

function toBars(rows: OhlcvRow[] | null): PriceBar[] {
  return rows?.map(row => ({
    date: row.날짜,
    close: row.종가,
    high: row.고가,
    low: row.저가,
    volume: row.거래량,
  })) ?? [];
}

function average(values: number[]) {
  if (!values.length) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentChange(base: number, current: number) {
  if (!base) {
    return 0;
  }
  return ((current - base) / base) * 100;
}

function calculateRsi14(closes: number[]) {
  if (closes.length < 15) {
    return 50;
  }

  const changes = closes.slice(1).map((close, index) => close - closes[index]);
  const gains = changes.map(value => (value > 0 ? value : 0));
  const losses = changes.map(value => (value < 0 ? Math.abs(value) : 0));
  const avgGain = average(gains.slice(-14));
  const avgLoss = average(losses.slice(-14));

  if (avgLoss === 0) {
    return 100;
  }

  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function isLimitUpDay(prev: PriceBar, current: PriceBar) {
  const dayReturn = percentChange(prev.close, current.close);
  const range = Math.max(current.high - current.low, 1);
  const closeLocation = (current.close - current.low) / range;

  return dayReturn >= 24 && closeLocation >= 0.82;
}

function findRecentLimitUp(bars: PriceBar[]) {
  const start = Math.max(1, bars.length - 16);

  for (let index = bars.length - 1; index >= start; index--) {
    if (!isLimitUpDay(bars[index - 1], bars[index])) {
      continue;
    }

    return { bar: bars[index], index };
  }

  return null;
}

function buildSnapshot(bars: PriceBar[]): FirstLimitUpSnapshot | null {
  if (bars.length < 80) {
    return null;
  }

  const first = findRecentLimitUp(bars);
  if (!first) {
    return null;
  }

  const current = bars[bars.length - 1];
  const prev = bars[bars.length - 2] ?? current;
  const closes = bars.map(bar => bar.close);
  const volumes = bars.map(bar => bar.volume);
  const latestRange = Math.max(current.high - current.low, 1);

  return {
    current,
    prev,
    firstLimitUp: first.bar,
    firstLimitUpIndex: first.index,
    daysSinceFirstLimitUp: bars.length - 1 - first.index,
    firstLimitUpReturn: percentChange(bars[first.index - 1].close, first.bar.close),
    pullbackPct: percentChange(first.bar.close, current.close),
    volumeRatio: current.volume / Math.max(average(volumes.slice(-20)), 1),
    turnoverPulse: average(volumes.slice(-3)) / Math.max(average(volumes.slice(-20)), 1),
    rsi14: calculateRsi14(closes),
    ma5: average(closes.slice(-5)),
    ma20: average(closes.slice(-20)),
    closeLocation: (current.close - current.low) / latestRange,
    upperWickRatio: (current.high - current.close) / latestRange,
  };
}

function buildSetup(snapshot: FirstLimitUpSnapshot) {
  const setup: string[] = [];
  const pullbackZone =
    snapshot.daysSinceFirstLimitUp >= 2 &&
    snapshot.daysSinceFirstLimitUp <= 7 &&
    snapshot.pullbackPct <= -3 &&
    snapshot.pullbackPct >= -14 &&
    snapshot.current.close >= snapshot.ma20 * 0.96;
  const continuationZone =
    snapshot.daysSinceFirstLimitUp <= 2 &&
    snapshot.pullbackPct >= -4 &&
    snapshot.closeLocation >= 0.68 &&
    snapshot.upperWickRatio <= 0.3;

  if (pullbackZone) {
    setup.push("첫 상한가 눌림목");
  }
  if (continuationZone) {
    setup.push("연속 상한가 후보");
  }
  if (snapshot.volumeRatio >= 1.2 || snapshot.turnoverPulse >= 1.25) {
    setup.push("후속 거래량 유지");
  }
  if (snapshot.current.close >= snapshot.ma5 * 0.98) {
    setup.push("5일선 방어");
  }
  if (snapshot.rsi14 >= 45 && snapshot.rsi14 <= 74) {
    setup.push("RSI 후속 과열 전");
  }

  return setup;
}

function classifyStrategy(setup: string[]): FirstLimitUpFollowThroughCandidate["strategy"] {
  if (setup.includes("첫 상한가 눌림목")) {
    return "첫 상한가 눌림목";
  }
  if (setup.includes("연속 상한가 후보")) {
    return "연속 상한가 후보";
  }
  return "후발 추격 제외";
}

function scoreSnapshot(snapshot: FirstLimitUpSnapshot, setup: string[]) {
  let score = 30;

  score += setup.includes("첫 상한가 눌림목") ? 24 : 0;
  score += setup.includes("연속 상한가 후보") ? 20 : 0;
  score += setup.includes("후속 거래량 유지") ? 12 : 0;
  score += setup.includes("5일선 방어") ? 8 : 0;
  score += setup.includes("RSI 후속 과열 전") ? 8 : -8;
  score += snapshot.firstLimitUpReturn >= 27 ? 8 : 0;
  score += snapshot.pullbackPct >= -12 && snapshot.pullbackPct <= 3 ? 8 : -8;
  score += snapshot.volumeRatio >= 1.2 && snapshot.volumeRatio <= 3.5 ? 8 : 0;
  score += snapshot.rsi14 >= 45 && snapshot.rsi14 <= 78 ? 6 : snapshot.rsi14 > 84 ? -18 : 0;
  score += snapshot.daysSinceFirstLimitUp > 8 ? -22 : 0;

  return Math.max(0, Math.min(100, Math.round(score)));
}

function buildCandidate(
  ticker: string,
  snapshot: FirstLimitUpSnapshot,
  names: Record<string, string>,
  markets: Record<string, "코스피" | "코스닥">
): FirstLimitUpFollowThroughCandidate | null {
  const setup = buildSetup(snapshot);
  const strategy = classifyStrategy(setup);
  const firstLimitUpScore = scoreSnapshot(snapshot, setup);

  if (strategy === "후발 추격 제외" || firstLimitUpScore < 58) {
    return null;
  }

  const triggerPrice = Math.round(
    strategy === "첫 상한가 눌림목"
      ? Math.max(snapshot.current.close * 1.025, snapshot.ma5 * 1.01)
      : Math.max(snapshot.current.close * 1.02, snapshot.firstLimitUp.high * 1.005)
  );
  const stopLossPrice = Math.round(
    strategy === "첫 상한가 눌림목"
      ? Math.min(snapshot.current.close * 0.92, snapshot.ma20 * 0.97)
      : Math.min(snapshot.firstLimitUp.close * 0.93, snapshot.ma5 * 0.96)
  );
  const reason = [
    `첫 상한가 ${snapshot.daysSinceFirstLimitUp}거래일 경과 / 당시 등락 ${snapshot.firstLimitUpReturn.toFixed(1)}%`,
    `첫 상한가 종가 대비 ${snapshot.pullbackPct.toFixed(1)}%`,
    `거래량비 ${snapshot.volumeRatio.toFixed(2)}x / 3일펄스 ${snapshot.turnoverPulse.toFixed(2)}x / RSI ${snapshot.rsi14.toFixed(1)}`,
  ];

  return {
    ticker,
    companyName: names[ticker] ?? ticker,
    market: markets[ticker] ?? "코스피",
    firstLimitUpScore,
    strategy,
    currentPrice: snapshot.current.close,
    triggerPrice,
    stopLossPrice,
    firstLimitUpDate: snapshot.firstLimitUp.date,
    firstLimitUpClose: snapshot.firstLimitUp.close,
    daysSinceFirstLimitUp: snapshot.daysSinceFirstLimitUp,
    pullbackPct: Number(snapshot.pullbackPct.toFixed(1)),
    volumeRatio: Number(snapshot.volumeRatio.toFixed(2)),
    turnoverPulse: Number(snapshot.turnoverPulse.toFixed(2)),
    rsi14: Number(snapshot.rsi14.toFixed(1)),
    setup,
    reason,
  };
}

function isActionableFirstLimitUp(candidate: FirstLimitUpFollowThroughCandidate) {
  return candidate.strategy === "첫 상한가 눌림목" || candidate.strategy === "연속 상한가 후보";
}

function isLateChaser(candidate: FirstLimitUpFollowThroughCandidate) {
  return (
    candidate.strategy === "후발 추격 제외" ||
    candidate.rsi14 >= 84 ||
    candidate.daysSinceFirstLimitUp >= 8 ||
    candidate.volumeRatio >= 4
  );
}

function firstLimitUpFocusScore(candidate: FirstLimitUpFollowThroughCandidate) {
  let score = candidate.firstLimitUpScore;

  if (candidate.strategy === "첫 상한가 눌림목") {
    score += 28;
  }
  if (candidate.strategy === "연속 상한가 후보") {
    score += 20;
  }
  if (candidate.pullbackPct <= -3 && candidate.pullbackPct >= -12) {
    score += 12;
  }
  if (candidate.daysSinceFirstLimitUp <= 3) {
    score += 8;
  }
  if (candidate.rsi14 >= 45 && candidate.rsi14 <= 74) {
    score += 8;
  }
  if (isLateChaser(candidate)) {
    score -= 45;
  }

  return score;
}

export function rankFirstLimitUpFollowThroughCandidates(
  candidates: FirstLimitUpFollowThroughCandidate[],
  limit = 3
) {
  const pullbacks = candidates
    .filter(candidate => candidate.strategy === "첫 상한가 눌림목")
    .sort((a, b) => firstLimitUpFocusScore(b) - firstLimitUpFocusScore(a));
  const continuations = candidates
    .filter(candidate => candidate.strategy === "연속 상한가 후보")
    .sort((a, b) => firstLimitUpFocusScore(b) - firstLimitUpFocusScore(a));
  const fallback = candidates
    .filter(candidate => !isActionableFirstLimitUp(candidate))
    .sort((a, b) => firstLimitUpFocusScore(b) - firstLimitUpFocusScore(a));
  const seen = new Set<string>();

  return [...pullbacks, ...continuations, ...fallback]
    .filter(candidate => {
      if (seen.has(candidate.ticker)) {
        return false;
      }
      seen.add(candidate.ticker);
      return true;
    })
    .slice(0, limit);
}

export async function predictFirstLimitUpFollowThroughCandidates(
  inputTickers?: string[]
): Promise<FirstLimitUpFollowThroughResult> {
  const { tickers, names, markets, seedCount } = await resolveFirstLimitUpUniverse(inputTickers);
  const rowsByTicker = await fetchKoreanOhlcvRowsBatch(tickers);
  const skipped: string[] = [];

  const candidates = tickers
    .map(ticker => {
      const bars = toBars(rowsByTicker[ticker]);
      const snapshot = buildSnapshot(bars);

      if (!snapshot) {
        skipped.push(`${names[ticker] ?? ticker}: 최근 상한가 없음`);
        return null;
      }

      const candidate = buildCandidate(ticker, snapshot, names, markets);
      if (!candidate) {
        skipped.push(`${names[ticker] ?? ticker}: 최근 상한가 후속 점수 부족`);
      }
      return candidate;
    })
    .filter((candidate): candidate is FirstLimitUpFollowThroughCandidate => Boolean(candidate));
  const rankedCandidates = rankFirstLimitUpFollowThroughCandidates(candidates, 3);

  return {
    candidates: rankedCandidates,
    scannedTickers: tickers,
    notes: [
      `상한가 후속 에이전트가 ${tickers.length}개 종목의 OHLCV를 점검했습니다.`,
      `최근 시장 전체 상한가 seed ${seedCount}개를 우선 반영했습니다.`,
      `상위 ${rankedCandidates.length}개를 최근 상한가 눌림목/연속 후보로 선정했습니다.`,
      "뉴스·테마 없이 최근 상한가 발생, 눌림폭, 후속 거래량, RSI, 5일선/20일선만 사용합니다.",
      skipped.slice(0, 5).length ? `제외 메모: ${skipped.slice(0, 5).join(" | ")}` : "제외 메모: 없음",
    ],
  };
}
