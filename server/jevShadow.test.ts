import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  callJev,
  jevShadowEnabled,
  maxPerRun,
  normalizeHeadlines,
  parseJevResponse,
  pickEntriesToShadow,
  readJevKey,
  recentReturns,
  runJevShadow,
  scoreJevShadow,
  type JevShadowRecord,
} from "./jevShadow";
import type { RecommendationEntry } from "./recommendationJournalAgent";

const NOW = new Date("2026-10-19T12:00:00Z");
const entry = (over: Partial<RecommendationEntry> = {}): RecommendationEntry =>
  ({ date: "2026-10-19", ticker: "005930", companyName: "삼성전자", source: "swing", triggerPrice: 100, stopLossPrice: 90, targetPrice: 120, recordedAt: "2026-10-18T21:00:00Z", status: "open", ...over }) as RecommendationEntry;

const GOOD_BODY = {
  model: "jev-1.13.0",
  answers: {
    lingering_bad_news: { type: "noul", noul: 0.54 },
    priced_in_rally: { type: "noul", noul: 0.2 },
    move_driver: { type: "choice", choice: "theme_or_flow", confidence: 0.76, probabilities: { theme_or_flow: 0.82, unclear: 0.18 } },
  },
  usage: { input_tokens: 1056, output_tokens: 95 },
};
const okFetch = (body: unknown = GOOD_BODY) => vi.fn(async () => ({ ok: true, status: 200, json: async () => body }) as Response);

describe("env switches", () => {
  it("accepts the lowercase .env.local name and the uppercase secret name", () => {
    expect(readJevKey({ TYPESAFE_AI_API_KEY: " abc " })).toBe("abc");
    expect(readJevKey({ typesafe_ai_api_key: "xyz" })).toBe("xyz");
    expect(readJevKey({ TYPESAFE_AI_API_KEY: "   " })).toBeNull(); // 빈 시크릿 = 키 없음
  });
  it("is off without a key or when JEV_SHADOW=off", () => {
    expect(jevShadowEnabled({})).toBe(false);
    expect(jevShadowEnabled({ TYPESAFE_AI_API_KEY: "k" })).toBe(true);
    expect(jevShadowEnabled({ TYPESAFE_AI_API_KEY: "k", JEV_SHADOW: "OFF" })).toBe(false);
  });
  it("maxPerRun treats an unset/empty GitHub variable as the default, not 0", () => {
    expect(maxPerRun({ JEV_SHADOW_MAX_PER_RUN: "" })).toBe(20);
    expect(maxPerRun({})).toBe(20);
    expect(maxPerRun({ JEV_SHADOW_MAX_PER_RUN: "5" })).toBe(5);
    expect(maxPerRun({ JEV_SHADOW_MAX_PER_RUN: "-3" })).toBe(20);
  });
});

describe("normalizeHeadlines", () => {
  it("parses RSS dates, drops stale/future/unparseable/duplicate items, sorts newest first, caps at 8", () => {
    const items = [
      { title: "오래된 기사", publishedAt: "Fri, 01 Aug 2026 00:00:00 GMT" },
      { title: "최신 기사", publishedAt: "Mon, 19 Oct 2026 01:00:00 GMT" },
      { title: "중간 기사", publishedAt: "Wed, 07 Oct 2026 01:00:00 GMT" },
      { title: "중간 기사", publishedAt: "Wed, 07 Oct 2026 02:00:00 GMT" },
      { title: "날짜 불량", publishedAt: "not a date" },
      { title: "미래 기사", publishedAt: "Mon, 01 Dec 2026 00:00:00 GMT" },
    ];
    const { lines, newestDate } = normalizeHeadlines(items, NOW);
    expect(lines).toEqual(["2026-10-19 최신 기사", "2026-10-07 중간 기사"]);
    expect(newestDate).toBe("2026-10-19");
    const many = Array.from({ length: 12 }, (_, i) => ({ title: `기사${i}`, publishedAt: `Mon, 19 Oct 2026 0${i % 9}:00:00 GMT` }));
    expect(normalizeHeadlines(many, NOW).lines.length).toBe(8);
  });
});

describe("recentReturns", () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ 날짜: `2026-09-${String(i + 1).padStart(2, "0")}`, 종가: 100 + i }));
  it("uses the last close on or before the signal date", () => {
    const { r5, r20 } = recentReturns(rows, "2026-09-30");
    expect(r5).toBeCloseTo(((129 / 124) - 1) * 100, 1);
    expect(r20).toBeCloseTo(((129 / 109) - 1) * 100, 1);
  });
  it("does not look past the signal date (no look-ahead)", () => {
    const early = recentReturns(rows, "2026-09-10");
    expect(early.r5).toBeCloseTo(((109 / 104) - 1) * 100, 1);
    expect(early.r20).toBeNull();
  });
  it("returns nulls for missing data", () => {
    expect(recentReturns(null, "2026-09-30")).toEqual({ r5: null, r20: null });
  });
});

describe("parseJevResponse / callJev", () => {
  it("parses noul, choice and usage", () => {
    const parsed = parseJevResponse(GOOD_BODY)!;
    expect(parsed.answers.lingeringBadNews).toBe(0.54);
    expect(parsed.answers.moveDriver?.choice).toBe("theme_or_flow");
    expect(parsed.usage).toEqual({ inputTokens: 1056, outputTokens: 95 });
    expect(parseJevResponse({ answers: {} })).toBeNull();
    expect(parseJevResponse(null)).toBeNull();
  });
  it("sends the key as a Bearer header and the fixed question set, and returns answers", async () => {
    const fetchImpl = okFetch();
    const result = await callJev({ company: "x", headlines: ["h"] }, "SECRET", { fetchImpl: fetchImpl as never });
    expect(result?.answers.pricedInRally).toBe(0.2);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer SECRET");
    const body = JSON.parse(init.body as string);
    expect(Object.keys(body.questions)).toEqual(["lingering_bad_news", "priced_in_rally", "move_driver"]);
  });
  it("retries once on 5xx and gives up quietly (null) after a second failure", async () => {
    const calls: number[] = [];
    const fetchImpl = vi.fn(async () => { calls.push(1); return { ok: false, status: 503, json: async () => ({}) } as Response; });
    const result = await callJev({}, "k", { fetchImpl: fetchImpl as never, sleep: async () => {} });
    expect(result).toBeNull();
    expect(calls.length).toBe(2);
  });
  it("does not retry a 401 and swallows network errors", async () => {
    const f401 = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }) as Response);
    expect(await callJev({}, "k", { fetchImpl: f401 as never, sleep: async () => {} })).toBeNull();
    expect(f401).toHaveBeenCalledTimes(1);
    const boom = vi.fn(async () => { throw new Error("network"); });
    expect(await callJev({}, "k", { fetchImpl: boom as never, sleep: async () => {} })).toBeNull();
  });
});

describe("pickEntriesToShadow", () => {
  it("takes recent open entries not yet recorded, real picks before watch-only, within the limit", () => {
    const journal = [
      entry({ ticker: "A", watchOnly: true }),
      entry({ ticker: "B" }),
      entry({ ticker: "C", date: "2026-10-01" }), // 너무 오래됨
      entry({ ticker: "D", status: "stop" }), // 이미 정산됨
      entry({ ticker: "E" }),
    ];
    const existing = { "2026-10-19|E": {} as JevShadowRecord };
    const picked = pickEntriesToShadow(journal, existing, "2026-10-19", 5).map(e => e.ticker);
    expect(picked).toEqual(["B", "A"]);
    expect(pickEntriesToShadow(journal, existing, "2026-10-19", 1).map(e => e.ticker)).toEqual(["B"]);
  });
});

describe("runJevShadow", () => {
  const baseDeps = async () => ({
    now: NOW,
    shadowPath: path.join(await mkdtemp(path.join(os.tmpdir(), "jev-")), "jev-shadow.json"),
    journal: [entry({ ticker: "005930" }), entry({ ticker: "000660", companyName: "SK하이닉스", watchOnly: true })],
    collectNews: vi.fn(async (cands: Array<{ ticker: string; companyName: string }>) =>
      cands.map(c => ({
        ticker: c.ticker, companyName: c.companyName, catalystScore: 2, riskScore: 0, sentimentLabel: "긍정" as const, summary: [], risks: [], catalysts: [],
        items: c.ticker === "005930" ? [{ title: "삼성전자 수주", source: "s", link: "l", publishedAt: "Mon, 19 Oct 2026 01:00:00 GMT", sentiment: "positive" as const }] : [],
      }))
    ),
    fetchBars: vi.fn(async () => ({ "005930": [{ 날짜: "2026-10-19", 종가: 100 }] as never, "000660": null })),
    sleep: async () => {},
  });

  it("records answers for tickers with headlines and a baseline-only record when there are none, never writing the key", async () => {
    const deps = await baseDeps();
    const fetchImpl = okFetch();
    const summary = await runJevShadow({ ...deps, env: { TYPESAFE_AI_API_KEY: "TOPSECRET" }, fetchImpl: fetchImpl as never });
    expect(summary).toMatchObject({ enabled: true, selected: 2, recorded: 2, asked: 1, skippedNoHeadlines: 1, failed: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(1); // 헤드라인 없는 종목은 호출하지 않는다
    const raw = await readFile(deps.shadowPath, "utf8");
    expect(raw).not.toContain("TOPSECRET");
    const file = JSON.parse(raw);
    expect(file.records["2026-10-19|005930"].answers.lingeringBadNews).toBe(0.54);
    expect(file.records["2026-10-19|005930"].baseline.sentimentLabel).toBe("긍정");
    expect(file.records["2026-10-19|000660"].answers).toBeNull();
    expect(file.records["2026-10-19|000660"].skippedReason).toBe("no_headlines");
  });

  it("is idempotent: a second run asks nothing new", async () => {
    const deps = await baseDeps();
    const fetchImpl = okFetch();
    await runJevShadow({ ...deps, env: { TYPESAFE_AI_API_KEY: "k" }, fetchImpl: fetchImpl as never });
    const second = await runJevShadow({ ...deps, env: { TYPESAFE_AI_API_KEY: "k" }, fetchImpl: fetchImpl as never });
    expect(second.selected).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("an API failure is not stored (so it is retried) and never throws", async () => {
    const deps = await baseDeps();
    const bad = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }) as Response);
    const summary = await runJevShadow({ ...deps, env: { TYPESAFE_AI_API_KEY: "k" }, fetchImpl: bad as never });
    expect(summary.failed).toBe(1);
    const file = JSON.parse(await readFile(deps.shadowPath, "utf8"));
    expect(file.records["2026-10-19|005930"]).toBeUndefined();
    const retry = await runJevShadow({ ...deps, env: { TYPESAFE_AI_API_KEY: "k" }, fetchImpl: okFetch() as never });
    expect(retry.asked).toBe(1);
  });

  it("does nothing without a key or when switched off", async () => {
    const deps = await baseDeps();
    const fetchImpl = okFetch();
    expect((await runJevShadow({ ...deps, env: {}, fetchImpl: fetchImpl as never })).enabled).toBe(false);
    expect((await runJevShadow({ ...deps, env: { TYPESAFE_AI_API_KEY: "k", JEV_SHADOW: "off" }, fetchImpl: fetchImpl as never })).enabled).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(deps.collectNews).not.toHaveBeenCalled();
  });

  it("swallows a crashing news collector", async () => {
    const deps = await baseDeps();
    deps.collectNews = vi.fn(async () => { throw new Error("rss down"); });
    const summary = await runJevShadow({ ...deps, env: { TYPESAFE_AI_API_KEY: "k" }, fetchImpl: okFetch() as never });
    expect(summary.recorded).toBe(2); // 뉴스 없이 기준선 자료부족으로 기록
    expect(summary.asked).toBe(0);
  });
});

describe("scoreJevShadow", () => {
  const rec = (key: string, q1: number, label = "중립"): JevShadowRecord =>
    ({ key, date: key.split("|")[0], ticker: key.split("|")[1], companyName: "", watchOnly: false, asOf: "", questionsVersion: "q", model: null, headlineCount: 3, newestHeadlineDate: null, return5dPct: null, return20dPct: null, answers: { lingeringBadNews: q1, pricedInRally: 0.1, moveDriver: null }, baseline: { sentimentLabel: label, riskScore: 0, catalystScore: 0 }, usage: null }) as JevShadowRecord;
  const settled = (ticker: string, returnPct: number, status: RecommendationEntry["status"] = "time_exit") => entry({ ticker, status, returnPct, triggerPrice: 100, stopLossPrice: 90 });

  it("splits settled trades by the pre-registered thresholds and reports R means (risk = 10%)", () => {
    const journal = [settled("A", -10, "stop"), settled("B", 5), settled("C", 10, "trail_exit"), entry({ ticker: "D" })];
    const records = [rec("2026-10-19|A", 0.8, "부정"), rec("2026-10-19|B", 0.1), rec("2026-10-19|C", 0.2), rec("2026-10-19|D", 0.9)];
    const score = scoreJevShadow(records, journal);
    expect(score.settledWithAnswers).toBe(3); // D는 아직 열려 있어 제외
    const q1 = score.rows[0];
    expect(q1.nHigh).toBe(1);
    expect(q1.meanRHigh).toBeCloseTo(-1, 5);
    expect(q1.nLow).toBe(2);
    expect(q1.meanRLow).toBeCloseTo((0.5 + 1) / 2, 5);
    expect(q1.diff).toBeCloseTo(-1.75, 5);
    expect(score.rows[2].nHigh).toBe(1); // 기준선: 키워드 '부정'
    expect(score.verdict).toContain("표본 부족");
  });

  it("excludes no_entry and open entries and records without answers", () => {
    const journal = [settled("A", 5), entry({ ticker: "N", status: "no_entry" })];
    const noAnswer = { ...rec("2026-10-19|A", 0.5), answers: null } as JevShadowRecord;
    const score = scoreJevShadow([noAnswer, rec("2026-10-19|N", 0.9)], journal);
    expect(score.settledWithAnswers).toBe(0);
    expect(score.rows[0].nHigh + score.rows[0].nLow).toBe(0);
  });
});
