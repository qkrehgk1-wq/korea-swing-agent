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

async function generateSection(
  role: string,
  systemPrompt: string,
  userPrompt: string,
  fallback: string
): Promise<string> {
  try {
    const response = await invokeLLM({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });
    const content = response.choices[0]?.message.content;
    if (typeof content === "string" && content.trim().length > 0) {
      const text = content.trim();
      // DataValidator harness: block scam-grade language, log hype tone.
      const check = checkAnalysisConstitution(text);
      if (!check.ok) {
        await logConstitutionViolation(role, check.violations);
        if (check.severe) return fallback;
      }
      return text;
    }
    return fallback;
  } catch (error) {
    console.warn("[KoreanAgentEngine] LLM section failed, using deterministic fallback:", error);
    return fallback;
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

  const [fundamental, technical, insider, risk, market] = await Promise.all([
    generateSection(
      "패턴 구조 분석가",
      `${BASE_RULES} 당신은 차트 패턴 구조를 읽는 분석가입니다. 밥그릇/하이힐/돌파/컵앤핸들 등 한국 스윙 패턴 관점에서 현재 구조를 해석하세요.`,
      `${facts}\n\n[지시] 다음 형식으로 답하세요.\n### 패턴 구조 결론\n### 패턴 체크 숫자\n- 3개\n### 지금 타점인가\n- 진입 가능 조건과 아직 이른 이유를 균형 있게`,
      deterministic.fundamentalAnalysis
    ),
    generateSection(
      "기술적 지표 분석가",
      `${BASE_RULES} 당신은 이동평균·거래량·모멘텀·변동성을 보는 기술적 지표 분석가입니다.`,
      `${facts}\n\n[지시] 다음 형식으로 답하세요.\n### 인디케이터 요약\n### 거래량과 변동성\n### 기술적 액션\n- 비중과 진입 타이밍 관점`,
      deterministic.technicalAnalysis
    ),
    generateSection(
      "수급 분석가",
      `${BASE_RULES} 당신은 외국인·기관 수급과 거래량으로 수급 주체를 해석하는 분석가입니다. 수급 수치가 없으면 거래량 배수로 보수적으로 해석하세요.`,
      `${facts}\n\n[지시] 다음 형식으로 답하세요.\n### 수급 해석\n### 거래량을 차트로 읽는 법\n### 주의할 점`,
      deterministic.insiderAnalysis
    ),
    generateSection(
      "리스크 관리자",
      `${BASE_RULES} 당신은 손실 방어에 집중하는 리스크 관리자입니다. 변동성·낙폭·추세 훼손 조건을 구체적 숫자로 짚으세요.`,
      `${facts}\n\n[지시] 다음 형식으로 답하세요.\n### 지금 가장 큰 리스크\n### 무엇이 깨지면 시나리오가 무너지나\n- 3개\n### 손절/비중 관리 기준`,
      deterministic.riskAnalysis
    ),
    generateSection(
      "스윙 전략가",
      `${BASE_RULES} 당신은 시장 흐름과 종목 위치를 엮는 스윙 전략 메모 작성자입니다.`,
      `${facts}\n\n[지시] 다음 형식으로 답하세요.\n### 스윙 매매 메모\n### 실전 해석\n- 시장이 이 종목을 받아주는 자리인지 판단`,
      deterministic.marketIntelligenceAnalysis
    ),
  ]);

  const investmentInsight = await generateSection(
    "종합 투자 전략가",
    `${BASE_RULES} 당신은 위 분석들을 종합해 실제 매매 계획으로 바꾸는 수석 스윙 트레이더입니다.`,
    [
      facts,
      "",
      "[에이전트 분석 요약]",
      `## 패턴\n${fundamental}`,
      `## 지표\n${technical}`,
      `## 수급\n${insider}`,
      `## 리스크\n${risk}`,
      `## 스윙메모\n${market}`,
      "",
      "[지시] 다음 형식으로만 답하세요.",
      "## 최종 판단\n- 의견:\n- 확신도(0~100):\n- 한줄 요약:",
      "## 왜 지금 볼 만한가\n- 3개",
      "## 지금 사기 전에 확인할 것\n- 3개",
      "## 실행 계획\n- 진입 전략:\n- 비중 전략:\n- 철회(손절) 조건:",
    ].join("\n"),
    deterministic.investmentInsight
  );

  return {
    ...result,
    fundamentalAnalysis: fundamental,
    technicalAnalysis: technical,
    insiderAnalysis: insider,
    riskAnalysis: risk,
    marketIntelligenceAnalysis: market,
    investmentInsight,
  };
}
