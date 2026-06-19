/**
 * News / market-sentiment agent.
 *
 * Pulls recent headlines for a Korean company so the LLM market-intelligence
 * agent can factor real news into its reasoning. Tries Serper (Google News),
 * then Tavily, then NewsAPI — whichever key is present. Returns null when no
 * key is configured or in tests, so analysis degrades gracefully.
 */

import { ENV } from "./_core/env";

export type NewsSentiment = {
  source: string;
  headlines: string[];
};

const TIMEOUT_MS = 8000;

async function fetchJson(url: string, init: RequestInit): Promise<any | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchViaSerper(query: string): Promise<NewsSentiment | null> {
  const data = await fetchJson("https://google.serper.dev/news", {
    method: "POST",
    headers: { "X-API-KEY": ENV.serperApiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ q: query, gl: "kr", hl: "ko", num: 8 }),
  });
  const news = data?.news;
  if (!Array.isArray(news) || news.length === 0) return null;
  return {
    source: "Google News (Serper)",
    headlines: news
      .slice(0, 8)
      .map((n: any) => `${n.title}${n.date ? ` (${n.date})` : ""}`),
  };
}

async function fetchViaTavily(query: string): Promise<NewsSentiment | null> {
  const data = await fetchJson("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: ENV.tavilyApiKey,
      query,
      topic: "news",
      max_results: 8,
    }),
  });
  const results = data?.results;
  if (!Array.isArray(results) || results.length === 0) return null;
  return {
    source: "Tavily",
    headlines: results.slice(0, 8).map((r: any) => r.title).filter(Boolean),
  };
}

async function fetchViaNewsApi(query: string): Promise<NewsSentiment | null> {
  const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(
    query
  )}&sortBy=publishedAt&pageSize=8&apiKey=${ENV.newsApiKey}`;
  const data = await fetchJson(url, { method: "GET" });
  const articles = data?.articles;
  if (!Array.isArray(articles) || articles.length === 0) return null;
  return {
    source: "NewsAPI",
    headlines: articles.slice(0, 8).map((a: any) => a.title).filter(Boolean),
  };
}

export async function fetchNewsSentiment(companyName: string): Promise<NewsSentiment | null> {
  if (process.env.NODE_ENV === "test" || !companyName) {
    return null;
  }

  const query = `${companyName} 주가`;
  try {
    if (ENV.serperApiKey) {
      const result = await fetchViaSerper(query);
      if (result) return result;
    }
    if (ENV.tavilyApiKey) {
      const result = await fetchViaTavily(query);
      if (result) return result;
    }
    if (ENV.newsApiKey) {
      const result = await fetchViaNewsApi(query);
      if (result) return result;
    }
  } catch (error) {
    console.warn("[News] sentiment fetch failed:", error);
  }
  return null;
}

// Behavioral / economic-psychology factor: crowd-moving headline keywords.
// Loss aversion means bad news matters more, so the negative threshold is lower.
const NEGATIVE_KEYWORDS = [
  "급락", "폭락", "하한가", "적자", "영업손실", "손실", "횡령", "배임", "소송", "고소",
  "압수수색", "검찰", "조사", "감자", "상장폐지", "거래정지", "분식", "리콜", "부도",
  "회생", "워크아웃", "유상증자", "어닝쇼크", "실적쇼크", "목표가 하향", "공매도", "구속",
];
const POSITIVE_KEYWORDS = [
  "급등", "상한가", "신고가", "흑자전환", "흑자", "최대 실적", "사상 최대", "수주", "공급계약",
  "계약 체결", "승인", "허가", "신약", "목표가 상향", "자사주", "깜짝 실적", "어닝서프라이즈", "흑자 전환",
];

export type NewsState = "positive" | "negative" | "neutral";

/** Pure keyword sentiment over headlines (deterministic, no LLM cost). */
export function scoreHeadlines(headlines: string[]): {
  state: NewsState;
  score: number;
  negativeHits: string[];
  positiveHits: string[];
} {
  const text = headlines.join(" ");
  const negativeHits = NEGATIVE_KEYWORDS.filter(keyword => text.includes(keyword));
  const positiveHits = POSITIVE_KEYWORDS.filter(keyword => text.includes(keyword));
  const score = positiveHits.length - negativeHits.length;
  let state: NewsState = "neutral";
  if (score <= -1) {
    state = "negative"; // any net-negative headline flow → caution
  } else if (score >= 2) {
    state = "positive"; // require a clear positive flow
  }
  return { state, score, negativeHits, positiveHits };
}

export type NewsAssessment = { state: NewsState; note: string; headlines: string[] };

/** Fetches recent headlines and folds them into a behavioral sentiment signal. */
export async function assessNewsSentiment(companyName: string): Promise<NewsAssessment | null> {
  const sentiment = await fetchNewsSentiment(companyName);
  if (!sentiment || sentiment.headlines.length === 0) {
    return null;
  }
  const scored = scoreHeadlines(sentiment.headlines);
  if (scored.state === "neutral") {
    return { state: "neutral", note: "", headlines: sentiment.headlines };
  }
  const note =
    scored.state === "negative"
      ? `⚠ 악재성 뉴스(${scored.negativeHits.slice(0, 2).join("·")})`
      : `호재성 뉴스(${scored.positiveHits.slice(0, 2).join("·")})`;
  return { state: scored.state, note, headlines: sentiment.headlines };
}
