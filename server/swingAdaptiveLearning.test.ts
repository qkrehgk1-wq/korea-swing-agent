import { describe, expect, it } from "vitest";

import { deriveSwingLearnedOverrides } from "./swingAdaptiveLearning";

describe("deriveSwingLearnedOverrides", () => {
  it("raises strong patterns and lowers weak patterns within bounded adjustments", () => {
    const overrides = deriveSwingLearnedOverrides({
      generatedAt: "2026-05-08T00:00:00.000Z",
      totalTrades: 42,
      winRate: 64.3,
      avgReturnPct: 1.56,
      patternStats: [
        {
          pattern: "돌파매매",
          trades: 11,
          wins: 8,
          losses: 3,
          noTriggers: 5,
          winRate: 72.7,
          avgReturnPct: 3.48,
        },
        {
          pattern: "하이힐 패턴",
          trades: 7,
          wins: 3,
          losses: 4,
          noTriggers: 3,
          winRate: 42.9,
          avgReturnPct: -0.9,
        },
      ],
    });

    expect(overrides.patternWeightAdjustments["돌파매매"]).toBe(2);
    expect(overrides.patternWeightAdjustments["하이힐 패턴"]).toBe(-2);
    expect(overrides.effectivePatternWeights["돌파매매"]).toBe(8);
    expect(overrides.effectivePatternWeights["하이힐 패턴"]).toBe(5);
    expect(overrides.workflowApprovalPolicy).toEqual({
      minAgreementScore: 58,
      maxConflictScore: 45,
      minWorkflowScore: 60,
      minElliottScore: 45,
    });
  });

  it("keeps low-sample patterns unchanged", () => {
    const overrides = deriveSwingLearnedOverrides({
      generatedAt: "2026-05-08T00:00:00.000Z",
      totalTrades: 12,
      winRate: 52,
      avgReturnPct: 0.7,
      patternStats: [
        {
          pattern: "밥그릇 1번자리",
          trades: 2,
          wins: 1,
          losses: 1,
          noTriggers: 4,
          winRate: 50,
          avgReturnPct: 0.3,
        },
      ],
    });

    expect(overrides.patternWeightAdjustments["밥그릇 1번자리"]).toBeUndefined();
    expect(overrides.notes[0]).toContain("자동 조정하지 않았습니다");
  });

  it("tightens elliott threshold when mixed wave structures backtest poorly", () => {
    const overrides = deriveSwingLearnedOverrides({
      generatedAt: "2026-05-09T00:00:00.000Z",
      totalTrades: 40,
      winRate: 61,
      avgReturnPct: 1.4,
      patternStats: [],
      elliottLabelStats: [
        {
          label: "교정/혼조",
          trades: 9,
          wins: 3,
          losses: 6,
          noTriggers: 1,
          winRate: 33.3,
          avgReturnPct: -1.2,
        },
        {
          label: "초기 3파 확장",
          trades: 8,
          wins: 5,
          losses: 3,
          noTriggers: 2,
          winRate: 62.5,
          avgReturnPct: 2.1,
        },
      ],
    });

    expect(overrides.workflowApprovalPolicy.minElliottScore).toBe(53);
  });

  it("relaxes approval policy slightly after repeated zero-approval maintenance runs", () => {
    const overrides = deriveSwingLearnedOverrides(
      {
        generatedAt: "2026-05-09T00:00:00.000Z",
        totalTrades: 41,
        winRate: 68.3,
        avgReturnPct: 1.94,
        patternStats: [],
        elliottLabelStats: [
          {
            label: "강한 상승 5파 진행",
            trades: 5,
            wins: 4,
            losses: 1,
            noTriggers: 1,
            winRate: 80,
            avgReturnPct: 2.25,
          },
        ],
      },
      "test-report.json",
      {
        recentRuns: [
          {
            generatedAt: "2026-05-09T01:00:00.000Z",
            success: true,
            approvedCandidates: 0,
            heldCandidates: 6,
            matchedSwingCandidates: 3,
            matchedLimitUpCandidates: 3,
            matchedFollowThroughCandidates: 0,
          },
          {
            generatedAt: "2026-05-09T02:00:00.000Z",
            success: true,
            approvedCandidates: 0,
            heldCandidates: 7,
            matchedSwingCandidates: 4,
            matchedLimitUpCandidates: 3,
            matchedFollowThroughCandidates: 0,
          },
          {
            generatedAt: "2026-05-09T03:00:00.000Z",
            success: true,
            approvedCandidates: 0,
            heldCandidates: 5,
            matchedSwingCandidates: 2,
            matchedLimitUpCandidates: 3,
            matchedFollowThroughCandidates: 0,
          },
        ],
        consecutiveZeroApprovalRuns: 3,
        averageApprovedCandidates: 0,
        averageHeldCandidates: 6,
      }
    );

    expect(overrides.workflowApprovalPolicy).toEqual({
      minAgreementScore: 56,
      maxConflictScore: 49,
      minWorkflowScore: 57,
      minElliottScore: 45,
    });
    expect(overrides.notes.at(-1)).toContain("연속 승인 0회 3회");
  });

  it("applies a mild relaxation when recent live runs are healthy but approvals stay near zero", () => {
    const overrides = deriveSwingLearnedOverrides(
      {
        generatedAt: "2026-05-09T00:00:00.000Z",
        totalTrades: 41,
        winRate: 68.3,
        avgReturnPct: 1.94,
        patternStats: [],
        elliottLabelStats: [
          {
            label: "강한 상승 5파 진행",
            trades: 5,
            wins: 4,
            losses: 1,
            noTriggers: 1,
            winRate: 80,
            avgReturnPct: 2.25,
          },
        ],
      },
      "test-report.json",
      {
        recentRuns: [
          {
            generatedAt: "2026-05-09T01:00:00.000Z",
            success: true,
            approvedCandidates: 0,
            heldCandidates: 6,
            matchedSwingCandidates: 3,
            matchedLimitUpCandidates: 3,
            matchedFollowThroughCandidates: 0,
          },
        ],
        consecutiveZeroApprovalRuns: 1,
        averageApprovedCandidates: 0,
        averageHeldCandidates: 6,
      }
    );

    expect(overrides.workflowApprovalPolicy).toEqual({
      minAgreementScore: 57,
      maxConflictScore: 47,
      minWorkflowScore: 58,
      minElliottScore: 46,
    });
  });
});
