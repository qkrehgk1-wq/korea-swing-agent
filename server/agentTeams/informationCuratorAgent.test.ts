import { describe, expect, it } from "vitest";

import {
  collectInformationCuratorReport,
  parseCuratorAtomFeed,
} from "./informationCuratorAgent";

const SAMPLE_ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>DeepSupp: Dynamic Support and Resistance Levels Identification</title>
    <id>http://arxiv.org/abs/2507.01971</id>
    <published>2025-06-22T00:00:00Z</published>
    <summary>Support and resistance detection with dynamic market regime sensitivity.</summary>
    <link href="http://arxiv.org/abs/2507.01971v1" />
  </entry>
</feed>`;

const IRRELEVANT_ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>MinerU-Popo: Universal Post-Processing Model for Structured Document Parsing</title>
    <id>http://arxiv.org/abs/2605.24973</id>
    <published>2026-05-24T00:00:00Z</published>
    <summary>VLM-based OCR models improve document parsing and page-level extraction for RAG systems.</summary>
    <link href="http://arxiv.org/abs/2605.24973v1" />
  </entry>
</feed>`;

describe("informationCuratorAgent", () => {
  it("parses atom entries", () => {
    const entries = parseCuratorAtomFeed(SAMPLE_ATOM);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.title).toContain("DeepSupp");
  });

  it("builds implementation-ready findings for our swing stack", async () => {
    const report = await collectInformationCuratorReport({
      feeds: [
        {
          source: "arXiv q-fin support-resistance",
          url: "https://example.test/feed",
          category: "support-resistance",
        },
      ],
      fetchImpl: async () =>
        new Response(SAMPLE_ATOM, {
          status: 200,
          headers: { "content-type": "application/atom+xml" },
        }),
      now: new Date("2026-05-26T00:00:00.000Z"),
    });

    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.category).toBe("support-resistance");
    expect(report.findings[0]?.implementationPlan).toContain("triggerPrice/stopLossPrice");
    expect(report.findings[0]?.targetFiles).toContain("server/technicalSwingScreener.ts");
  });

  it("rejects non-finance papers even when feed category matches", async () => {
    const report = await collectInformationCuratorReport({
      feeds: [
        {
          source: "arXiv q-fin support-resistance",
          url: "https://example.test/feed",
          category: "support-resistance",
        },
      ],
      fetchImpl: async () =>
        new Response(IRRELEVANT_ATOM, {
          status: 200,
          headers: { "content-type": "application/atom+xml" },
        }),
      danteCollector: async () => {
        throw new Error("fallback disabled for test");
      },
      now: new Date("2026-05-26T00:00:00.000Z"),
    });

    expect(report.findings).toHaveLength(0);
  });

  it("falls back to Dante house-view rules when live feeds are unavailable", async () => {
    const report = await collectInformationCuratorReport({
      feeds: [
        {
          source: "arXiv q-fin regime",
          url: "https://example.test/feed",
          category: "regime",
        },
      ],
      fetchImpl: async () => new Response("busy", { status: 429 }),
      danteCollector: async () => ({
        channelId: "demo",
        channelName: "주식단테_20년차트고수",
        generatedAt: "2026-05-26T00:00:00.000Z",
        sources: [],
        rules: [
          {
            id: "bowl-right-side",
            label: "밥그릇 우측 회복",
            confidence: 88,
            evidenceCount: 4,
            keywords: ["밥그릇", "1번자리", "2번자리"],
            summary: "우측 회복과 20일선 회복을 중시합니다.",
          },
        ],
        notes: [],
      }),
      now: new Date("2026-05-26T00:00:00.000Z"),
    });

    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.title).toContain("Dante House View");
    expect(report.findings[0]?.implementationPlan).toContain("밥그릇");
  });
});
