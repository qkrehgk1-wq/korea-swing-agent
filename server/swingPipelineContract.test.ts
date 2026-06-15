import { describe, expect, it } from "vitest";

import {
  createSwingPipelineExecutionReport,
  createSwingPipelineSeed,
} from "./swingPipelineContract";

describe("swingPipelineContract", () => {
  it("builds a seed and execution report for evaluation-ready pipeline runs", () => {
    const seed = createSwingPipelineSeed(
      {
        ORIANE_EXPORT_PATH: "C:/tmp/oriane.csv",
        WAYDEV_MCP_URL: "https://waydev.example",
        WAYDEV_MCP_TOKEN: "token",
        WAYDEV_MCP_TOOL: "tool",
      },
      new Date("2026-05-26T00:00:00.000Z")
    );

    const report = createSwingPipelineExecutionReport({
      seed,
      technicalSwing: {
        bible: [],
        candidates: [],
        scannedTickers: ["005930", "000660"],
        notes: ["스윙 메모 1", "스윙 메모 2"],
      },
      kosdaqTeam: {
        candidates: [],
        scannedTickers: ["086520"],
        notes: ["코스닥 메모"],
      },
      limitUp: {
        candidates: [
          {
            ticker: "042700",
            companyName: "한미반도체",
            market: "코스닥",
            limitUpScore: 72,
            limitUpFit: "상",
            currentPrice: 100,
            triggerPrice: 102,
            stopLossPrice: 95,
            estimatedLimitPrice: 130,
            dayReturn: 5,
            volumeRatio: 1.8,
            turnoverPulse: 1.4,
            rsi14: 61,
            setup: ["바닥권 거래량 점화"],
            reason: ["reason"],
          },
        ],
        scannedTickers: ["042700"],
        notes: ["상한가 메모"],
      },
      firstLimitUp: {
        candidates: [],
        scannedTickers: ["058470"],
        notes: ["후속 메모"],
      },
      mergedSwingCandidates: [{ ticker: "005930" }],
      externalPlatformReport: {
        enabled: ["Oriane", "Waydev"],
        disabled: ["Airbyte"],
        insights: [],
        notes: [],
      },
      agentTeamReport: {
        generatedAt: "2026-05-26T00:01:00.000Z",
        phaseSummary: [],
        companyInsights: [],
        approved: [
          {
            ticker: "005930",
            companyName: "삼성전자",
            source: "스윙",
            alphaScore: 80,
            workflowScore: 70,
            agreementScore: 75,
            conflictScore: 20,
            validation: "승인",
            riskGrade: "A",
            recommendedCapitalPct: 4,
            maxLossPct: 5,
            rewardRiskRatio: 1.4,
            reasons: [],
            blockers: [],
          },
        ],
        rejected: [
          {
            ticker: "042700",
            companyName: "한미반도체",
            source: "상한가",
            alphaScore: 72,
            workflowScore: 49,
            agreementScore: 40,
            conflictScore: 50,
            validation: "보류",
            riskGrade: "C",
            recommendedCapitalPct: 0,
            maxLossPct: 10,
            rewardRiskRatio: 0.9,
            reasons: [],
            blockers: ["합의 부족"],
          },
        ],
        notes: ["에이전트 메모"],
      },
      danteLearning: {
        channelName: "주식단테_20년차트고수",
        generatedAt: "2026-05-26T00:01:00.000Z",
        rules: [{ id: "rule-1", title: "rule", summary: "summary", patternHints: [], riskNotes: [] }],
        sources: [{ videoId: "a", title: "video", publishedAt: "2026-05-20", url: "https://example.com", summary: "sum" }],
        notes: [],
      },
      telegramDelivered: true,
      now: new Date("2026-05-26T00:02:00.000Z"),
    });

    expect(seed.externalIntegrations.find(item => item.name === "Oriane")?.mode).toBe("export");
    expect(seed.externalIntegrations.find(item => item.name === "Waydev")?.mode).toBe("mcp");
    expect(report.status).toBe("completed");
    expect(report.counts.approvedCandidates).toBe(1);
    expect(report.approvals.heldTickers).toEqual(["042700"]);
    expect(report.externalPlatformStatus.enabled).toEqual(["Oriane", "Waydev"]);
    expect(report.danteLearning.rules).toBe(1);
  });
});
