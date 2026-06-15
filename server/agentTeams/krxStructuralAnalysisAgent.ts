import type { TenbaggerCandidate } from "../tenbaggerPipeline";

export type KrxStructuralAnalysis = {
  ticker: string;
  companyName: string;
  marketStructureScore: number;
  sizeTier: "초소형" | "소형" | "중형" | "대형" | "정보부족";
  liquidityTier: "낮음" | "보통" | "높음" | "매우높음" | "정보부족";
  listingAgeYears?: number;
  structuralTailwinds: string[];
  structuralRisks: string[];
  verdict: string;
};

type AnalyzeKrxStructureInput = Pick<
  TenbaggerCandidate,
  "ticker" | "companyName" | "marketCap" | "tradingValue" | "marketCategory" | "listingDate"
>;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function getListingAgeYears(listingDate?: string) {
  if (!listingDate) {
    return undefined;
  }

  const parsed = new Date(`${listingDate}T00:00:00+09:00`);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }

  const now = new Date();
  const diffMs = now.getTime() - parsed.getTime();
  return Number((diffMs / (365.25 * 24 * 60 * 60 * 1000)).toFixed(1));
}

function classifySizeTier(marketCap?: number): KrxStructuralAnalysis["sizeTier"] {
  if (marketCap === undefined) {
    return "정보부족";
  }
  const marketCapEok = marketCap / 100_000_000;
  if (marketCapEok >= 50_000) {
    return "대형";
  }
  if (marketCapEok >= 10_000) {
    return "중형";
  }
  if (marketCapEok >= 3_000) {
    return "소형";
  }
  return "초소형";
}

function classifyLiquidityTier(tradingValue?: number): KrxStructuralAnalysis["liquidityTier"] {
  if (tradingValue === undefined) {
    return "정보부족";
  }
  const tradingValueEok = tradingValue / 100_000_000;
  if (tradingValueEok >= 1_000) {
    return "매우높음";
  }
  if (tradingValueEok >= 300) {
    return "높음";
  }
  if (tradingValueEok >= 100) {
    return "보통";
  }
  return "낮음";
}

export function analyzeKrxStructure(
  input: AnalyzeKrxStructureInput
): KrxStructuralAnalysis {
  const listingAgeYears = getListingAgeYears(input.listingDate);
  const sizeTier = classifySizeTier(input.marketCap);
  const liquidityTier = classifyLiquidityTier(input.tradingValue);
  const structuralTailwinds: string[] = [];
  const structuralRisks: string[] = [];
  let score = 55;

  if (input.marketCategory === "KOSPI") {
    score += 8;
    structuralTailwinds.push("KOSPI 소속이라 기관 자금 유입과 대형 추세 확장에 유리합니다.");
  } else if (input.marketCategory === "KOSDAQ") {
    score += 4;
    structuralTailwinds.push("KOSDAQ 성장주 성격이라 텐버거 서사가 붙기 쉬운 시장입니다.");
  } else if (input.marketCategory === "KONEX") {
    score -= 10;
    structuralRisks.push("KONEX 소속이라 유동성과 추세 지속성 확인이 더 필요합니다.");
  }

  if (sizeTier === "대형") {
    score += 10;
    structuralTailwinds.push("시가총액이 충분해 장기 자금 수용력이 좋습니다.");
  } else if (sizeTier === "중형") {
    score += 7;
    structuralTailwinds.push("중형 시총 구간으로 추세 확대와 기관 수급의 균형이 좋습니다.");
  } else if (sizeTier === "소형") {
    score += 2;
  } else if (sizeTier === "초소형") {
    score -= 8;
    structuralRisks.push("시가총액이 작아 변동성 주도형으로 흐를 위험이 큽니다.");
  }

  if (liquidityTier === "매우높음") {
    score += 12;
    structuralTailwinds.push("KRX 거래대금이 매우 높아 추세가 길게 이어질 기반이 있습니다.");
  } else if (liquidityTier === "높음") {
    score += 8;
    structuralTailwinds.push("KRX 거래대금이 높아 눌림목 이후 재상승 신뢰가 높습니다.");
  } else if (liquidityTier === "보통") {
    score += 2;
  } else if (liquidityTier === "낮음") {
    score -= 12;
    structuralRisks.push("KRX 거래대금이 낮아 장기 추세가 뉴스 이벤트 의존형일 수 있습니다.");
  }

  if (listingAgeYears !== undefined) {
    if (listingAgeYears >= 8) {
      score += 6;
      structuralTailwinds.push("상장 이력이 길어 사이클을 견딘 기업일 가능성이 높습니다.");
    } else if (listingAgeYears <= 2.5) {
      score -= 6;
      structuralRisks.push("상장 이력이 짧아 시장 검증이 덜 끝났을 수 있습니다.");
    }
  } else {
    structuralRisks.push("상장일 데이터가 없어 기업의 사이클 검증 이력을 판단하기 어렵습니다.");
  }

  if (input.marketCap === undefined) {
    structuralRisks.push("KRX 시가총액 데이터가 없어 구조적 체급 판단이 비어 있습니다.");
  }
  if (input.tradingValue === undefined) {
    structuralRisks.push("KRX 거래대금 데이터가 없어 유동성 판단이 제한적입니다.");
  }

  const marketStructureScore = clamp(Math.round(score), 0, 100);
  const verdict =
    marketStructureScore >= 78
      ? "KRX 구조상 장기 추세를 수용할 체급과 유동성이 충분합니다."
      : marketStructureScore >= 64
        ? "KRX 구조는 무난하지만 텐버거로 보려면 수급 재확인이 더 필요합니다."
        : "KRX 구조 데이터만 보면 아직 텐버거 전개를 강하게 지지하긴 어렵습니다.";

  return {
    ticker: input.ticker,
    companyName: input.companyName,
    marketStructureScore,
    sizeTier,
    liquidityTier,
    listingAgeYears,
    structuralTailwinds,
    structuralRisks,
    verdict,
  };
}
