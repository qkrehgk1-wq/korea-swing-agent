/**
 * Korean Multi-Agent Analysis Engine (LLM-enhanced)
 *
 * Builds a structured "fact sheet" from real Korean market data (price snapshot,
 * DART financials, supply/demand, valuation, detected patterns) and lets five
 * role-specific agents interpret it with the LLM. Every section degrades
 * gracefully to the deterministic analysis when the LLM is unavailable, times
 * out, or returns an empty body — so output is never worse than rule-based.
 */

import { ENV } from "./_core/env";
import { invokeLLM } from "./_core/llm";
import {
  buildKoreanAnalyses,
  calculateSnapshot,
  inferTechnicalPatterns,
  type KoreanStockAnalysisData,
  type PriceSnapshot,
} from "./koreaStockMcp";
import { buildSwingVerdict, type SwingCouncilVerdict } from "./koreaSignalCouncil";
import { checkAnalysisConstitution, logConstitutionViolation } from "./dataValidator";
import { fetchNewsSentiment, type NewsSentiment } from "./newsSentimentAgent";

export type KoreanAnalysisResult = ReturnType<typeof buildKoreanAnalyses> & {
  signalCouncil?: SwingCouncilVerdict;
};

function won(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) return "데이터 없음";
  return `${Math.round(value).toLocaleString("ko-KR")}원`;
}

function pct(value?: number, digits = 1): string {
  if (value === undefined || !Number.isFinite(value)) return "데이터 없음";
  return `${value > 0 ? "+" : ""}${value.toFixed(digits)}%`;
}

function money(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) return "데이터 없음";
  const trillion = 1_000_000_000_000;
  const billion = 100_000_000;
  if (Math.abs(value) >= trillion) return `${(value / trillion).toFixed(2)}조원`;
  return `${(value / billion).toFixed(0)}억원`;
}

function percentChange(from: number, to: number): number {
  if (!from || !Number.isFinite(from)) return 0;
  return ((to - from) / Math.abs(from)) * 100;
}

/**
 * Render the only ground truth the agents are allowed to reason from.
 * Keeping every number in one block makes hallucination easy to spot and lets
 * the system prompt enforce "use these numbers only".
 */
function buildFactSheet(
  ticker: string,
  companyName: string,
  snapshot: PriceSnapshot,
  data: KoreanStockAnalysisData,
  verdict: SwingCouncilVerdict,
  news: NewsSentiment | null
): string {
  const fundamental = data.fundamentals.at(-1);
  const marketCap = data.marketCaps.at(-1);
  const trading = data.tradingValues.at(-1);
  const fin = data.officialFinancials;
  const market = data.krxProfile?.market ?? "한국";

  const lines: string[] = [
    `[종목] ${companyName} (${ticker}) · ${market}`,
    "",
    "[가격/추세]",
    `- 종가 ${won(snapshot.latestClose)} (전일 대비 ${pct(snapshot.changePercent)})`,
    `- 이동평균: 20일 ${won(snapshot.ma20)} / 60일 ${won(snapshot.ma60)} / 120일 ${won(snapshot.ma120)}`,
    `- 종가의 이평선 대비 위치: 20일선 ${pct(percentChange(snapshot.ma20, snapshot.latestClose))}, 60일선 ${pct(percentChange(snapshot.ma60, snapshot.latestClose))}`,
    `- 수익률: 1주 ${pct(snapshot.return5d)} / 1개월 ${pct(snapshot.return20d)} / 3개월 ${pct(snapshot.return60d)} / 6개월 ${pct(snapshot.return120d)}`,
    `- 52주 고점 ${won(snapshot.annualHigh)} (고점 대비 ${pct(snapshot.distanceFromHigh)}), 52주 저점 ${won(snapshot.annualLow)} (저점 대비 ${pct(snapshot.distanceFromLow)})`,
    "",
    "[거래량/변동성]",
    `- 최근 거래량 / 20일 평균 = ${snapshot.volumeRatio.toFixed(2)}배 (20일 평균 ${Math.round(snapshot.volumeAverage20).toLocaleString("ko-KR")}주)`,
    `- 20일 연환산 변동성 ${snapshot.annualVolatility.toFixed(1)}% / 1년 최대 낙폭 ${snapshot.maxDrawdown.toFixed(1)}%`,
  ];

  lines.push("", "[밸류에이션]");
  if (fundamental?.PER || fundamental?.PBR || fundamental?.DIV) {
    if (fundamental?.PER) lines.push(`- PER ${fundamental.PER.toFixed(2)}배`);
    if (fundamental?.PBR) lines.push(`- PBR ${fundamental.PBR.toFixed(2)}배`);
    if (fundamental?.DIV) lines.push(`- 배당수익률 ${fundamental.DIV.toFixed(2)}%`);
  } else {
    lines.push("- PER/PBR/배당 데이터 없음");
  }
  if (marketCap?.시가총액) lines.push(`- 시가총액 ${money(marketCap.시가총액)}`);

  lines.push("", "[공식 재무 (DART)]");
  if (fin) {
    lines.push(`- 기준연도 ${fin.year}`);
    if (fin.revenue !== undefined)
      lines.push(`- 매출액 ${money(fin.revenue)} (YoY ${pct(fin.revenueYoY)})`);
    if (fin.operatingProfit !== undefined)
      lines.push(`- 영업이익 ${money(fin.operatingProfit)} (YoY ${pct(fin.operatingProfitYoY)})`);
    if (fin.netIncome !== undefined)
      lines.push(`- 순이익 ${money(fin.netIncome)} (YoY ${pct(fin.netIncomeYoY)})`);
    if (fin.equity !== undefined) lines.push(`- 자본총계 ${money(fin.equity)}`);
    if (fin.liabilities !== undefined) lines.push(`- 부채총계 ${money(fin.liabilities)}`);
  } else {
    lines.push("- DART 공식 재무 데이터 없음 (가격/거래량 기반으로만 판단)");
  }

  lines.push("", "[수급]");
  if (trading && (trading.외국인합계 !== undefined || trading.기관합계 !== undefined || trading.개인 !== undefined)) {
    if (typeof trading.외국인합계 === "number")
      lines.push(`- 외국인 순매수 추정 ${trading.외국인합계.toLocaleString("ko-KR")}원`);
    if (typeof trading.기관합계 === "number")
      lines.push(`- 기관 순매수 추정 ${trading.기관합계.toLocaleString("ko-KR")}원`);
    if (typeof trading.개인 === "number")
      lines.push(`- 개인 순매수 추정 ${trading.개인.toLocaleString("ko-KR")}원`);
  } else {
    lines.push("- 외국인/기관 수급 세부 수치 없음 (거래량 배수로 대체 해석)");
  }

  lines.push("", "[Signal Council 점수 (결정론적 사전 평가)]");
  lines.push(`- ${verdict.summary}`);
  for (const reason of verdict.rationale) {
    lines.push(`- ${reason}`);
  }

  if (news && news.headlines.length) {
    lines.push("", `[최근 뉴스 (${news.source})]`);
    for (const headline of news.headlines.slice(0, 6)) {
      lines.push(`- ${headline}`);
    }
  }

  return lines.join("\n");
}

const BASE_RULES =
  "반드시 한국어로만 답하세요. 아래 '사실 시트'에 제시된 숫자만 근거로 사용하고, 시트에 없는 수치·뉴스·재무·목표가를 지어내지 마세요. 데이터가 없으면 '데이터 없음'이라고 분명히 쓰세요. 한국 시장의 단기~중기(2~8주) 스윙 매매 관점에서, 막연한 표현 대신 실제 매매 판단에 쓸 수 있게 간결한 투자 메모 톤으로 쓰세요.";

type CombinedSections = {
  pattern: string;
  indicator: string;
  supply: string;
  risk: string;
  swingMemo: string;
  insight: string;
};

function extractJsonObject(text: string): Record<string, unknown> | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// One LLM call produces all 6 sections (was 6 calls) on the cheap tier, with
// per-section constitution checks and deterministic fallback.
async function generateCombined(
  facts: string,
  fallback: KoreanAnalysisResult
): Promise<CombinedSections> {
  const det: CombinedSections = {
    pattern: fallback.fundamentalAnalysis,
    indicator: fallback.technicalAnalysis,
    supply: fallback.insiderAnalysis,
    risk: fallback.riskAnalysis,
    swingMemo: fallback.marketIntelligenceAnalysis,
    insight: fallback.investmentInsight,
  };

  const system = `${BASE_RULES} 당신은 한국 일봉 스윙 분석 6개 역할(패턴 구조·기술 지표·수급·리스크·스윙 전략·종합 투자메모)을 한 번에 수행합니다. 각 값은 마크다운 소제목(###)으로 구성하세요.`;
  const user = [
    facts,
    "",
    "[지시] 위 사실만 근거로 아래 6개 키를 가진 JSON 객체 하나만 출력하세요. 다른 텍스트 없이 JSON만.",
    '{"pattern":"패턴 구조 분석","indicator":"기술 지표 분석","supply":"수급 분석","risk":"리스크 분석","swingMemo":"스윙 전략 메모","insight":"종합 투자 메모: 최종 판단·왜 지금·확인할 것·실행 계획(진입/비중/철회)"}',
    "각 값은 마크다운 문자열. 과장·단정 금지, 시트에 없으면 '데이터 없음'.",
  ].join("\n");

  try {
    const response = await invokeLLM({
      tier: "cheap",
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      maxTokens: 4096,
    });
    const content = response.choices[0]?.message.content;
    if (typeof content !== "string") return det;
    const obj = extractJsonObject(content);
    if (!obj) return det;

    const pick = (key: keyof CombinedSections, role: string): string => {
      const raw = obj[key];
      if (typeof raw !== "string" || raw.trim().length === 0) return det[key];
      const text = raw.trim();
      const check = checkAnalysisConstitution(text);
      if (!check.ok) {
        void logConstitutionViolation(role, check.violations);
        if (check.severe) return det[key];
      }
      return text;
    };

    return {
      pattern: pick("pattern", "패턴 구조 분석가"),
      indicator: pick("indicator", "기술적 지표 분석가"),
      supply: pick("supply", "수급 분석가"),
      risk: pick("risk", "리스크 관리자"),
      swingMemo: pick("swingMemo", "스윙 전략가"),
      insight: pick("insight", "종합 투자 전략가"),
    };
  } catch (error) {
    console.warn("[KoreanAgentEngine] combined LLM call failed, using deterministic:", error);
    return det;
  }
}

/**
 * LLM-enhanced Korean analysis. Returns the exact same shape as
 * buildKoreanAnalyses so the tRPC layer and client stay unchanged.
 */
export async function runKoreanAgentAnalysis(
  ticker: string,
  data: KoreanStockAnalysisData | null
): Promise<KoreanAnalysisResult> {
  const deterministic = buildKoreanAnalyses(ticker, data);
  const snapshot = data ? calculateSnapshot(data.ohlcvRows) : null;

  // Signal Council (deterministic) — compute whenever price data exists; its
  // 0-100 total becomes the headline score (framework.asymmetricGrowthScore).
  let verdict: SwingCouncilVerdict | undefined;
  let result: KoreanAnalysisResult = deterministic;
  if (data && snapshot) {
    const patterns = inferTechnicalPatterns(snapshot);
    verdict = buildSwingVerdict(snapshot, patterns, data);
    result = {
      ...deterministic,
      framework: { ...deterministic.framework, asymmetricGrowthScore: verdict.total },
      signalCouncil: verdict,
    };
  }

  // No usable price data, or no LLM configured → deterministic + council only.
  const llmAvailable = Boolean(ENV.anthropicApiKey || ENV.forgeApiKey);
  if (!data || !snapshot || !verdict || !llmAvailable) {
    return result;
  }

  const news = await fetchNewsSentiment(deterministic.companyName);
  const facts = buildFactSheet(ticker, deterministic.companyName, snapshot, data, verdict, news);
  const sections = await generateCombined(facts, result);

  return {
    ...result,
    fundamentalAnalysis: sections.pattern,
    technicalAnalysis: sections.indicator,
    insiderAnalysis: sections.supply,
    riskAnalysis: sections.risk,
    marketIntelligenceAnalysis: sections.swingMemo,
    investmentInsight: sections.insight,
  };
}
