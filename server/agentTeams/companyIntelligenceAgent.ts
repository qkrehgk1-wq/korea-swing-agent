type CompanyCandidate = {
  ticker: string;
  companyName: string;
};

export type CompanyNewsItem = {
  title: string;
  source: string;
  link: string;
  publishedAt: string;
  sentiment: "positive" | "negative" | "neutral";
};

export type CompanyIntelligenceInsight = {
  ticker: string;
  companyName: string;
  items: CompanyNewsItem[];
  catalystScore: number;
  riskScore: number;
  sentimentLabel: "긍정" | "중립" | "부정" | "자료부족";
  summary: string[];
  risks: string[];
  catalysts: string[];
};

const POSITIVE_KEYWORDS = [
  "수주",
  "계약",
  "흑자",
  "실적",
  "성장",
  "증가",
  "상향",
  "목표가",
  "매수",
  "돌파",
  "호조",
  "신고가",
  "승인",
  "공급",
  "협력",
];

const NEGATIVE_KEYWORDS = [
  "적자",
  "감소",
  "하락",
  "급락",
  "소송",
  "조사",
  "리콜",
  "부진",
  "하향",
  "매도",
  "경고",
  "리스크",
  "중단",
  "취소",
  "유상증자",
];

function uniqueCandidates(candidates: CompanyCandidate[]) {
  const seen = new Set<string>();
  return candidates.filter(candidate => {
    if (seen.has(candidate.ticker)) {
      return false;
    }
    seen.add(candidate.ticker);
    return true;
  });
}

function stripCdata(value: string) {
  return value.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "").trim();
}

function decodeXml(value: string) {
  return stripCdata(value)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function getTag(item: string, tag: string) {
  const match = item.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? decodeXml(match[1]) : "";
}

function isRecentPublishedAt(value: string, days = 120) {
  const publishedAt = Date.parse(value);
  if (!Number.isFinite(publishedAt)) {
    return false;
  }

  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return publishedAt >= cutoff;
}

function classifyTitle(title: string): CompanyNewsItem["sentiment"] {
  const positiveHits = POSITIVE_KEYWORDS.filter(keyword => title.includes(keyword)).length;
  const negativeHits = NEGATIVE_KEYWORDS.filter(keyword => title.includes(keyword)).length;

  if (positiveHits > negativeHits) {
    return "positive";
  }
  if (negativeHits > positiveHits) {
    return "negative";
  }
  return "neutral";
}

function parseGoogleNewsRss(xml: string): CompanyNewsItem[] {
  return Array.from(xml.matchAll(/<item>([\s\S]*?)<\/item>/gi))
    .map(match => {
      const rawItem = match[1];
      const title = getTag(rawItem, "title");
      const source = getTag(rawItem, "source") || "Google News";
      const link = getTag(rawItem, "link");
      const publishedAt = getTag(rawItem, "pubDate");

      return {
        title,
        source,
        link,
        publishedAt,
        sentiment: classifyTitle(title),
      };
    })
    .filter(item => Boolean(item.title) && isRecentPublishedAt(item.publishedAt))
    .slice(0, 5);
}

async function fetchWithTimeout(url: string, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "billionaire-stock-agent/1.0",
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchCompanyNews(candidate: CompanyCandidate): Promise<CompanyNewsItem[]> {
  if (process.env.COMPANY_INTELLIGENCE_ENABLED === "false") {
    return [];
  }

  const query = encodeURIComponent(`${candidate.companyName} ${candidate.ticker} 주식`);
  const url = `https://news.google.com/rss/search?q=${query}&hl=ko&gl=KR&ceid=KR:ko`;

  try {
    const response = await fetchWithTimeout(url);
    if (!response.ok) {
      console.warn(`[Company_Intelligence] News fetch failed for ${candidate.ticker}: ${response.status}`);
      return [];
    }

    return parseGoogleNewsRss(await response.text());
  } catch (error) {
    console.warn(`[Company_Intelligence] News fetch error for ${candidate.ticker}:`, error);
    return [];
  }
}

function summarizeInsight(candidate: CompanyCandidate, items: CompanyNewsItem[]): CompanyIntelligenceInsight {
  const positive = items.filter(item => item.sentiment === "positive");
  const negative = items.filter(item => item.sentiment === "negative");
  const catalystScore = positive.length * 2 + items.filter(item => item.title.includes("실적")).length;
  const riskScore = negative.length * 2;
  const sentimentLabel =
    items.length === 0
      ? "자료부족"
      : catalystScore > riskScore
        ? "긍정"
        : riskScore > catalystScore
          ? "부정"
          : "중립";

  return {
    ticker: candidate.ticker,
    companyName: candidate.companyName,
    items,
    catalystScore,
    riskScore,
    sentimentLabel,
    summary: items.length
      ? items.slice(0, 3).map(item => `${item.source}: ${item.title}`)
      : ["최근 뉴스/RSS 자료를 안정적으로 확보하지 못했습니다."],
    risks: negative.slice(0, 2).map(item => item.title),
    catalysts: positive.slice(0, 2).map(item => item.title),
  };
}

export async function collectCompanyIntelligence(
  candidates: CompanyCandidate[]
): Promise<CompanyIntelligenceInsight[]> {
  const unique = uniqueCandidates(candidates).slice(0, 8);
  const insights = await Promise.all(
    unique.map(async candidate => summarizeInsight(candidate, await fetchCompanyNews(candidate)))
  );

  return insights;
}
