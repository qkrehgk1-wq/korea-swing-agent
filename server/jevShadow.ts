/**
 * Jev(TypeSafe System One) 섀도 모드 — 결과를 기록만 하고 알림·점수·주문에는 전혀 관여하지 않는다.
 *
 * 목적: "Jev의 판단이 실제 성과(R)를 가르는가"를 자동매매 없이 측정할 증거를 쌓는다.
 * 설계 원칙(PROJECT_CHARTER 2026-10-07):
 *   - 실패해도 파이프라인을 막지 않는다(키 없음·네트워크 오류·형식 변경 모두 건너뜀).
 *   - 질문과 채점 방식을 사전에 고정한다(JEV_QUESTIONS_VERSION). 질문을 바꾸면 버전을 올리고 기록을 분리한다.
 *   - 같은 시점의 키워드 감성 점수(기준선)를 함께 저장한다. Jev가 무료 코드보다 못하면 쓸 이유가 없다.
 *   - API 키는 로그·기록에 남기지 않는다.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { collectCompanyIntelligence, type CompanyNewsItem } from "./agentTeams/companyIntelligenceAgent";
import { toRMultiple } from "./expectancy";
import { fetchKoreanOhlcvRowsBatch, type OhlcvRow } from "./koreaStockMcp";
import type { RecommendationEntry } from "./recommendationJournalAgent";

export const JEV_QUESTIONS_VERSION = "q1-2026-10";
export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const MIN_SAMPLES_FOR_VERDICT = 120;
const HEADLINE_MAX_AGE_DAYS = 45;
const HEADLINE_MAX_COUNT = 8;
const DEFAULT_MAX_PER_RUN = 20;
const LOOKBACK_DAYS = 3;

export const JEV_QUESTIONS = {
  lingering_bad_news: {
    type: "noul",
    instructions:
      "`headlines` 중에 앞으로 2~3주 동안 이 종목 주가를 계속 누를 수 있는 악재(실적 악화, 증자·전환사채 등 자금 조달, 소송·조사·제재, 대주주·내부자 매도, 거래정지·상장 위험)가 하나라도 있는가?",
    criteria: {
      true: "구체적이고 아직 해소되지 않은 악재가 헤드라인에 드러나 있다",
      false: "악재가 없거나, 있어도 일회성이며 이미 해소·정정됐다",
    },
  },
  priced_in_rally: {
    type: "noul",
    instructions:
      "`headlines`가 전하는 호재는 `return_5d_pct`·`return_20d_pct`로 이미 가격에 상당 부분 반영돼서, 지금 새로 사는 사람이 뒤늦게 추격하는 구도인가?",
    criteria: {
      true: "호재 기사가 이미 급등한 뒤에 나온 것이고 추가로 새로울 것이 없다",
      false: "호재가 새롭거나 가격이 아직 크게 반응하지 않았다, 또는 눈에 띄는 호재 기사 자체가 없다",
    },
  },
  move_driver: {
    type: "choice",
    instructions: "`headlines`와 `return_20d_pct`를 볼 때, 최근 주가 움직임을 만든 주된 동력은 무엇인가?",
    criteria: {
      earnings_or_contract: "실적·수주·계약·승인 등 이 회사 고유의 구체적 사건",
      theme_or_flow: "테마·업종 분위기·수급(외국인·기관 매수, 쏠림) 위주로 설명되는 움직임",
      market_wide: "시장 전체나 업종 전체의 동반 움직임",
      unclear: "헤드라인만으로는 이유를 알 수 없다",
    },
  },
} as const;

export type JevAnswers = {
  lingeringBadNews: number | null;
  pricedInRally: number | null;
  moveDriver: { choice: string; confidence: number | null; probabilities: Record<string, number> } | null;
};

export type JevShadowRecord = {
  key: string; // `${date}|${ticker}`
  date: string;
  ticker: string;
  companyName: string;
  watchOnly: boolean;
  asOf: string;
  questionsVersion: string;
  model: string | null;
  headlineCount: number;
  newestHeadlineDate: string | null;
  return5dPct: number | null;
  return20dPct: number | null;
  /** null이면 Jev를 호출하지 못했거나(헤드라인 없음·오류) 호출하지 않았다. */
  answers: JevAnswers | null;
  skippedReason?: "no_headlines";
  /** 기존 키워드 감성(companyIntelligence) — Jev가 이겨야 하는 무료 기준선. */
  baseline: { sentimentLabel: string; riskScore: number; catalystScore: number };
  usage: { inputTokens: number; outputTokens: number } | null;
};

export type JevShadowFile = { version: 1; questionsVersion: string; records: Record<string, JevShadowRecord> };

// ── 순수 함수 ──

export function jevShadowEnabled(env: Record<string, string | undefined>): boolean {
  if ((env.JEV_SHADOW ?? "").trim().toLowerCase() === "off") return false;
  return Boolean(readJevKey(env));
}

/** 대소문자 변형을 모두 허용한다(.env.local은 소문자, GitHub 시크릿은 대문자). */
export function readJevKey(env: Record<string, string | undefined>): string | null {
  const raw = env.TYPESAFE_AI_API_KEY ?? env.typesafe_ai_api_key ?? "";
  const key = raw.trim();
  return key ? key : null;
}

export function maxPerRun(env: Record<string, string | undefined>): number {
  const n = Number((env.JEV_SHADOW_MAX_PER_RUN ?? "").trim()); // 빈 문자열은 0이 되므로 따로 처리
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_PER_RUN;
}

/** RSS 날짜 문자열을 파싱하고 오래되거나 중복된 기사를 걸러 최신순 `YYYY-MM-DD 제목`으로 만든다. */
export function normalizeHeadlines(
  items: Array<Pick<CompanyNewsItem, "title" | "publishedAt">>,
  now: Date
): { lines: string[]; newestDate: string | null } {
  const cutoff = now.getTime() - HEADLINE_MAX_AGE_DAYS * 86_400_000;
  const seen = new Set<string>();
  const parsed = items
    .map(item => ({ title: item.title.trim(), t: Date.parse(item.publishedAt) }))
    .filter(item => item.title && Number.isFinite(item.t) && item.t >= cutoff && item.t <= now.getTime() + 86_400_000)
    .filter(item => (seen.has(item.title) ? false : (seen.add(item.title), true)))
    .sort((a, b) => b.t - a.t)
    .slice(0, HEADLINE_MAX_COUNT);
  return {
    lines: parsed.map(item => `${new Date(item.t).toISOString().slice(0, 10)} ${item.title}`),
    newestDate: parsed.length ? new Date(parsed[0].t).toISOString().slice(0, 10) : null,
  };
}

/** 신호일(포함) 이전 마지막 종가 기준 5·20거래일 수익률(%). 데이터가 모자라면 null. */
export function recentReturns(rows: Array<Pick<OhlcvRow, "날짜" | "종가">> | null | undefined, date: string) {
  if (!rows?.length) return { r5: null as number | null, r20: null as number | null };
  const sorted = [...rows].sort((a, b) => a.날짜.localeCompare(b.날짜));
  let idx = -1;
  for (let i = 0; i < sorted.length; i += 1) if (sorted[i].날짜 <= date) idx = i;
  const at = (n: number) => {
    if (idx - n < 0 || !(sorted[idx - n].종가 > 0) || !(sorted[idx].종가 > 0)) return null;
    return Number(((sorted[idx].종가 / sorted[idx - n].종가 - 1) * 100).toFixed(2));
  };
  return { r5: at(5), r20: at(20) };
}

export function parseJevResponse(body: unknown): { answers: JevAnswers; model: string | null; usage: JevShadowRecord["usage"] } | null {
  const root = body as {
    model?: string;
    answers?: Record<string, { noul?: number; choice?: string; confidence?: number; probabilities?: Record<string, number> }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  } | null;
  const a = root?.answers;
  if (!a || typeof a !== "object") return null;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const mv = a.move_driver;
  const answers: JevAnswers = {
    lingeringBadNews: num(a.lingering_bad_news?.noul),
    pricedInRally: num(a.priced_in_rally?.noul),
    moveDriver: mv && typeof mv.choice === "string" ? { choice: mv.choice, confidence: num(mv.confidence), probabilities: mv.probabilities ?? {} } : null,
  };
  if (answers.lingeringBadNews === null && answers.pricedInRally === null && !answers.moveDriver) return null;
  return {
    answers,
    model: typeof root?.model === "string" ? root.model : null,
    usage: root?.usage ? { inputTokens: num(root.usage.input_tokens) ?? 0, outputTokens: num(root.usage.output_tokens) ?? 0 } : null,
  };
}

type FetchLike = typeof fetch;

export async function callJev(
  state: Record<string, unknown>,
  apiKey: string,
  options: { fetchImpl?: FetchLike; timeoutMs?: number; sleep?: (ms: number) => Promise<void> } = {}
) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);
    try {
      const response = await fetchImpl(JEV_ENDPOINT, {
        method: "POST",
        signal: controller.signal,
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ state, model: "jev-latest", questions: JEV_QUESTIONS }),
      });
      if (response.status === 429 || response.status >= 500) {
        if (attempt === 0) { await sleep(1500); continue; }
        return null;
      }
      if (!response.ok) return null;
      return parseJevResponse(await response.json());
    } catch {
      if (attempt === 0) { await sleep(1500); continue; }
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

export function pickEntriesToShadow(
  journal: RecommendationEntry[],
  existing: Record<string, JevShadowRecord>,
  today: string,
  limit: number
): RecommendationEntry[] {
  const since = new Date(`${today}T00:00:00Z`);
  since.setUTCDate(since.getUTCDate() - LOOKBACK_DAYS);
  const cutoff = since.toISOString().slice(0, 10);
  return journal
    .filter(e => e.status === "open" && e.date >= cutoff && !existing[`${e.date}|${e.ticker}`])
    .sort((a, b) => Number(Boolean(a.watchOnly)) - Number(Boolean(b.watchOnly))) // 실픽 우선
    .slice(0, limit);
}

// ── 채점(사전 고정) ──

export type ShadowScoreRow = { name: string; nHigh: number; nLow: number; meanRHigh: number | null; meanRLow: number | null; diff: number | null; twoSe: number | null };

/**
 * 가설: 질문 1·2의 확률이 0.5 이상이면 R이 더 낮다. 기준선: 키워드 감성이 "부정"이면 R이 더 낮다.
 * 진입이 체결돼 정산된 건만 센다. 표본이 MIN_SAMPLES_FOR_VERDICT 미만이면 방향만 보여주고 판정하지 않는다.
 */
export function scoreJevShadow(records: JevShadowRecord[], journal: RecommendationEntry[]) {
  const byKey = new Map(journal.map(e => [`${e.date}|${e.ticker}`, e]));
  const rows = records
    .map(rec => {
      const e = byKey.get(rec.key);
      if (!e || !["target", "stop", "trail_exit", "time_exit"].includes(e.status) || typeof e.returnPct !== "number") return null;
      const r = toRMultiple({ outcome: e.status, returnPct: e.returnPct, triggerPrice: e.triggerPrice, stopLossPrice: e.stopLossPrice });
      return r === null ? null : { rec, r };
    })
    .filter((x): x is { rec: JevShadowRecord; r: number } => x !== null);
  const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
  const se = (a: number[]) => {
    if (a.length < 2) return 0;
    const m = a.reduce((s, x) => s + x, 0) / a.length;
    return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1) / a.length);
  };
  const split = (name: string, isHigh: (rec: JevShadowRecord) => boolean | null): ShadowScoreRow => {
    const usable = rows.filter(x => isHigh(x.rec) !== null);
    const hi = usable.filter(x => isHigh(x.rec) === true).map(x => x.r);
    const lo = usable.filter(x => isHigh(x.rec) === false).map(x => x.r);
    const mh = mean(hi), ml = mean(lo);
    return { name, nHigh: hi.length, nLow: lo.length, meanRHigh: mh, meanRLow: ml, diff: mh !== null && ml !== null ? mh - ml : null, twoSe: hi.length && lo.length ? 2 * Math.sqrt(se(hi) ** 2 + se(lo) ** 2) : null };
  };
  const rowsOut = [
    split("Jev Q1 악재 지속 ≥0.5", rec => (rec.answers?.lingeringBadNews == null ? null : rec.answers.lingeringBadNews >= 0.5)),
    split("Jev Q2 추격 구도 ≥0.5", rec => (rec.answers?.pricedInRally == null ? null : rec.answers.pricedInRally >= 0.5)),
    split("기준선: 키워드 감성 '부정'", rec => (rec.baseline.sentimentLabel === "자료부족" ? null : rec.baseline.sentimentLabel === "부정")),
  ];
  const scored = rows.filter(x => x.rec.answers).length;
  return {
    settledWithAnswers: scored,
    settledTotal: rows.length,
    rows: rowsOut,
    verdict: scored < MIN_SAMPLES_FOR_VERDICT ? `표본 부족(${scored}/${MIN_SAMPLES_FOR_VERDICT}) — 판정 보류` : "표본 충족 — Jev 행이 기준선 행보다 R 차이가 크고 ±2SE 밖이어야 채택 검토",
  };
}

// ── IO ──

export const DEFAULT_JOURNAL_PATH = path.join(process.cwd(), "data", "journal", "recommendations.json");
export const DEFAULT_SHADOW_PATH = path.join(process.cwd(), "data", "journal", "jev-shadow.json");

export async function readShadowFile(file = DEFAULT_SHADOW_PATH): Promise<JevShadowFile> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as JevShadowFile;
    if (parsed && typeof parsed === "object" && parsed.records) return parsed;
  } catch {
    // 없거나 깨졌으면 새로 시작한다(원본 저널은 건드리지 않는다).
  }
  return { version: 1, questionsVersion: JEV_QUESTIONS_VERSION, records: {} };
}

async function writeShadowFile(file: string, data: JevShadowFile) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(tmp, file);
}

export async function readJournalFile(file = DEFAULT_JOURNAL_PATH): Promise<RecommendationEntry[]> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export type JevShadowDeps = {
  env?: Record<string, string | undefined>;
  now?: Date;
  journal?: RecommendationEntry[];
  shadowPath?: string;
  collectNews?: typeof collectCompanyIntelligence;
  fetchBars?: (tickers: string[]) => Promise<Record<string, OhlcvRow[] | null>>;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
};

/** 오늘 새로 기록된 후보(실픽 우선)에 질문을 던져 섀도 기록에 추가한다. 어떤 실패도 던지지 않는다. */
export async function runJevShadow(deps: JevShadowDeps = {}) {
  const env = deps.env ?? process.env;
  const now = deps.now ?? new Date();
  const summary = { enabled: false, selected: 0, recorded: 0, asked: 0, failed: 0, skippedNoHeadlines: 0 };
  try {
    if ((env.JEV_SHADOW ?? "").trim().toLowerCase() === "off") { console.log("[Jev Shadow] off — 건너뜀"); return summary; }
    const apiKey = readJevKey(env);
    if (!apiKey) { console.log("[Jev Shadow] API 키 없음 — 건너뜀"); return summary; }
    summary.enabled = true;

    const shadowPath = deps.shadowPath ?? DEFAULT_SHADOW_PATH;
    const file = await readShadowFile(shadowPath);
    const journal = deps.journal ?? (await readJournalFile());
    const today = now.toISOString().slice(0, 10);
    const picks = pickEntriesToShadow(journal, file.records, today, maxPerRun(env));
    summary.selected = picks.length;
    if (!picks.length) { console.log("[Jev Shadow] 새로 질문할 후보 없음"); return summary; }

    const collect = deps.collectNews ?? collectCompanyIntelligence;
    const insights = new Map<string, Awaited<ReturnType<typeof collectCompanyIntelligence>>[number]>();
    for (let i = 0; i < picks.length; i += 8) {
      const chunk = picks.slice(i, i + 8);
      const got = await collect(chunk.map(e => ({ ticker: e.ticker, companyName: e.companyName }))).catch(() => []);
      for (const insight of got) insights.set(insight.ticker, insight);
    }
    const bars = await (deps.fetchBars ?? ((t: string[]) => fetchKoreanOhlcvRowsBatch(t, 60)))(picks.map(e => e.ticker)).catch(() => ({} as Record<string, OhlcvRow[] | null>));

    for (const entry of picks) {
      const insight = insights.get(entry.ticker);
      const { lines, newestDate } = normalizeHeadlines(insight?.items ?? [], now);
      const { r5, r20 } = recentReturns(bars[entry.ticker], entry.date);
      const record: JevShadowRecord = {
        key: `${entry.date}|${entry.ticker}`, date: entry.date, ticker: entry.ticker, companyName: entry.companyName,
        watchOnly: Boolean(entry.watchOnly), asOf: now.toISOString(), questionsVersion: JEV_QUESTIONS_VERSION, model: null,
        headlineCount: lines.length, newestHeadlineDate: newestDate, return5dPct: r5, return20dPct: r20,
        answers: null,
        baseline: { sentimentLabel: insight?.sentimentLabel ?? "자료부족", riskScore: insight?.riskScore ?? 0, catalystScore: insight?.catalystScore ?? 0 },
        usage: null,
      };
      if (!lines.length) {
        record.skippedReason = "no_headlines";
        summary.skippedNoHeadlines += 1;
      } else {
        summary.asked += 1;
        const result = await callJev({ company: entry.companyName, headlines: lines, return_5d_pct: r5, return_20d_pct: r20 }, apiKey, { fetchImpl: deps.fetchImpl, sleep: deps.sleep });
        if (result) {
          record.answers = result.answers;
          record.model = result.model;
          record.usage = result.usage;
        } else {
          // 저장하지 않는다: 일시 장애로 영구 누락되지 않게 조회 기간(3일) 안에서 다음 실행이 다시 시도한다.
          summary.failed += 1;
          continue;
        }
      }
      file.records[record.key] = record;
      summary.recorded += 1;
    }
    await writeShadowFile(shadowPath, file);
    console.log(`[Jev Shadow] ${summary.recorded}건 기록 · 질문 ${summary.asked} · 실패 ${summary.failed} · 헤드라인 없음 ${summary.skippedNoHeadlines}`);
  } catch (error) {
    // 키가 메시지에 섞일 수 있는 객체를 통째로 출력하지 않는다.
    console.warn("[Jev Shadow] 건너뜀(오류):", error instanceof Error ? error.message : "unknown");
  }
  return summary;
}
