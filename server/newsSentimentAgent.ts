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
