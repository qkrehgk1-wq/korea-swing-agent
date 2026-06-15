export type StrategyResearchFinding = {
  title: string;
  source: string;
  publishedAt: string;
  url: string;
  summary: string;
  relevanceScore: number;
  adoptionIdea: string;
  caution: string;
};

export type StrategyDiscoveryReport = {
  generatedAt: string;
  findings: StrategyResearchFinding[];
  notes: string[];
};

type FeedEntry = {
  title: string;
  summary: string;
  publishedAt: string;
  url: string;
};

type StrategyFeed = {
  source: string;
  url: string;
};

const DEFAULT_STRATEGY_FEEDS: StrategyFeed[] = [
  {
    source: "arXiv q-fin",
    url: "https://export.arxiv.org/api/query?search_query=all:(market%20regime%20OR%20momentum%20trading%20OR%20technical%20analysis)&start=0&max_results=6&sortBy=submittedDate&sortOrder=descending",
  },
  {
    source: "arXiv cs.LG",
    url: "https://export.arxiv.org/api/query?search_query=all:(time%20series%20forecasting%20finance%20OR%20sequence%20model%20trading)&start=0&max_results=6&sortBy=submittedDate&sortOrder=descending",
  },
];

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

export function parseAtomFeed(xml: string): FeedEntry[] {
  const entries = xml.match(/<entry[\s\S]*?<\/entry>/g) ?? [];

  return entries
    .map(entry => {
      const title = firstMatch(entry, /<title[^>]*>([\s\S]*?)<\/title>/);
      const summary = firstMatch(entry, /<summary[^>]*>([\s\S]*?)<\/summary>/);
      const publishedAt = firstMatch(entry, /<published>([\s\S]*?)<\/published>/) ||
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

function keywordScore(text: string) {
  const positiveKeywords = [
    "market regime",
    "momentum",
    "breakout",
    "technical analysis",
    "time series",
    "risk",
    "volatility",
    "reinforcement learning",
    "forecast",
  ];
  const cautionKeywords = ["crypto", "high-frequency", "options", "derivative", "intraday only"];
  const normalized = text.toLowerCase();
  const positiveHits = positiveKeywords.filter(keyword => normalized.includes(keyword)).length;
  const cautionHits = cautionKeywords.filter(keyword => normalized.includes(keyword)).length;
  return Math.max(0, Math.min(100, 45 + positiveHits * 10 - cautionHits * 4));
}

function isRelevantResearch(text: string) {
  const normalized = text.toLowerCase();
  const financeKeywords = [
    "market",
    "trading",
    "momentum",
    "technical analysis",
    "volatility",
    "time series",
    "financial",
    "portfolio",
    "asset",
    "price",
    "forecast",
    "regime",
    "risk",
  ];
  const excludedKeywords = [
    "quantum",
    "particle",
    "physics",
    "standard model",
    "exciton",
    "reed-muller",
    "causally definite",
    "video-llm",
  ];
  const financeHits = financeKeywords.filter(keyword => normalized.includes(keyword)).length;
  const excludedHits = excludedKeywords.filter(keyword => normalized.includes(keyword)).length;

  return financeHits >= 2 && excludedHits === 0;
}

function deriveAdoptionIdea(text: string) {
  const normalized = text.toLowerCase();

  if (normalized.includes("market regime") || normalized.includes("volatility")) {
    return "장세 분류 필터를 추가해 패턴별 점수와 승인 기준을 장세별로 다르게 적용합니다.";
  }
  if (normalized.includes("momentum") || normalized.includes("breakout")) {
    return "돌파매매와 상한가 예측 로직에 모멘텀 지속 시간과 거래량 가속도 피처를 추가합니다.";
  }
  if (normalized.includes("risk")) {
    return "손절폭 대신 변동성 기반 포지션 사이징 보정 로직을 실험합니다.";
  }
  if (normalized.includes("time series") || normalized.includes("forecast")) {
    return "패턴 점수 앞단에 시계열 확률 점수 보조축을 붙이는 백테스트를 설계합니다.";
  }
  return "기존 차트/거래량 규칙과 충돌하지 않는 보조 피처로 샌드박스 백테스트를 진행합니다.";
}

function deriveCaution(text: string) {
  const normalized = text.toLowerCase();

  if (normalized.includes("high-frequency") || normalized.includes("intraday")) {
    return "현재 시스템은 일봉 스윙 중심이라 초단타 논문은 바로 이식하면 왜곡될 수 있습니다.";
  }
  if (normalized.includes("crypto")) {
    return "암호자산 데이터 특성은 KRX 일봉 종목과 달라 직접 이식 전에 분리 검증이 필요합니다.";
  }
  if (normalized.includes("derivative") || normalized.includes("options")) {
    return "파생상품 기반 기법은 현물 스윙 추천에 그대로 넣지 말고 리스크 필터로만 제한 검토합니다.";
  }
  return "새 기법은 실전 반영 전에 백테스트와 보류 후보 재평가 구간에서 먼저 검증해야 합니다.";
}

export async function collectStrategyDiscoveryReport(options: {
  feeds?: StrategyFeed[];
  fetchImpl?: typeof fetch;
  maxFindings?: number;
  now?: Date;
} = {}): Promise<StrategyDiscoveryReport> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const feeds = options.feeds ?? DEFAULT_STRATEGY_FEEDS;
  const maxFindings = options.maxFindings ?? 6;
  const now = options.now ?? new Date();
  const notes: string[] = [];
  const findings: StrategyResearchFinding[] = [];
  const seen = new Set<string>();

  for (const feed of feeds) {
    try {
      const response = await fetchImpl(feed.url, {
        headers: {
          "user-agent": "Mozilla/5.0",
        },
      });
      if (!response.ok) {
        notes.push(`${feed.source}: feed fetch failed (${response.status})`);
        continue;
      }
      const entries = parseAtomFeed(await response.text());
      for (const entry of entries) {
        const dedupeKey = `${entry.title.toLowerCase()}|${entry.url}`;
        if (seen.has(dedupeKey)) {
          continue;
        }
        seen.add(dedupeKey);
        const text = `${entry.title} ${entry.summary}`;
        if (!isRelevantResearch(text)) {
          continue;
        }
        findings.push({
          title: entry.title,
          source: feed.source,
          publishedAt: entry.publishedAt,
          url: entry.url,
          summary: entry.summary.slice(0, 320),
          relevanceScore: keywordScore(text),
          adoptionIdea: deriveAdoptionIdea(text),
          caution: deriveCaution(text),
        });
      }
    } catch (error) {
      notes.push(`${feed.source}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    generatedAt: now.toISOString(),
    findings: findings
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .slice(0, maxFindings),
    notes: [
      ...notes,
      "Strategy Scout Team은 최신 기법을 바로 매수 규칙으로 넣지 않고, 백테스트 후보와 규칙 보조축으로만 제안합니다.",
    ],
  };
}
