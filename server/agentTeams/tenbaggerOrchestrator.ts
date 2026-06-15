import type { CompanyIntelligenceInsight } from "./companyIntelligenceAgent";
import type { TenbaggerCandidate } from "../tenbaggerPipeline";
import {
  analyzeKrxStructure,
  type KrxStructuralAnalysis,
} from "./krxStructuralAnalysisAgent";

export type TenbaggerAgentReview = {
  ticker: string;
  companyName: string;
  validation: "승인" | "보류";
  riskGrade: "A" | "B" | "C" | "D";
  recommendedCapitalPct: number;
  maxDrawdownPct: number;
  reasons: string[];
  blockers: string[];
  krxStructuralAnalysis: KrxStructuralAnalysis;
};

export type TenbaggerAgentTeamReport = {
  generatedAt: string;
  phaseSummary: string[];
  companyInsights: CompanyIntelligenceInsight[];
  approved: TenbaggerAgentReview[];
  rejected: TenbaggerAgentReview[];
  notes: string[];
};

type RunTenbaggerAgentTeamInput = {
  candidates: TenbaggerCandidate[];
  companyInsights?: CompanyIntelligenceInsight[];
  accountRiskPct?: number;
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function riskGrade(candidate: TenbaggerCandidate) {
  if (candidate.maxDrawdown >= -28 && candidate.volumeRatio >= 1 && candidate.return240d >= 120) {
    return "A";
  }
  if (candidate.maxDrawdown >= -35 && candidate.return240d >= 80) {
    return "B";
  }
  if (candidate.maxDrawdown >= -45) {
    return "C";
  }
  return "D";
}

function findCompanyInsight(
  insights: CompanyIntelligenceInsight[],
  ticker: string
) {
  return insights.find(insight => insight.ticker === ticker);
}

function reviewTenbaggerCandidate(
  candidate: TenbaggerCandidate,
  companyInsight: CompanyIntelligenceInsight | undefined,
  accountRiskPct: number
): TenbaggerAgentReview {
  const krxStructuralAnalysis = analyzeKrxStructure(candidate);
  const reasons = [
    `Compounder_Scout: 비대칭 ${candidate.frameworkScore}점 / 텐버거 ${candidate.score}점`,
    `Trend_Architect: 120일 ${candidate.return120d.toFixed(1)}% / 240일 ${candidate.return240d.toFixed(1)}% / 거래량 ${candidate.volumeRatio.toFixed(2)}배`,
    `KRX_Structure_Specialist: 구조 ${krxStructuralAnalysis.marketStructureScore}점 / 체급 ${krxStructuralAnalysis.sizeTier} / 유동성 ${krxStructuralAnalysis.liquidityTier}${krxStructuralAnalysis.listingAgeYears !== undefined ? ` / 상장 ${krxStructuralAnalysis.listingAgeYears.toFixed(1)}년` : ""}`,
  ];
  const blockers: string[] = [];
  const grade = riskGrade(candidate);

  if (candidate.return240d < 80) {
    blockers.push("장기 복리 추세로 보기엔 1년 수익률이 아직 약함");
  }
  if (candidate.volumeRatio < 0.95) {
    blockers.push("거래량이 평균권 아래라 장기 추세 지속 신뢰가 낮음");
  }
  if (candidate.maxDrawdown <= -40) {
    blockers.push("역사적 낙폭이 커서 텐버거 보유 난이도가 높음");
  }
  if (candidate.tradingValue !== undefined && candidate.tradingValue < 20_000_000_000) {
    blockers.push("KRX 거래대금 기준 유동성이 낮아 장기 대형 추세 지속 신뢰가 약함");
  }
  if (krxStructuralAnalysis.marketStructureScore < 60) {
    blockers.push("KRX 구조 데이터 기준 체급·유동성·상장 이력이 텐버거 전개를 충분히 지지하지 못함");
  }
  if (candidate.revenueYoY !== undefined && candidate.revenueYoY < 10) {
    blockers.push("매출 성장률이 텐버거 기대치 대비 약함");
  }
  if (candidate.operatingProfitYoY !== undefined && candidate.operatingProfitYoY < 10) {
    blockers.push("영업이익 성장률이 아직 강하지 않음");
  }
  if (companyInsight) {
    reasons.push(
      `Narrative_Analyst: 뉴스 ${companyInsight.sentimentLabel} / 촉매 ${companyInsight.catalystScore} / 리스크 ${companyInsight.riskScore}`
    );
    if (companyInsight.sentimentLabel === "부정" && companyInsight.riskScore >= companyInsight.catalystScore + 2) {
      blockers.push("외부 뉴스 흐름에서 리스크가 촉매보다 우세");
    }
  } else {
    reasons.push("Narrative_Analyst: 회사 뉴스 인텔리전스 없음");
  }

  if (candidate.revenueYoY === undefined && candidate.operatingProfitYoY === undefined) {
    reasons.push(
      `Fundamental_Archivist: DART 재무 YoY 미연결 상태${candidate.marketCap !== undefined ? ` / KRX 시총 ${(candidate.marketCap / 100_000_000).toFixed(0)}억원` : ""}${candidate.tradingValue !== undefined ? ` / KRX 거래대금 ${(candidate.tradingValue / 100_000_000).toFixed(0)}억원` : ""}${candidate.marketCategory ? ` / 시장 ${candidate.marketCategory}` : ""}`
    );
  } else {
    reasons.push(
      `Fundamental_Archivist: 매출 YoY ${candidate.revenueYoY?.toFixed(1) ?? "N/A"}% / 영업이익 YoY ${candidate.operatingProfitYoY?.toFixed(1) ?? "N/A"}%`
    );
  }

  if (grade === "D") {
    blockers.push("장기 보유 리스크 등급 D");
  }

  const recommendedCapitalPct = blockers.length
    ? 0
    : Number(
        clamp(
          Math.min(accountRiskPct / Math.max(Math.abs(candidate.maxDrawdown), 1) * 100, candidate.score / 8),
          0,
          10
        ).toFixed(1)
      );

  return {
    ticker: candidate.ticker,
    companyName: candidate.companyName,
    validation: blockers.length ? "보류" : "승인",
    riskGrade: grade,
    recommendedCapitalPct,
    maxDrawdownPct: candidate.maxDrawdown,
    reasons,
    blockers,
    krxStructuralAnalysis,
  };
}

export async function runTenbaggerAgentTeamReview({
  candidates,
  companyInsights = [],
  accountRiskPct = 1.5,
}: RunTenbaggerAgentTeamInput): Promise<TenbaggerAgentTeamReport> {
  const reviews = candidates
    .map(candidate =>
      reviewTenbaggerCandidate(
        candidate,
        findCompanyInsight(companyInsights, candidate.ticker),
        accountRiskPct
      )
    )
    .sort((a, b) => {
      if (a.validation !== b.validation) {
        return a.validation === "승인" ? -1 : 1;
      }
      return b.recommendedCapitalPct - a.recommendedCapitalPct;
    });

  return {
    generatedAt: new Date().toISOString(),
    phaseSummary: [
      "Compounder Scout Team: 장기 우상향과 비대칭 성장 점수를 1차 후보로 압축",
      "Fundamental Archivist Team: DART YoY 연결 시 실적 성장 가속 여부를 확인",
      "KRX Structure Specialist Team: 시총, 거래대금, 시장구분, 상장 히스토리로 장기 추세 수용 구조를 판정",
      "Narrative Analyst Team: 뉴스/RSS 촉매와 리스크를 장기 서사 관점에서 정리",
      "Trend Architect Team: 120일/240일 수익률, 거래량, 고점 유지력으로 추세 내구성을 평가",
      "Capital Allocation Team: 최대 낙폭과 계좌 리스크 한도로 권장 비중 상한만 산출",
    ],
    companyInsights,
    approved: reviews.filter(review => review.validation === "승인"),
    rejected: reviews.filter(review => review.validation === "보류"),
    notes: [
      "실거래 주문 기능은 포함하지 않았습니다.",
      `텐버거 전용 에이전트팀의 기본 계좌 리스크 한도는 ${accountRiskPct.toFixed(1)}%입니다.`,
      "DART YoY가 비어 있으면 KRX Structure Specialist가 체급·유동성·상장 이력을 대신 보강합니다.",
    ],
  };
}
