import "dotenv/config";

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { routeToCommander } from "./commanderChannel";
import {
  isSettledStatus,
  loadRecommendationJournal,
  summarizeByFactor,
  summarizeJournal,
  summarizeJournalByTicker,
  summarizeShadowByTicker,
  type JournalSummary,
  type RecommendationEntry,
  type TickerLevelSummary,
} from "./recommendationJournalAgent";
import {
  computeExpectancy,
  computeRiskBudget,
  formatExpectancy,
  type ExpectancyStats,
  type RiskBudget,
} from "./expectancy";
import {
  SWING_BACKTEST_REPORT_PATH,
  SWING_LEARNED_OVERRIDES_PATH,
  SWING_MAINTENANCE_HISTORY_PATH,
} from "./swingAdaptiveLearning";
import { SWING_PREDICTION_QUALITY_OVERRIDES_PATH } from "./swingPredictionQualityAgent";

/**
 * Data Steward — oversees the agent's own data: storage, classification, and a
 * unified analysis. It catalogs every data source (freshness, size, record
 * count, tracked-vs-ephemeral), classifies health, and folds the live journal,
 * factor attribution, evolution lineage and backtest stats into one
 * "state of the system" report. Pure governance — no new trading signals.
 */

export type DataCategory =
  | "signals"
  | "outcomes"
  | "learning"
  | "evolution"
  | "reports";
export type SourceHealth = "fresh" | "ok" | "stale" | "missing";

export type DataSourceSpec = {
  key: string;
  path: string;
  category: DataCategory;
  tracked: boolean; // committed to git → persists across ephemeral CI runs
  staleAfterHours: number;
};

export type SourceStatus = {
  key: string;
  category: DataCategory;
  tracked: boolean;
  exists: boolean;
  sizeBytes: number;
  modifiedAt: string | null;
  ageHours: number | null;
  records: number | null;
  health: SourceHealth;
};

const CHAMPION_PATH = path.join(
  process.cwd(),
  "data",
  "evolution",
  "champion.json"
);
const EVOLUTION_HISTORY_PATH = path.join(
  process.cwd(),
  ".data",
  "evolution",
  "history.json"
);
const JOURNAL_PATH = path.join(
  process.cwd(),
  "data",
  "journal",
  "recommendations.json"
);
const REPORT_DIR = path.join(process.cwd(), ".data", "data-steward");
const REPORT_JSON_PATH = path.join(REPORT_DIR, "latest-report.json");
const REPORT_MD_PATH = path.join(REPORT_DIR, "latest-report.md");
// Under data/ (committed by the daily workflow) so the next run can read it.
const HEARTBEAT_PATH = path.join(process.cwd(), "data", "ops", "steward-heartbeat.json");
// Normal cron jitter was observed up to ~29h between runs; one fully missed
// day lands near 48h.
const RUN_GAP_ALERT_HOURS = Number(process.env.RUN_GAP_ALERT_HOURS) || 36;
const BILLIONAIRE_BACKTEST_PATH = path.join(
  process.cwd(),
  ".data",
  "backtests",
  "billionaire-core-v1.json"
);
const BILLIONAIRE_SPEC_PATH = path.join(
  process.cwd(),
  "data",
  "strategy",
  "billionaire-core-v1.md"
);
const MARKET_DATA_ACCURACY_PATH = path.join(
  process.cwd(),
  ".data",
  "quality",
  "market-data",
  "latest-report.json"
);
const MARKET_DATA_JOURNAL_AUDIT_PATH = path.join(
  process.cwd(),
  ".data",
  "quality",
  "market-data",
  "journal-audit.md"
);

const DAY = 24;
const SOURCES: DataSourceSpec[] = [
  {
    key: "추천 저널",
    path: JOURNAL_PATH,
    category: "signals",
    tracked: true,
    staleAfterHours: 4 * DAY,
  },
  {
    key: "진화 챔피언",
    path: CHAMPION_PATH,
    category: "evolution",
    tracked: true,
    staleAfterHours: 30 * DAY,
  },
  {
    key: "진화 히스토리",
    path: EVOLUTION_HISTORY_PATH,
    category: "evolution",
    tracked: false,
    staleAfterHours: 10 * DAY,
  },
  {
    key: "백테스트 리포트",
    path: SWING_BACKTEST_REPORT_PATH,
    category: "learning",
    tracked: false,
    staleAfterHours: 2 * DAY,
  },
  {
    key: "학습 가중치",
    path: SWING_LEARNED_OVERRIDES_PATH,
    category: "learning",
    tracked: false,
    staleAfterHours: 2 * DAY,
  },
  {
    key: "품질 필터",
    path: SWING_PREDICTION_QUALITY_OVERRIDES_PATH,
    category: "learning",
    tracked: false,
    staleAfterHours: 2 * DAY,
  },
  {
    key: "Billionaire Core 백테스트",
    path: BILLIONAIRE_BACKTEST_PATH,
    category: "learning",
    tracked: false,
    staleAfterHours: 2 * DAY,
  },
  {
    key: "Billionaire Core 명세",
    path: BILLIONAIRE_SPEC_PATH,
    category: "reports",
    tracked: true,
    staleAfterHours: 30 * DAY,
  },
  {
    key: "시세 정확성 검수",
    path: MARKET_DATA_ACCURACY_PATH,
    category: "reports",
    tracked: false,
    staleAfterHours: 2,
  },
  {
    key: "저널 시세 소급 감사",
    path: MARKET_DATA_JOURNAL_AUDIT_PATH,
    category: "reports",
    tracked: false,
    staleAfterHours: 7 * DAY,
  },
  {
    key: "유지보수 히스토리",
    path: SWING_MAINTENANCE_HISTORY_PATH,
    category: "reports",
    tracked: false,
    staleAfterHours: 10 * DAY,
  },
];

/** Pure: classify a source's freshness from existence + age. */
export function classifyHealth(
  exists: boolean,
  ageHours: number | null,
  staleAfterHours: number
): SourceHealth {
  if (!exists || ageHours === null) return "missing";
  if (ageHours <= staleAfterHours / 2) return "fresh";
  if (ageHours <= staleAfterHours) return "ok";
  return "stale";
}

async function inspectSource(
  spec: DataSourceSpec,
  now: Date
): Promise<SourceStatus> {
  let exists = false;
  let sizeBytes = 0;
  let modifiedAt: string | null = null;
  let ageHours: number | null = null;
  let records: number | null = null;
  try {
    const info = await stat(spec.path);
    exists = true;
    sizeBytes = info.size;
    modifiedAt = info.mtime.toISOString();
    ageHours =
      Math.round(((now.getTime() - info.mtime.getTime()) / 3_600_000) * 10) /
      10;
    try {
      const parsed = JSON.parse(await readFile(spec.path, "utf8"));
      if (Array.isArray(parsed)) {
        records = parsed.length;
      }
    } catch {
      // not a JSON array (or unreadable) — leave records null
    }
  } catch {
    // missing source
  }
  return {
    key: spec.key,
    category: spec.category,
    tracked: spec.tracked,
    exists,
    sizeBytes,
    modifiedAt,
    ageHours,
    records,
    health: classifyHealth(exists, ageHours, spec.staleAfterHours),
  };
}

export async function catalogData(now = new Date()): Promise<SourceStatus[]> {
  return Promise.all(SOURCES.map(spec => inspectSource(spec, now)));
}

export type SystemAnalysis = {
  generatedAt: string;
  catalog: SourceStatus[];
  journal: JournalSummary;
  journalByTicker: TickerLevelSummary;
  shadowByTicker: TickerLevelSummary;
  expectancy: {
    backtest: ExpectancyStats;
    /** Settled picks under the current champion — what alerts judge. */
    live: ExpectancyStats;
    /** Every settled pick ever, including code that no longer runs. Report only. */
    lifetime: ExpectancyStats;
    budget: RiskBudget;
  };
  factors: ReturnType<typeof summarizeByFactor>;
  evolution: {
    championFitness: number | null;
    championAt: string | null;
    generations: number;
    promotions: number;
  };
  backtest: {
    winRate: number | null;
    avgReturnPct: number | null;
    totalTrades: number | null;
    generatedAt: string | null;
    distinctTickers: number | null;
    inSampleWinRate: number | null;
    outOfSampleWinRate: number | null;
  };
  issues: string[];
};

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

/**
 * Picks made under the current champion — the same population the evolution
 * gate already scores. Every "is the running system working?" judgement here
 * uses it, so the steward and the gate cannot disagree about what "live" means.
 */
export function currentChampionEntries(
  entries: RecommendationEntry[],
  championAt: string | null | undefined
): RecommendationEntry[] {
  if (!championAt) return [];
  return entries.filter(entry => entry.championAt === championAt);
}

/**
 * Sizing basis, most conservative evidence first: current-champion live if it
 * has a verdict, else lifetime live, else backtest. Jumping straight to the
 * backtest whenever a fresh champion has not settled enough picks would size
 * off a promise instead of evidence.
 */
export function pickBudgetBasis(
  current: ExpectancyStats,
  lifetime: ExpectancyStats,
  backtest: ExpectancyStats
): ExpectancyStats {
  if (current.edgeVerdict !== "insufficient") return current;
  if (lifetime.edgeVerdict !== "insufficient") return lifetime;
  return backtest;
}

/**
 * Hours since the previous run when that exceeds the threshold, else null.
 *
 * A job that never starts cannot report its own absence: on 2026-08-30..09-01
 * GitHub never assigned a runner, three days of alerts and scoring were lost,
 * and nothing said so. The first run afterwards is the earliest point anyone
 * can notice — so it measures the gap.
 */
export function detectRunGap(
  previousRunAt: string | null,
  now: Date,
  thresholdHours: number
): number | null {
  if (!previousRunAt) return null;
  const previous = Date.parse(previousRunAt);
  if (!Number.isFinite(previous)) return null;
  const hours = (now.getTime() - previous) / 3_600_000;
  return hours > thresholdHours ? Math.round(hours) : null;
}

function liveRTrades(entries: RecommendationEntry[]) {
  return entries
    .filter(entry => !entry.watchOnly && isSettledStatus(entry.status))
    .map(entry => ({
      triggerPrice: entry.triggerPrice,
      stopLossPrice: entry.stopLossPrice,
      returnPct: entry.returnPct ?? 0,
    }));
}

export async function buildSystemAnalysis(
  now = new Date()
): Promise<SystemAnalysis> {
  const catalog = await catalogData(now);
  const journalEntries = await loadRecommendationJournal();
  const journal = summarizeJournal(journalEntries);
  const journalByTicker = summarizeJournalByTicker(journalEntries);
  const shadowByTicker = summarizeShadowByTicker(journalEntries);
  const factors = summarizeByFactor(journalEntries);

  const champion = await readJson<{ generatedAt?: string; fitness?: number }>(
    CHAMPION_PATH
  );
  const history =
    (await readJson<Array<{ promoted?: boolean }>>(EVOLUTION_HISTORY_PATH)) ??
    [];
  const evolution = {
    championFitness:
      typeof champion?.fitness === "number" ? champion.fitness : null,
    championAt: champion?.generatedAt ?? null,
    generations: history.length,
    promotions: history.filter(entry => entry.promoted).length,
  };

  const backtestReport = await readJson<{
    winRate?: number;
    avgReturnPct?: number;
    totalTrades?: number;
    generatedAt?: string;
    trades?: Array<{
      triggerPrice: number;
      stopLossPrice: number;
      returnPct: number;
      outcome?: string;
    }>;
    splitSample?: {
      distinctTickers?: number;
      inSample?: { winRate?: number };
      outOfSample?: { winRate?: number };
    };
  }>(SWING_BACKTEST_REPORT_PATH);
  const sample = backtestReport?.splitSample;
  const backtest = {
    winRate: backtestReport?.winRate ?? null,
    avgReturnPct: backtestReport?.avgReturnPct ?? null,
    totalTrades: backtestReport?.totalTrades ?? null,
    generatedAt: backtestReport?.generatedAt ?? null,
    distinctTickers: sample?.distinctTickers ?? null,
    inSampleWinRate: sample?.inSample?.winRate ?? null,
    outOfSampleWinRate: sample?.outOfSample?.winRate ?? null,
  };

  // Expectancy in R — the risk-normalized edge. Live is the one that decides
  // whether the strategy is actually worth running; backtest is the reference.
  // "Live" is scoped to the current champion. Judged on the whole journal, the
  // 40 picks from pre-July code (−0.345R) outvoted the 13 from the current rules
  // (+0.043R), so the commander got the same stale "기대값 음수" alert every day.
  const currentEntries = currentChampionEntries(journalEntries, champion?.generatedAt);
  const backtestExpectancy = computeExpectancy(backtestReport?.trades ?? []);
  const liveExpectancy = computeExpectancy(liveRTrades(currentEntries));
  const lifetimeExpectancy = computeExpectancy(liveRTrades(journalEntries));
  const budget = computeRiskBudget(
    pickBudgetBasis(liveExpectancy, lifetimeExpectancy, backtestExpectancy)
  );
  const currentByTicker = summarizeJournalByTicker(currentEntries);

  const issues: string[] = [];
  for (const source of catalog) {
    if (source.health === "missing" && source.tracked) {
      issues.push(`${source.key}: 추적 데이터 누락`);
    } else if (source.health === "stale") {
      issues.push(`${source.key}: 갱신 지연(${source.ageHours}h)`);
    }
  }
  if (journal.triggered === 0 && journal.open > 0) {
    issues.push(
      `정산 표본 0 — 라이브 검증 데이터 축적 중(진행 ${journal.open}건)`
    );
  }
  const missingCurrentPrice = journalEntries.filter(
    entry => !Number.isFinite(entry.currentPrice)
  ).length;
  if (missingCurrentPrice > 0) {
    issues.push(
      `추천 저널: 현재가 누락 ${missingCurrentPrice}/${journalEntries.length}건 — 기록 당시 시세 소급 검증 불가`
    );
  }

  // Negative measured expectancy is the one condition where continuing to size
  // up is mathematically indefensible, regardless of how good the picks look.
  // After a promotion the new champion starts from zero picks, so both live
  // alerts below go quiet for weeks. Say so instead of going quiet silently.
  if (liveExpectancy.edgeVerdict === "insufficient") {
    issues.push(
      `현 챔피언 라이브 표본 부족(${liveExpectancy.trades}건) — 기대값·엣지 괴리 경보 판정 보류(전체 이력은 리포트 참고)`
    );
  }
  if (liveExpectancy.edgeVerdict === "negative") {
    issues.push(
      `⚠ 기대값 음수: 현 챔피언 라이브 ${liveExpectancy.expectancyR}R/거래(${liveExpectancy.trades}건) — 리스크 예산 0% 유지, 게이트 재검토 필요`
    );
  }

  // Edge-decay watch: when live (ticker-level, de-correlated) results fall far
  // below what the backtest promises, the edge is being arbitraged away
  // (signal crowding by other agents) or the regime shifted — either way the
  // gates need review before more capital-relevant picks go out.
  const minEdgeTickers = Number(process.env.EDGE_DECAY_MIN_TICKERS) || 8;
  const decayGapPp = Number(process.env.EDGE_DECAY_GAP_PP) || 15;
  // Same scoping as expectancy: compare the backtest with picks the current
  // champion actually made, not with results from rules that were replaced.
  if (
    currentByTicker.settledTickers >= minEdgeTickers &&
    backtest.winRate != null
  ) {
    const winGap = backtest.winRate - currentByTicker.winRate;
    const losingLive =
      currentByTicker.avgReturnPct < 0 && (backtest.avgReturnPct ?? 0) > 0;
    if (winGap > decayGapPp || losingLive) {
      issues.push(
        `⚠ 엣지 괴리: 현 챔피언 실측(종목단위) 승률 ${currentByTicker.winRate}%·평균 ${currentByTicker.avgReturnPct}% vs 백테스트 ${backtest.winRate}%·${backtest.avgReturnPct}% — 신호 군집화/레짐 변화 의심, 게이트 재검토 권고`
      );
    }
  }

  return {
    generatedAt: now.toISOString(),
    catalog,
    journal,
    journalByTicker,
    shadowByTicker,
    expectancy: {
      backtest: backtestExpectancy,
      live: liveExpectancy,
      lifetime: lifetimeExpectancy,
      budget,
    },
    factors,
    evolution,
    backtest,
    issues,
  };
}

function healthMark(health: SourceHealth): string {
  return health === "stale" ? "🟡" : health === "missing" ? "🔴" : "🟢";
}

export function toReport(analysis: SystemAnalysis): string {
  const fmtFactor = (bucket: {
    label: string;
    settled: number;
    winRate: number;
    avgReturnPct: number;
  }) =>
    `${bucket.label} ${bucket.settled}건·승률 ${bucket.winRate}%·평균 ${bucket.avgReturnPct}%`;
  return [
    "# Data Steward — 시스템 데이터 총괄",
    "",
    `- Generated: ${analysis.generatedAt}`,
    "",
    "## 데이터 카탈로그",
    ...analysis.catalog.map(source => {
      const detail = source.exists
        ? `${source.records != null ? `${source.records}건 · ` : ""}${Math.round(source.sizeBytes / 1024)}KB · ${source.ageHours}h 전`
        : "없음";
      return `- ${healthMark(source.health)} ${source.key} [${source.category}${source.tracked ? "·tracked" : ""}] — ${detail}`;
    }),
    "",
    "## 라이브 성과 (저널)",
    `- 정산 ${analysis.journal.triggered} · 진행중 ${analysis.journal.open} · 승률 ${analysis.journal.winRate}% · 평균수익 ${analysis.journal.avgReturnPct}%`,
    `- 종목단위(중복 제거): ${analysis.journalByTicker.settledTickers}종목 · 승률 ${analysis.journalByTicker.winRate}% · 평균 ${analysis.journalByTicker.avgReturnPct}%`,
    `- 관찰 섀도(억제 후보 검증): ${analysis.shadowByTicker.settledTickers}종목 · 승률 ${analysis.shadowByTicker.winRate}% · 평균 ${analysis.shadowByTicker.avgReturnPct}%`,
    "",
    "## 기대값 / 리스크 예산 (R 단위)",
    `- 라이브(현 챔피언): ${formatExpectancy(analysis.expectancy.live, analysis.expectancy.budget)}`,
    `- 라이브(전체 이력·교체된 규칙 포함, 참고용): ${formatExpectancy(analysis.expectancy.lifetime, analysis.expectancy.budget)}`,
    `- 백테스트: ${formatExpectancy(analysis.expectancy.backtest, analysis.expectancy.budget)}`,
    `- 사이징 근거: ${analysis.expectancy.budget.note}`,
    `- 수급: ${
      analysis.factors.supply
        .filter(b => b.settled)
        .map(fmtFactor)
        .join(" / ") || "표본 없음"
    }`,
    `- 뉴스: ${
      analysis.factors.news
        .filter(b => b.settled)
        .map(fmtFactor)
        .join(" / ") || "표본 없음"
    }`,
    "",
    "## 진화 / 백테스트",
    `- 챔피언 적합도 ${analysis.evolution.championFitness ?? "(base 시드)"} · 세대 ${analysis.evolution.generations} · 승격 ${analysis.evolution.promotions}`,
    `- 백테스트 승률 ${analysis.backtest.winRate ?? "-"}% · 평균 ${analysis.backtest.avgReturnPct ?? "-"}% · 체결 ${analysis.backtest.totalTrades ?? "-"}`,
    `- 워크포워드: 최근(OOS) ${analysis.backtest.outOfSampleWinRate ?? "-"}% vs 과거(IS) ${analysis.backtest.inSampleWinRate ?? "-"}% · 고유종목 ${analysis.backtest.distinctTickers ?? "-"}`,
    "",
    "## 점검 이슈",
    ...(analysis.issues.length
      ? analysis.issues.map(issue => `- ${issue}`)
      : ["- 없음"]),
  ].join("\n");
}

export async function runDataSteward(
  now = new Date()
): Promise<SystemAnalysis> {
  const analysis = await buildSystemAnalysis(now);

  // Heartbeat. Only CI's cadence means anything, and a local run would dirty a
  // tracked file — so both the check and the write are CI-only.
  if (process.env.GITHUB_ACTIONS === "true") {
    const previous = await readJson<{ lastRunAt?: string }>(HEARTBEAT_PATH);
    const gapHours = detectRunGap(previous?.lastRunAt ?? null, now, RUN_GAP_ALERT_HOURS);
    if (gapHours !== null) {
      analysis.issues.unshift(
        `⚠ 자동 실행 공백 ${gapHours}시간 — 그 사이 알림·채점·데이터 커밋이 없었습니다(GitHub Actions 러너 미배정 등)`
      );
    }
    await mkdir(path.dirname(HEARTBEAT_PATH), { recursive: true });
    await writeFile(
      HEARTBEAT_PATH,
      `${JSON.stringify({ lastRunAt: now.toISOString() }, null, 2)}\n`,
      "utf8"
    );
  }

  await mkdir(REPORT_DIR, { recursive: true });
  await Promise.all([
    writeFile(
      REPORT_JSON_PATH,
      `${JSON.stringify(analysis, null, 2)}\n`,
      "utf8"
    ),
    writeFile(REPORT_MD_PATH, `${toReport(analysis)}\n`, "utf8"),
  ]);

  console.log(
    `[Data Steward] sources ${analysis.catalog.length} · issues ${analysis.issues.length} · journal ${analysis.journal.triggered} settled / ${analysis.journal.open} open · champion ${
      analysis.evolution.championFitness ?? "seed"
    }`
  );
  // The markdown report lives in .data, which a CI runner discards — so the
  // log line used to be the only trace, and it carried a count with no text.
  for (const issue of analysis.issues) {
    console.log(`[Data Steward]   - ${issue}`);
  }

  // Alert on durable problems only: tracked-data health issues and edge-decay
  // warnings. Ephemeral .data absence on a CI run is expected, not an incident.
  const criticalIssues = [
    ...analysis.catalog
      .filter(
        source =>
          source.tracked &&
          (source.health === "missing" || source.health === "stale")
      )
      .map(source => `${source.key}: ${source.health}`),
    ...analysis.issues.filter(
      issue =>
        issue.includes("엣지 괴리") ||
        issue.includes("기대값 음수") ||
        issue.includes("자동 실행 공백")
    ),
  ];
  if (criticalIssues.length) {
    await routeToCommander({
      ticker: "DATA",
      companyName: "데이터 총괄",
      kind: "high_risk",
      headline: `시스템 점검 경보 ${criticalIssues.length}건`,
      detail: criticalIssues,
    }).catch(error =>
      console.warn("[Data Steward] commander notify failed:", error)
    );
  }

  return analysis;
}

async function runFromCli() {
  await runDataSteward();
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  runFromCli().catch(error => {
    console.error("[Data Steward] Failed:", error);
    process.exit(1);
  });
}
