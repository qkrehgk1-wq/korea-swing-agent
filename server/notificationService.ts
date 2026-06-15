/**
 * Notification Service for Owner Alerts
 * Sends notifications when analysis is complete or important events occur
 */

import { notifyOwner } from "./_core/notification";
import { sendKakaoMemo } from "./_core/kakaoNotification";
import { sendTelegramMessage } from "./_core/telegramNotification";
import { ENV } from "./_core/env";
import type { ExternalPlatformReport } from "./agentTeams/externalPlatformIntegrationAgent";
import type { AgentTeamCandidateReview, AgentTeamReport } from "./agentTeams/orchestrator";

interface AnalysisNotification {
  ticker: string;
  asymmetricGrowthScore: number;
  investmentInsight: string;
  framework: Record<string, unknown>;
}

type SwingCandidate = {
  ticker: string;
  companyName: string;
  market: "코스피" | "코스닥";
  swingScore: number;
  swingFit?: "상" | "중" | "관찰";
  patterns: string[];
  currentPrice: number;
  triggerPrice: number;
  stopLossPrice: number;
  volumeRatio?: number;
  rsi14?: number;
  reason?: string[];
};

type LimitUpPredictionCandidate = {
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

type FirstLimitUpFollowThroughCandidate = {
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

type NotificationDeliveryResult = {
  owner: boolean;
  telegram: boolean;
  kakao: boolean;
  anyDelivered: boolean;
  primaryDelivered: boolean;
  failedChannels: string[];
};

const SWING_PATTERN_ORDER = [
  "밥그릇 1번자리",
  "밥그릇 2번자리",
  "밥그릇 패턴",
  "하이힐 패턴",
  "돌파매매",
  "컵앤핸들",
];

type RecommendationEntry = {
  ticker: string;
  companyName: string;
  market: "코스피" | "코스닥";
  source: "스윙" | "상한가 예측" | "상한가 후속";
  score: number;
  workflowScore: number;
  fitLabel: string;
  currentPrice: number;
  triggerPrice: number;
  stopLossPrice: number;
  keyPatternReason: string;
  riskStatus: string;
  elliottFractalStatus?: string;
  danteAlignment?: string;
  externalStatus?: string;
  failureCause?: string;
};

function findAgentReview(report: AgentTeamReport | undefined, ticker: string) {
  if (!report) {
    return undefined;
  }

  return [...report.approved, ...report.rejected].find(item => item.ticker === ticker);
}

function extractDanteAlignment(review: AgentTeamCandidateReview | undefined) {
  return review?.reasons.find(reason => reason.startsWith("Dante_Strategy_Extractor:"));
}

function extractElliottFractalStatus(review: AgentTeamCandidateReview | undefined) {
  return review?.reasons.find(reason => reason.startsWith("Elliott_Fractal_Agent:"));
}

function buildExternalStatus(
  report: ExternalPlatformReport | undefined,
  ticker: string
) {
  if (!report) {
    return undefined;
  }

  const matched = report.insights.filter(insight => insight.ticker === ticker).slice(0, 2);
  if (matched.length) {
    return matched
      .map(insight => `${insight.source} ${insight.label} ${insight.score}점`)
      .join(" / ");
  }

  return report.enabled.length ? `활성 통합 ${report.enabled.join(", ")} 내 개별 종목 신호 없음` : "활성 외부 통합 없음";
}

function buildRiskStatus(review: AgentTeamCandidateReview | undefined) {
  if (!review) {
    return "에이전트팀 리스크 검토 없음";
  }

  return `${review.validation} / 워크플로우 ${review.workflowScore}점 / 합의 ${review.agreementScore}점 / 등급 ${review.riskGrade} / 권장비중 ${review.recommendedCapitalPct.toFixed(1)}% / 손절폭 ${review.maxLossPct.toFixed(1)}%`;
}

function buildFailureCause(review: AgentTeamCandidateReview | undefined) {
  if (!review?.blockers.length) {
    return undefined;
  }

  return review.blockers.join(" / ");
}

function buildTopRecommendationEntries(
  swingCandidates: SwingCandidate[],
  limitUpCandidates: LimitUpPredictionCandidate[],
  firstLimitUpCandidates: FirstLimitUpFollowThroughCandidate[],
  externalPlatformReport?: ExternalPlatformReport,
  agentTeamReport?: AgentTeamReport
): RecommendationEntry[] {
  const entries: RecommendationEntry[] = [];

  for (const candidate of swingCandidates) {
    const review = findAgentReview(agentTeamReport, candidate.ticker);
    entries.push({
      ticker: candidate.ticker,
      companyName: candidate.companyName,
      market: candidate.market,
      source: "스윙",
      score: candidate.swingScore,
      workflowScore: review?.workflowScore ?? candidate.swingScore,
      fitLabel: candidate.swingFit ?? "관찰",
      currentPrice: candidate.currentPrice,
      triggerPrice: candidate.triggerPrice,
      stopLossPrice: candidate.stopLossPrice,
      keyPatternReason: `${candidate.patterns.join(", ")} / ${candidate.reason?.[0] ?? "차트 정렬 양호"}`,
      riskStatus: buildRiskStatus(review),
      elliottFractalStatus: extractElliottFractalStatus(review),
      danteAlignment: extractDanteAlignment(review),
      externalStatus: buildExternalStatus(externalPlatformReport, candidate.ticker),
      failureCause: buildFailureCause(review),
    });
  }

  for (const candidate of limitUpCandidates) {
    const review = findAgentReview(agentTeamReport, candidate.ticker);
    entries.push({
      ticker: candidate.ticker,
      companyName: candidate.companyName,
      market: candidate.market,
      source: "상한가 예측",
      score: candidate.limitUpScore,
      workflowScore: review?.workflowScore ?? candidate.limitUpScore,
      fitLabel: candidate.limitUpFit,
      currentPrice: candidate.currentPrice,
      triggerPrice: candidate.triggerPrice,
      stopLossPrice: candidate.stopLossPrice,
      keyPatternReason: `${candidate.setup.join(", ")} / ${candidate.reason[0] ?? "바닥권 거래량 점화"}`,
      riskStatus: buildRiskStatus(review),
      elliottFractalStatus: extractElliottFractalStatus(review),
      danteAlignment: extractDanteAlignment(review),
      externalStatus: buildExternalStatus(externalPlatformReport, candidate.ticker),
      failureCause: buildFailureCause(review),
    });
  }

  for (const candidate of firstLimitUpCandidates) {
    const review = findAgentReview(agentTeamReport, candidate.ticker);
    entries.push({
      ticker: candidate.ticker,
      companyName: candidate.companyName,
      market: candidate.market,
      source: "상한가 후속",
      score: candidate.firstLimitUpScore,
      workflowScore: review?.workflowScore ?? candidate.firstLimitUpScore,
      fitLabel: candidate.strategy,
      currentPrice: candidate.currentPrice,
      triggerPrice: candidate.triggerPrice,
      stopLossPrice: candidate.stopLossPrice,
      keyPatternReason: `${candidate.setup.join(", ")} / ${candidate.reason[0] ?? "상한가 후속 패턴"}`,
      riskStatus: buildRiskStatus(review),
      elliottFractalStatus: extractElliottFractalStatus(review),
      danteAlignment: extractDanteAlignment(review),
      externalStatus: buildExternalStatus(externalPlatformReport, candidate.ticker),
      failureCause: buildFailureCause(review),
    });
  }

  return entries
    .sort((a, b) => {
      const aReview = agentTeamReport ? findAgentReview(agentTeamReport, a.ticker) : undefined;
      const bReview = agentTeamReport ? findAgentReview(agentTeamReport, b.ticker) : undefined;
      if ((aReview?.validation ?? "보류") !== (bReview?.validation ?? "보류")) {
        return (aReview?.validation === "승인" ? -1 : 1) - (bReview?.validation === "승인" ? -1 : 1);
      }
      if (a.workflowScore !== b.workflowScore) {
        return b.workflowScore - a.workflowScore;
      }
      return b.score - a.score;
    })
    .slice(0, 5);
}

function formatTopRecommendation(entry: RecommendationEntry, index: number) {
  return [
    `${index + 1}. ${entry.companyName} (${entry.ticker}, ${entry.market})`,
    `분류: ${entry.source} / 점수 ${entry.score}점 / 워크플로우 ${entry.workflowScore}점 / 상태 ${entry.fitLabel}`,
    `현재가: ${entry.currentPrice.toLocaleString("ko-KR")}원`,
    `트리거가: ${entry.triggerPrice.toLocaleString("ko-KR")}원`,
    `손절가: ${entry.stopLossPrice.toLocaleString("ko-KR")}원`,
    `핵심 패턴 사유: ${entry.keyPatternReason}`,
    `엘리엇/프랙털: ${entry.elliottFractalStatus ?? "파동/프랙털 데이터 없음"}`,
    `단테 정합: ${entry.danteAlignment ?? "학습 규칙 정합 데이터 없음"}`,
    `외부 플랫폼 상태: ${entry.externalStatus ?? "외부 플랫폼 데이터 없음"}`,
    `리스크 상태: ${entry.riskStatus}`,
    `실패/보류 사유: ${entry.failureCause ?? "없음"}`,
  ].join("\n");
}

function formatLimitUpCandidate(candidate: LimitUpPredictionCandidate, index: number) {
  return [
    `${index + 1}. ${candidate.companyName} (${candidate.ticker})`,
    `상한가점수: ${candidate.limitUpScore}점 / 적합도 ${candidate.limitUpFit}`,
    `현재가: ${candidate.currentPrice.toLocaleString("ko-KR")}원`,
    `상한가 추정: ${candidate.estimatedLimitPrice.toLocaleString("ko-KR")}원`,
    `트리거: ${candidate.triggerPrice.toLocaleString("ko-KR")}원`,
    `손절: ${candidate.stopLossPrice.toLocaleString("ko-KR")}원`,
    `당일등락: ${candidate.dayReturn.toFixed(1)}% / 거래량비: ${candidate.volumeRatio.toFixed(2)}x / 3일펄스: ${candidate.turnoverPulse.toFixed(2)}x`,
    `RSI14: ${candidate.rsi14.toFixed(1)}`,
    `셋업: ${candidate.setup.join(", ")}`,
    `근거: ${candidate.reason.join(" | ")}`,
  ].join("\n");
}

function formatFirstLimitUpCandidate(candidate: FirstLimitUpFollowThroughCandidate, index: number) {
  return [
    `${index + 1}. ${candidate.companyName} (${candidate.ticker})`,
    `전략: ${candidate.strategy} / 점수 ${candidate.firstLimitUpScore}점`,
    `기준 상한가일: ${candidate.firstLimitUpDate} / 경과 ${candidate.daysSinceFirstLimitUp}거래일`,
    `기준 상한가 종가 대비: ${candidate.pullbackPct.toFixed(1)}%`,
    `현재가: ${candidate.currentPrice.toLocaleString("ko-KR")}원`,
    `트리거: ${candidate.triggerPrice.toLocaleString("ko-KR")}원`,
    `손절: ${candidate.stopLossPrice.toLocaleString("ko-KR")}원`,
    `거래량비: ${candidate.volumeRatio.toFixed(2)}x / 3일펄스: ${candidate.turnoverPulse.toFixed(2)}x / RSI14: ${candidate.rsi14.toFixed(1)}`,
    `셋업: ${candidate.setup.join(", ")}`,
    `근거: ${candidate.reason.join(" | ")}`,
  ].join("\n");
}

function formatSwingCandidate(candidate: SwingCandidate, index: number) {
  const lines = [
    `${index + 1}. ${candidate.companyName} (${candidate.ticker})`,
    `점수: ${candidate.swingScore}점${candidate.swingFit ? ` / 매매적합도 ${candidate.swingFit}` : ""}`,
    `패턴: ${candidate.patterns.join(", ")}`,
    `현재가: ${candidate.currentPrice.toLocaleString("ko-KR")}원`,
    `트리거: ${candidate.triggerPrice.toLocaleString("ko-KR")}원`,
    `손절: ${candidate.stopLossPrice.toLocaleString("ko-KR")}원`,
  ];

  if (candidate.volumeRatio !== undefined) {
    lines.push(`거래량비: ${candidate.volumeRatio.toFixed(2)}x`);
  }

  if (candidate.rsi14 !== undefined) {
    lines.push(`RSI14: ${candidate.rsi14.toFixed(1)}`);
  }

  if (candidate.reason?.length) {
    lines.push(`근거: ${candidate.reason.join(" | ")}`);
  }

  return lines.join("\n");
}

function formatAgentTeamReport(report: AgentTeamReport) {
  const intelligenceLines = report.companyInsights.length
    ? report.companyInsights
        .slice(0, 5)
        .map(
          insight =>
            `${insight.companyName} (${insight.ticker}) / ${insight.sentimentLabel} / 촉매 ${insight.catalystScore} / 리스크 ${insight.riskScore}: ${insight.summary[0]}`
        )
    : ["회사 자료/뉴스 분석 결과 없음"];
  const danteLearningLines = report.danteLearning?.rules.length
    ? [
        `채널: ${report.danteLearning.channelName}`,
        `학습 소스: 최근 공개 영상 ${report.danteLearning.sources.length}개`,
        ...report.danteLearning.rules.slice(0, 5).map(
          rule =>
            `${rule.label} / 신뢰 ${rule.confidence} / 근거 ${rule.evidenceCount}건: ${rule.summary}`
        ),
      ]
    : ["유튜브 학습 결과 없음 또는 접근 가능한 규칙 부족"];
  const elliottLines = report.elliottFractalInsights?.length
    ? report.elliottFractalInsights
        .slice(0, 5)
        .map(
          insight =>
            `${insight.companyName} (${insight.ticker}) / ${insight.label} / 점수 ${insight.score} / 파동 ${insight.waveCountEstimate} / 프랙털 ${insight.fractalCompressionScore}`
        )
    : ["엘리엇/프랙털 분석 결과 없음"];
  const approvedLines = report.approved.length
    ? report.approved
        .slice(0, 5)
        .map(
          (item, index) =>
            `${index + 1}. ${item.companyName} (${item.ticker}) / ${item.source} / 리스크 ${item.riskGrade} / 권장상한 ${item.recommendedCapitalPct.toFixed(1)}% / 손절폭 ${item.maxLossPct.toFixed(1)}%`
        )
    : ["승인 후보 없음"];
  const rejectedLines = report.rejected.length
    ? report.rejected
        .slice(0, 5)
        .map(
          item =>
            `${item.companyName} (${item.ticker}) 보류: ${item.blockers.join(" / ") || "Red_Teamer 보수 필터"}`
        )
    : ["보류 후보 없음"];

  return [
    "에이전트팀 검토",
    ...report.phaseSummary,
    "",
    "회사 자료/뉴스 분석",
    ...intelligenceLines,
    "",
    "엘리엇/프랙털 분석",
    ...elliottLines,
    "",
    "유튜브 차트 학습",
    ...danteLearningLines,
    "",
    "승인 후보",
    ...approvedLines,
    "",
    "보류 후보",
    ...rejectedLines,
    "",
    ...report.notes,
  ].join("\n");
}

function formatExternalPlatformReport(report: ExternalPlatformReport) {
  const enabled = report.enabled.length ? report.enabled.join(", ") : "없음";
  const insightLines = report.insights.length
    ? report.insights
        .slice(0, 5)
        .map(
          insight =>
            `${insight.source} / ${insight.label} / ${insight.score}점${insight.ticker ? ` / ${insight.companyName ?? insight.ticker}(${insight.ticker})` : ""}: ${insight.summary}`
        )
    : ["활성화된 외부 인사이트 없음"];
  const disabledLines = report.disabled.length
    ? report.disabled.slice(0, 3)
    : ["비활성 통합 없음"];

  return [
    "외부 플랫폼 인텔리전스",
    `활성 통합: ${enabled}`,
    ...insightLines,
    "",
    "비활성/대기",
    ...disabledLines,
    ...report.notes,
  ].join("\n");
}

function groupSwingCandidatesByMarket(candidates: SwingCandidate[]) {
  const kospi: SwingCandidate[] = [];
  const kosdaq: SwingCandidate[] = [];

  for (const candidate of candidates) {
    if (candidate.market === "코스닥") {
      kosdaq.push(candidate);
    } else {
      kospi.push(candidate);
    }
  }

  return { kospi, kosdaq };
}

async function deliverMultiChannelNotification(
  title: string,
  content: string
): Promise<NotificationDeliveryResult> {
  const ownerConfigured = Boolean(ENV.forgeApiUrl && ENV.forgeApiKey);
  const telegramConfigured = Boolean(ENV.telegramBotToken && ENV.telegramChatId);
  const kakaoConfigured = Boolean(
    ENV.kakaoRestApiKey && (ENV.kakaoRefreshToken || ENV.kakaoAccessToken)
  );

  const [ownerResult, telegramResult, kakaoResult] = await Promise.allSettled([
    ownerConfigured ? notifyOwner({ title, content }) : Promise.resolve(false),
    telegramConfigured ? sendTelegramMessage(title, content) : Promise.resolve(false),
    kakaoConfigured ? sendKakaoMemo(title, content) : Promise.resolve(false),
  ]);

  const owner = ownerConfigured && ownerResult.status === "fulfilled" && ownerResult.value === true;
  const telegram = telegramConfigured && telegramResult.status === "fulfilled" && telegramResult.value === true;
  const kakao = kakaoConfigured && kakaoResult.status === "fulfilled" && kakaoResult.value === true;
  const failedChannels = [
    ownerConfigured && !owner ? "owner" : null,
    telegramConfigured && !telegram ? "telegram" : null,
    kakaoConfigured && !kakao ? "kakao" : null,
  ].filter((channel): channel is string => Boolean(channel));

  if (failedChannels.length) {
    console.warn(`[Notification] Failed channels for "${title}": ${failedChannels.join(", ")}`);
  }

  return {
    owner,
    telegram,
    kakao,
    anyDelivered: owner || telegram || kakao,
    primaryDelivered: telegram,
    failedChannels,
  };
}

/**
 * Send notification when analysis is complete
 */
export async function notifyAnalysisComplete(
  analysis: AnalysisNotification
): Promise<boolean> {
  const score = analysis.asymmetricGrowthScore;
  const scoreLevel = score >= 80 ? "매우 높음" : score >= 70 ? "높음" : "중간";

  const title = `${analysis.ticker} 분석 완료 - 비대칭적 성장 가능성: ${scoreLevel}`;

  const content = `
**종목:** ${analysis.ticker}
**비대칭적 성장 점수:** ${score}/100
**분석 요약:** ${analysis.investmentInsight.substring(0, 200)}...

[대시보드에서 전체 분석 보기]
`;

  try {
    const result = await notifyOwner({ title, content });
    console.log(`[Notification] Analysis complete for ${analysis.ticker}:`, result);
    return result;
  } catch (error) {
    console.error(`[Notification Error] Failed to notify analysis for ${analysis.ticker}:`, error);
    return false;
  }
}

/**
 * Send notification for high-opportunity stocks
 */
export async function notifyHighOpportunity(
  ticker: string,
  score: number,
  reason: string
): Promise<boolean> {
  const title = `🚀 ${ticker} - 높은 비대칭적 성장 기회 감지`;

  const content = `
**종목:** ${ticker}
**비대칭적 성장 점수:** ${score}/100
**기회 분석:** ${reason}

이 종목은 억만장자형 사고 프레임워크 기준으로 높은 성장 가능성을 보유하고 있습니다.
`;

  try {
    const result = await notifyOwner({ title, content });
    console.log(`[Notification] High opportunity for ${ticker}:`, result);
    return result;
  } catch (error) {
    console.error(`[Notification Error] Failed to notify high opportunity for ${ticker}:`, error);
    return false;
  }
}

/**
 * Send daily watchlist change summary notification
 */
export async function notifyDailyMarketSummary(
  topMovers: Array<{ ticker: string; score: number }>,
  alertedStocks: number,
  totalSignals: number
): Promise<boolean> {
  const title = "📊 일일 관심종목 변동 요약";

  const topTickers = topMovers
    .slice(0, 3)
    .map((o) => `- ${o.ticker}: ${o.score}점`)
    .join("\n");

  const content = `
**변동 상위 종목:**
${topTickers || "- 유의미한 변동 없음"}

**오늘의 변동 신호:**
- 변동 감지 종목: ${alertedStocks}개
- 총 변동 신호: ${totalSignals}건

자세한 내용은 대시보드에서 확인하세요.
`;

  try {
    const [ownerResult, telegramResult, kakaoResult] = await Promise.allSettled([
      notifyOwner({ title, content }),
      sendTelegramMessage(title, content),
      sendKakaoMemo(title, content),
    ]);
    console.log("[Notification] Daily market summary sent");
    return [ownerResult, telegramResult, kakaoResult].some(result => result.status === "fulfilled" && result.value === true);
  } catch (error) {
    console.error("[Notification Error] Failed to send daily market summary:", error);
    return false;
  }
}

export async function notifyDailySwingCandidates(
  candidates: SwingCandidate[],
  limitUpCandidates: LimitUpPredictionCandidate[] = [],
  firstLimitUpCandidates: FirstLimitUpFollowThroughCandidate[] = [],
  externalPlatformReport?: ExternalPlatformReport,
  agentTeamReport?: AgentTeamReport,
  kosdaqFocusCandidates: SwingCandidate[] = []
): Promise<NotificationDeliveryResult> {
  const title = limitUpCandidates.length || firstLimitUpCandidates.length
    ? "기술적 스윙 + 상한가 예측 추천"
    : "기술적 스윙 추천 종목";
  const ranked = candidates.slice(0, 5);
  const limitUpRanked = limitUpCandidates.slice(0, 3);
  const firstLimitUpRanked = firstLimitUpCandidates.slice(0, 3);
  const topRecommendations = buildTopRecommendationEntries(
    ranked,
    limitUpRanked,
    firstLimitUpRanked,
    externalPlatformReport,
    agentTeamReport
  );
  const marketGroups = groupSwingCandidatesByMarket(ranked);
  const patternSummary = SWING_PATTERN_ORDER
    .map(pattern => {
      const matchedCount = ranked.filter(candidate => candidate.patterns.includes(pattern)).length;
      return matchedCount ? `${pattern} ${matchedCount}건` : null;
    })
    .filter((item): item is string => Boolean(item))
    .join(" / ");
  const marketSummary = [
    marketGroups.kospi.length ? `코스피 ${marketGroups.kospi.length}개` : null,
    marketGroups.kosdaq.length ? `코스닥 ${marketGroups.kosdaq.length}개` : null,
  ]
    .filter((item): item is string => Boolean(item))
    .join(" / ");

  const topRecommendationSection = topRecommendations.length
    ? [
        "오늘의 상위 5개 추천",
        "트리거가, 손절가, 차트 사유, 단테 정합, 외부 플랫폼 상태, 리스크 상태를 함께 정리했습니다.",
        ...topRecommendations.map((entry, index) => formatTopRecommendation(entry, index)),
      ].join("\n\n")
    : "오늘의 상위 5개 추천을 구성할 후보가 없습니다.";

  const swingSection = ranked.length
    ? [
        "차트, 거래량, RSI, 이평선만으로 걸러낸 오늘의 기술적 스윙 상위 5선입니다.",
        `총 후보 수: ${ranked.length}개`,
        marketSummary ? `시장 분포: ${marketSummary}` : "",
        patternSummary ? `패턴 분포: ${patternSummary}` : "",
        "",
        ...ranked.map((candidate, index) => formatSwingCandidate(candidate, index)),
      ].join("\n\n")
    : "오늘은 조건에 맞는 스윙 추천 종목이 없습니다.";

  const limitUpSection = limitUpRanked.length
    ? [
        "상한가 예측 플러스",
        "뉴스·테마 없이 차트, 거래량, RSI, 이평선, 바닥권 거래량 점화로 산출한 초기 급등 후보입니다.",
        ...limitUpRanked.map((candidate, index) => formatLimitUpCandidate(candidate, index)),
      ].join("\n\n")
    : [
        "상한가 예측 플러스",
        "오늘은 상한가 예측 점수 기준을 통과한 추가 후보가 없습니다.",
      ].join("\n\n");
  const firstLimitUpSection = firstLimitUpRanked.length
    ? [
        "상한가 후속 플러스",
        "최근 상한가 이후 눌림목 재공략 또는 연속 상한가 가능성을 차트, 거래량, RSI, 이평선만으로 점검한 후보입니다.",
        ...firstLimitUpRanked.map((candidate, index) => formatFirstLimitUpCandidate(candidate, index)),
      ].join("\n\n")
    : [
        "상한가 후속 플러스",
        "최근 상한가 이후 눌림목/연속 상한가 조건을 통과한 추가 후보가 없습니다.",
      ].join("\n\n");
  const kosdaqFocusSection = kosdaqFocusCandidates.length
    ? [
        "코스닥 전용 에이전트 팀",
        "코스닥 변동성과 성장주 특성을 따로 반영해 재정렬한 전용 후보입니다.",
        ...kosdaqFocusCandidates.slice(0, 5).map((candidate, index) => formatSwingCandidate(candidate, index)),
      ].join("\n\n")
    : [
        "코스닥 전용 에이전트 팀",
        "오늘은 코스닥 전용 팀이 추가 우선순위 후보를 만들지 못했습니다.",
      ].join("\n\n");

  const agentTeamSection = agentTeamReport ? formatAgentTeamReport(agentTeamReport) : "";
  const externalPlatformSection = externalPlatformReport ? formatExternalPlatformReport(externalPlatformReport) : "";
  const content = [
    topRecommendationSection,
    swingSection,
    kosdaqFocusSection,
    limitUpSection,
    firstLimitUpSection,
    externalPlatformSection,
    agentTeamSection,
  ]
    .filter(Boolean)
    .join("\n\n");

  try {
    return await deliverMultiChannelNotification(title, content);
  } catch (error) {
    console.error("[Notification Error] Failed to send daily swing candidates:", error);
    return {
      owner: false,
      telegram: false,
      kakao: false,
      anyDelivered: false,
      primaryDelivered: false,
      failedChannels: ["owner", "telegram", "kakao"],
    };
  }
}

export async function notifyDailySwingFailure(
  notes: string[],
  error?: string
): Promise<NotificationDeliveryResult> {
  const title = "기술적 스윙 스캔 실패";
  const content = [
    "스캔 결과를 만들지 못했습니다.",
    error ? `오류: ${error}` : "",
    notes.length ? `원인/참고: ${notes.join(" | ")}` : "",
    "점검 포인트: 데이터 수집, 패턴 산출, 텔레그램 전송 순서로 확인",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    return await deliverMultiChannelNotification(title, content);
  } catch (notifyError) {
    console.error("[Notification Error] Failed to send swing failure notification:", notifyError);
    return {
      owner: false,
      telegram: false,
      kakao: false,
      anyDelivered: false,
      primaryDelivered: false,
      failedChannels: ["owner", "telegram", "kakao"],
    };
  }
}
