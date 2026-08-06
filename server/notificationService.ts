/**
 * Notification Service — owner / Telegram / Kakao alerts.
 *
 * The daily swing push is intentionally simple: only market mood, candidates,
 * prices, and a short watch list are sent. Heavy detail (Elliott, Dante,
 * external platforms, agent-team review) stays in the execution report and
 * dashboard instead of being dumped into the message.
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

// ── Daily swing push (simple, ranked) ──

// 기대수익 표기는 저널·백테스트가 실제로 채점하는 2.5R로 통일(정직한 표기).
function decisionLabel(candidate: SwingCandidate): string {
  if (candidate.swingFit === "상" || candidate.swingScore >= 75) return "우선 확인";
  if (candidate.swingFit === "중" || candidate.swingScore >= 60) return "확인";
  return "관찰";
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

function formatWatch(candidate: SwingCandidate): string {
  return `${candidate.companyName} (${candidate.ticker}) · ${candidate.swingScore}점`;
}

function formatPick(candidate: SwingCandidate, rMultiple: number, rank: number): string {
  const pct = expectedReturnPct(candidate, rMultiple);
  return [
    `${rank}. ${candidate.companyName} (${candidate.ticker}) · ${decisionLabel(candidate)} · ${candidate.swingScore}점`,
    `   현재가 ${won(candidate.currentPrice)} · 기준가 ${won(candidate.triggerPrice)}`,
    `   주의가격 ${won(candidate.stopLossPrice)} · 목표 +${pct}%`,
  ].join("\n");
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
  watchlist: SwingCandidate[] = [],
  options: { performanceLine?: string; dataDegraded?: boolean; accuracyLine?: string } = {}
): { title: string; body: string } {
  const title = `📊 오늘의 주식 후보 · ${kstDateLabel(now)}`;
  const ranked = [...candidates].sort((a, b) => b.swingScore - a.swingScore);
  const regime = (ranked[0] ?? watchlist[0])?.marketRegimeLabel;
  const riskOff = regime === "약세";
  const maxPicks = riskOff ? 3 : 5;
  const picks = ranked.slice(0, maxPicks);
  // When the tape demotes everything, the watch list IS the day's entire output —
  // showing only 3 of it made the alert look frozen on the same names for weeks.
  // With picks present it stays a short footnote.
  const watchLimit = picks.length ? 3 : 10;
  const shownWatch = watchlist.slice(0, watchLimit);
  const watchHeader =
    watchlist.length > shownWatch.length
      ? `👀 관찰 ${shownWatch.length}/${watchlist.length}`
      : "👀 관찰";
  const watchSection = watchlist.length
    ? [watchHeader, ...shownWatch.map(formatWatch)].join("\n")
    : "";

  const limitUpNames = [...limitUpCandidates, ...firstLimitUpCandidates]
    .slice(0, 4)
    .map(c => c.companyName);

  const footer: string[] = [];
  if (limitUpNames.length) footer.push(`⚡ 급등 관심: ${limitUpNames.join(" · ")}`);
  if (options.performanceLine) footer.push(options.performanceLine);
  if (options.accuracyLine) footer.push(options.accuracyLine);
  footer.push("자세한 근거와 차트는 대시보드에서 확인하세요.");

  const dataBanner = options.dataDegraded
    ? "⚠️ 자료 확인 필요 — 오늘 알림은 참고만 봐주세요."
    : "";
  const regimeBanner = riskOff
    ? "⚠️ 시장 흐름: 조심"
    : regime === "강세"
      ? "🟢 시장 흐름: 좋음"
      : regime === "중립"
        ? "🟡 시장 흐름: 보통"
        : "";
  const body =
    picks.length || watchSection
      ? [
          dataBanner,
          regimeBanner,
          `후보 ${ranked.length}개 · 관찰 ${watchlist.length}개`,
          "",
          picks.length ? ["✅ 후보", ...picks.map((c, index) => formatPick(c, 2.5, index + 1))].join("\n") : "",
          ranked.length > picks.length ? `외 ${ranked.length - picks.length}개 후보는 대시보드에서 확인하세요.` : "",
          watchSection,
          "",
          ...footer,
        ]
          .filter(Boolean)
          .join("\n")
      : [dataBanner, "오늘은 조건에 맞는 후보가 없습니다.", ...footer].filter(Boolean).join("\n");
  return { title, body };
}

export async function notifyDailySwingCandidates(
  candidates: SwingCandidate[],
  limitUpCandidates: LimitUpPredictionCandidate[] = [],
  firstLimitUpCandidates: FirstLimitUpFollowThroughCandidate[] = [],
  _externalPlatformReport?: ExternalPlatformReport,
  _agentTeamReport?: AgentTeamReport,
  _kosdaqFocusCandidates: SwingCandidate[] = [],
  watchlist: SwingCandidate[] = [],
  options: { performanceLine?: string; dataDegraded?: boolean; accuracyLine?: string } = {}
): Promise<NotificationDeliveryResult> {
  const { title, body } = buildDailySwingMessage(
    candidates,
    limitUpCandidates,
    firstLimitUpCandidates,
    new Date(),
    watchlist,
    options
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
