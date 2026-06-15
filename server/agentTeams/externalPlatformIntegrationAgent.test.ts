import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  collectExternalPlatformInsights,
  extractMcpRows,
  parseFlexibleCsv,
  summarizeAirbyteRows,
  summarizeOrianeRows,
  summarizeWaydevRows,
} from "./externalPlatformIntegrationAgent";

describe("externalPlatformIntegrationAgent", () => {
  it("parses CSV exports with quoted commas", () => {
    const rows = parseFlexibleCsv('ticker,brand,summary\n"035720","카카오","숏폼, 영상 언급 증가"\n');

    expect(rows).toEqual([
      {
        ticker: "035720",
        brand: "카카오",
        summary: "숏폼, 영상 언급 증가",
      },
    ]);
  });

  it("summarizes Oriane video intelligence rows into stock-adjacent trend insights", () => {
    const insights = summarizeOrianeRows([
      {
        ticker: "035720",
        brand: "카카오",
        views: "2500000",
        engagement: "82000",
        sentiment: "positive",
        summary: "카카오 서비스 언급 영상 확산",
      },
    ]);

    expect(insights[0]).toMatchObject({
      source: "Oriane",
      ticker: "035720",
      label: "영상 트렌드 긍정",
    });
    expect(insights[0].score).toBeGreaterThan(50);
  });

  it("summarizes Waydev exports without affecting stock recommendations", () => {
    const insights = summarizeWaydevRows([
      {
        metric: "AI cost per PR",
        value: "42",
        change: "35",
        summary: "AI 비용 상승",
      },
    ]);

    expect(insights[0]).toMatchObject({
      source: "Waydev",
      label: "운영 리스크",
    });
  });

  it("summarizes Airbyte pipeline status without affecting stock recommendations", () => {
    const insights = summarizeAirbyteRows([
      {
        connection_name: "google-news-to-local-cache",
        status: "succeeded",
        records_synced: "12800",
        last_sync_at: "2026-05-06T00:00:00Z",
        summary: "뉴스 수집 파이프라인 정상",
      },
      {
        connection_name: "orphan-source",
        status: "failed",
        errors: "2",
        summary: "소스 인증 실패",
      },
    ]);

    expect(insights[0]).toMatchObject({
      source: "Airbyte",
      label: "데이터 파이프라인 정상",
    });
    expect(insights[1]).toMatchObject({
      source: "Airbyte",
      label: "데이터 파이프라인 리스크",
    });
  });

  it("extracts rows from common MCP tool result shapes", () => {
    expect(
      extractMcpRows({
        structuredContent: {
          rows: [
            {
              Ticker: "035720",
              Brand: "카카오",
              Views: 120000,
            },
          ],
        },
      }),
    ).toEqual([
      {
        ticker: "035720",
        brand: "카카오",
        views: "120000",
      },
    ]);

    expect(
      extractMcpRows({
        content: [
          {
            type: "text",
            text: "metric,value,change\nAI acceptance rate,70,9\n",
          },
        ],
      })[0],
    ).toMatchObject({
      metric: "AI acceptance rate",
      change: "9",
    });
  });

  it("collects optional integrations from configured export paths", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "external-platform-"));
    const orianePath = path.join(tempDir, "oriane.csv");
    const waydevPath = path.join(tempDir, "waydev.csv");
    const airbytePath = path.join(tempDir, "airbyte.csv");

    try {
      await writeFile(orianePath, "ticker,brand,views,engagement,sentiment,summary\n196170,알테오젠,1000000,45000,positive,언급 증가\n");
      await writeFile(waydevPath, "metric,value,change,summary\nAI acceptance rate,72,8,수용률 개선\n");
      await writeFile(airbytePath, "connection_name,status,records_synced,summary\ngoogle-news,succeeded,1000,뉴스 동기화 정상\n");

      const report = await collectExternalPlatformInsights({ orianePath, waydevPath, airbytePath });

      expect(report.enabled).toEqual(["Oriane", "Waydev", "Airbyte"]);
      expect(report.insights).toHaveLength(3);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("collects optional integrations from configured MCP endpoints", async () => {
    const report = await collectExternalPlatformInsights({
      orianeMcpUrl: "https://mcp.oriane.example/mcp",
      waydevMcpUrl: "https://api.waydev.example/mcp",
      airbyteMcpUrl: "https://mcp.airbyte.example/mcp",
      mcpClient: async ({ platform }) =>
        platform === "Oriane"
          ? [
              {
                ticker: "196170",
                brand: "알테오젠",
                views: "1500000",
                engagement: "55000",
                sentiment: "positive",
                summary: "영상 언급 증가",
              },
            ]
          : platform === "Airbyte"
            ? [
                {
                  connection_name: "market-context-store",
                  status: "succeeded",
                  records_synced: "32000",
                  summary: "시장 컨텍스트 동기화 정상",
                },
              ]
          : [
              {
                metric: "AI acceptance rate",
                value: "72",
                change: "8",
                summary: "자동화 수용률 개선",
              },
            ],
    });

    expect(report.enabled).toEqual(["Oriane", "Waydev", "Airbyte"]);
    expect(report.disabled).toEqual([]);
    expect(report.insights.map(insight => insight.source).sort()).toEqual(["Airbyte", "Oriane", "Waydev"]);
    expect(report.notes.join("\n")).toContain("MCP Streamable HTTP");
  });
});
