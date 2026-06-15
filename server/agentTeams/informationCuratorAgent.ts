import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { collectDanteLearningReport, type DanteStrategyRule } from "./youtubeLearningAgent";

export type CuratedTechniqueCategory =
  | "regime"
  | "support-resistance"
  | "robustness"
  | "chart-vision";

export type CuratedTechniqueFinding = {
  title: string;
  source: string;
  publishedAt: string;
  url: string;
  category: CuratedTechniqueCategory;
  summary: string;
  takeaway: string;
  fitScore: number;
  implementationPlan: string;
  guardrail: string;
  targetFiles: string[];
};

export type InformationCuratorReport = {
  generatedAt: string;
  findings: CuratedTechniqueFinding[];
  notes: string[];
};

type FeedEntry = {
  title: string;
  summary: string;
  publishedAt: string;
  url: string;
};

type CuratorFeed = {
  source: string;
  url: string;
  category: CuratedTechniqueCategory;
};

const REPORT_DIR = path.join(process.cwd(), ".data", "information-curator");

const DEFAULT_CURATOR_FEEDS: CuratorFeed[] = [
  {
    source: "arXiv q-fin regime",
    url: "https://export.arxiv.org/api/query?search_query=all:(market%20regime%20volatility%20trading)&start=0&max_results=6&sortBy=submittedDate&sortOrder=descending",
    category: "regime",
  },
  {
    source: "arXiv q-fin support-resistance",
    url: "https://export.arxiv.org/api/query?search_query=all:(support%20resistance%20technical%20analysis%20stock)&start=0&max_results=6&sortBy=submittedDate&sortOrder=descending",
    category: "support-resistance",
  },
  {
    source: "arXiv cs.LG robustness",
    url: "https://export.arxiv.org/api/query?search_query=all:(out-of-distribution%20time-series%20forecasting%20finance)&start=0&max_results=6&sortBy=submittedDate&sortOrder=descending",
    category: "robustness",
  },
  {
    source: "arXiv candlestick vision",
    url: "https://export.arxiv.org/api/query?search_query=all:(candlestick%20chart%20forecasting%20stock)&start=0&max_results=6&sortBy=submittedDate&sortOrder=descending",
    category: "chart-vision",
  },
];

const FINANCE_KEYWORDS = [
  "stock",
  "stocks",
  "equity",
  "equities",
  "market",
  "markets",
  "trading",
  "price",
  "prices",
  "momentum",
  "volatility",
  "financial",
  "finance",
  "asset",
  "assets",
  "return",
  "returns",
  "candlestick",
  "technical analysis",
  "time series",
];

const REJECT_KEYWORDS = [
  "document parsing",
  "document understanding",
  "ocr",
  "layout analysis",
  "page-level",
  "rag",
  "pdf",
  "vision-language model",
  "vlm-based ocr",
  "post-processing model",
  "newton polytope",
  "bézout",
  "tropical geometry",
  "hypersurface",
  "lattice indices",
  "medical",
  "protein",
  "robot",
  "autonomous driving",
];

const CATEGORY_KEYWORDS: Record<
  CuratedTechniqueCategory,
  {
    requiredAny: string[];
    preferredAny: string[];
  }
> = {
  regime: {
    requiredAny: ["regime", "volatility", "drawdown", "state switching"],
    preferredAny: ["trend", "risk-on", "risk-off", "allocation", "momentum"],
  },
  "support-resistance": {
    requiredAny: ["support", "resistance", "breakout", "pivot"],
    preferredAny: ["price level", "technical analysis", "candlestick", "trendline"],
  },
  robustness: {
    requiredAny: ["out-of-distribution", "distribution shift", "robustness", "invariant"],
    preferredAny: ["time series", "generalization", "regime", "market"],
  },
  "chart-vision": {
    requiredAny: ["candlestick", "chart pattern", "price chart", "chart"],
    preferredAny: ["technical analysis", "stock", "market", "time series"],
  },
};

function decodeXml(value: string) {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function stripTags(value: string) {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function firstMatch(text: string, pattern: RegExp) {
  const match = text.match(pattern);
  return match?.[1] ? decodeXml(stripTags(match[1])) : "";
}

export function parseCuratorAtomFeed(xml: string): FeedEntry[] {
  const entries = xml.match(/<entry[\s\S]*?<\/entry>/g) ?? [];

  return entries
    .map(entry => {
      const title = firstMatch(entry, /<title[^>]*>([\s\S]*?)<\/title>/);
      const summary = firstMatch(entry, /<summary[^>]*>([\s\S]*?)<\/summary>/);
      const publishedAt =
        firstMatch(entry, /<published>([\s\S]*?)<\/published>/) ||
        firstMatch(entry, /<updated>([\s\S]*?)<\/updated>/);
      const id = firstMatch(entry, /<id>([\s\S]*?)<\/id>/);
      const link = entry.match(/<link[^>]+href="([^"]+)"/)?.[1] ?? id;

      if (!title || !link) {
        return null;
      }

      return {
        title,
        summary,
        publishedAt,
        url: decodeXml(link),
      };
    })
    .filter((entry): entry is FeedEntry => Boolean(entry));
}

function countKeywordHits(text: string, keywords: string[]) {
  return keywords.reduce((count, keyword) => count + (text.includes(keyword) ? 1 : 0), 0);
}

function containsKeyword(text: string, keywords: string[]) {
  return keywords.some(keyword => text.includes(keyword));
}

function normalizeResearchText(text: string) {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function isRelevantCategory(category: CuratedTechniqueCategory, text: string) {
  const normalized = normalizeResearchText(text);
  const rule = CATEGORY_KEYWORDS[category];
  const hasFinanceAnchor = containsKeyword(normalized, FINANCE_KEYWORDS);
  const hasCategoryAnchor = containsKeyword(normalized, rule.requiredAny);
  const rejectHit = containsKeyword(normalized, REJECT_KEYWORDS);

  if (rejectHit || !hasFinanceAnchor || !hasCategoryAnchor) {
    return false;
  }

  if (category === "chart-vision" && !containsKeyword(normalized, ["stock", "market", "trading", "price"])) {
    return false;
  }

  if (category === "support-resistance" && !containsKeyword(normalized, ["price", "stock", "trading", "market"])) {
    return false;
  }

  return true;
}

function deriveResearchStrength(category: CuratedTechniqueCategory, text: string) {
  const normalized = text.toLowerCase();
  const rule = CATEGORY_KEYWORDS[category];

  return (
    countKeywordHits(normalized, FINANCE_KEYWORDS) * 5 +
    countKeywordHits(normalized, rule.requiredAny) * 10 +
    countKeywordHits(normalized, rule.preferredAny) * 4 -
    countKeywordHits(normalized, REJECT_KEYWORDS) * 25
  );
}

function deriveTakeaway(category: CuratedTechniqueCategory, text: string) {
  switch (category) {
    case "regime":
      return "장세를 단일 점수로 보지 말고, 변동성/혼돈 국면별로 승인 기준을 다르게 두는 편이 유리합니다.";
    case "support-resistance":
      return "트리거와 손절을 고정 배율 대신 동적 지지/저항 구조에서 뽑아내는 쪽이 더 구조적입니다.";
    case "robustness":
      return "장세 전환 구간에서도 유지되는 불변 피처를 따로 관리해야 백테스트 과최적화를 줄일 수 있습니다.";
    case "chart-vision":
      return "차트 이미지만으로 예측력을 기대하기보다, 멀티스케일 구조를 보조신호로 제한하는 편이 안전합니다.";
  }
}

function deriveFitScore(category: CuratedTechniqueCategory, text: string) {
  const normalized = normalizeResearchText(text);
  let score = 45 + deriveResearchStrength(category, normalized);

  if (containsKeyword(normalized, ["stock", "stocks", "market", "markets", "equity", "equities"])) {
    score += 8;
  }
  if (containsKeyword(normalized, ["technical analysis", "candlestick", "chart pattern"])) {
    score += 8;
  }
  if (containsKeyword(normalized, ["volatility", "regime", "drawdown", "state switching"])) {
    score += category === "regime" || category === "robustness" ? 12 : 4;
  }
  if (containsKeyword(normalized, ["support", "resistance", "breakout", "pivot"])) {
    score += category === "support-resistance" ? 12 : 0;
  }
  if (containsKeyword(normalized, ["out-of-distribution", "invariant", "robustness", "distribution shift"])) {
    score += category === "robustness" ? 12 : 0;
  }
  if (containsKeyword(normalized, ["cnn", "transformer", "vision transformer"])) {
    score += category === "chart-vision" ? 8 : 0;
  }
  if (containsKeyword(normalized, ["crypto", "intraday", "high-frequency"])) {
    score -= 12;
  }
  if (containsKeyword(normalized, REJECT_KEYWORDS)) {
    score -= 35;
  }

  return Math.max(0, Math.min(100, score));
}

function deriveImplementationPlan(category: CuratedTechniqueCategory) {
  switch (category) {
    case "regime":
      return "marketRegimeScore와 승인 임계값을 연동하는 장세별 approval policy 실험을 추가합니다.";
    case "support-resistance":
      return "triggerPrice/stopLossPrice 산출 로직에 동적 지지·저항 후보 레벨 계산을 백테스트용으로 먼저 붙입니다.";
    case "robustness":
      return "백테스트 리포트를 국면별로 분리하고, 국면 공통으로 살아남는 피처만 learned override에 반영합니다.";
    case "chart-vision":
      return "차트 이미지 모델은 주 신호가 아니라 보조 검증기로만 실험하고, 일단은 멀티스케일 차트 요약 규칙만 추출합니다.";
  }
}

function deriveGuardrail(category: CuratedTechniqueCategory, text: string) {
  const normalized = text.toLowerCase();

  if (normalized.includes("crypto")) {
    return "암호자산 중심 결과는 KRX 일봉 스윙에 바로 주입하지 말고 분리 검증합니다.";
  }
  if (normalized.includes("intraday") || normalized.includes("high-frequency")) {
    return "초단타 전제 기법은 현재 일봉 스윙 파이프라인에 직접 이식하지 않습니다.";
  }

  switch (category) {
    case "regime":
      return "장세 필터는 승인 완화/강화 보조축으로만 쓰고, 패턴 자체를 대체하지 않습니다.";
    case "support-resistance":
      return "동적 지지·저항 레벨은 실거래 신호가 아니라 trigger/stop 백테스트 개선용으로만 사용합니다.";
    case "robustness":
      return "OOD 강건성 기법은 최근 성능이 좋아 보여도 최소 2개 장세 구간 백테스트 전에는 운영 반영하지 않습니다.";
    case "chart-vision":
      return "이미지 기반 판정은 현재 VLM/CNN 한계가 커서 최종 승인 근거로 단독 사용하지 않습니다.";
  }
}

function deriveTargetFiles(category: CuratedTechniqueCategory) {
  switch (category) {
    case "regime":
      return ["server/technicalSwingScreener.ts", "server/agentTeams/orchestrator.ts", "server/swingAdaptiveLearning.ts"];
    case "support-resistance":
      return ["server/technicalSwingScreener.ts", "server/limitUpPredictionAgent.ts", "server/firstLimitUpFollowThroughAgent.ts"];
    case "robustness":
      return ["server/swingBacktestAgent.ts", "server/swingAdaptiveLearning.ts", "server/agentTeams/selfReviewAgent.ts"];
    case "chart-vision":
      return ["server/agentTeams/youtubeLearningAgent.ts", "server/agentTeams/orchestrator.ts", "server/notificationService.ts"];
  }
}

function mapDanteRuleCategory(rule: DanteStrategyRule): CuratedTechniqueCategory {
  switch (rule.id) {
    case "bowl-right-side":
    case "base-candle-pullback":
    case "stop-loss-invalidated":
      return "support-resistance";
    case "technical-chart-discipline":
    case "avoid-overheated-chase":
      return "chart-vision";
    case "market-leader-flow":
      return "regime";
    case "volume-before-price":
      return "robustness";
    default:
      return "chart-vision";
  }
}

function deriveDanteImplementationPlan(rule: DanteStrategyRule) {
  switch (rule.id) {
    case "bowl-right-side":
      return "밥그릇 1번자리/2번자리 판별에서 20일선 회복과 우측 거래량 회복을 점수화해 승인 전 후보 필터로 붙입니다.";
    case "base-candle-pullback":
      return "기준봉 이후 눌림목 구간을 별도 태깅해 triggerPrice를 기준봉 상단 재돌파형과 눌림 저점형으로 분리합니다.";
    case "market-leader-flow":
      return "주도주/수급 흔적이 보이는 후보에만 돌파매매 가산점을 주는 장세별 approval policy를 실험합니다.";
    case "volume-before-price":
      return "가격 신호보다 거래량 선행 여부를 먼저 확인하도록 volumeRatio 기반 컷오프를 백테스트에서 재학습합니다.";
    case "stop-loss-invalidated":
      return "저점 이탈·기준선 이탈을 패턴별 무효화 규칙으로 표준화해 stopLossPrice 산출 일관성을 높입니다.";
    case "avoid-overheated-chase":
      return "신고가 돌파 후보는 추격 과열 감점과 손절폭 검증을 함께 넣어 승인 0건 drift를 줄이는 방향으로 튜닝합니다.";
    default:
      return "Dante 규칙을 현재 패턴 승인 로직의 보조 점수로만 연결하고, 실전 반영 전에는 보류후보 재평가부터 수행합니다.";
  }
}

function buildDanteFallbackFindings(reportGeneratedAt: string, rules: DanteStrategyRule[]): CuratedTechniqueFinding[] {
  return rules.slice(0, 3).map(rule => {
    const category = mapDanteRuleCategory(rule);
    return {
      title: `[Dante House View] ${rule.label}`,
      source: "YouTube Learning Team",
      publishedAt: reportGeneratedAt,
      url: "https://www.youtube.com/@%EC%A3%BC%EC%8B%9D%EB%8B%A8%ED%85%8C_20%EB%85%84%EC%B0%A8%ED%8A%B8%EA%B3%A0%EC%88%98",
      category,
      summary: rule.summary,
      takeaway: `${rule.label} 규칙은 현재 스윙 승인 로직에서 재현 가능한 내부 기준선으로 유지할 가치가 있습니다.`,
      fitScore: Math.min(92, Math.max(72, rule.confidence)),
      implementationPlan: deriveDanteImplementationPlan(rule),
      guardrail: "Dante 규칙은 외부 최신 논문 대체물이 아니라, 우리 전략 문맥을 유지하는 내부 기준선으로만 사용합니다.",
      targetFiles: deriveTargetFiles(category),
    };
  });
}

async function writeReport(report: InformationCuratorReport) {
  await mkdir(REPORT_DIR, { recursive: true });
  const jsonPath = path.join(REPORT_DIR, "latest-report.json");
  const mdPath = path.join(REPORT_DIR, "latest-report.md");
  const markdown = [
    "# Information Curator Report",
    "",
    `- Generated: ${report.generatedAt}`,
    "",
    "## Findings",
    ...(report.findings.length
      ? report.findings.flatMap(item => [
          `- [${item.category}] ${item.source}: ${item.title}`,
          `  - Published: ${item.publishedAt}`,
          `  - Fit score: ${item.fitScore}`,
          `  - Takeaway: ${item.takeaway}`,
          `  - Plan: ${item.implementationPlan}`,
          `  - Guardrail: ${item.guardrail}`,
        ])
      : ["- 없음"]),
    "",
    "## Notes",
    ...report.notes.map(item => `- ${item}`),
  ].join("\n");

  await Promise.all([
    writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8"),
    writeFile(mdPath, `${markdown}\n`, "utf8"),
  ]);
}

async function sleep(ms: number) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchFeedWithRetry(
  fetchImpl: typeof fetch,
  feed: CuratorFeed,
  retries = 2
) {
  let attempt = 0;
  let lastStatus: number | undefined;
  let lastMessage = "";

  while (attempt <= retries) {
    try {
      const response = await fetchImpl(feed.url, {
        headers: {
          "user-agent": "Mozilla/5.0 (compatible; BillionaireStockAgent/1.0; +https://arxiv.org)",
          accept: "application/atom+xml,text/xml;q=0.9,*/*;q=0.8",
        },
      });

      if (response.ok) {
        return response;
      }

      lastStatus = response.status;
      lastMessage = `feed fetch failed (${response.status})`;
      if (![429, 500, 502, 503, 504].includes(response.status) || attempt === retries) {
        return response;
      }
    } catch (error) {
      lastMessage = error instanceof Error ? error.message : String(error);
      if (attempt === retries) {
        throw error;
      }
    }

    attempt += 1;
    await sleep(900 * attempt);
  }

  throw new Error(lastMessage || `feed fetch failed (${lastStatus ?? "unknown"})`);
}

export async function collectInformationCuratorReport(options: {
  feeds?: CuratorFeed[];
  fetchImpl?: typeof fetch;
  maxFindings?: number;
  now?: Date;
  danteCollector?: typeof collectDanteLearningReport;
} = {}): Promise<InformationCuratorReport> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const feeds = options.feeds ?? DEFAULT_CURATOR_FEEDS;
  const maxFindings = options.maxFindings ?? 8;
  const now = options.now ?? new Date();
  const danteCollector = options.danteCollector ?? collectDanteLearningReport;
  const findings: CuratedTechniqueFinding[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();

  for (const feed of feeds) {
    try {
      const response = await fetchFeedWithRetry(fetchImpl, feed);
      if (!response.ok) {
        notes.push(`${feed.source}: feed fetch failed (${response.status})`);
        continue;
      }

      const entries = parseCuratorAtomFeed(await response.text());
      for (const entry of entries) {
        const dedupeKey = `${feed.category}|${entry.title.toLowerCase()}`;
        if (seen.has(dedupeKey)) {
          continue;
        }
        seen.add(dedupeKey);
        const text = `${entry.title} ${entry.summary}`;
        if (!isRelevantCategory(feed.category, text)) {
          continue;
        }

        findings.push({
          title: entry.title,
          source: feed.source,
          publishedAt: entry.publishedAt,
          url: entry.url,
          category: feed.category,
          summary: entry.summary.slice(0, 320),
          takeaway: deriveTakeaway(feed.category, text),
          fitScore: deriveFitScore(feed.category, text),
          implementationPlan: deriveImplementationPlan(feed.category),
          guardrail: deriveGuardrail(feed.category, text),
          targetFiles: deriveTargetFiles(feed.category),
        });
      }

      await sleep(350);
    } catch (error) {
      notes.push(`${feed.source}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (!findings.length) {
    try {
      const danteLearning = await danteCollector({
        maxVideos: 18,
        transcriptLimit: 4,
        timeoutMs: 6000,
      });
      findings.push(...buildDanteFallbackFindings(danteLearning.generatedAt, danteLearning.rules));
      notes.push(`external feed fallback used: Dante house-view ${danteLearning.rules.length} rules`);
    } catch (error) {
      notes.push(`Dante fallback unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const report: InformationCuratorReport = {
    generatedAt: now.toISOString(),
    findings: findings.sort((a, b) => b.fitScore - a.fitScore).slice(0, maxFindings),
    notes: [
      ...notes,
      "정보관 에이전트는 최신 기법을 바로 추천 로직에 넣지 않고, 우리 패턴/승인/백테스트 체계에 맞는 번역 결과만 남깁니다.",
      "논문/최신 소스의 목적은 아이디어 수집이며, 운영 반영 전에는 반드시 백테스트 또는 보류후보 재평가가 필요합니다.",
    ],
  };

  await writeReport(report);
  return report;
}

async function runFromCli() {
  const report = await collectInformationCuratorReport();
  console.log(
    "[Information Curator Agent] Findings:",
    report.findings.slice(0, 5).map(item => `${item.category}:${item.title}`).join(" | ") || "없음"
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  runFromCli().catch(error => {
    console.error("[Information Curator Agent] Failed:", error);
    process.exit(1);
  });
}
