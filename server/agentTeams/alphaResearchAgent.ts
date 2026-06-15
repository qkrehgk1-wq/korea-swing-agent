/**
 * Alpha Research Agent — finds the latest profit-maximizing techniques on the
 * open web and distills them, via Claude, into changes we can actually make to
 * the Korean swing system (Signal Council weights, screener rules, risk model).
 *
 * Unlike strategyDiscovery/informationCurator (deterministic arXiv keyword
 * matching), this agent searches the whole web (Serper/Tavily) and uses the LLM
 * to reason about edge — win-rate, payoff ratio, drawdown — and how to adopt it.
 * Degrades to a curated deterministic set when search or LLM are unavailable.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { ENV } from "../_core/env";
import { invokeLLM } from "../_core/llm";
import { sendTelegramMessage } from "../_core/telegramNotification";

export type AlphaCategory =
  | "entry"
  | "exit"
  | "risk"
  | "regime"
  | "volume"
  | "ai-quant";

const ALPHA_CATEGORIES: AlphaCategory[] = [
  "entry",
  "exit",
  "risk",
  "regime",
  "volume",
  "ai-quant",
];

export type AlphaTechnique = {
  title: string;
  category: AlphaCategory;
  thesis: string; // why it improves returns
  expectedEdge: string; // win-rate / payoff / drawdown effect
  implementation: string; // how to wire into our system
  guardrail: string; // validation / risk note
  priority: "high" | "medium" | "low";
  confidence: number; // 1-100
};

export type AlphaResearchReport = {
  generatedAt: string;
  source: "llm" | "deterministic";
  techniques: AlphaTechnique[];
  notes: string[];
};

const REPORT_DIR = path.join(process.cwd(), ".data", "alpha-research");

const SEARCH_QUERIES = [
  "swing trading volume breakout edge 2026",
  "momentum trading risk management position sizing technique",
  "market regime filter trading strategy improve win rate",
  "한국 주식 스윙 매매 기법 거래량 돌파",
  "quant trading signal feature engineering daily bars",
];

// Curated, battle-tested techniques used when web/LLM are unavailable. Each maps
// to a concrete change in our codebase so the report is actionable either way.
const FALLBACK_TECHNIQUES: AlphaTechnique[] = [
  {
    title: "거래량 동반 20일선 눌림목 매수",
    category: "entry",
    thesis:
      "상승 추세 중 20일선까지의 얕은 눌림은 거래량이 줄었다가 반등 시 늘면 추세 재개 확률이 높다.",
    expectedEdge: "추격 매수 대비 진입가 개선 → 손익비 향상",
    implementation:
      "koreaSignalCouncil.ts의 entryTiming에 '20일선 0~4% 위 + 거래량 반등' 가점을 강화.",
    guardrail: "60일선 이탈 또는 거래량 없는 반등은 제외. 눌림 깊이 임계값을 백테스트로 검증.",
    priority: "high",
    confidence: 68,
  },
  {
    title: "박스권 상단 돌파 후 종가 안착 확인",
    category: "entry",
    thesis: "장중 돌파는 속임수가 많지만 종가가 저항선 위에서 마감하면 신뢰도가 크게 오른다.",
    expectedEdge: "가짜 돌파 회피 → 승률 향상",
    implementation: "technicalSwingScreener의 돌파매매 조건을 장중가 아닌 종가 기준으로 강화.",
    guardrail: "거래량 미달 돌파는 제외. 돌파 후 3일 내 재이탈 시 손절.",
    priority: "high",
    confidence: 66,
  },
  {
    title: "ATR/변동성 기반 포지션 사이징",
    category: "risk",
    thesis: "고정 비중 대신 변동성에 반비례해 비중을 정하면 계좌 변동성이 평탄해진다.",
    expectedEdge: "MDD 감소 → 위험 조정 수익(샤프) 향상",
    implementation: "Signal Council riskLevel을 권장 비중 계산으로 확장(변동성↑ → 비중↓).",
    guardrail: "변동성 추정 구간(20일)이 짧아 급변장에서 지연될 수 있음 — 상한 비중 캡 병행.",
    priority: "high",
    confidence: 64,
  },
  {
    title: "시장 레짐 필터 (지수 추세 게이트)",
    category: "regime",
    thesis: "지수가 약세 레짐일 때 개별 스윙 신호의 기대값은 급감한다.",
    expectedEdge: "약세장 진입 억제 → 손실 구간 회피",
    implementation: "KOSPI/KOSDAQ 지수 추세를 레짐 점수로 만들어 약세 레짐에서 ACT 임계값을 상향.",
    guardrail: "레짐 전환 지연(휩쏘) 위험 — 점진적 비중 축소로 완화.",
    priority: "medium",
    confidence: 60,
  },
  {
    title: "분할 익절 + 추적 손절(트레일링)",
    category: "exit",
    thesis: "1차 목표에서 일부 익절하고 나머지는 추적 손절로 끌면 큰 추세를 놓치지 않으면서 이익을 보호한다.",
    expectedEdge: "평균 이익 구간 확대 → 손익비 향상",
    implementation: "추천 출력에 1차 익절가(예: +R)와 트레일링 기준(예: 5일선 종가 이탈)을 필드로 추가.",
    guardrail: "변동성 큰 종목은 트레일링 폭을 넓혀 조기 이탈 방지.",
    priority: "medium",
    confidence: 58,
  },
];

type SearchHit = { title: string; snippet: string };

const SEARCH_TIMEOUT_MS = 8000;

async function fetchJson(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch
): Promise<any | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { ...init, signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function webSearch(query: string, fetchImpl: typeof fetch): Promise<SearchHit[]> {
  if (ENV.serperApiKey) {
    const data = await fetchJson(
      "https://google.serper.dev/search",
      {
        method: "POST",
        headers: { "X-API-KEY": ENV.serperApiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ q: query, gl: "kr", hl: "ko", num: 6 }),
      },
      fetchImpl
    );
    const organic = data?.organic;
    if (Array.isArray(organic)) {
      return organic
        .slice(0, 6)
        .map((o: any) => ({ title: String(o.title ?? ""), snippet: String(o.snippet ?? "") }))
        .filter((h: SearchHit) => h.title || h.snippet);
    }
  }
  if (ENV.tavilyApiKey) {
    const data = await fetchJson(
      "https://api.tavily.com/search",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: ENV.tavilyApiKey, query, max_results: 6 }),
      },
      fetchImpl
    );
    const results = data?.results;
    if (Array.isArray(results)) {
      return results
        .slice(0, 6)
        .map((r: any) => ({ title: String(r.title ?? ""), snippet: String(r.content ?? "") }))
        .filter((h: SearchHit) => h.title || h.snippet);
    }
  }
  return [];
}

function extractJsonArray(text: string): unknown[] | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("[");
  const end = candidate.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function coerceTechnique(raw: any): AlphaTechnique | null {
  if (!raw || typeof raw !== "object") return null;
  const category = ALPHA_CATEGORIES.includes(raw.category) ? raw.category : "entry";
  const priority = ["high", "medium", "low"].includes(raw.priority) ? raw.priority : "medium";
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  const thesis = typeof raw.thesis === "string" ? raw.thesis.trim() : "";
  if (!title || !thesis) return null;
  const confidence = Math.max(1, Math.min(100, Number(raw.confidence) || 50));
  return {
    title,
    category,
    thesis,
    expectedEdge: typeof raw.expectedEdge === "string" ? raw.expectedEdge.trim() : "",
    implementation: typeof raw.implementation === "string" ? raw.implementation.trim() : "",
    guardrail: typeof raw.guardrail === "string" ? raw.guardrail.trim() : "",
    priority,
    confidence,
  };
}

async function distillWithLlm(hits: SearchHit[]): Promise<AlphaTechnique[] | null> {
  const corpus = hits
    .slice(0, 24)
    .map((h, i) => `${i + 1}. ${h.title}\n${h.snippet}`)
    .join("\n\n");

  const system =
    "당신은 한국 일봉 스윙 매매 시스템을 개선하는 퀀트 리서처입니다. 반드시 한국어로 답하고, 아래 검색 스니펫에 근거한 내용만 쓰세요. 근거가 없으면 지어내지 마세요.";
  const user = [
    "[웹 검색 스니펫]",
    corpus || "(검색 결과 없음)",
    "",
    "[지시] 위 자료에서 우리의 한국 일봉 스윙 시스템(Signal Council 7차원 점수, 기술적 스윙 스크리너, 리스크 모델)에 적용하면 수익률(승률·손익비·MDD)을 끌어올릴 수 있는 기법을 최대 6개 뽑아 JSON 배열로만 답하세요. 다른 텍스트 없이 JSON만.",
    '형식: [{"title","category","thesis","expectedEdge","implementation","guardrail","priority","confidence"}]',
    "category는 entry|exit|risk|regime|volume|ai-quant 중 하나. priority는 high|medium|low. confidence는 1~100 정수. implementation은 우리 코드/규칙에 어떻게 반영할지 구체적으로.",
  ].join("\n");

  try {
    const response = await invokeLLM({
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      maxTokens: 4096,
    });
    const content = response.choices[0]?.message.content;
    if (typeof content !== "string") return null;
    const arr = extractJsonArray(content);
    if (!arr) return null;
    const techniques = arr
      .map(coerceTechnique)
      .filter((t): t is AlphaTechnique => t !== null);
    return techniques.length > 0 ? techniques : null;
  } catch (error) {
    console.warn("[AlphaResearch] LLM distillation failed:", error);
    return null;
  }
}

async function writeReport(report: AlphaResearchReport): Promise<void> {
  try {
    await mkdir(REPORT_DIR, { recursive: true });
    const stamp = report.generatedAt.replace(/[:.]/g, "-");
    await writeFile(
      path.join(REPORT_DIR, `report_${stamp}.json`),
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8"
    );
    const md = [
      `# Alpha Research Report (${report.generatedAt})`,
      `- 소스: ${report.source}`,
      "",
      ...report.techniques.flatMap(t => [
        `## [${t.category}] ${t.title} (${t.priority}, 신뢰 ${t.confidence})`,
        `- 논리: ${t.thesis}`,
        `- 예상 효과: ${t.expectedEdge}`,
        `- 적용: ${t.implementation}`,
        `- 주의: ${t.guardrail}`,
        "",
      ]),
      "## Notes",
      ...report.notes.map(n => `- ${n}`),
    ].join("\n");
    await writeFile(path.join(REPORT_DIR, "latest-report.md"), `${md}\n`, "utf8");
  } catch (error) {
    console.warn("[AlphaResearch] Failed to write report:", error);
  }
}

export async function collectAlphaResearchReport(
  options: { fetchImpl?: typeof fetch; now?: Date; persist?: boolean } = {}
): Promise<AlphaResearchReport> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? new Date();
  const persist = options.persist ?? true;
  const notes: string[] = [];

  const searchAvailable = Boolean(ENV.serperApiKey || ENV.tavilyApiKey);
  const llmAvailable = Boolean(ENV.anthropicApiKey || ENV.forgeApiKey);
  const isTest = process.env.NODE_ENV === "test";

  let report: AlphaResearchReport;

  if (isTest || !searchAvailable || !llmAvailable) {
    if (!isTest) {
      if (!searchAvailable) notes.push("검색 키(SERPER/TAVILY) 없음 — 큐레이션 기법으로 대체.");
      if (!llmAvailable) notes.push("LLM 키 없음 — 큐레이션 기법으로 대체.");
    }
    report = {
      generatedAt: now.toISOString(),
      source: "deterministic",
      techniques: FALLBACK_TECHNIQUES,
      notes: [
        ...notes,
        "Alpha Research는 발견 기법을 바로 매수 규칙에 넣지 않고, 백테스트 후보·규칙 보조축으로만 제안합니다.",
      ],
    };
  } else {
    const hitGroups = await Promise.all(SEARCH_QUERIES.map(q => webSearch(q, fetchImpl)));
    const hits = hitGroups.flat();
    if (hits.length === 0) {
      notes.push("웹 검색 결과가 비어 큐레이션 기법으로 대체.");
    }
    const distilled = hits.length > 0 ? await distillWithLlm(hits) : null;
    report = {
      generatedAt: now.toISOString(),
      source: distilled ? "llm" : "deterministic",
      techniques: distilled ?? FALLBACK_TECHNIQUES,
      notes: [
        ...notes,
        `검색 스니펫 ${hits.length}건 수집.`,
        "Alpha Research는 발견 기법을 바로 매수 규칙에 넣지 않고, 백테스트 후보·규칙 보조축으로만 제안합니다.",
      ],
    };
  }

  if (persist) {
    await writeReport(report);
  }
  return report;
}

async function runFromCli() {
  const report = await collectAlphaResearchReport();
  console.log(
    `[Alpha Research] source=${report.source}, techniques=${report.techniques.length}`
  );
  for (const t of report.techniques) {
    console.log(`- [${t.category}] ${t.title} (${t.priority}, 신뢰 ${t.confidence}) → ${t.implementation}`);
  }

  // Strategic owner info → commander channel (falls back to the normal chat).
  const chatId = ENV.commanderChatId || ENV.telegramChatId;
  if (chatId) {
    const top = report.techniques
      .slice(0, 5)
      .map(
        (t, i) =>
          `${i + 1}. [${t.category}] ${t.title}\n   효과: ${t.expectedEdge}\n   적용: ${t.implementation}`
      )
      .join("\n\n");
    await sendTelegramMessage(
      "🔬 알파 리서치 리포트",
      `소스: ${report.source}\n\n${top}`,
      chatId
    );
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  runFromCli().catch(error => {
    console.error("[Alpha Research] Failed:", error);
    process.exit(1);
  });
}
