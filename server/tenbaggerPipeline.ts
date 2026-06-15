import "dotenv/config";

import {
  buildKoreanAnalyses,
  fetchKoreanStockAnalysisData,
  fetchKoreanStockAnalysisDataBatch,
  type KoreanStockKrxProfile,
  type OhlcvRow,
} from "./koreaStockMcp";
import { collectCompanyIntelligence } from "./agentTeams/companyIntelligenceAgent";
import { runTenbaggerAgentTeamReview } from "./agentTeams/tenbaggerOrchestrator";
import { persistTenbaggerWatchlistMemory } from "./agentTeams/tenbaggerWatchlistMemory";

export type TenbaggerCandidate = {
  ticker: string;
  companyName: string;
  score: number;
  frameworkScore: number;
  fit: "상" | "중" | "관찰";
  currentPrice: number;
  return240d: number;
  return120d: number;
  volumeRatio: number;
  marketCap?: number;
  tradingValue?: number;
  marketCategory?: KoreanStockKrxProfile["marketCategory"];
  listingDate?: string;
  revenueYoY?: number;
  operatingProfitYoY?: number;
  maxDrawdown: number;
  reasons: string[];
};

type TenbaggerScanResult = {
  candidates: TenbaggerCandidate[];
  scannedTickers: string[];
  notes: string[];
};

type Snapshot = {
  currentPrice: number;
  return120d: number;
  return240d: number;
  ma20: number;
  ma60: number;
  ma120: number;
  volumeRatio: number;
  annualHigh: number;
  maxDrawdown: number;
};

const DEFAULT_TENBAGGER_UNIVERSE = [
  "042700",
  "214150",
  "247540",
  "086520",
  "196170",
  "277810",
  "141080",
  "348370",
  "240810",
  "058470",
  "012450",
  "034020",
  "064350",
  "042660",
  "003670",
  "028300",
  "145020",
  "112040",
  "329180",
  "251270",
];

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

function getRowAtDistance<T>(rows: T[], distance: number) {
  return rows[Math.max(0, rows.length - 1 - distance)];
}

function calculateSnapshot(rows: OhlcvRow[]): Snapshot | null {
  if (rows.length < 140) {
    return null;
  }

  const closes = rows.map(row => row.종가);
  const volumes = rows.map(row => row.거래량);
  const latest = rows[rows.length - 1];
  let peak = closes[0];
  let worstDrawdown = 0;

  for (const close of closes) {
    peak = Math.max(peak, close);
    worstDrawdown = Math.min(worstDrawdown, (close - peak) / peak);
  }

  return {
    currentPrice: latest.종가,
    return120d: percentChange(getRowAtDistance(rows, 120)?.종가 ?? rows[0].종가, latest.종가),
    return240d: percentChange(getRowAtDistance(rows, 240)?.종가 ?? rows[0].종가, latest.종가),
    ma20: average(closes.slice(-20)),
    ma60: average(closes.slice(-60)),
    ma120: average(closes.slice(-120)),
    volumeRatio: latest.거래량 / Math.max(average(volumes.slice(-20)), 1),
    annualHigh: Math.max(...closes),
    maxDrawdown: worstDrawdown * 100,
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function buildTenbaggerCandidate(
  ticker: string,
  companyName: string,
  rows: OhlcvRow[],
  frameworkScore: number,
  opportunities: string[],
  marketContext?: {
    marketCap?: number;
    tradingValue?: number;
    marketCategory?: KoreanStockKrxProfile["marketCategory"];
    listingDate?: string;
  },
  officialFinancials?: {
    revenueYoY?: number;
    operatingProfitYoY?: number;
  } | null
): TenbaggerCandidate | null {
  const snapshot = calculateSnapshot(rows);
  if (!snapshot) {
    return null;
  }

  const reasons: string[] = [];
  let score = frameworkScore * 0.45;
  const strongTrend =
    snapshot.currentPrice > snapshot.ma20 &&
    snapshot.ma20 > snapshot.ma60 &&
    snapshot.ma60 > snapshot.ma120;
  const nearHigh = snapshot.currentPrice >= snapshot.annualHigh * 0.88;

  if (strongTrend) {
    score += 18;
    reasons.push("20일선 > 60일선 > 120일선 정배열");
  }
  if (snapshot.return240d >= 80) {
    score += Math.min(22, snapshot.return240d / 18);
    reasons.push(`1년 수익률 ${snapshot.return240d.toFixed(1)}%`);
  } else if (snapshot.return240d >= 40) {
    score += 8;
    reasons.push(`장기 상승률 ${snapshot.return240d.toFixed(1)}%`);
  } else {
    score -= 8;
  }
  if (snapshot.return120d >= 20) {
    score += Math.min(10, snapshot.return120d / 12);
  }
  if (snapshot.volumeRatio >= 1.0 && snapshot.volumeRatio <= 2.8) {
    score += 8;
    reasons.push(`거래량 ${snapshot.volumeRatio.toFixed(2)}배`);
  }
  if (nearHigh) {
    score += 8;
    reasons.push("연중 고점권에서 추세 유지");
  }
  if (snapshot.maxDrawdown >= -30) {
    score += 4;
  } else if (snapshot.maxDrawdown <= -55) {
    score -= 8;
  }

  if (officialFinancials?.revenueYoY !== undefined) {
    if (officialFinancials.revenueYoY >= 15) {
      score += Math.min(8, officialFinancials.revenueYoY / 5);
      reasons.push(`매출 YoY ${officialFinancials.revenueYoY.toFixed(1)}%`);
    } else if (officialFinancials.revenueYoY < 0) {
      score -= 8;
    }
  } else {
    reasons.push("DART 재무 YoY 없음");
  }

  if (officialFinancials?.operatingProfitYoY !== undefined) {
    if (officialFinancials.operatingProfitYoY >= 20) {
      score += Math.min(10, officialFinancials.operatingProfitYoY / 6);
      reasons.push(`영업이익 YoY ${officialFinancials.operatingProfitYoY.toFixed(1)}%`);
    } else if (officialFinancials.operatingProfitYoY < 0) {
      score -= 10;
    }
  }

  if (opportunities.length) {
    reasons.push(opportunities[0]);
  }

  if (marketContext?.marketCap !== undefined) {
    const marketCapEok = marketContext.marketCap / 100_000_000;
    reasons.push(`KRX 시총 ${marketCapEok.toFixed(0)}억원`);
    if (marketCapEok >= 5000) {
      score += 4;
    }
  }

  if (marketContext?.tradingValue !== undefined) {
    const tradingValueEok = marketContext.tradingValue / 100_000_000;
    reasons.push(`KRX 거래대금 ${tradingValueEok.toFixed(0)}억원`);
    if (tradingValueEok >= 300) {
      score += 3;
    }
  }

  const finalScore = clamp(Math.round(score), 0, 100);
  if (finalScore < 58) {
    return null;
  }

  return {
    ticker,
    companyName,
    score: finalScore,
    frameworkScore,
    fit: finalScore >= 78 ? "상" : finalScore >= 66 ? "중" : "관찰",
    currentPrice: snapshot.currentPrice,
    return240d: Number(snapshot.return240d.toFixed(1)),
    return120d: Number(snapshot.return120d.toFixed(1)),
    volumeRatio: Number(snapshot.volumeRatio.toFixed(2)),
    marketCap: marketContext?.marketCap,
    tradingValue: marketContext?.tradingValue,
    marketCategory: marketContext?.marketCategory,
    listingDate: marketContext?.listingDate,
    revenueYoY: officialFinancials?.revenueYoY !== undefined
      ? Number(officialFinancials.revenueYoY.toFixed(1))
      : undefined,
    operatingProfitYoY: officialFinancials?.operatingProfitYoY !== undefined
      ? Number(officialFinancials.operatingProfitYoY.toFixed(1))
      : undefined,
    maxDrawdown: Number(snapshot.maxDrawdown.toFixed(1)),
    reasons,
  };
}

export async function screenTenbaggerCandidates(
  inputTickers?: string[]
): Promise<TenbaggerScanResult> {
  const tickers = (inputTickers?.length ? inputTickers : DEFAULT_TENBAGGER_UNIVERSE).slice(0, 20);
  const candidates: TenbaggerCandidate[] = [];
  const notes: string[] = [];
  let dataFailures = 0;
  const batchData = await fetchKoreanStockAnalysisDataBatch(tickers);

  for (const ticker of tickers) {
    const data = batchData[ticker] ?? (await fetchKoreanStockAnalysisData(ticker));
    if (!data?.ohlcvRows?.length) {
      dataFailures += 1;
      continue;
    }

    const analysis = buildKoreanAnalyses(ticker, data);
    const latestMarketCap = data.marketCaps.at(-1);
    const candidate = buildTenbaggerCandidate(
      ticker,
      analysis.companyName,
      data.ohlcvRows,
      analysis.framework.asymmetricGrowthScore,
      analysis.framework.asymmetricOpportunities,
      {
        marketCap: latestMarketCap?.시가총액,
        tradingValue: latestMarketCap?.거래대금,
        marketCategory: data.krxProfile?.marketCategory ?? data.krxProfile?.market,
        listingDate: data.krxProfile?.listingDate,
      },
      data.officialFinancials
    );

    if (candidate) {
      candidates.push(candidate);
    }
  }

  const ranked = candidates.sort((a, b) => b.score - a.score).slice(0, 5);

  notes.push(`텐버거 유니버스 ${tickers.length}개 중 ${ranked.length}개를 상위 후보로 선정했습니다.`);
  notes.push(`데이터 확보 실패 ${dataFailures}개`);
  notes.push("현재 스캐너는 한국 성장주 유니버스와 가격 구조, 비대칭 성장 점수, 선택적 뉴스 인텔리전스를 사용합니다.");

  return {
    candidates: ranked,
    scannedTickers: tickers,
    notes,
  };
}

async function runTenbaggerPipeline() {
  console.log("[Tenbagger Pipeline] Starting candidate scan...");

  try {
    const result = await screenTenbaggerCandidates();
    console.log(
      `[Tenbagger Pipeline] Scanned ${result.scannedTickers.length} tickers, matched ${result.candidates.length} candidates`
    );

    if (!result.candidates.length) {
      console.log("[Tenbagger Pipeline] No qualified candidates");
      for (const note of result.notes) {
        console.log(`[Tenbagger Pipeline] ${note}`);
      }
      process.exitCode = 0;
      return;
    }

    const companyInsights = await collectCompanyIntelligence(
      result.candidates.map(candidate => ({
        ticker: candidate.ticker,
        companyName: candidate.companyName,
      }))
    );
    const teamReport = await runTenbaggerAgentTeamReview({
      candidates: result.candidates,
      companyInsights,
      accountRiskPct: 1.5,
    });
    const watchlistMemory = await persistTenbaggerWatchlistMemory(result.candidates, teamReport);
    console.log(
      `[Tenbagger Pipeline] Agent team approved ${teamReport.approved.length}, held ${teamReport.rejected.length}`
    );
    console.log(
      `[Tenbagger Pipeline] Watchlist memory updated with ${watchlistMemory.entries.length} tracked names`
    );
    if (watchlistMemory.changes.length) {
      console.log(
        `[Tenbagger Pipeline] Watchlist deltas: ${watchlistMemory.changes
          .map(change => `${change.companyName}(${change.ticker}) ${change.summary}`)
          .join(" || ")}`
      );
    } else {
      console.log("[Tenbagger Pipeline] Watchlist deltas: no state changes");
    }

    for (let index = 0; index < result.candidates.length; index += 1) {
      const candidate = result.candidates[index];
      const review =
        [...teamReport.approved, ...teamReport.rejected].find(item => item.ticker === candidate.ticker);
      const insight = companyInsights.find(item => item.ticker === candidate.ticker);
      console.log(
        [
          `[Tenbagger Pipeline] ${index + 1}. ${candidate.companyName} (${candidate.ticker})`,
          `점수 ${candidate.score} / 적합도 ${candidate.fit}`,
          `현재가 ${candidate.currentPrice.toLocaleString("ko-KR")}원 / 120일 ${candidate.return120d}% / 240일 ${candidate.return240d}%`,
          `거래량 ${candidate.volumeRatio}배 / 최대낙폭 ${candidate.maxDrawdown}%`,
          `근거: ${candidate.reasons.join(" | ")}${insight ? ` | 뉴스 ${insight.sentimentLabel} / 촉매 ${insight.catalystScore} / 리스크 ${insight.riskScore}` : ""}`,
          review
            ? `에이전트팀: ${review.validation} / 등급 ${review.riskGrade} / 권장상한 ${review.recommendedCapitalPct.toFixed(1)}% / 사유 ${review.reasons.join(" | ")}${review.blockers.length ? ` / 보류요인 ${review.blockers.join(" | ")}` : ""}`
            : "에이전트팀: 검토 결과 없음",
          review
            ? `재평가 조건: ${watchlistMemory.entries.find(item => item.ticker === candidate.ticker)?.recheckTriggers.join(" | ") ?? "없음"}`
            : "재평가 조건: 없음",
        ].join("\n")
      );
    }

    process.exitCode = 0;
    return;
  } catch (error) {
    console.error("[Tenbagger Pipeline] Fatal error:", error);
    process.exitCode = 1;
  }
}

runTenbaggerPipeline();
