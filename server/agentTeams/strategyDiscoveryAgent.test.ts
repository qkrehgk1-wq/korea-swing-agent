import { describe, expect, it } from "vitest";

import { collectStrategyDiscoveryReport, parseAtomFeed } from "./strategyDiscoveryAgent";

const SAMPLE_ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>Market Regime Detection for Momentum Trading</title>
    <id>http://arxiv.org/abs/1234.5678</id>
    <published>2026-05-20T00:00:00Z</published>
    <summary>We study market regime shifts, volatility filters, and momentum trading timing.</summary>
    <link href="http://arxiv.org/abs/1234.5678v1" />
  </entry>
</feed>`;

describe("strategyDiscoveryAgent", () => {
  it("parses atom feed entries", () => {
    const entries = parseAtomFeed(SAMPLE_ATOM);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.title).toContain("Market Regime Detection");
  });

  it("builds actionable findings from research feeds", async () => {
    const report = await collectStrategyDiscoveryReport({
      feeds: [{ source: "arXiv q-fin", url: "https://example.test/feed" }],
      fetchImpl: async () =>
        new Response(SAMPLE_ATOM, {
          status: 200,
          headers: { "content-type": "application/atom+xml" },
        }),
      now: new Date("2026-05-22T00:00:00.000Z"),
    });

    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.relevanceScore).toBeGreaterThanOrEqual(70);
    expect(report.findings[0]?.adoptionIdea).toContain("장세 분류 필터");
  });
});
