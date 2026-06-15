import { describe, expect, it } from "vitest";

import {
  assessSwingPipelineDrift,
  createSwingPipelineExecutionReport,
  createSwingPipelineSeed,
} from "./swingPipelineContract";

describe("assessSwingPipelineDrift", () => {
  it("flags high drift when candidates exist but approvals are zero", () => {
    const seed = createSwingPipelineSeed({}, new Date("2026-05-26T00:00:00.000Z"));
    const execution = createSwingPipelineExecutionReport({
      seed,
      technicalSwing: {
        bible: [],
        candidates: [],
        scannedTickers: ["005930"],
        notes: [],
      },
      kosdaqTeam: {
        candidates: [],
        scannedTickers: ["196170"],
        notes: [],
      },
      limitUp: {
        candidates: [],
        scannedTickers: ["042700"],
        notes: [],
      },
      firstLimitUp: {
        candidates: [],
        scannedTickers: ["058470"],
        notes: [],
      },
      mergedSwingCandidates: [{ ticker: "005930" }],
      telegramDelivered: true,
      agentTeamReport: {
        generatedAt: "2026-05-26T00:01:00.000Z",
        phaseSummary: [],
        companyInsights: [],
        approved: [],
        rejected: [
          {
            ticker: "005930",
            companyName: "삼성전자",
            source: "스윙",
            alphaScore: 60,
            workflowScore: 45,
            agreementScore: 30,
            conflictScore: 50,
            validation: "보류",
            riskGrade: "C",
            recommendedCapitalPct: 0,
            maxLossPct: 10,
            rewardRiskRatio: 0.8,
            reasons: [],
            blockers: ["합의 부족"],
          },
        ],
        notes: [],
      },
      now: new Date("2026-05-26T00:02:00.000Z"),
    });

    const drift = assessSwingPipelineDrift(seed, execution);

    expect(drift.status).toBe("watch");
    expect(drift.score).toBeGreaterThanOrEqual(20);
    expect(drift.findings.some(item => item.includes("승인 후보가 0건"))).toBe(true);
  });
});
