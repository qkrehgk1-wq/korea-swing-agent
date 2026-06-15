import {
  screenTechnicalSwingCandidates,
  type TechnicalSwingCandidate,
} from "../technicalSwingScreener";
import { isKoreanTicker } from "../koreaStockMcp";

export type KosdaqSwingTeamResult = {
  generatedAt: string;
  candidates: TechnicalSwingCandidate[];
  scannedTickers: string[];
  phaseSummary: string[];
  notes: string[];
};

export const KOSDAQ_SWING_FOCUS_UNIVERSE = [
  "003670",
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
  "251270",
  "215000",
  "064350",
  "058610",
  "357780",
];

function kosdaqFocusScore(candidate: TechnicalSwingCandidate) {
  let score = candidate.swingScore;

  if (candidate.patterns.includes("밥그릇 2번자리")) {
    score += 14;
  }
  if (candidate.patterns.includes("밥그릇 1번자리")) {
    score += 10;
  }
  if (candidate.patterns.includes("돌파매매")) {
    score += 8;
  }
  if (candidate.patterns.includes("컵앤핸들")) {
    score += 6;
  }
  if (candidate.volumeRatio >= 1.1 && candidate.volumeRatio <= 2.8) {
    score += 8;
  }
  if (candidate.rsi14 >= 44 && candidate.rsi14 <= 68) {
    score += 8;
  }
  if (candidate.marketRegimeLabel === "강세") {
    score += 6;
  } else if (candidate.marketRegimeLabel === "약세") {
    score -= 12;
  }
  if (candidate.volatility20 >= 55) {
    score -= 6;
  }

  return score;
}

export function rankKosdaqFocusCandidates(
  candidates: TechnicalSwingCandidate[],
  limit = 5
) {
  return candidates
    .filter(candidate => candidate.market === "코스닥")
    .sort((left, right) => kosdaqFocusScore(right) - kosdaqFocusScore(left) || right.swingScore - left.swingScore)
    .slice(0, limit);
}

export async function runKosdaqSwingTeam(inputTickers?: string[]): Promise<KosdaqSwingTeamResult> {
  const tickers = (inputTickers?.filter(isKoreanTicker) || KOSDAQ_SWING_FOCUS_UNIVERSE).slice(0, 20);
  const swingResult = await screenTechnicalSwingCandidates(tickers);
  const kosdaqCandidates = rankKosdaqFocusCandidates(swingResult.candidates, 5);

  return {
    generatedAt: new Date().toISOString(),
    candidates: kosdaqCandidates,
    scannedTickers: tickers,
    phaseSummary: [
      "Kosdaq Universe Scout: 코스닥 성장주/주도주 중심 유니버스를 별도로 스캔",
      "Kosdaq Pattern Analyst: 밥그릇 1번/2번자리, 돌파, 컵앤핸들 신호를 코스닥 변동성에 맞춰 우선순위화",
      "Kosdaq Volatility Guard: RSI 과열과 과도한 변동성을 감점해 추격형 후보를 억제",
      "Kosdaq Workflow Liaison: 일반 스윙 파이프라인과 중복 종목을 합쳐 최종 리뷰팀으로 전달",
    ],
    notes: [
      `코스닥 전용 팀이 ${tickers.length}개 종목을 별도로 점검했습니다.`,
      `최종 코스닥 전용 후보 ${kosdaqCandidates.length}개를 추렸습니다.`,
      "코스닥 전용 팀은 일반 스윙 스캐너를 재사용하되, 밥그릇 초입과 거래량 회복 신호 가중치를 더 높게 반영합니다.",
      ...swingResult.notes.slice(0, 4),
    ],
  };
}
