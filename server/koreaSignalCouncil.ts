/**
 * Korea Swing Signal Council — 7-dimension scoring + ACT/PREPARE/WATCH/AVOID.
 *
 * Adapted from the avatar_core Signal Council (scoring.py) to Korean swing
 * trading: instead of scoring news/capital signals, it scores a stock's chart
 * structure, volume, pattern, entry timing, supply/demand, risk, and (when DART
 * data is present) fundamentals. Deterministic and explainable — no LLM here.
 */

import type {
  KoreanStockAnalysisData,
  PriceSnapshot,
} from "./koreaStockMcp";

export type SwingCouncilScore = {
  trendStrength: number; // 1-10  추세 강도 (이평 정렬·수익률)
  volumeConfidence: number; // 1-10  거래량 신뢰 (평균 대비 배수)
  patternClarity: number; // 1-10  패턴 완성도
  entryTiming: number; // 1-10  진입 타점 (눌림목/돌파/과열 회피)
  supplyDemand: number; // 1-10  수급 (외국인·기관 또는 거래량 프록시)
  riskLevel: number; // 1-10  리스크 (높을수록 위험)
  fundamentalBacking: number; // 1-10  펀더멘털 뒷받침 (DART 재무)
};

export type SwingDecision = "ACT" | "PREPARE" | "WATCH" | "AVOID";

export type SwingHorizon = "단기" | "중기" | "장기";

export type SwingCouncilVerdict = {
  score: SwingCouncilScore;
  total: number; // 0-100
  decision: SwingDecision;
  horizon: SwingHorizon;
  summary: string;
  rationale: string[];
};

const HORIZON_HOLD: Record<SwingHorizon, string> = {
  단기: "1~5일",
  중기: "1~4주",
  장기: "1~3개월",
};

/** Classify holding horizon from chart structure + fundamentals (deterministic). */
export function classifyHorizon(
  snapshot: PriceSnapshot,
  patterns: string[],
  data: KoreanStockAnalysisData
): SwingHorizon {
  // 단기: 돌파/거래량 급등/고점 근접 모멘텀
  if (
    patterns.some(p => p.includes("돌파")) ||
    snapshot.volumeRatio >= 2.0 ||
    Math.abs(snapshot.distanceFromHigh) <= 2.5
  ) {
    return "단기";
  }
  // 장기: 60·120일선 정배열 + 120일선 위 + 재무 뒷받침/저변동성
  const longTrend =
    snapshot.ma60 > snapshot.ma120 &&
    snapshot.latestClose > snapshot.ma120 &&
    snapshot.return120d > 0;
  const fin = data.officialFinancials;
  const hasFundamentals = Boolean(
    fin && (((fin.operatingProfit ?? 0) > 0) || ((fin.revenueYoY ?? 0) > 0))
  );
  if (longTrend && (hasFundamentals || snapshot.annualVolatility < 35)) {
    return "장기";
  }
  // 중기: 그 외 (밥그릇/하이힐/눌림목)
  return "중기";
}

const DECISION_LABEL: Record<SwingDecision, string> = {
  ACT: "실행 (분할 진입 후보)",
  PREPARE: "준비 (타점 임박, 관찰 강화)",
  WATCH: "관찰 (조건 미충족)",
  AVOID: "회피 (위험/약세 우위)",
};

function clamp(value: number): number {
  return Math.max(1, Math.min(10, Math.round(value)));
}

function scoreTrend(snapshot: PriceSnapshot): number {
  let score = 4;
  if (snapshot.latestClose > snapshot.ma20) score += 1;
  if (snapshot.ma20 > snapshot.ma60) score += 1;
  if (snapshot.ma60 > snapshot.ma120) score += 1;
  if (snapshot.return20d > 0) score += 1;
  if (snapshot.return60d > 8) score += 1;
  if (snapshot.return20d < -5) score -= 2;
  return clamp(score);
}

function scoreVolume(snapshot: PriceSnapshot): number {
  // 1.0x ≈ neutral; surges raise confidence, droughts lower it.
  return clamp(3 + (snapshot.volumeRatio - 0.8) * 4);
}

function scorePattern(patterns: string[]): number {
  if (patterns.length === 0) return 3;
  let score = 4 + patterns.length * 1.5;
  if (patterns.some(p => p.includes("밥그릇") || p.includes("돌파"))) score += 1;
  return clamp(score);
}

function scoreEntryTiming(snapshot: PriceSnapshot): number {
  let score = 5;
  // Near 20d line from above = good pullback entry.
  const distFromMa20 = ((snapshot.latestClose - snapshot.ma20) / Math.max(snapshot.ma20, 1)) * 100;
  if (distFromMa20 >= 0 && distFromMa20 <= 4) score += 2;
  else if (distFromMa20 > 12) score -= 2; // extended/overheated
  // Breakout proximity to 52w high with room.
  if (Math.abs(snapshot.distanceFromHigh) <= 3) score += 1;
  // Overheated short-term move = worse chase risk.
  if (snapshot.return20d > 35) score -= 2;
  return clamp(score);
}

function scoreSupplyDemand(
  snapshot: PriceSnapshot,
  data: KoreanStockAnalysisData
): number {
  const trading = data.tradingValues.at(-1);
  if (trading && (typeof trading.외국인합계 === "number" || typeof trading.기관합계 === "number")) {
    let score = 5;
    if ((trading.외국인합계 ?? 0) > 0) score += 2;
    if ((trading.기관합계 ?? 0) > 0) score += 2;
    if ((trading.외국인합계 ?? 0) < 0 && (trading.기관합계 ?? 0) < 0) score -= 2;
    return clamp(score);
  }
  // No supply data → proxy with volume surge.
  return clamp(4 + (snapshot.volumeRatio - 1) * 3);
}

function scoreRisk(snapshot: PriceSnapshot): number {
  let score = 3;
  if (snapshot.annualVolatility > 60) score += 3;
  else if (snapshot.annualVolatility > 40) score += 2;
  else if (snapshot.annualVolatility > 25) score += 1;
  if (snapshot.maxDrawdown < -45) score += 2;
  else if (snapshot.maxDrawdown < -30) score += 1;
  if (snapshot.return20d < -10) score += 1;
  return clamp(score);
}

function scoreFundamentals(data: KoreanStockAnalysisData): number {
  const fin = data.officialFinancials;
  if (!fin) return 5; // neutral when DART data is unavailable
  let score = 5;
  if ((fin.operatingProfit ?? 0) > 0) score += 1;
  if ((fin.netIncome ?? 0) > 0) score += 1;
  if ((fin.operatingProfitYoY ?? 0) > 0) score += 1;
  if ((fin.revenueYoY ?? 0) > 0) score += 1;
  if ((fin.netIncome ?? 0) < 0) score -= 2;
  return clamp(score);
}

export function scoreSwingSignal(
  snapshot: PriceSnapshot,
  patterns: string[],
  data: KoreanStockAnalysisData
): SwingCouncilScore {
  return {
    trendStrength: scoreTrend(snapshot),
    volumeConfidence: scoreVolume(snapshot),
    patternClarity: scorePattern(patterns),
    entryTiming: scoreEntryTiming(snapshot),
    supplyDemand: scoreSupplyDemand(snapshot, data),
    riskLevel: scoreRisk(snapshot),
    fundamentalBacking: scoreFundamentals(data),
  };
}

/** Weighted 0-100 total. Risk is subtracted as a penalty. */
export function totalSwingScore(score: SwingCouncilScore): number {
  const positive =
    score.trendStrength * 1.3 +
    score.volumeConfidence * 1.0 +
    score.patternClarity * 1.1 +
    score.entryTiming * 1.3 +
    score.supplyDemand * 1.0 +
    score.fundamentalBacking * 0.8;
  const maxPositive = (1.3 + 1.0 + 1.1 + 1.3 + 1.0 + 0.8) * 10; // 65
  const riskPenalty = score.riskLevel * 1.5; // up to 15
  const raw = (positive - riskPenalty) / maxPositive; // ~ -0.23 .. 1.0
  return Math.max(0, Math.min(100, Math.round(raw * 100)));
}

export function decideSwing(score: SwingCouncilScore): SwingDecision {
  const total = totalSwingScore(score);
  if (score.riskLevel >= 8 && score.trendStrength <= 4) return "AVOID";
  if (total >= 72 && score.entryTiming >= 7 && score.riskLevel <= 6) return "ACT";
  if (total >= 58) return "PREPARE";
  if (total >= 44) return "WATCH";
  return "AVOID";
}

export function buildSwingVerdict(
  snapshot: PriceSnapshot,
  patterns: string[],
  data: KoreanStockAnalysisData
): SwingCouncilVerdict {
  const score = scoreSwingSignal(snapshot, patterns, data);
  const total = totalSwingScore(score);
  const decision = decideSwing(score);

  const rationale: string[] = [];
  if (score.trendStrength >= 7) rationale.push("이평선 정렬과 수익률이 추세 강세를 지지");
  else if (score.trendStrength <= 4) rationale.push("추세가 약해 반등을 추세전환으로 오인할 위험");
  if (score.volumeConfidence >= 7) rationale.push("거래량 동반으로 수급 변화 신뢰도 양호");
  if (score.entryTiming >= 7) rationale.push("눌림목/돌파 등 진입 타점이 유리한 구간");
  else if (score.entryTiming <= 4) rationale.push("과열 또는 타점 이탈로 추격 위험");
  if (score.riskLevel >= 7) rationale.push("변동성·낙폭이 커 비중 관리 필수");
  if (data.officialFinancials && score.fundamentalBacking >= 7)
    rationale.push("DART 재무가 흑자/성장으로 뒷받침");

  const horizon = classifyHorizon(snapshot, patterns, data);
  const summary = `${horizon}(${HORIZON_HOLD[horizon]}) · 총점 ${total}/100 · 결정 ${decision}(${DECISION_LABEL[decision]}) · 추세 ${score.trendStrength} 거래량 ${score.volumeConfidence} 패턴 ${score.patternClarity} 타점 ${score.entryTiming} 수급 ${score.supplyDemand} 리스크 ${score.riskLevel} 펀더멘털 ${score.fundamentalBacking}`;

  return { score, total, decision, horizon, summary, rationale };
}
