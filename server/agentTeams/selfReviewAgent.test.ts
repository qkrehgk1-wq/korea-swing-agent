import { describe, expect, it } from "vitest";

import { buildSelfReviewReport } from "./selfReviewAgent";

describe("buildSelfReviewReport", () => {
  it("raises upgrade actions when approvals stay at zero", () => {
    const report = buildSelfReviewReport({
      maintenanceReport: {
        generatedAt: "2026-05-22T00:00:00.000Z",
        success: true,
        warnings: [],
        failures: [],
        pipeline: {
          matchedSwingCandidates: 0,
          matchedLimitUpCandidates: 1,
          matchedFollowThroughCandidates: 0,
          approvedCandidates: 0,
          heldCandidates: 6,
          youtubeRules: 0,
        },
        notificationStatus: {
          telegramConfigured: true,
          ownerConfigured: false,
          kakaoConfigured: false,
        },
        contract: {
          drift: {
            score: 44,
            status: "watch",
            findings: ["후보는 생성됐지만 승인 0건"],
          },
        },
      },
      maintenanceHistory: [
        {
          generatedAt: "2026-05-20T00:00:00.000Z",
          success: true,
          approvedCandidates: 0,
          heldCandidates: 5,
          matchedSwingCandidates: 0,
          matchedLimitUpCandidates: 0,
          matchedFollowThroughCandidates: 0,
        },
        {
          generatedAt: "2026-05-21T00:00:00.000Z",
          success: true,
          approvedCandidates: 0,
          heldCandidates: 6,
          matchedSwingCandidates: 0,
          matchedLimitUpCandidates: 1,
          matchedFollowThroughCandidates: 0,
        },
      ],
      now: new Date("2026-05-22T00:00:00.000Z"),
    });

    expect(report.findings.some(item => item.includes("연속 2회 승인 0건"))).toBe(true);
    expect(report.actions.some(item => item.title === "승인 기준과 유니버스 재조정")).toBe(true);
    expect(report.healthScores.signalQuality).toBeLessThan(60);
  });
});
