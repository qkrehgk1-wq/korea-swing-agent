import { describe, expect, it } from "vitest";

import { runAgentTeamReview } from "./orchestrator";

describe("runAgentTeamReview workflow orchestration", () => {
  it("holds a technically strong candidate when cross-agent agreement is weak", async () => {
    const report = await runAgentTeamReview({
      swingCandidates: [
        {
          ticker: "A",
          companyName: "Alpha",
          market: "코스피",
          currentPrice: 100,
          triggerPrice: 102,
          stopLossPrice: 92,
          swingScore: 88,
          swingFit: "상",
          patterns: ["돌파매매"],
          volumeRatio: 0.8,
          rsi14: 86,
        },
        {
          ticker: "B",
          companyName: "Beta",
          market: "코스피",
          currentPrice: 100,
          triggerPrice: 103,
          stopLossPrice: 96,
          swingScore: 74,
          swingFit: "중",
          patterns: ["밥그릇 2번자리"],
          volumeRatio: 1.5,
          rsi14: 58,
        },
      ],
      limitUpCandidates: [],
      companyInsights: [
        {
          ticker: "A",
          companyName: "Alpha",
          items: [],
          catalystScore: 0,
          riskScore: 4,
          sentimentLabel: "부정",
          summary: [],
          risks: [],
          catalysts: [],
        },
        {
          ticker: "B",
          companyName: "Beta",
          items: [],
          catalystScore: 3,
          riskScore: 0,
          sentimentLabel: "긍정",
          summary: [],
          risks: [],
          catalysts: [],
        },
      ],
      danteLearning: {
        channelId: "x",
        channelName: "y",
        generatedAt: new Date().toISOString(),
        sources: [],
        rules: [
          {
            id: "bowl-right-side",
            label: "밥그릇 우측 회복",
            confidence: 80,
            evidenceCount: 2,
            keywords: ["밥그릇", "2번자리", "20일선"],
            summary: "밥그릇 우측 회복",
          },
        ],
        notes: [],
      },
      elliottFractalInsights: [
        {
          ticker: "A",
          companyName: "Alpha",
          score: 38,
          label: "교정/혼조",
          waveBias: "mixed",
          waveCountEstimate: "파동 식별 부족",
          fractalCompressionScore: 34,
          notes: [],
          warnings: ["최근 파동 구조가 매끈하지 않아 엘리엇 판독 신뢰도가 낮음"],
        },
        {
          ticker: "B",
          companyName: "Beta",
          score: 79,
          label: "초기 3파 확장",
          waveBias: "early_impulse",
          waveCountEstimate: "초기 3파 확장",
          fractalCompressionScore: 72,
          notes: [],
          warnings: [],
        },
      ],
    });

    const approvedTickers = report.approved.map(item => item.ticker);
    const rejectedTickers = report.rejected.map(item => item.ticker);
    const beta = report.approved.find(item => item.ticker === "B");
    const alpha = report.rejected.find(item => item.ticker === "A");

    expect(approvedTickers).toContain("B");
    expect(rejectedTickers).toContain("A");
    expect(beta?.workflowScore).toBeGreaterThan(alpha?.workflowScore ?? 0);
  });
});
