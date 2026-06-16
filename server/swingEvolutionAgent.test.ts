import { describe, expect, it } from "vitest";

import type { BacktestSummary } from "./swingBacktestAgent";
import {
  BASE_GENOME,
  clampGenome,
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

  it("is reproducible for the same seed", () => {
    expect(mutateGenome(BASE_GENOME, createRng(99), 0.7)).toEqual(
      mutateGenome(BASE_GENOME, createRng(99), 0.7)
    );
  });
});

describe("genomeFitness", () => {
  it("disqualifies strategies that trade too rarely", () => {
    expect(genomeFitness(summary({ totalTrades: 5, avgReturnPct: 9, winRate: 100 }))).toBeLessThan(-900);
  });

  it("rewards higher realized edge", () => {
    const weak = genomeFitness(summary({ avgReturnPct: 0.4, winRate: 48 }));
    const strong = genomeFitness(summary({ avgReturnPct: 2.5, winRate: 66 }));
    expect(strong).toBeGreaterThan(weak);
  });

  it("scales down low-sample strong runs via sample confidence", () => {
    const lowSample = genomeFitness(summary({ totalTrades: 20, avgReturnPct: 2, winRate: 60 }));
    const fullSample = genomeFitness(summary({ totalTrades: 40, avgReturnPct: 2, winRate: 60 }));
    expect(fullSample).toBeGreaterThan(lowSample);
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

  it("holds when the challenger has too few trades", () => {
    const challenger = evaluation(2.0, { totalTrades: 10, avgReturnPct: 3, winRate: 70 });
    expect(shouldPromote(incumbent, challenger).promote).toBe(false);
  });

  it("holds when average return regresses", () => {
    const challenger = evaluation(1.4, { totalTrades: 45, avgReturnPct: 1.2, winRate: 70 });
    expect(shouldPromote(incumbent, challenger).promote).toBe(false);
  });

  it("holds when win-rate collapses", () => {
    const challenger = evaluation(1.4, { totalTrades: 45, avgReturnPct: 2.0, winRate: 49 });
    expect(shouldPromote(incumbent, challenger).promote).toBe(false);
  });
});
