import { describe, expect, it } from "vitest";

import { computeExpectancy } from "./expectancy";
import type { BacktestSummary } from "./swingBacktestAgent";
import {
  BASE_GENOME,
  clampGenome,
  consistencyFactor,
  createRng,
  genomeFitness,
  mutateGenome,
  shouldPromote,
  type Evaluation,
  type Genome,
} from "./swingEvolutionAgent";

function summary(overrides: Partial<BacktestSummary>): BacktestSummary {
  return {
    totalSignals: 100,
    totalTrades: 40,
    winRate: 55,
    avgReturnPct: 1.5,
    medianReturnPct: 1,
    stopRate: 20,
    targetRate: 40,
    noTriggerRate: 30,
    patternStats: [],
    elliottLabelStats: [],
    ...overrides,
  };
}

function evaluation(fitness: number, overrides: Partial<BacktestSummary> = {}): Evaluation {
  return { genome: BASE_GENOME, summary: summary(overrides), fitness };
}

describe("createRng", () => {
  it("is deterministic for a given seed", () => {
    const a = createRng(42);
    const b = createRng(42);
    const seqA = [a(), a(), a()];
    const seqB = [b(), b(), b()];
    expect(seqA).toEqual(seqB);
    expect(seqA.every(value => value >= 0 && value < 1)).toBe(true);
  });

  it("differs across seeds", () => {
    expect(createRng(1)()).not.toEqual(createRng(2)());
  });
});

describe("clampGenome", () => {
  it("clamps out-of-bounds genes back into range", () => {
    const wild: Genome = {
      patternWeights: { ...BASE_GENOME.patternWeights, 돌파매매: 999, 컵앤핸들: -50 },
      quality: {
        minDefaultSwingScore: 999,
        minEarlyBowlSwingScore: -10,
        minVolumeRatio: 9,
        maxRsi14: 5,
        maxVolatility20: 200,
      },
    };
    const clamped = clampGenome(wild);
    expect(clamped.patternWeights.돌파매매).toBeLessThanOrEqual(26);
    expect(clamped.patternWeights.컵앤핸들).toBeGreaterThanOrEqual(3);
    expect(clamped.quality.minDefaultSwingScore).toBeLessThanOrEqual(75);
    expect(clamped.quality.minVolumeRatio).toBeLessThanOrEqual(1.6);
    expect(clamped.quality.maxRsi14).toBeGreaterThanOrEqual(68);
    expect(clamped.quality.maxVolatility20).toBeLessThanOrEqual(60);
  });
});

describe("mutateGenome", () => {
  it("keeps every gene within bounds across many mutations", () => {
    const rng = createRng(7);
    let genome = BASE_GENOME;
    for (let i = 0; i < 200; i += 1) {
      genome = mutateGenome(genome, rng, 0.8);
      for (const weight of Object.values(genome.patternWeights)) {
        expect(weight).toBeGreaterThanOrEqual(3);
        expect(weight).toBeLessThanOrEqual(26);
      }
      expect(genome.quality.minVolumeRatio).toBeGreaterThanOrEqual(0.6);
      expect(genome.quality.minVolumeRatio).toBeLessThanOrEqual(1.6);
      expect(genome.quality.maxRsi14).toBeGreaterThanOrEqual(68);
      expect(genome.quality.maxRsi14).toBeLessThanOrEqual(82);
    }
  });

  it("keeps the evolvable exit ladder inside bounds", () => {
    const rng = createRng(13);
    let genome = BASE_GENOME;
    for (let i = 0; i < 200; i += 1) {
      genome = mutateGenome(genome, rng, 0.9);
      expect(genome.exit.breakevenAtR).toBeGreaterThanOrEqual(0);
      expect(genome.exit.breakevenAtR).toBeLessThanOrEqual(1.5);
      expect(genome.exit.trailGivebackR).toBeGreaterThanOrEqual(0);
      expect(genome.exit.trailGivebackR).toBeLessThanOrEqual(1.2);
    }
  });

  it("restores a missing exit ladder from the base genome", () => {
    const legacy = { patternWeights: BASE_GENOME.patternWeights, quality: BASE_GENOME.quality };
    expect(clampGenome(legacy).exit).toEqual(BASE_GENOME.exit);
  });

  it("is reproducible for the same seed", () => {
    expect(mutateGenome(BASE_GENOME, createRng(99), 0.7)).toEqual(
      mutateGenome(BASE_GENOME, createRng(99), 0.7)
    );
  });
});

describe("genomeFitness", () => {
  /** trigger 100 / stop 90 ⇒ risk 10% ⇒ returnPct N is N/10 R. */
  const trades = (spec: Array<[count: number, returnPct: number]>) =>
    spec.flatMap(([count, returnPct]) =>
      Array.from({ length: count }, () => ({
        triggerPrice: 100,
        stopLossPrice: 90,
        returnPct,
        outcome: returnPct > 0 ? "target" : "stop",
      }))
    );

  it("disqualifies strategies that trade too rarely", () => {
    expect(genomeFitness(computeExpectancy(trades([[5, 30]])))).toBeLessThan(-900);
  });

  it("rewards higher realized edge per unit of risk", () => {
    const weak = genomeFitness(computeExpectancy(trades([[20, 3], [20, -3]])));
    const strong = genomeFitness(computeExpectancy(trades([[20, 25], [20, -10]])));
    expect(strong).toBeGreaterThan(weak);
  });

  it("scales down low-sample strong runs via sample confidence", () => {
    const lowSample = genomeFitness(computeExpectancy(trades([[10, 20]])));
    const fullSample = genomeFitness(computeExpectancy(trades([[40, 20]])));
    expect(fullSample).toBeGreaterThan(lowSample);
  });

  it("does not reward 'win small, win often' over a genuine payoff edge", () => {
    // 80% hit rate but tiny wins vs 45% hit rate with a 3:1 payoff.
    const winSmallOften = genomeFitness(computeExpectancy(trades([[32, 1.5], [8, -10]])));
    const realPayoff = genomeFitness(computeExpectancy(trades([[18, 30], [22, -10]])));
    expect(realPayoff).toBeGreaterThan(winSmallOften);
  });
});

describe("consistencyFactor", () => {
  const split = (aTrades: number, aAvg: number, bTrades: number, bAvg: number) => ({
    splitDate: "2025-01-01" as string | null,
    distinctTickers: 10,
    inSample: { trades: aTrades, winRate: 50, avgReturnPct: aAvg },
    outOfSample: { trades: bTrades, winRate: 50, avgReturnPct: bAvg },
  });

  it("returns 1 when either half lacks sample", () => {
    expect(consistencyFactor(split(3, 5, 20, 5))).toBe(1);
    expect(consistencyFactor({ ...split(10, 5, 10, 5), splitDate: null })).toBe(1);
  });

  it("halves fitness when one half loses money (bull-only genome)", () => {
    expect(consistencyFactor(split(10, -1, 10, 5))).toBe(0.5);
    expect(consistencyFactor(split(10, 5, 10, -0.5))).toBe(0.5);
  });

  it("rewards balanced halves, scales down imbalance", () => {
    expect(consistencyFactor(split(10, 4, 10, 4))).toBe(1);
    expect(consistencyFactor(split(10, 1, 10, 4))).toBe(0.7);
  });
});

describe("shouldPromote", () => {
  const incumbent = evaluation(1.0, { totalTrades: 40, avgReturnPct: 1.5, winRate: 55 });

  it("promotes a clear, well-sampled winner", () => {
    const challenger = evaluation(1.4, { totalTrades: 45, avgReturnPct: 2.0, winRate: 58 });
    expect(shouldPromote(incumbent, challenger).promote).toBe(true);
  });

  it("holds when the fitness gain is within the margin", () => {
    const challenger = evaluation(1.05, { totalTrades: 45, avgReturnPct: 1.6, winRate: 56 });
    expect(shouldPromote(incumbent, challenger).promote).toBe(false);
  });

  it("scales the margin to the fitness level (R-scale safe)", () => {
    // Expectancy-scale incumbent: 0.20 needs ~+0.04 (20%), not a fixed +0.15.
    const small = evaluation(0.20, { totalTrades: 45, avgReturnPct: 1.5, winRate: 55 });
    const betterEnough = evaluation(0.26, { totalTrades: 45, avgReturnPct: 1.6, winRate: 56 });
    const notEnough = evaluation(0.22, { totalTrades: 45, avgReturnPct: 1.6, winRate: 56 });
    expect(shouldPromote(small, betterEnough).promote).toBe(true);
    expect(shouldPromote(small, notEnough).promote).toBe(false);
  });

  it("holds when the challenger has too few trades", () => {
    const challenger = evaluation(2.0, { totalTrades: 6, avgReturnPct: 3, winRate: 70 });
    expect(shouldPromote(incumbent, challenger).promote).toBe(false);
  });

  it("no longer vetoes on a rounding-level average-return dip (fitness governs)", () => {
    // Real 7/19 case: clearly better fitness, higher win rate, lower stop rate,
    // but avgReturnPct 0.06pp lower — the old guard killed it.
    const challenger = evaluation(1.4, { totalTrades: 45, avgReturnPct: 1.44, winRate: 60 });
    expect(shouldPromote(incumbent, challenger).promote).toBe(true);
  });

  it("holds when win-rate collapses", () => {
    const challenger = evaluation(1.4, { totalTrades: 45, avgReturnPct: 2.0, winRate: 49 });
    expect(shouldPromote(incumbent, challenger).promote).toBe(false);
  });
});
