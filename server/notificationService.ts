/**
 * Notification Service — owner / Telegram / Kakao alerts.
 *
 * The daily swing push is intentionally compact: candidates are grouped by
 * holding horizon (단기/중기/장기), 3 lines each. Heavy detail (Elliott, Dante,
 * external platforms, agent-team review) is persisted to the execution report
 * file, not dumped into the message.
 */

import { notifyOwner } from "./_core/notification";
import { sendKakaoMemo } from "./_core/kakaoNotification";
import { sendTelegramMessage } from "./_core/telegramNotification";
import { ENV } from "./_core/env";
import type { ExternalPlatformReport } from "./agentTeams/externalPlatformIntegrationAgent";
import type { AgentTeamReport } from "./agentTeams/orchestrator";

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
  marketRegimeLabel?: "강세" | "중립" | "약세";
  marketRegimeScore?: number;
  supplyState?: "accumulating" | "distributing" | "neutral";
  qualityScore?: number;
  relativeStrength?: number;
  newsState?: "positive" | "negative" | "neutral";
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

export async function notifyAnalysisComplete(
  analysis: AnalysisNotification
): Promise<boolean> {
  const score = analysis.asymmetricGrowthScore;
  const scoreLevel = score >= 80 ? "매우 높음" : score >= 70 ? "높음" : "중간";
  const title = `${analysis.ticker} 스윙 분석 완료 · 적합도 ${scoreLevel}`;
  const content = [
    `종목: ${analysis.ticker}`,
    `스윙 적합 점수: ${score}/100`,
    `요약: ${analysis.investmentInsight.substring(0, 180)}...`,
    "대시보드에서 전체 분석 보기",
  ].join("\n");

  try {
    return await notifyOwner({ title, content });
  } catch (error) {
    console.error(`[Notification Error] analysis ${analysis.ticker}:`, error);
    return false;
  }
}

export async function notifyHighOpportunity(
  ticker: string,
  score: number,
  reason: string
): Promise<boolean> {
  const title = `🚀 ${ticker} · 높은 스윙 적합 신호`;
  const content = [`종목: ${ticker}`, `스윙 적합 점수: ${score}/100`, `사유: ${reason}`].join("\n");

  try {
    return await notifyOwner({ title, content });
  } catch (error) {
    console.error(`[Notification Error] high opportunity ${ticker}:`, error);
    return false;
  }
}

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
  const content = [
    "변동 상위 종목:",
    topTickers || "- 유의미한 변동 없음",
    "",
    `변동 감지 종목: ${alertedStocks}개 · 총 변동 신호: ${totalSignals}건`,
    "자세한 내용은 대시보드에서.",
  ].join("\n");

  try {
    const settled = await Promise.allSettled([
      notifyOwner({ title, content }),
      sendTelegramMessage(title, content),
      sendKakaoMemo(title, content),
    ]);
    return settled.some(r => r.status === "fulfilled" && r.value === true);
  } catch (error) {
    console.error("[Notification Error] daily market summary:", error);
    return false;
  }
}

// ── Daily swing push (compact, horizon-grouped) ──

// 기대수익 표기는 저널·백테스트가 실제로 채점하는 2.5R로 통일(정직한 표기).
const HORIZONS: Array<{ key: "단기" | "중기" | "장기"; header: string; rMultiple: number }> = [
  { key: "단기", header: "🔴 단기 (1~5일)", rMultiple: 2.5 },
  { key: "중기", header: "🟡 중기 (1~4주)", rMultiple: 2.5 },
  { key: "장기", header: "🟢 장기 (1~3개월)", rMultiple: 2.5 },
];

function inferHorizon(candidate: SwingCandidate): "단기" | "중기" | "장기" {
  const patterns = candidate.patterns ?? [];
  const volumeRatio = candidate.volumeRatio ?? 1;
  const rsi = candidate.rsi14 ?? 50;
  // 단기: 돌파/모멘텀/거래량 급등/과열 직전
  if (patterns.some(p => p.includes("돌파")) || volumeRatio >= 2.0 || rsi >= 68) {
    return "단기";
  }
  // 장기: 바닥 다지기 베이스(밥그릇 1번자리·컵앤핸들) + 거래량 과열 아님
  if (patterns.some(p => p.includes("밥그릇 1번") || p.includes("컵앤핸들")) && volumeRatio < 1.6) {
    return "장기";
  }
  // 중기: 그 외 (밥그릇 2번자리·하이힐·눌림목)
  return "중기";
}

function decisionLabel(candidate: SwingCandidate): string {
  if (candidate.swingFit === "상" || candidate.swingScore >= 75) return "ACT";
  if (candidate.swingFit === "중" || candidate.swingScore >= 60) return "PREPARE";
  return "WATCH";
}

function expectedReturnPct(candidate: SwingCandidate, rMultiple: number): number {
  const risk = candidate.triggerPrice - candidate.stopLossPrice;
  if (risk <= 0 || candidate.triggerPrice <= 0) return 0;
  const target = candidate.triggerPrice + risk * rMultiple;
  return Math.round(((target - candidate.triggerPrice) / candidate.triggerPrice) * 100);
}

function won(value: number): string {
  return Math.round(value).toLocaleString("ko-KR");
}

function supplyMark(candidate: SwingCandidate): string {
  if (candidate.supplyState === "accumulating") return " 🟢매집";
  if (candidate.supplyState === "distributing") return " 🔴분산";
  return "";
}

function newsMark(candidate: SwingCandidate): string {
  if (candidate.newsState === "negative") return " 🔴악재";
  if (candidate.newsState === "positive") return " 🟢호재";
  return "";
}

function formatWatch(candidate: SwingCandidate): string {
  const confluence =
    candidate.reason?.find(r => r.includes("황금비") || r.includes("VCP") || r.includes("ADX")) ??
    candidate.patterns?.[0] ??
    "";
  return `${candidate.companyName} ${candidate.ticker} · ${candidate.swingScore}${supplyMark(candidate)}${newsMark(candidate)}${
    confluence ? ` · ${confluence}` : ""
  }`;
}

function formatPick(candidate: SwingCandidate, rMultiple: number): string {
  const pct = expectedReturnPct(candidate, rMultiple);
  const rs =
    typeof candidate.relativeStrength === "number"
      ? `RS${candidate.relativeStrength >= 0 ? "+" : ""}${candidate.relativeStrength}`
      : "";
  const confluence =
    candidate.reason?.find(r => r.includes("황금비") || r.includes("VCP") || r.includes("ADX")) ??
    candidate.patterns?.[0] ??
    "";
  const detail = [rs, confluence].filter(Boolean).join(" · ");
  return [
    `${candidate.companyName} ${candidate.ticker} · ${decisionLabel(candidate)} ${candidate.swingScore}${supplyMark(candidate)}${newsMark(candidate)}`,
    `  진입 ${won(candidate.triggerPrice)} · 손절 ${won(candidate.stopLossPrice)} · 기대 +${pct}%`,
    detail ? `  ${detail}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function kstDateLabel(now: Date): string {
  const kst = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Seoul" }));
  const days = ["일", "월", "화", "수", "목", "금", "토"];
  return `${kst.getMonth() + 1}/${kst.getDate()}(${days[kst.getDay()]})`;
}

export function buildDailySwingMessage(
  candidates: SwingCandidate[],
  limitUpCandidates: LimitUpPredictionCandidate[] = [],
  firstLimitUpCandidates: FirstLimitUpFollowThroughCandidate[] = [],
  now: Date = new Date(),
  watchlist: SwingCandidate[] = []
): { title: string; body: string } {
  const title = `📊 한국 스윙 · ${kstDateLabel(now)}`;
  const ranked = [...candidates].sort((a, b) => b.swingScore - a.swingScore);
  const regime = (ranked[0] ?? watchlist[0])?.marketRegimeLabel;
  const riskOff = regime === "약세";
  const picksPerGroup = riskOff ? 1 : 2;

  const sections: string[] = [];
  for (const horizon of HORIZONS) {
    const picks = ranked.filter(c => inferHorizon(c) === horizon.key).slice(0, picksPerGroup);
    if (!picks.length) continue;
    sections.push([horizon.header, ...picks.map(c => formatPick(c, horizon.rMultiple))].join("\n"));
  }
  // Watch-only floor — keeps the alert informative (never silent) without
  // presenting sub-conviction names as ACT signals.
  const watchSection = watchlist.length
    ? ["👀 관찰 (조건 미달·참고용)", ...watchlist.slice(0, 3).map(formatWatch)].join("\n")
    : "";

  const limitUpNames = [...limitUpCandidates, ...firstLimitUpCandidates]
    .slice(0, 4)
    .map(c => c.companyName);

  const footer: string[] = [];
  if (limitUpNames.length) footer.push(`⚡ 상한가 후보: ${limitUpNames.join(" · ")}`);
  footer.push("🔒 전체 근거·차트 → 대시보드");

  const regimeBanner = riskOff
    ? "⚠️ 시장 약세 — 신규 진입 신중·비중 축소·현금 권고"
    : regime === "강세"
      ? "🟢 시장 강세 — 추세 우호적"
      : "";
  const body =
    sections.length || watchSection
      ? [
          regimeBanner,
          `KOSPI·KOSDAQ 자동 스캔 · 후보 ${ranked.length} · 관찰 ${watchlist.length}`,
          "",
          ...sections,
          watchSection,
          "",
          ...footer,
        ]
          .filter(Boolean)
          .join("\n")
      : "오늘은 조건에 맞는 스윙 후보가 없습니다.";
  return { title, body };
}

export async function notifyDailySwingCandidates(
  candidates: SwingCandidate[],
  limitUpCandidates: LimitUpPredictionCandidate[] = [],
  firstLimitUpCandidates: FirstLimitUpFollowThroughCandidate[] = [],
  _externalPlatformReport?: ExternalPlatformReport,
  _agentTeamReport?: AgentTeamReport,
  _kosdaqFocusCandidates: SwingCandidate[] = [],
  watchlist: SwingCandidate[] = []
): Promise<NotificationDeliveryResult> {
  const { title, body } = buildDailySwingMessage(
    candidates,
    limitUpCandidates,
    firstLimitUpCandidates,
    new Date(),
    watchlist
  );

  try {
    return await deliverMultiChannelNotification(title, body);
  } catch (error) {
    console.error("[Notification Error] daily swing candidates:", error);
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
    "점검: 데이터 수집 → 패턴 산출 → 텔레그램 전송 순서로 확인",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    return await deliverMultiChannelNotification(title, content);
  } catch (notifyError) {
    console.error("[Notification Error] swing failure notification:", notifyError);
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
