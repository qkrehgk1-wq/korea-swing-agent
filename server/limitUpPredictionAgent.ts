import {
  fetchKoreanOhlcvRowsBatch,
  isKoreanTicker,
  type OhlcvRow,
} from "./koreaStockMcp";

export type LimitUpPredictionCandidate = {
  ticker: string;
  companyName: string;
  market: "코스피" | "코스닥";
  limitUpScore: number;
  limitUpFit: "상" | "중" | "관찰";
  currentPrice: number;
  triggerPrice: number;
  stopLossPrice: number;
  estimatedLimitPrice: number;
  dayReturn: number;
  volumeRatio: number;
  turnoverPulse: number;
  rsi14: number;
  setup: string[];
  reason: string[];
};

export type LimitUpPredictionResult = {
  candidates: LimitUpPredictionCandidate[];
  scannedTickers: string[];
  notes: string[];
};

type PriceBar = {
  close: number;
  high: number;
  low: number;
  volume: number;
};

type LimitUpSnapshot = {
  currentPrice: number;
  prevClose: number;
  dayReturn: number;
  ma5: number;
  ma20: number;
  ma60: number;
  rsi14: number;
  volumeRatio: number;
  turnoverPulse: number;
  high20: number;
  high60: number;
  low20: number;
  low60: number;
  low120: number;
  high120: number;
  return5d: number;
  return20d: number;
  return60d: number;
  upperWickRatio: number;
  closeLocation: number;
  rangeCompression: number;
};

export const LIMIT_UP_UNIVERSE = [
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

const LIMIT_UP_NAMES: Record<string, string> = {
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

const LIMIT_UP_MARKETS: Record<string, "코스피" | "코스닥"> = {
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

function toBars(rows: OhlcvRow[] | null): PriceBar[] {
  return rows?.map(row => ({
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

function buildSnapshot(bars: PriceBar[]): LimitUpSnapshot | null {
  if (bars.length < 80) {
    return null;
  }

  const closes = bars.map(bar => bar.close);
  const volumes = bars.map(bar => bar.volume);
  const latest = bars[bars.length - 1];
  const prev = bars[bars.length - 2] ?? latest;
  const range = Math.max(latest.high - latest.low, 1);
  const recentRanges = bars.slice(-8).map(bar => percentChange(bar.low, bar.high));
  const priorRanges = bars.slice(-28, -8).map(bar => percentChange(bar.low, bar.high));

  return {
    currentPrice: latest.close,
    prevClose: prev.close,
    dayReturn: percentChange(prev.close, latest.close),
    ma5: average(closes.slice(-5)),
    ma20: average(closes.slice(-20)),
    ma60: average(closes.slice(-60)),
    rsi14: calculateRsi14(closes),
    volumeRatio: latest.volume / Math.max(average(volumes.slice(-20)), 1),
    turnoverPulse: average(volumes.slice(-3)) / Math.max(average(volumes.slice(-20)), 1),
    high20: Math.max(...closes.slice(-20)),
    high60: Math.max(...closes.slice(-60)),
    low20: Math.min(...closes.slice(-20)),
    low60: Math.min(...closes.slice(-60)),
    low120: Math.min(...closes.slice(-120)),
    high120: Math.max(...closes.slice(-120)),
    return5d: percentChange(closes[closes.length - 6], latest.close),
    return20d: percentChange(closes[closes.length - 21], latest.close),
    return60d: percentChange(closes[closes.length - 61], latest.close),
    upperWickRatio: (latest.high - latest.close) / range,
    closeLocation: (latest.close - latest.low) / range,
    rangeCompression: average(recentRanges) / Math.max(average(priorRanges), 0.1),
  };
}

function buildSetup(snapshot: LimitUpSnapshot) {
  const setup: string[] = [];
  const drawdownFrom120High = percentChange(snapshot.high120, snapshot.currentPrice);
  const recoveryFrom120Low = percentChange(snapshot.low120, snapshot.currentPrice);
  const bottomZone =
    drawdownFrom120High <= -18 &&
    recoveryFrom120Low >= 3 &&
    recoveryFrom120Low <= 32 &&
    snapshot.rsi14 >= 38 &&
    snapshot.rsi14 <= 66;
  const earlyMaRecovery =
    snapshot.currentPrice >= snapshot.ma20 * 0.98 &&
    snapshot.currentPrice <= snapshot.ma60 * 1.08 &&
    snapshot.return20d > -4 &&
    snapshot.return60d <= 18;

  if (snapshot.currentPrice >= snapshot.high20 * 0.985) {
    setup.push("20일 신고가 근접");
  }
  if (snapshot.currentPrice >= snapshot.high60 * 0.95) {
    setup.push("60일 상단 매물대 압박");
  }
  if (snapshot.volumeRatio >= 1.8 || snapshot.turnoverPulse >= 1.5) {
    setup.push("거래량 급증");
  }
  if (snapshot.ma5 > snapshot.ma20 && snapshot.ma20 >= snapshot.ma60 * 0.98) {
    setup.push("단기 이평선 정배열");
  }
  if (snapshot.rangeCompression <= 0.75 && snapshot.currentPrice > snapshot.ma20) {
    setup.push("변동성 압축 후 상방 대기");
  }
  if (snapshot.closeLocation >= 0.7 && snapshot.upperWickRatio <= 0.25) {
    setup.push("종가 고가권 마감");
  }
  if (bottomZone && (snapshot.volumeRatio >= 1.25 || snapshot.turnoverPulse >= 1.15)) {
    setup.push("바닥권 거래량 점화");
  }
  if (bottomZone && earlyMaRecovery) {
    setup.push("20일선 회복 초입");
  }
  if (bottomZone && recoveryFrom120Low <= 18 && snapshot.dayReturn > 0) {
    setup.push("저점 대비 초기 반등");
  }

  return setup;
}

function scoreLimitUp(snapshot: LimitUpSnapshot, setup: string[]) {
  let score = 28;
  const hasBottomIgnition = setup.some(item => item.includes("바닥권"));

  score += Math.min(20, Math.max(0, snapshot.volumeRatio - 1) * 10);
  score += Math.min(14, Math.max(0, snapshot.turnoverPulse - 1) * 8);
  score += snapshot.currentPrice >= snapshot.high20 * 0.985 ? (hasBottomIgnition ? 3 : 9) : 0;
  score += snapshot.currentPrice >= snapshot.high60 * 0.95 ? (hasBottomIgnition ? 2 : 6) : 0;
  score += snapshot.ma5 > snapshot.ma20 ? 6 : -4;
  score += snapshot.ma20 >= snapshot.ma60 * 0.98 ? 6 : -4;
  score += snapshot.dayReturn >= 2 && snapshot.dayReturn <= 10 ? 12 : snapshot.dayReturn < 0 ? -8 : 0;
  score += snapshot.return5d >= 4 && snapshot.return5d <= 35 ? 6 : 0;
  score += snapshot.rsi14 >= 42 && snapshot.rsi14 <= 68 ? 8 : snapshot.rsi14 > 82 ? -12 : 0;
  score += snapshot.closeLocation >= 0.7 ? 5 : -4;
  score += snapshot.upperWickRatio <= 0.25 ? 4 : -8;
  score += snapshot.rangeCompression <= 0.75 ? 4 : 0;
  score += setup.includes("바닥권 거래량 점화") ? 16 : 0;
  score += setup.includes("20일선 회복 초입") ? 12 : 0;
  score += setup.includes("저점 대비 초기 반등") ? 8 : 0;
  score += !hasBottomIgnition && snapshot.rsi14 >= 78 && snapshot.dayReturn >= 10 ? -18 : 0;
  score += setup.length >= 4 ? 5 : 0;
  score += snapshot.volumeRatio < 1 && snapshot.turnoverPulse < 1 ? -14 : 0;

  return Math.max(0, Math.min(100, Math.round(score)));
}

function isBottomLimitUpCandidate(candidate: LimitUpPredictionCandidate) {
  return candidate.setup.some(item => item.includes("바닥권") || item.includes("회복 초입") || item.includes("초기 반등"));
}

function isExtendedLimitUpCandidate(candidate: LimitUpPredictionCandidate) {
  return candidate.rsi14 >= 78 || candidate.dayReturn >= 10 || candidate.volumeRatio >= 3;
}

function bottomLimitUpFocusScore(candidate: LimitUpPredictionCandidate) {
  let score = candidate.limitUpScore;

  if (candidate.setup.includes("바닥권 거래량 점화")) {
    score += 35;
  }
  if (candidate.setup.includes("20일선 회복 초입")) {
    score += 24;
  }
  if (candidate.setup.includes("저점 대비 초기 반등")) {
    score += 18;
  }
  if (candidate.rsi14 >= 40 && candidate.rsi14 <= 66) {
    score += 10;
  }
  if (candidate.dayReturn >= 1 && candidate.dayReturn <= 8) {
    score += 8;
  }
  if (candidate.volumeRatio >= 1.15 && candidate.volumeRatio <= 2.8) {
    score += 7;
  }
  if (!isBottomLimitUpCandidate(candidate) && isExtendedLimitUpCandidate(candidate)) {
    score -= 45;
  }

  return score;
}

export function rankBottomLimitUpCandidates(
  candidates: LimitUpPredictionCandidate[],
  limit = 3
) {
  const bottomCandidates = candidates
    .filter(isBottomLimitUpCandidate)
    .sort((a, b) => bottomLimitUpFocusScore(b) - bottomLimitUpFocusScore(a));
  const supportCandidates = candidates
    .filter(candidate => !isBottomLimitUpCandidate(candidate) && !isExtendedLimitUpCandidate(candidate))
    .sort((a, b) => bottomLimitUpFocusScore(b) - bottomLimitUpFocusScore(a));
  const extendedFallback = candidates
    .filter(candidate => !isBottomLimitUpCandidate(candidate) && isExtendedLimitUpCandidate(candidate))
    .sort((a, b) => bottomLimitUpFocusScore(b) - bottomLimitUpFocusScore(a));
  const seen = new Set<string>();

  return [...bottomCandidates, ...supportCandidates, ...extendedFallback]
    .filter(candidate => {
      if (seen.has(candidate.ticker)) {
        return false;
      }
      seen.add(candidate.ticker);
      return true;
    })
    .slice(0, limit);
}

function buildCandidate(
  ticker: string,
  snapshot: LimitUpSnapshot
): LimitUpPredictionCandidate | null {
  const setup = buildSetup(snapshot);
  const limitUpScore = scoreLimitUp(snapshot, setup);
  const hasBottomIgnition = setup.some(item => item.includes("바닥권"));
  const hasVolumeOrPriceIgnition =
    snapshot.volumeRatio >= 1.25 || snapshot.turnoverPulse >= 1.2 || snapshot.dayReturn >= 5;

  if (!hasVolumeOrPriceIgnition || limitUpScore < (hasBottomIgnition ? 54 : 62) || setup.length < 2) {
    return null;
  }

  const triggerBase = Math.max(snapshot.currentPrice * 1.015, snapshot.high20 * 1.003);
  const triggerPrice = Math.round(triggerBase);
  const stopLossPrice = Math.round(Math.min(snapshot.ma5 * 0.97, snapshot.ma20 * 0.985));
  const estimatedLimitPrice = Math.round(snapshot.prevClose * 1.3);
  const limitUpFit = limitUpScore >= 78 ? "상" : limitUpScore >= 66 ? "중" : "관찰";
  const reason = [
    `거래량비 ${snapshot.volumeRatio.toFixed(2)}x / 3일 거래 펄스 ${snapshot.turnoverPulse.toFixed(2)}x`,
    `당일 등락률 ${snapshot.dayReturn.toFixed(1)}%, 5일 수익률 ${snapshot.return5d.toFixed(1)}%`,
    `RSI14 ${snapshot.rsi14.toFixed(1)}, 종가 위치 ${(snapshot.closeLocation * 100).toFixed(0)}%`,
  ];

  return {
    ticker,
    companyName: LIMIT_UP_NAMES[ticker] ?? ticker,
    market: LIMIT_UP_MARKETS[ticker] ?? "코스피",
    limitUpScore,
    limitUpFit,
    currentPrice: snapshot.currentPrice,
    triggerPrice,
    stopLossPrice,
    estimatedLimitPrice,
    dayReturn: Number(snapshot.dayReturn.toFixed(1)),
    volumeRatio: Number(snapshot.volumeRatio.toFixed(2)),
    turnoverPulse: Number(snapshot.turnoverPulse.toFixed(2)),
    rsi14: Number(snapshot.rsi14.toFixed(1)),
    setup,
    reason,
  };
}

export async function predictLimitUpCandidates(
  inputTickers?: string[]
): Promise<LimitUpPredictionResult> {
  const tickers = (inputTickers?.filter(isKoreanTicker) || LIMIT_UP_UNIVERSE).slice(0, 30);
  const rowsByTicker = await fetchKoreanOhlcvRowsBatch(tickers);
  const skipped: string[] = [];

  const candidates = tickers
    .map(ticker => {
      const bars = toBars(rowsByTicker[ticker]);
      const snapshot = buildSnapshot(bars);

      if (!snapshot) {
        skipped.push(`${LIMIT_UP_NAMES[ticker] ?? ticker}: 분석 최소 길이 부족`);
        return null;
      }

      const candidate = buildCandidate(ticker, snapshot);
      if (!candidate) {
        skipped.push(`${LIMIT_UP_NAMES[ticker] ?? ticker}: 상한가 예측 점수 부족`);
      }
      return candidate;
    })
    .filter((candidate): candidate is LimitUpPredictionCandidate => Boolean(candidate))
  const rankedCandidates = rankBottomLimitUpCandidates(candidates, 3);

  return {
    candidates: rankedCandidates,
    scannedTickers: tickers,
    notes: [
      `상한가 예측 에이전트가 ${tickers.length}개 종목의 OHLCV 자료를 수집했습니다.`,
      `상위 ${rankedCandidates.length}개를 바닥권 상한가 근접 후보 중심으로 선정했습니다.`,
      "상한가 예측은 뉴스·테마를 제외하고 차트, 거래량, RSI, 이평선, 바닥권 거래량 점화만 사용합니다.",
      skipped.slice(0, 5).length ? `제외 메모: ${skipped.slice(0, 5).join(" | ")}` : "제외 메모: 없음",
    ],
  };
}
