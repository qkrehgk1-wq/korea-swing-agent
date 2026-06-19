import "dotenv/config";

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { routeToCommander } from "./commanderChannel";
import {
  collectBacktestTrades,
  fetchBacktestRows,
  summarizeBacktestTrades,
  type BacktestSummary,
} from "./swingBacktestAgent";
import {
  SWING_LEARNED_OVERRIDES_PATH,
  writeSwingLearnedOverrides,
  type SwingLearnedOverrides,
  type WorkflowApprovalPolicy,
} from "./swingAdaptiveLearning";
import {
  SWING_PREDICTION_QUALITY_OVERRIDES_PATH,
  writeSwingPredictionQualityOverrides,
  type SwingPredictionQualityOverrides,
} from "./swingPredictionQualityAgent";
import {
  SWING_PATTERN_BASE_WEIGHTS,
  type InjectedSwingOverrides,
  type PatternName,
  type SwingQualityParams,
} from "./technicalSwingScreener";

/**
 * Self-evolving strategy optimizer. Treats the screener's tunable parameters
 * (pattern weights + quality thresholds) as a genome, mutates a population,
 * scores each variant on the historical backtest, and — only when a challenger
 * clearly beats the incumbent (champion/challenger gate) — auto-promotes it to
 * the live override files. Fully deterministic (seeded RNG), no LLM, with the
 * previous champion archived for rollback.
 */

export type Genome = {
  patternWeights: Record<PatternName, number>;
  quality: SwingQualityParams;
};

export type Evaluation = {
  genome: Genome;
  summary: BacktestSummary;
  fitness: number;
};

const PATTERN_NAMES = Object.keys(SWING_PATTERN_BASE_WEIGHTS) as PatternName[];
const QUALITY_KEYS: (keyof SwingQualityParams)[] = [
  "minDefaultSwingScore",
  "minEarlyBowlSwingScore",
  "minVolumeRatio",
  "maxRsi14",
  "maxVolatility20",
];

const WEIGHT_BOUNDS = { min: 3, max: 26 };
const QUALITY_BOUNDS: Record<keyof SwingQualityParams, { min: number; max: number; step: number }> = {
  minDefaultSwingScore: { min: 50, max: 75, step: 2 },
  minEarlyBowlSwingScore: { min: 40, max: 65, step: 2 },
  minVolumeRatio: { min: 0.6, max: 1.6, step: 0.1 },
  maxRsi14: { min: 68, max: 82, step: 1 },
  maxVolatility20: { min: 30, max: 60, step: 2 },
};

export const BASE_GENOME: Genome = {
  patternWeights: { ...SWING_PATTERN_BASE_WEIGHTS },
  quality: {
    minDefaultSwingScore: 62,
    minEarlyBowlSwingScore: 48,
    minVolumeRatio: 0.9,
    maxRsi14: 76,
    maxVolatility20: 45,
  },
};

const EVOLUTION_DIR = path.join(process.cwd(), ".data", "evolution");
// The champion lives in a TRACKED dir so it survives ephemeral CI runs (the
// workflow commits it back) — that is what lets evolution accumulate across
// generations instead of restarting from the daily baseline every run.
const CHAMPION_PATH = path.join(process.cwd(), "data", "evolution", "champion.json");
const HISTORY_PATH = path.join(EVOLUTION_DIR, "history.json");
const REPORT_JSON_PATH = path.join(EVOLUTION_DIR, "latest-report.json");
const REPORT_MD_PATH = path.join(EVOLUTION_DIR, "latest-report.md");

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

/** Deterministic PRNG (mulberry32) so a given seed reproduces an evolution run. */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function clampGenome(genome: Genome): Genome {
  const patternWeights = {} as Record<PatternName, number>;
  for (const name of PATTERN_NAMES) {
    const raw = genome.patternWeights[name] ?? SWING_PATTERN_BASE_WEIGHTS[name];
    patternWeights[name] = Math.round(clamp(raw, WEIGHT_BOUNDS.min, WEIGHT_BOUNDS.max));
  }
  const quality = {} as SwingQualityParams;
  for (const key of QUALITY_KEYS) {
    const bounds = QUALITY_BOUNDS[key];
    const raw = genome.quality[key] ?? BASE_GENOME.quality[key];
    const clamped = clamp(raw, bounds.min, bounds.max);
    quality[key] = key === "minVolumeRatio" ? Number(clamped.toFixed(2)) : Math.round(clamped);
  }
  return { patternWeights, quality };
}

export function mutateGenome(genome: Genome, rng: () => number, rate = 0.5): Genome {
  const next = clampGenome(genome);
  for (const name of PATTERN_NAMES) {
    if (rng() < rate) {
      const delta = Math.round((rng() * 2 - 1) * 3); // -3..3
      next.patternWeights[name] += delta;
    }
  }
  for (const key of QUALITY_KEYS) {
    if (rng() < rate) {
      const { step } = QUALITY_BOUNDS[key];
      const dir = rng() < 0.5 ? -1 : 1;
      const steps = 1 + Math.floor(rng() * 2); // 1..2 steps
      next.quality[key] = Number((next.quality[key] + dir * step * steps).toFixed(2));
    }
  }
  return clampGenome(next);
}

export function genomeToInjected(genome: Genome): InjectedSwingOverrides {
  return { patternWeights: genome.patternWeights, quality: genome.quality };
}

/**
 * Fitness = realized edge scaled by sample confidence. Strategies that trade too
 * rarely are disqualified (overfitting / no-signal guard) rather than rewarded
 * for a lucky high win-rate on a handful of trades.
 */
export function genomeFitness(summary: BacktestSummary): number {
  const minTrades = Number(process.env.EVOLUTION_MIN_TRADES) || 8;
  if (summary.totalTrades < minTrades) {
    return -1000 + summary.totalTrades;
  }
  const targetTrades = Number(process.env.EVOLUTION_TARGET_TRADES) || 20;
  const sampleConfidence = Math.min(1, summary.totalTrades / targetTrades);
  const edge = summary.avgReturnPct + (summary.winRate - 50) * 0.04 - summary.stopRate * 0.02;
  return Number((edge * sampleConfidence).toFixed(4));
}

/**
 * Champion/challenger gate. A challenger only wins if it beats the incumbent's
 * fitness by a margin, has enough trades, and does not regress average return or
 * collapse win-rate — guarding live recommendations against noisy mutations.
 */
export function shouldPromote(
  incumbent: Evaluation,
  challenger: Evaluation
): { promote: boolean; reason: string } {
  const margin = Number(process.env.EVOLUTION_PROMOTE_MARGIN) || 0.15;
  const minTrades = Number(process.env.EVOLUTION_MIN_PROMOTE_TRADES) || 10;
  if (challenger.summary.totalTrades < minTrades) {
    return { promote: false, reason: `표본 부족 (${challenger.summary.totalTrades} < ${minTrades})` };
  }
  if (challenger.fitness <= incumbent.fitness + margin) {
    return {
      promote: false,
      reason: `적합도 개선 부족 (${challenger.fitness.toFixed(3)} vs ${incumbent.fitness.toFixed(3)}, 마진 ${margin})`,
    };
  }
  if (challenger.summary.avgReturnPct < incumbent.summary.avgReturnPct) {
    return { promote: false, reason: "평균수익 하락" };
  }
  if (challenger.summary.winRate < incumbent.summary.winRate - 5) {
    return { promote: false, reason: "승률 급락 (>5%p)" };
  }
  return {
    promote: true,
    reason: `적합도 ${incumbent.fitness.toFixed(3)} → ${challenger.fitness.toFixed(3)} (+${(challenger.fitness - incumbent.fitness).toFixed(3)})`,
  };
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Champion seed: prior champion file → live override files → base genome. */
async function loadChampionGenome(): Promise<Genome> {
  const champion = await readJson<{ genome?: Genome }>(CHAMPION_PATH);
  if (champion?.genome?.patternWeights && champion.genome.quality) {
    return clampGenome(champion.genome);
  }
  const learned = await readJson<{ effectivePatternWeights?: Record<PatternName, number> }>(
    SWING_LEARNED_OVERRIDES_PATH
  );
  const quality = await readJson<Partial<SwingQualityParams>>(SWING_PREDICTION_QUALITY_OVERRIDES_PATH);
  return clampGenome({
    patternWeights: { ...BASE_GENOME.patternWeights, ...(learned?.effectivePatternWeights ?? {}) },
    quality: { ...BASE_GENOME.quality, ...(quality ?? {}) },
  });
}

function patternWeightAdjustments(genome: Genome): Partial<Record<PatternName, number>> {
  const adjustments: Partial<Record<PatternName, number>> = {};
  for (const name of PATTERN_NAMES) {
    const delta = genome.patternWeights[name] - SWING_PATTERN_BASE_WEIGHTS[name];
    if (delta !== 0) {
      adjustments[name] = delta;
    }
  }
  return adjustments;
}

/** Writes a genome into the live override files the screener reads. */
async function promoteToLiveOverrides(
  genome: Genome,
  summary?: BacktestSummary | null,
  fitness = 0
) {
  const totalTrades = summary?.totalTrades ?? 0;
  const winRate = summary?.winRate ?? 0;
  const avgReturnPct = summary?.avgReturnPct ?? 0;
  const existingLearned = await readJson<SwingLearnedOverrides>(SWING_LEARNED_OVERRIDES_PATH);
  const policy: WorkflowApprovalPolicy = existingLearned?.workflowApprovalPolicy ?? {
    minAgreementScore: 55,
    maxConflictScore: 50,
    minWorkflowScore: 56,
    minElliottScore: 45,
  };

  const learned: SwingLearnedOverrides = {
    generatedAt: new Date().toISOString(),
    sourceReport: "swing-evolution",
    totalTrades,
    overallWinRate: winRate,
    overallAvgReturnPct: avgReturnPct,
    minTradesForAdjustment: Number(process.env.SWING_TUNING_MIN_TRADES) || 5,
    patternWeightAdjustments: patternWeightAdjustments(genome),
    effectivePatternWeights: genome.patternWeights,
    workflowApprovalPolicy: policy,
    notes: [
      `자동진화 에이전트가 적용한 가중치입니다 (적합도 ${fitness.toFixed(3)}, 체결 ${totalTrades}건, 승률 ${winRate.toFixed(1)}%).`,
      "기존 워크플로우 승인 정책은 유지했습니다.",
    ],
  };
  await writeSwingLearnedOverrides(learned);

  const quality: SwingPredictionQualityOverrides = {
    generatedAt: new Date().toISOString(),
    sourceReport: "swing-evolution",
    totalTrades,
    sampleSize: totalTrades,
    minDefaultSwingScore: genome.quality.minDefaultSwingScore,
    minEarlyBowlSwingScore: genome.quality.minEarlyBowlSwingScore,
    minVolumeRatio: genome.quality.minVolumeRatio,
    maxRsi14: genome.quality.maxRsi14,
    maxVolatility20: genome.quality.maxVolatility20,
    notes: [`자동진화 에이전트가 승격한 품질 필터입니다 (적합도 ${fitness.toFixed(3)}).`],
  };
  await writeSwingPredictionQualityOverrides(quality);
}

export type EvolutionRunResult = {
  generatedAt: string;
  seed: number;
  promoted: boolean;
  reason: string;
  autoPromote: boolean;
  incumbent: { fitness: number; summary: BacktestSummary };
  challenger: { genome: Genome; fitness: number; summary: BacktestSummary };
  lineage: Array<{ generation: number; bestFitness: number; totalTrades: number; winRate: number; avgReturnPct: number }>;
};

function toMarkdown(result: EvolutionRunResult): string {
  const diff = PATTERN_NAMES.map(name => {
    const before = SWING_PATTERN_BASE_WEIGHTS[name];
    const after = result.challenger.genome.patternWeights[name];
    return `- ${name}: ${before} → ${after}`;
  });
  return [
    "# Swing Evolution Report",
    "",
    `- Generated: ${result.generatedAt}`,
    `- Seed: ${result.seed}`,
    `- Auto-promote: ${result.autoPromote}`,
    `- Decision: ${result.promoted ? "PROMOTED" : "HELD"} (${result.reason})`,
    "",
    "## Fitness",
    `- Incumbent: ${result.incumbent.fitness.toFixed(3)} (trades ${result.incumbent.summary.totalTrades}, win ${result.incumbent.summary.winRate.toFixed(1)}%, avg ${result.incumbent.summary.avgReturnPct.toFixed(2)}%)`,
    `- Challenger: ${result.challenger.fitness.toFixed(3)} (trades ${result.challenger.summary.totalTrades}, win ${result.challenger.summary.winRate.toFixed(1)}%, avg ${result.challenger.summary.avgReturnPct.toFixed(2)}%)`,
    "",
    "## Challenger pattern weights (vs base)",
    ...diff,
    "",
    "## Challenger quality filters",
    `- minDefaultSwingScore: ${result.challenger.genome.quality.minDefaultSwingScore}`,
    `- minEarlyBowlSwingScore: ${result.challenger.genome.quality.minEarlyBowlSwingScore}`,
    `- minVolumeRatio: ${result.challenger.genome.quality.minVolumeRatio}`,
    `- maxRsi14: ${result.challenger.genome.quality.maxRsi14}`,
    `- maxVolatility20: ${result.challenger.genome.quality.maxVolatility20}`,
    "",
    "## Lineage",
    ...result.lineage.map(
      gen => `- gen ${gen.generation}: fitness ${gen.bestFitness.toFixed(3)} (trades ${gen.totalTrades}, win ${gen.winRate.toFixed(1)}%)`
    ),
  ].join("\n");
}

function shouldRunFullEvolution(): boolean {
  if ((process.env.EVOLUTION_FORCE ?? "") === "true") return true;
  const configured = Number(process.env.EVOLUTION_DAY);
  const targetDay = Number.isInteger(configured) && configured >= 0 && configured <= 6 ? configured : 1; // 기본 월요일(KST)
  const kstDay = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Seoul" })).getDay();
  return kstDay === targetDay;
}

/**
 * Daily-cheap path: re-assert the persisted champion onto the live override
 * files. The daily backtest/tuner regenerates those files every run, so the
 * champion must be re-applied each day to drive recommendations between the
 * weekly evolution searches.
 */
async function applyChampionToLive(): Promise<boolean> {
  const champion = await readJson<{ genome?: Genome; summary?: BacktestSummary; fitness?: number }>(
    CHAMPION_PATH
  );
  // Only apply a champion that an evolution run actually promoted (has a backtest
  // summary). The initial base seed has none — leave the daily tuner output in
  // place so there is no regression until the first weekly evolution improves it.
  if (!champion?.genome?.patternWeights || !champion.genome.quality || !champion.summary) {
    return false;
  }
  await promoteToLiveOverrides(clampGenome(champion.genome), champion.summary, champion.fitness ?? 0);
  return true;
}

export async function runSwingEvolution(): Promise<EvolutionRunResult | null> {
  if (!shouldRunFullEvolution()) {
    const applied = await applyChampionToLive();
    console.log(
      `[Swing Evolution] 주간 진화일 아님 — 탐색 생략. 챔피언 적용: ${applied ? "완료" : "건너뜀(시드 없음)"}`
    );
    return null;
  }

  const population = Math.max(2, Number(process.env.EVOLUTION_POPULATION) || 8);
  const generations = Math.max(1, Number(process.env.EVOLUTION_GENERATIONS) || 3);
  const mutationRate = Number(process.env.EVOLUTION_MUTATION_RATE) || 0.5;
  const autoPromote = (process.env.EVOLUTION_AUTO_PROMOTE ?? "true") !== "false";
  const seed = Number(process.env.EVOLUTION_SEED) || (Date.now() % 2147483647);
  const rng = createRng(seed);

  const rows = await fetchBacktestRows();
  const evaluate = async (genome: Genome): Promise<Evaluation> => {
    const { trades } = await collectBacktestTrades(rows, genomeToInjected(genome));
    const summary = summarizeBacktestTrades(trades);
    return { genome, summary, fitness: genomeFitness(summary) };
  };

  const incumbent = await evaluate(await loadChampionGenome());
  let best = incumbent;
  const lineage: EvolutionRunResult["lineage"] = [];

  for (let generation = 1; generation <= generations; generation += 1) {
    let genBest = best;
    for (let i = 0; i < population; i += 1) {
      const candidate = await evaluate(mutateGenome(best.genome, rng, mutationRate));
      if (candidate.fitness > genBest.fitness) {
        genBest = candidate;
      }
    }
    best = genBest;
    lineage.push({
      generation,
      bestFitness: best.fitness,
      totalTrades: best.summary.totalTrades,
      winRate: best.summary.winRate,
      avgReturnPct: best.summary.avgReturnPct,
    });
  }

  const decision = shouldPromote(incumbent, best);
  const promoted = autoPromote && decision.promote;
  const generatedAt = new Date().toISOString();

  await mkdir(EVOLUTION_DIR, { recursive: true });

  if (promoted) {
    const previousChampion = await readJson<unknown>(CHAMPION_PATH);
    if (previousChampion) {
      const archiveDir = path.join(EVOLUTION_DIR, "archive");
      await mkdir(archiveDir, { recursive: true });
      await writeFile(
        path.join(archiveDir, `champion-${generatedAt.replace(/[:.]/g, "-")}.json`),
        `${JSON.stringify(previousChampion, null, 2)}\n`,
        "utf8"
      );
    }
    await mkdir(path.dirname(CHAMPION_PATH), { recursive: true });
    await writeFile(
      CHAMPION_PATH,
      `${JSON.stringify(
        { generatedAt, seed, fitness: best.fitness, summary: best.summary, genome: best.genome },
        null,
        2
      )}\n`,
      "utf8"
    );
    await promoteToLiveOverrides(best.genome, best.summary, best.fitness);
  }

  const history = (await readJson<unknown[]>(HISTORY_PATH)) ?? [];
  history.push({
    generatedAt,
    seed,
    promoted,
    reason: decision.reason,
    incumbentFitness: incumbent.fitness,
    challengerFitness: best.fitness,
    totalTrades: best.summary.totalTrades,
    winRate: best.summary.winRate,
    avgReturnPct: best.summary.avgReturnPct,
  });
  await writeFile(HISTORY_PATH, `${JSON.stringify(history.slice(-200), null, 2)}\n`, "utf8");

  const result: EvolutionRunResult = {
    generatedAt,
    seed,
    promoted,
    reason: decision.reason,
    autoPromote,
    incumbent: { fitness: incumbent.fitness, summary: incumbent.summary },
    challenger: { genome: best.genome, fitness: best.fitness, summary: best.summary },
    lineage,
  };

  await Promise.all([
    writeFile(REPORT_JSON_PATH, `${JSON.stringify(result, null, 2)}\n`, "utf8"),
    writeFile(REPORT_MD_PATH, `${toMarkdown(result)}\n`, "utf8"),
  ]);

  await routeToCommander({
    ticker: "EVOLVE",
    companyName: "자동진화",
    kind: "high_conviction",
    headline: promoted
      ? `전략 진화 승격: 적합도 ${incumbent.fitness.toFixed(2)} → ${best.fitness.toFixed(2)}`
      : `진화 후보 보류 (${decision.reason})`,
    detail: [
      `체결 ${best.summary.totalTrades}건 · 승률 ${best.summary.winRate.toFixed(1)}% · 평균수익 ${best.summary.avgReturnPct.toFixed(2)}%`,
      `자동승격 ${autoPromote ? "ON" : "OFF"} · seed ${seed} · ${generations}세대×${population}개체`,
      promoted ? "라이브 오버라이드에 반영됨 (이전 챔피언 보관)." : "라이브 변경 없음.",
    ],
  }).catch(error => {
    console.warn("[Swing Evolution] commander notify failed:", error);
  });

  return result;
}

async function runFromCli() {
  const result = await runSwingEvolution();
  if (!result) {
    return;
  }
  console.log(
    `[Swing Evolution] ${result.promoted ? "PROMOTED" : "HELD"} — incumbent ${result.incumbent.fitness.toFixed(
      3
    )} vs challenger ${result.challenger.fitness.toFixed(3)} (${result.reason})`
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  runFromCli().catch(error => {
    console.error("[Swing Evolution] Failed:", error);
    process.exit(1);
  });
}
