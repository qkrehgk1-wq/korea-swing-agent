import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  fetchKoreanOhlcvRowsBatch,
  fetchNaverUniverse,
  isKoreanTicker,
  type NaverUniverseEntry,
  type OhlcvRow,
} from "./koreaStockMcp";
import { SWING_UNIVERSE_FALLBACK } from "./swingUniverseFallback";
import { analyzeTechnicalConfluence, type ConfluenceResult } from "./technicalConfluence";

export type PatternName =
  | "밥그릇 1번자리"
  | "밥그릇 2번자리"
  | "밥그릇 패턴"
  | "하이힐 패턴"
  | "돌파매매"
  | "컵앤핸들";

type BiblePattern = {
  name: PatternName;
  summary: string;
  checklist: string[];
  entryRule: string;
  riskRule: string;
};

export type TechnicalSwingCandidate = {
  ticker: string;
  companyName: string;
  market: "코스피" | "코스닥";
  patterns: PatternName[];
  swingScore: number;
  swingFit: "상" | "중" | "관찰";
  currentPrice: number;
  triggerPrice: number;
  stopLossPrice: number;
  volumeRatio: number;
  rsi14: number;
  volatility20: number;
  marketRegimeLabel: "강세" | "중립" | "약세";
  marketRegimeScore: number;
  reason: string[];
  qualityScore?: number;
  relativeStrength?: number;
  fibExtensionTarget?: number | null;
  confluenceSignals?: string[];
  supplyState?: "accumulating" | "distributing" | "neutral";
  supplyNote?: string;
  newsState?: "positive" | "negative" | "neutral";
  newsNote?: string;
};

type Candidate = TechnicalSwingCandidate;

type ScreenerResult = {
  bible: BiblePattern[];
  candidates: Candidate[];
  watchlist?: Candidate[];
  scannedTickers: string[];
  notes: string[];
  dataReliability?: {
    scanned: number;
    dataFailures: number;
    staleTickers: number;
    degraded: boolean;
  };
};

/** Calendar-day gap between two yyyy-mm-dd strings (to − from); 0 on bad input. */
export function isoDaysBetween(fromDate: string, toDate: string): number {
  const from = new Date(`${fromDate}T00:00:00Z`).getTime();
  const to = new Date(`${toDate}T00:00:00Z`).getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return Math.round((to - from) / 86400000);
}

export type TechnicalSwingRowsByTicker = Record<string, OhlcvRow[] | null>;
export type TechnicalSwingScreenerResult = ScreenerResult;

type PriceBar = {
  close: number;
  high: number;
  low: number;
  volume: number;
};

type IndicatorSnapshot = {
  currentPrice: number;
  ma20: number;
  ma60: number;
  ma120: number;
  rsi14: number;
  volumeRatio: number;
  annualHigh: number;
  annualLow: number;
  return20d: number;
  return60d: number;
  volatility20: number;
};

type PatternDetection = {
  matched: boolean;
  note: string;
};

type MarketRegime = {
  label: "강세" | "중립" | "약세";
  score: number;
  notes: string[];
};

export type SwingPatternWeights = Record<PatternName, number>;

type SwingLearnedOverrides = {
  generatedAt: string;
  sourceReport: string;
  patternWeightAdjustments: Partial<Record<PatternName, number>>;
  effectivePatternWeights: SwingPatternWeights;
  notes: string[];
};

type SwingPredictionQualityOverrides = {
  generatedAt: string;
  sourceReport: string;
  minDefaultSwingScore: number;
  minEarlyBowlSwingScore: number;
  minVolumeRatio: number;
  maxRsi14: number;
  maxVolatility20: number;
  notes: string[];
};

export type SwingQualityParams = {
  minDefaultSwingScore: number;
  minEarlyBowlSwingScore: number;
  minVolumeRatio: number;
  maxRsi14: number;
  maxVolatility20: number;
  // Confluence gates — evolvable so the weekly GA tunes them on the backtest
  // instead of leaving them as hand-picked constants.
  minConfluenceScore: number;
  minRelativeStrength: number;
};

/**
 * Parameters the evolution agent injects to backtest a candidate strategy
 * variant without touching the live override files. When passed, the screener
 * uses these instead of reading learned/quality overrides from disk.
 */
export type InjectedSwingOverrides = {
  patternWeights?: Partial<Record<PatternName, number>> | null;
  quality?: SwingQualityParams | null;
};

const LEARNED_OVERRIDES_PATH = path.join(
  process.cwd(),
  ".data",
  "backtests",
  "learned-swing-overrides.json"
);
const QUALITY_OVERRIDES_PATH = path.join(
  process.cwd(),
  ".data",
  "backtests",
  "prediction-quality-overrides.json"
);

export const SWING_PATTERN_BASE_WEIGHTS: SwingPatternWeights = {
  "밥그릇 2번자리": 20,
  "밥그릇 1번자리": 18,
  "밥그릇 패턴": 13,
  "컵앤핸들": 8,
  "하이힐 패턴": 7,
  "돌파매매": 6,
};

function clampWeight(value: number) {
  return Math.max(3, Math.min(26, Math.round(value)));
}

async function loadSwingLearnedOverrides(): Promise<SwingLearnedOverrides | null> {
  try {
    const raw = await readFile(LEARNED_OVERRIDES_PATH, "utf8");
    return JSON.parse(raw) as SwingLearnedOverrides;
  } catch {
    return null;
  }
}

async function loadSwingPredictionQualityOverrides(): Promise<SwingPredictionQualityOverrides | null> {
  try {
    const raw = await readFile(QUALITY_OVERRIDES_PATH, "utf8");
    return JSON.parse(raw) as SwingPredictionQualityOverrides;
  } catch {
    return null;
  }
}

export function resolveSwingPatternWeights(
  overrides?: Partial<Record<PatternName, number>> | null
): SwingPatternWeights {
  return {
    "밥그릇 1번자리": clampWeight(overrides?.["밥그릇 1번자리"] ?? SWING_PATTERN_BASE_WEIGHTS["밥그릇 1번자리"]),
    "밥그릇 2번자리": clampWeight(overrides?.["밥그릇 2번자리"] ?? SWING_PATTERN_BASE_WEIGHTS["밥그릇 2번자리"]),
    "밥그릇 패턴": clampWeight(overrides?.["밥그릇 패턴"] ?? SWING_PATTERN_BASE_WEIGHTS["밥그릇 패턴"]),
    "하이힐 패턴": clampWeight(overrides?.["하이힐 패턴"] ?? SWING_PATTERN_BASE_WEIGHTS["하이힐 패턴"]),
    "돌파매매": clampWeight(overrides?.["돌파매매"] ?? SWING_PATTERN_BASE_WEIGHTS["돌파매매"]),
    "컵앤핸들": clampWeight(overrides?.["컵앤핸들"] ?? SWING_PATTERN_BASE_WEIGHTS["컵앤핸들"]),
  };
}

export const DEFAULT_SWING_UNIVERSE = [
  "005930",
  "000660",
  "035420",
  "035720",
  "005380",
  "068270",
  "105560",
  "012450",
  "034020",
  "009150",
  "011200",
  "066570",
  "323410",
  "329180",
  "003670",
  "251270",
  "086520",
  "042700",
  "214150",
  "247540",
  "028300",
  "196170",
  "277810",
  "141080",
  "145020",
  "112040",
  "240810",
  "058470",
  "348370",
  "950160",
];

export const DEFAULT_SWING_NAMES: Record<string, string> = {
  "005930": "삼성전자",
  "000660": "SK하이닉스",
  "035420": "NAVER",
  "035720": "카카오",
  "005380": "현대차",
  "068270": "셀트리온",
  "105560": "KB금융",
  "012450": "한화에어로스페이스",
  "034020": "두산에너빌리티",
  "009150": "삼성전기",
  "011200": "HMM",
  "066570": "LG전자",
  "323410": "카카오뱅크",
  "329180": "HD현대중공업",
  "003670": "포스코퓨처엠",
  "251270": "넷마블",
  "086520": "에코프로",
  "042700": "한미반도체",
  "214150": "클래시스",
  "247540": "에코프로비엠",
  "028300": "HLB",
  "196170": "알테오젠",
  "277810": "레인보우로보틱스",
  "141080": "리가켐바이오",
  "145020": "휴젤",
  "112040": "위메이드",
  "240810": "원익IPS",
  "058470": "리노공업",
  "348370": "엔켐",
  "950160": "코오롱티슈진",
  "069500": "KODEX 200",
  "229200": "KODEX 코스닥150",
};

export const DEFAULT_SWING_MARKETS: Record<string, "코스피" | "코스닥"> = {
  "005930": "코스피",
  "000660": "코스피",
  "035420": "코스피",
  "035720": "코스피",
  "005380": "코스피",
  "068270": "코스피",
  "105560": "코스피",
  "012450": "코스피",
  "034020": "코스피",
  "009150": "코스피",
  "011200": "코스피",
  "066570": "코스피",
  "323410": "코스피",
  "329180": "코스피",
  "003670": "코스닥",
  "251270": "코스닥",
  "086520": "코스닥",
  "042700": "코스닥",
  "214150": "코스닥",
  "247540": "코스닥",
  "028300": "코스닥",
  "196170": "코스닥",
  "277810": "코스닥",
  "141080": "코스닥",
  "145020": "코스닥",
  "112040": "코스닥",
  "240810": "코스닥",
  "058470": "코스닥",
  "348370": "코스닥",
  "950160": "코스닥",
};

export function buildTechnicalSwingBible(): BiblePattern[] {
  return [
    {
      name: "밥그릇 1번자리",
      summary: "급락 뒤 바닥권에서 저점이 더 내려가지 않고 거래가 마르는 초입 구간입니다.",
      checklist: [
        "120일 구간에서 충분한 하락폭이 먼저 있었는지",
        "최근 저점 대비 반등은 시작했지만 아직 좌측 고점과 거리가 큰지",
        "RSI가 과열이 아니고 손절선을 짧게 잡을 수 있는지",
      ],
      entryRule: "저점 재이탈이 멈춘 뒤 5일선 회복 또는 첫 양봉 확인 시 아주 작은 비중으로 관찰 진입",
      riskRule: "최근 20일 저점 또는 바닥 확인봉 저가를 이탈하면 패턴 실패로 간주",
    },
    {
      name: "밥그릇 2번자리",
      summary: "바닥을 지나 우측 회복이 시작되고 20일선을 회복하는 초기 구간입니다.",
      checklist: [
        "저점 대비 10% 이상 회복했지만 아직 고점 추격 구간은 아닌지",
        "20일선 위로 올라오며 거래량이 서서히 붙는지",
        "60일선 또는 우측 목선 전까지 손익비가 남아 있는지",
      ],
      entryRule: "20일선 위 안착 후 눌림이 얕게 끝나면 2차 관찰 진입",
      riskRule: "20일선 재이탈 또는 우측 회복봉 저가 이탈 시 비중 축소",
    },
    {
      name: "밥그릇 패턴",
      summary: "급락 후 V자 반등이 아니라 둥글게 저점을 다지고 우상향 복원하는 구조를 찾습니다.",
      checklist: [
        "중앙부에 저점이 있고 좌우가 둥글게 회복되는지",
        "우측 상승 구간에서 20일선과 60일선을 회복했는지",
        "고점 근처에서 거래량이 다시 살아나는지",
      ],
      entryRule: "이전 목선 또는 우측 고점 재돌파를 거래량과 함께 확인한 뒤 분할 진입",
      riskRule: "핸들 역할을 하는 최근 눌림 저점 또는 20일선을 이탈하면 손실 관리",
    },
    {
      name: "하이힐 패턴",
      summary: "짧은 눌림 후 각도 높은 상승이 붙는 강한 모멘텀형 패턴입니다.",
      checklist: [
        "최근 1개월 상승률이 강한데 과도한 윗꼬리 남발은 아닌지",
        "20일 평균 대비 거래량이 살아나는지",
        "가격이 20일선 위에서 빠르게 재지지하는지",
      ],
      entryRule: "장대 양봉 추격보다 3~5일 눌림목에서 거래량 감소를 확인하고 진입",
      riskRule: "20일선 이탈과 함께 거래량이 커지면 하이힐 각도가 꺾인 것으로 판단",
    },
    {
      name: "돌파매매",
      summary: "상단 매물대를 소화한 뒤 신고가 또는 박스 상단을 돌파하는 순간을 노립니다.",
      checklist: [
        "직전 60일 고점 근처에서 종가 기준 돌파가 나오는지",
        "돌파일 거래량이 평균 대비 유의미하게 증가하는지",
        "돌파 이후 종가가 다시 박스 안으로 밀리지 않는지",
      ],
      entryRule: "종가 기준 돌파 확인 후 다음 눌림 또는 돌파 당일 종가 부근 분할 진입",
      riskRule: "돌파 기준봉 저가 또는 박스 상단 재이탈 시 실패 돌파로 간주",
    },
    {
      name: "컵앤핸들",
      summary: "중기 조정으로 컵을 만들고, 짧은 손잡이 조정을 거쳐 재돌파를 노리는 패턴입니다.",
      checklist: [
        "좌측 고점과 현재 가격 차이가 크지 않은지",
        "손잡이 구간 조정폭이 과도하지 않은지",
        "손잡이 저점이 60일선 위 또는 근처에서 지지되는지",
      ],
      entryRule: "손잡이 상단 또는 좌측 고점 돌파 시 거래량 동반 여부를 보고 진입",
      riskRule: "손잡이 저점 하향 이탈 시 패턴 무효로 보고 재진입보다 관망",
    },
  ];
}

function toBars(rows: OhlcvRow[] | null): PriceBar[] {
  if (!rows?.length) {
    return [];
  }

  return rows.map(row => ({
    close: row.종가,
    high: row.고가,
    low: row.저가,
    volume: row.거래량,
  }));
}

function average(values: number[]) {
  if (values.length === 0) {
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

function standardDeviation(values: number[]) {
  if (values.length === 0) {
    return 0;
  }

  const mean = average(values);
  const variance = average(values.map(value => (value - mean) ** 2));
  return Math.sqrt(variance);
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

function buildIndicatorSnapshot(bars: PriceBar[]): IndicatorSnapshot | null {
  if (bars.length < 140) {
    return null;
  }

  const closes = bars.map(bar => bar.close);
  const volumes = bars.map(bar => bar.volume);
  const currentPrice = closes[closes.length - 1];
  const annualHigh = Math.max(...closes.slice(-120));
  const annualLow = Math.min(...closes.slice(-120));
  const dailyReturns = closes
    .slice(1)
    .map((close, index) => percentChange(closes[index], close) / 100);

  return {
    currentPrice,
    ma20: average(closes.slice(-20)),
    ma60: average(closes.slice(-60)),
    ma120: average(closes.slice(-120)),
    rsi14: calculateRsi14(closes),
    volumeRatio: volumes[volumes.length - 1] / Math.max(average(volumes.slice(-20)), 1),
    annualHigh,
    annualLow,
    return20d: percentChange(closes[closes.length - 21], currentPrice),
    return60d: percentChange(closes[closes.length - 61], currentPrice),
    volatility20: standardDeviation(dailyReturns.slice(-20)) * Math.sqrt(252) * 100,
  };
}

function detectBowlPattern(bars: PriceBar[], indicators: IndicatorSnapshot): PatternDetection {
  const closes = bars.map(bar => bar.close);
  const window = closes.slice(-120);
  const low = Math.min(...window);
  const lowIndex = window.findIndex(value => value === low);
  const leftHigh = Math.max(...window.slice(0, Math.max(lowIndex, 1)));
  const current = window[window.length - 1];
  const drawdown = percentChange(leftHigh, low);
  const recovery = percentChange(low, current);
  const nearHigh = current >= leftHigh * 0.88;
  const centeredLow = lowIndex > 20 && lowIndex < 95;

  const matched =
    centeredLow &&
    drawdown <= -12 &&
    recovery >= 18 &&
    nearHigh &&
    indicators.currentPrice > indicators.ma20 &&
    indicators.ma20 > indicators.ma60;

  return {
    matched,
    note: matched
      ? "둥근 바닥을 만들고 우측 회복 구간이 살아 있습니다."
      : "밥그릇 구조가 아직 완성형은 아닙니다.",
  };
}

function detectBowlPosition1(bars: PriceBar[], indicators: IndicatorSnapshot): PatternDetection {
  const closes = bars.map(bar => bar.close);
  const window = closes.slice(-120);
  const low = Math.min(...window);
  const lowIndex = window.findIndex(value => value === low);
  const leftHigh = Math.max(...window.slice(0, Math.max(lowIndex, 1)));
  const current = window[window.length - 1];
  const drawdown = percentChange(leftHigh, low);
  const recovery = percentChange(low, current);
  const stillBottomZone = current <= leftHigh * 0.82;
  const recentLowHeld = current >= Math.min(...window.slice(-20)) * 1.03;
  const recentBottom = lowIndex >= 60;

  const matched =
    recentBottom &&
    drawdown <= -18 &&
    recovery >= 4 &&
    recovery <= 22 &&
    stillBottomZone &&
    recentLowHeld &&
    indicators.rsi14 >= 35 &&
    indicators.rsi14 <= 62;

  return {
    matched,
    note: matched
      ? "밥그릇 1번자리: 바닥권 저점 이탈이 멈추고 초기 반등이 붙는 구간입니다."
      : "밥그릇 1번자리로 보기에는 바닥 확인 또는 저점 방어가 부족합니다.",
  };
}

function detectBowlPosition2(bars: PriceBar[], indicators: IndicatorSnapshot): PatternDetection {
  const closes = bars.map(bar => bar.close);
  const window = closes.slice(-120);
  const low = Math.min(...window);
  const lowIndex = window.findIndex(value => value === low);
  const leftHigh = Math.max(...window.slice(0, Math.max(lowIndex, 1)));
  const current = window[window.length - 1];
  const drawdown = percentChange(leftHigh, low);
  const recovery = percentChange(low, current);
  const beforeNeckline = current < leftHigh * 0.88;
  const rightSideStarted = current > indicators.ma20 && indicators.return20d > 0;
  const notExtended = indicators.rsi14 <= 70 && recovery <= 35;

  const matched =
    lowIndex > 35 &&
    lowIndex < 105 &&
    drawdown <= -14 &&
    recovery >= 10 &&
    beforeNeckline &&
    rightSideStarted &&
    notExtended;

  return {
    matched,
    note: matched
      ? "밥그릇 2번자리: 20일선을 회복하며 우측 회복 초입에 들어온 구간입니다."
      : "밥그릇 2번자리로 보기에는 20일선 회복 또는 우측 반등 각도가 부족합니다.",
  };
}

function detectHighHeelPattern(bars: PriceBar[], indicators: IndicatorSnapshot): PatternDetection {
  const closes = bars.map(bar => bar.close);
  const recent5 = closes.slice(-5);
  const positiveDays = recent5.filter((close, index) => index > 0 && close >= recent5[index - 1]).length;
  const matched =
    indicators.return20d >= 12 &&
    indicators.return20d <= 45 &&
    indicators.currentPrice > indicators.ma20 &&
    indicators.volumeRatio >= 1.1 &&
    indicators.rsi14 >= 58 &&
    indicators.rsi14 <= 78 &&
    positiveDays >= 3;

  return {
    matched,
    note: matched
      ? "최근 상승 각도가 강하고 눌림 뒤 재가속 가능성이 보입니다."
      : "하이힐처럼 강한 각도와 거래량이 아직 부족합니다.",
  };
}

function detectBreakoutPattern(bars: PriceBar[], indicators: IndicatorSnapshot): PatternDetection {
  const closes = bars.map(bar => bar.close);
  const priorRangeHigh = Math.max(...closes.slice(-65, -5));
  const matched =
    indicators.currentPrice >= priorRangeHigh * 0.995 &&
    indicators.currentPrice > indicators.ma20 &&
    indicators.ma20 > indicators.ma60 &&
    indicators.volumeRatio >= 1.35 &&
    indicators.rsi14 >= 55 &&
    indicators.rsi14 <= 76;

  return {
    matched,
    note: matched
      ? "상단 매물대를 종가 기준으로 두드리는 돌파 구간입니다."
      : "돌파 신호로 보기에는 거래량 또는 위치가 애매합니다.",
  };
}

function detectCupHandlePattern(bars: PriceBar[], indicators: IndicatorSnapshot): PatternDetection {
  const closes = bars.map(bar => bar.close);
  const window = closes.slice(-120);
  const leftHigh = Math.max(...window.slice(0, 45));
  const bottom = Math.min(...window.slice(20, 90));
  const handleWindow = window.slice(-15);
  const handleLow = Math.min(...handleWindow);
  const handleDrawdown = percentChange(Math.max(...handleWindow), handleLow);
  const current = window[window.length - 1];

  const matched =
    percentChange(leftHigh, bottom) <= -12 &&
    current >= leftHigh * 0.94 &&
    handleDrawdown >= -8 &&
    handleDrawdown <= -2 &&
    handleLow >= indicators.ma60 * 0.95 &&
    indicators.currentPrice > indicators.ma20 &&
    indicators.rsi14 >= 52;

  return {
    matched,
    note: matched
      ? "컵을 만든 뒤 얕은 손잡이 조정이 붙어 재돌파 대기 구조입니다."
      : "컵앤핸들로 보기엔 손잡이 깊이 또는 우측 회복이 부족합니다.",
  };
}

function assessMarketRegime(snapshot: IndicatorSnapshot | null): MarketRegime {
  if (!snapshot) {
    return {
      label: "중립",
      score: 50,
      notes: ["시장 레짐을 확인할 수 없어 중립으로 처리했습니다."],
    };
  }

  let score = 50;
  const notes: string[] = [];

  if (snapshot.currentPrice > snapshot.ma20) {
    score += 10;
    notes.push("지수가 20일선 위에 있습니다.");
  } else {
    score -= 10;
    notes.push("지수가 20일선 아래입니다.");
  }

  if (snapshot.ma20 > snapshot.ma60) {
    score += 12;
    notes.push("20일선이 60일선 위입니다.");
  } else {
    score -= 12;
    notes.push("20일선이 60일선 아래입니다.");
  }

  if (snapshot.return20d > 0) {
    score += 10;
    notes.push("최근 20일 수익률이 양호합니다.");
  } else {
    score -= 10;
    notes.push("최근 20일 수익률이 약합니다.");
  }

  if (snapshot.rsi14 >= 50 && snapshot.rsi14 <= 68) {
    score += 6;
    notes.push("RSI가 과열 구간이 아닙니다.");
  } else if (snapshot.rsi14 > 72) {
    score -= 4;
    notes.push("RSI가 과열에 가깝습니다.");
  }

  const label = score >= 62 ? "강세" : score >= 45 ? "중립" : "약세";
  return { label, score: Math.max(0, Math.min(100, score)), notes };
}

function computeSwingScore(
  indicators: IndicatorSnapshot,
  matchedPatterns: PatternName[],
  patternWeights: SwingPatternWeights
) {
  let score = 45;
  score += matchedPatterns.reduce((sum, pattern) => sum + patternWeights[pattern], 0);
  score += indicators.currentPrice > indicators.ma20 ? 6 : -8;
  score += indicators.ma20 > indicators.ma60 ? 6 : -6;
  score += indicators.volumeRatio >= 1.2 ? 8 : indicators.volumeRatio >= 0.9 ? 3 : -4;
  score += indicators.rsi14 >= 45 && indicators.rsi14 <= 66 ? 8 : indicators.rsi14 > 74 ? -12 : 0;
  score += indicators.return60d > 0 ? 4 : -5;
  score += indicators.volatility20 <= 45 ? 4 : -4;
  score += matchedPatterns.length >= 2 ? 4 : 0;
  score += matchedPatterns.some(pattern => pattern === "밥그릇 1번자리" || pattern === "밥그릇 2번자리")
    ? 8
    : 0;
  score += matchedPatterns.some(pattern => pattern === "돌파매매" || pattern === "하이힐 패턴") &&
    indicators.rsi14 >= 72
    ? -10
    : 0;

  return Math.max(0, Math.min(100, Math.round(score)));
}

function hasEarlyBowlPattern(patterns: PatternName[]) {
  return patterns.some(pattern => pattern === "밥그릇 1번자리" || pattern === "밥그릇 2번자리");
}

function hasAggressiveHighPattern(patterns: PatternName[]) {
  return patterns.some(pattern => pattern === "돌파매매" || pattern === "하이힐 패턴" || pattern === "컵앤핸들");
}

function isOverheatedCandidate(candidate: TechnicalSwingCandidate) {
  const nearTrigger = candidate.triggerPrice <= candidate.currentPrice * 1.02;
  return candidate.rsi14 >= 76 || (hasAggressiveHighPattern(candidate.patterns) && nearTrigger);
}

function bowlFocusScore(candidate: TechnicalSwingCandidate) {
  let score = candidate.swingScore;

  if (candidate.patterns.includes("밥그릇 2번자리")) {
    score += 34;
  }
  if (candidate.patterns.includes("밥그릇 1번자리")) {
    score += 30;
  }
  if (candidate.patterns.includes("밥그릇 패턴")) {
    score += 10;
  }
  if (candidate.volumeRatio >= 1.0 && candidate.volumeRatio <= 2.5) {
    score += 7;
  }
  if (candidate.rsi14 >= 40 && candidate.rsi14 <= 66) {
    score += 8;
  }
  if (isOverheatedCandidate(candidate)) {
    score -= 35;
  }

  return score;
}

export function rankBowlFocusedCandidates(
  candidates: TechnicalSwingCandidate[],
  limit = 5
): TechnicalSwingCandidate[] {
  const byBowlFocus = (a: TechnicalSwingCandidate, b: TechnicalSwingCandidate) =>
    bowlFocusScore(b) - bowlFocusScore(a) || b.swingScore - a.swingScore;
  const earlyBowl = candidates
    .filter(candidate => hasEarlyBowlPattern(candidate.patterns))
    .sort(byBowlFocus);
  const completedBowl = candidates
    .filter(candidate => !hasEarlyBowlPattern(candidate.patterns) && candidate.patterns.includes("밥그릇 패턴"))
    .sort(byBowlFocus);
  const nonOverheatedSupport = candidates
    .filter(
      candidate =>
        !hasEarlyBowlPattern(candidate.patterns) &&
        !candidate.patterns.includes("밥그릇 패턴") &&
        !isOverheatedCandidate(candidate)
    )
    .sort(byBowlFocus);
  const overheatedFallback = candidates
    .filter(
      candidate =>
        !hasEarlyBowlPattern(candidate.patterns) &&
        !candidate.patterns.includes("밥그릇 패턴") &&
        isOverheatedCandidate(candidate)
    )
    .sort(byBowlFocus);
  const seen = new Set<string>();

  return [...earlyBowl, ...completedBowl, ...nonOverheatedSupport, ...overheatedFallback]
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
  companyName: string,
  indicators: IndicatorSnapshot,
  detections: Array<{ name: PatternName; result: PatternDetection }>,
  regime: MarketRegime,
  patternWeights: SwingPatternWeights,
  confluence: ConfluenceResult,
  qualityOverrides?: Partial<SwingQualityParams> | null
): { candidate: Candidate; watchOnly: boolean } | null {
  const patterns = detections.filter(item => item.result.matched).map(item => item.name);
  if (patterns.length === 0) {
    return null;
  }

  // Bear-market handling is unified below (watch-only demotion), so the old
  // ad-hoc 약세 hard-rejects are gone — every 약세 candidate is surfaced as
  // watch rather than some vanishing and some showing.
  const swingScore = computeSwingScore(indicators, patterns, patternWeights);
  const swingFit = swingScore >= 78 ? "상" : swingScore >= 62 ? "중" : "관찰";
  const isEarlyBowl = hasEarlyBowlPattern(patterns);
  const minDefaultSwingScore = qualityOverrides?.minDefaultSwingScore ?? 62;
  const minEarlyBowlSwingScore = qualityOverrides?.minEarlyBowlSwingScore ?? 48;
  const minVolumeRatio = qualityOverrides?.minVolumeRatio ?? 0.9;
  const maxRsi14 = qualityOverrides?.maxRsi14 ?? 76;
  const maxVolatility20 = qualityOverrides?.maxVolatility20 ?? 45;
  const isOverheatedAggressive =
    !isEarlyBowl &&
    patterns.length === 1 &&
    hasAggressiveHighPattern(patterns) &&
    indicators.rsi14 >= 72 &&
    indicators.currentPrice >= indicators.annualHigh * 0.94;
  if (isOverheatedAggressive) {
    return null;
  }
  if (!isEarlyBowl && indicators.volumeRatio < minVolumeRatio) {
    return null;
  }
  if (!isEarlyBowl && indicators.rsi14 > maxRsi14) {
    return null;
  }
  if (!isEarlyBowl && indicators.volatility20 > maxVolatility20 && patterns.length === 1) {
    return null;
  }
  // Soft score shortfall → not rejected, but demoted to watch-only (see below).
  const lowPatternScore =
    swingScore < (isEarlyBowl ? minEarlyBowlSwingScore : minDefaultSwingScore) && patterns.length === 1;

  // Multi-factor confluence quality gate — proven leadership/trend/golden-ratio
  // filters that reject single-pattern noise (the main lever on candidate quality).
  const minConfluence =
    qualityOverrides?.minConfluenceScore ?? (Number(process.env.MIN_CONFLUENCE_SCORE) || 50);
  const confluenceFloor = isEarlyBowl ? Math.max(30, minConfluence - 12) : minConfluence;
  const rsFloorEnv = Number(process.env.MIN_RELATIVE_STRENGTH);
  const rsFloor =
    qualityOverrides?.minRelativeStrength ?? (Number.isFinite(rsFloorEnv) ? rsFloorEnv : -10);
  if (confluence.relativeStrength60 < rsFloor) {
    return null; // chronically lagging its index — not a leadership stock
  }
  if (confluence.overExtended && !isEarlyBowl) {
    return null; // anti-FOMO: do not chase a stock stretched far above its 20MA
  }
  if (!isEarlyBowl && !confluence.trendAligned) {
    return null; // breakout/continuation setups must sit in an uptrend
  }

  const triggerPrice = Math.round(
    isEarlyBowl
      ? Math.max(indicators.currentPrice * 1.015, indicators.ma20 * 1.01)
      : Math.max(indicators.currentPrice, indicators.annualHigh * 0.985)
  );
  const stopLossPrice = Math.round(
    isEarlyBowl
      ? Math.min(indicators.currentPrice * 0.93, indicators.annualLow * 1.02)
      : Math.min(indicators.ma20, indicators.ma60 * 0.98)
  );

  // Blend the pattern score with the multi-factor confluence quality so the final
  // score reflects leadership + trend + momentum, not just the chart pattern.
  const blendedScore = Math.round(swingScore * 0.55 + confluence.qualityScore * 0.45);
  // Watch-only: structurally sound (passed every hard gate) but the score or
  // confluence quality is below the conviction floor. Surfaced for situational
  // awareness so the alert is never silent — never counted as a backtest trade.
  // Bear-market risk-off: the backtest shows 약세-regime entries average a loss
  // (win ~52%, avg −1%), so in a bearish tape demote every pick to watch-only —
  // out of live picks and backtest trades, still visible for awareness.
  const skipBearish = (process.env.SKIP_BEARISH_ENTRIES ?? "true") !== "false";
  const watchOnly =
    lowPatternScore ||
    confluence.qualityScore < confluenceFloor ||
    (skipBearish && regime.label === "약세");
  const blendedFit = watchOnly
    ? "관찰"
    : blendedScore >= 78
      ? "상"
      : blendedScore >= 62
        ? "중"
        : "관찰";

  return {
    candidate: {
      ticker,
      companyName,
      market: marketFor(ticker),
      patterns,
      swingScore: blendedScore,
      swingFit: blendedFit,
      currentPrice: indicators.currentPrice,
      triggerPrice,
      stopLossPrice,
      volumeRatio: Number(indicators.volumeRatio.toFixed(2)),
      rsi14: Number(indicators.rsi14.toFixed(1)),
      volatility20: Number(indicators.volatility20.toFixed(1)),
      marketRegimeLabel: regime.label,
      marketRegimeScore: regime.score,
      reason: [
        ...detections.filter(item => item.result.matched).map(item => item.result.note),
        ...confluence.signals,
      ],
      qualityScore: confluence.qualityScore,
      relativeStrength: confluence.relativeStrength60,
      fibExtensionTarget: confluence.fibExtensionTarget,
      confluenceSignals: confluence.signals,
    },
    watchOnly,
  };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  worker: (item: T) => Promise<R>,
  concurrency = 4
) {
  const results: R[] = [];
  let cursor = 0;

  async function runWorker() {
    while (cursor < items.length) {
      const currentIndex = cursor++;
      results[currentIndex] = await worker(items[currentIndex]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => runWorker()));
  return results;
}

/**
 * Dynamic name/market maps populated at runtime from the Naver market-cap
 * universe; DEFAULT_SWING_* stay as the offline fallback.
 */
const runtimeNames: Record<string, string> = {};
const runtimeMarkets: Record<string, "코스피" | "코스닥"> = {};
let cachedUniverse: string[] | null = null;

function nameFor(ticker: string): string {
  return runtimeNames[ticker] ?? DEFAULT_SWING_NAMES[ticker] ?? ticker;
}

function marketFor(ticker: string): "코스피" | "코스닥" {
  return runtimeMarkets[ticker] ?? DEFAULT_SWING_MARKETS[ticker] ?? "코스피";
}

function registerUniverse(entries: NaverUniverseEntry[]): string[] {
  for (const entry of entries) {
    runtimeNames[entry.ticker] = entry.name;
    runtimeMarkets[entry.ticker] = entry.market;
  }
  return entries.map(entry => entry.ticker);
}

/**
 * Builds the scan universe with layered sources (per-process cached):
 * 1) Naver live (mobile API → classic page) top market-cap KOSPI + KOSDAQ
 *    (size via SWING_UNIVERSE_KOSPI / SWING_UNIVERSE_KOSDAQ),
 * 2) a baked top-cap snapshot (SWING_UNIVERSE_FALLBACK) — survives a geo-blocked
 *    CI runner with zero network,
 * 3) the original 30-ticker DEFAULT_SWING_UNIVERSE as the absolute last resort.
 */
export async function resolveSwingUniverse(): Promise<string[]> {
  if (cachedUniverse) return cachedUniverse;
  const kospiCount = Number(process.env.SWING_UNIVERSE_KOSPI) || 120;
  const kosdaqCount = Number(process.env.SWING_UNIVERSE_KOSDAQ) || 80;
  try {
    const [kospi, kosdaq] = await Promise.all([
      fetchNaverUniverse("KOSPI", kospiCount),
      fetchNaverUniverse("KOSDAQ", kosdaqCount),
    ]);
    const merged = [...kospi, ...kosdaq];
    if (merged.length >= 20) {
      cachedUniverse = registerUniverse(merged);
      return cachedUniverse;
    }
    console.warn(`[Swing Universe] live fetch too thin (${merged.length}), using baked fallback`);
  } catch (error) {
    console.warn("[Swing Universe] live fetch failed, using baked fallback:", error);
  }
  if (SWING_UNIVERSE_FALLBACK.length >= 20) {
    cachedUniverse = registerUniverse(SWING_UNIVERSE_FALLBACK);
    return cachedUniverse;
  }
  cachedUniverse = [...DEFAULT_SWING_UNIVERSE];
  return cachedUniverse;
}

export async function screenTechnicalSwingCandidatesFromRows(
  rowsByTicker: TechnicalSwingRowsByTicker,
  inputTickers?: string[],
  injected?: InjectedSwingOverrides
): Promise<ScreenerResult> {
  const learnedOverrides = injected ? null : await loadSwingLearnedOverrides();
  const qualityOverrides = injected ? injected.quality ?? null : await loadSwingPredictionQualityOverrides();
  const patternWeights = resolveSwingPatternWeights(
    injected?.patternWeights ?? learnedOverrides?.effectivePatternWeights
  );
  const tickers = inputTickers?.filter(isKoreanTicker) ?? DEFAULT_SWING_UNIVERSE;
  const kospiRows = rowsByTicker["069500"];
  const kosdaqRows = rowsByTicker["229200"];
  const kospiRegime = assessMarketRegime(buildIndicatorSnapshot(toBars(kospiRows)));
  const kosdaqRegime = assessMarketRegime(buildIndicatorSnapshot(toBars(kosdaqRows)));
  const marketRegime =
    kospiRegime.score <= kosdaqRegime.score ? kospiRegime : kosdaqRegime;
  const kospiBars = toBars(kospiRows);
  const kosdaqBars = toBars(kosdaqRows);
  const benchLastDate =
    kospiRows?.[kospiRows.length - 1]?.날짜 ?? kosdaqRows?.[kosdaqRows.length - 1]?.날짜 ?? null;
  const haltStaleDays = Number(process.env.HALT_STALE_DAYS) || 7;

  const scanned = await mapWithConcurrency(
    tickers,
    async ticker => {
      const rows = rowsByTicker[ticker];
      if (!rows?.length) {
        return {
          ticker,
          candidate: null,
          watchOnly: false,
          skipReason: "OHLCV 데이터를 가져오지 못했습니다.",
        };
      }

      // Trading-halt / delisting guard: a name whose last bar lags the benchmark
      // by 7+ calendar days is effectively 거래정지/관리종목 — never a candidate.
      const lastDate = rows[rows.length - 1]?.날짜;
      const staleGap = benchLastDate && lastDate ? isoDaysBetween(lastDate, benchLastDate) : 0;
      if (staleGap > haltStaleDays) {
        return {
          ticker,
          candidate: null,
          watchOnly: false,
          skipReason: `최근 ${staleGap}일 시세 없음(거래정지·관리종목 가능성) — 제외`,
        };
      }

      const bars = toBars(rows);
      const indicators = buildIndicatorSnapshot(bars);
      if (!indicators) {
        return {
          ticker,
          candidate: null,
          watchOnly: false,
          skipReason: `분석 최소 길이(140봉) 부족: ${bars.length}봉`,
        };
      }

      const detections = [
        { name: "밥그릇 1번자리" as const, result: detectBowlPosition1(bars, indicators) },
        { name: "밥그릇 2번자리" as const, result: detectBowlPosition2(bars, indicators) },
        { name: "밥그릇 패턴" as const, result: detectBowlPattern(bars, indicators) },
        { name: "하이힐 패턴" as const, result: detectHighHeelPattern(bars, indicators) },
        { name: "돌파매매" as const, result: detectBreakoutPattern(bars, indicators) },
        { name: "컵앤핸들" as const, result: detectCupHandlePattern(bars, indicators) },
      ];

      const benchmarkBars = marketFor(ticker) === "코스닥" ? kosdaqBars : kospiBars;
      const confluence = analyzeTechnicalConfluence(bars, benchmarkBars);

      const built = buildCandidate(
        ticker,
        nameFor(ticker),
        indicators,
        detections,
        marketRegime,
        patternWeights,
        confluence,
        qualityOverrides
      );
      return {
        ticker,
        candidate: built?.candidate ?? null,
        watchOnly: built?.watchOnly ?? false,
        skipReason: null,
      };
    },
    6
  );

  const skipped = scanned.filter(item => Boolean(item?.skipReason && !item.candidate)) as Array<{
    ticker: string;
    skipReason: string;
  }>;
  const candidates = scanned
    .filter(item => item?.candidate && !item.watchOnly)
    .map(item => item!.candidate as Candidate)
    .sort((a, b) => b.swingScore - a.swingScore);
  // Watch-only near-misses (passed every hard gate, just below the conviction
  // floor) — surfaced so the daily alert is never silent in a thin/weak tape.
  const watchlist = scanned
    .filter(item => item?.candidate && item.watchOnly)
    .map(item => item!.candidate as Candidate)
    .sort((a, b) => b.swingScore - a.swingScore)
    .slice(0, 3);
  const earlyBowlCandidates = candidates.filter(candidate => hasEarlyBowlPattern(candidate.patterns));
  const rankedCandidates = rankBowlFocusedCandidates(candidates, 5);
  const dataFailureCount = skipped.filter(item => item.skipReason.includes("OHLCV")).length;
  const staleTickerCount = skipped.filter(item => item.skipReason.includes("시세 없음")).length;
  const shortHistoryCount = skipped.filter(item => item.skipReason.includes("140봉")).length;

  // Data-degradation protocol: when the feed is unreliable (benchmark missing or
  // too many fetch failures) we say so explicitly and stop issuing 검토 후보 —
  // survivors are demoted to watch-only, same stance as a RED market state.
  const degradedRatio = Number(process.env.DATA_DEGRADED_RATIO) || 0.2;
  const benchmarkMissing = !kospiRows?.length || !kosdaqRows?.length;
  const degraded =
    benchmarkMissing || (tickers.length > 0 && dataFailureCount / tickers.length > degradedRatio);
  const finalCandidates = degraded ? [] : rankedCandidates;
  const finalWatchlist = degraded ? [...rankedCandidates, ...watchlist].slice(0, 5) : watchlist;
  const skippedSummary = skipped
    .slice(0, 5)
    .map(item => `${nameFor(item.ticker)}: ${item.skipReason}`)
    .join(" | ");

  return {
    bible: buildTechnicalSwingBible(),
    candidates: finalCandidates,
    watchlist: finalWatchlist,
    scannedTickers: tickers,
    dataReliability: {
      scanned: tickers.length,
      dataFailures: dataFailureCount,
      staleTickers: staleTickerCount,
      degraded,
    },
    notes: [
      ...(degraded
        ? [
            `⚠ 데이터 신뢰도 저하: 수집 실패 ${dataFailureCount}/${tickers.length}${benchmarkMissing ? " + 벤치마크 누락" : ""} — 신규 검토 후보 생성 중단(관찰만 제공)`,
          ]
        : []),
      `시장 요약: 코스피 ${kospiRegime.label} / 코스닥 ${kosdaqRegime.label}`,
      `시장 레짐: ${marketRegime.label} (${marketRegime.score}점)`,
      `코스피 레짐: ${kospiRegime.label} (${kospiRegime.score}점)`,
      ...kospiRegime.notes,
      `코스닥 레짐: ${kosdaqRegime.label} (${kosdaqRegime.score}점)`,
      ...kosdaqRegime.notes,
      ...marketRegime.notes,
      `스캔 대상 ${tickers.length}개 중 ${finalCandidates.length}개를 최종 후보로 선정했습니다.`,
      earlyBowlCandidates.length
        ? `밥그릇 1번/2번자리 후보 우선선정: ${earlyBowlCandidates.map(candidate => `${candidate.companyName}(${candidate.ticker})`).join(", ")}`
        : "밥그릇 1번/2번자리 후보 포함: 조건 통과 종목 없음",
      `데이터 수집 실패 ${dataFailureCount}개, 히스토리 부족 ${shortHistoryCount}개, 거래정지 의심 제외 ${staleTickerCount}개`,
      skippedSummary ? `제외 종목 메모: ${skippedSummary}` : "제외 종목 메모: 없음",
      "현재 스캐너는 기술적 스윙 전용이며, 차트·거래량·RSI·이평선만 사용합니다.",
      "밥그릇 1번/2번자리를 우선 랭킹하고, 과열 돌파·하이힐 단일 신호는 강하게 감점합니다.",
      learnedOverrides
        ? `학습 반영: ${path.basename(LEARNED_OVERRIDES_PATH)} (${learnedOverrides.generatedAt})`
        : "학습 반영: 아직 학습 오버라이드가 없어 기본 가중치를 사용합니다.",
      qualityOverrides
        ? `품질 필터 반영: ${path.basename(QUALITY_OVERRIDES_PATH)} (${"generatedAt" in qualityOverrides ? qualityOverrides.generatedAt : "주입"}) / 최소 거래량비 ${qualityOverrides.minVolumeRatio.toFixed(2)}x / RSI 상한 ${qualityOverrides.maxRsi14.toFixed(1)} / 변동성 상한 ${qualityOverrides.maxVolatility20.toFixed(1)}`
        : "품질 필터 반영: 아직 예측 품질 오버라이드가 없어 기본 필터를 사용합니다.",
      "기본 유니버스는 빠른 검증용 핵심 종목군이며, 이후 관심종목/사용자 유니버스로 확장할 수 있습니다.",
      "패턴은 참고용 자동화 규칙이므로, 실제 진입 전 일봉 위치와 거래량 재확인을 권장합니다.",
    ],
  };
}

export async function screenTechnicalSwingCandidates(inputTickers?: string[]): Promise<ScreenerResult> {
  const tickers = inputTickers?.length
    ? inputTickers.filter(isKoreanTicker)
    : await resolveSwingUniverse();
  const rowsByTicker = await fetchKoreanOhlcvRowsBatch(["069500", "229200", ...tickers]);
  return await screenTechnicalSwingCandidatesFromRows(rowsByTicker, tickers);
}
