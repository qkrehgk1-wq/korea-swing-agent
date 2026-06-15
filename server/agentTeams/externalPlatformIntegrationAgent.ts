import { access, readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export type ExternalPlatformName = "Oriane" | "Waydev" | "Airbyte";

export type ExternalPlatformInsight = {
  source: ExternalPlatformName;
  label: string;
  score: number;
  ticker?: string;
  companyName?: string;
  summary: string;
  evidence: string[];
};

export type ExternalPlatformReport = {
  generatedAt: string;
  enabled: ExternalPlatformName[];
  disabled: string[];
  insights: ExternalPlatformInsight[];
  notes: string[];
};

type CsvRow = Record<string, string>;

type McpToolResult = {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  toolResult?: unknown;
};

type McpClientOptions = {
  platform: ExternalPlatformName;
  url: string;
  token?: string;
  toolName: string;
  arguments: Record<string, unknown>;
};

export type ExternalPlatformMcpClient = (options: McpClientOptions) => Promise<CsvRow[]>;

function normalizeHeader(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, "_");
}

function numeric(value: string | undefined) {
  const parsed = Number(String(value ?? "").replace(/[,_%\s]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function firstValue(row: CsvRow, keys: string[]) {
  for (const key of keys) {
    const normalized = normalizeHeader(key);
    if (row[normalized]) {
      return row[normalized];
    }
  }
  return "";
}

function stringifyCell(value: unknown) {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function rowsFromUnknown(value: unknown): CsvRow[] {
  if (!value) {
    return [];
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return [];
    }
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return rowsFromUnknown(JSON.parse(trimmed));
      } catch {
        return parseFlexibleCsv(trimmed);
      }
    }
    return parseFlexibleCsv(trimmed);
  }
  if (Array.isArray(value)) {
    return value
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
      .map(item => Object.fromEntries(Object.entries(item).map(([key, cell]) => [normalizeHeader(key), stringifyCell(cell)])));
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["rows", "items", "data", "results", "insights"]) {
      const rows = rowsFromUnknown(record[key]);
      if (rows.length) {
        return rows;
      }
    }
    return [Object.fromEntries(Object.entries(record).map(([key, cell]) => [normalizeHeader(key), stringifyCell(cell)]))];
  }
  return [];
}

export function extractMcpRows(result: McpToolResult): CsvRow[] {
  const structuredRows = rowsFromUnknown(result.structuredContent);
  if (structuredRows.length) {
    return structuredRows;
  }

  const toolRows = rowsFromUnknown(result.toolResult);
  if (toolRows.length) {
    return toolRows;
  }

  for (const item of result.content ?? []) {
    if (item.type !== "text" || !item.text) {
      continue;
    }
    const rows = rowsFromUnknown(item.text);
    if (rows.length) {
      return rows;
    }
  }

  return [];
}

export function parseFlexibleCsv(csv: string): CsvRow[] {
  const rows: string[][] = [];
  let current = "";
  let row: string[] = [];
  let inQuotes = false;

  for (let index = 0; index < csv.length; index += 1) {
    const char = csv[index];
    const next = csv[index + 1];

    if (char === "\"" && next === "\"") {
      current += "\"";
      index += 1;
      continue;
    }
    if (char === "\"") {
      inQuotes = !inQuotes;
      continue;
    }
    if (char === "," && !inQuotes) {
      row.push(current.trim());
      current = "";
      continue;
    }
    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") {
        index += 1;
      }
      row.push(current.trim());
      if (row.some(cell => cell.length > 0)) {
        rows.push(row);
      }
      row = [];
      current = "";
      continue;
    }
    current += char;
  }

  if (current.length || row.length) {
    row.push(current.trim());
    if (row.some(cell => cell.length > 0)) {
      rows.push(row);
    }
  }

  const [headers, ...body] = rows;
  if (!headers?.length) {
    return [];
  }

  const normalizedHeaders = headers.map(normalizeHeader);
  return body.map(values =>
    Object.fromEntries(normalizedHeaders.map((header, index) => [header, values[index] ?? ""]))
  );
}

export function summarizeOrianeRows(rows: CsvRow[]): ExternalPlatformInsight[] {
  return rows.slice(0, 10).map(row => {
    const ticker = firstValue(row, ["ticker", "stock_code", "symbol"]);
    const companyName = firstValue(row, ["company", "company_name", "brand", "topic"]);
    const views = numeric(firstValue(row, ["views", "view_count", "video_views"]));
    const engagement = numeric(firstValue(row, ["engagement", "engagements", "likes", "interactions"]));
    const sentiment = firstValue(row, ["sentiment", "tone", "label"]).toLowerCase();
    const summary = firstValue(row, ["summary", "insight", "description", "caption"]) || "Oriane 영상 인텔리전스 행";
    const baseScore = Math.min(45, Math.log10(Math.max(views, 1)) * 8);
    const engagementScore = Math.min(35, Math.log10(Math.max(engagement, 1)) * 7);
    const sentimentScore = sentiment.includes("positive") || sentiment.includes("긍정") ? 15 : sentiment.includes("negative") || sentiment.includes("부정") ? -15 : 0;
    const score = Math.max(0, Math.min(100, Math.round(baseScore + engagementScore + sentimentScore)));
    const label = sentimentScore >= 0 && score >= 50 ? "영상 트렌드 긍정" : sentimentScore < 0 ? "영상 트렌드 리스크" : "영상 트렌드 관찰";

    return {
      source: "Oriane",
      label,
      score,
      ticker: ticker || undefined,
      companyName: companyName || ticker || undefined,
      summary,
      evidence: [
        views ? `views ${views.toLocaleString("ko-KR")}` : "views 없음",
        engagement ? `engagement ${engagement.toLocaleString("ko-KR")}` : "engagement 없음",
        sentiment ? `sentiment ${sentiment}` : "sentiment 없음",
      ],
    };
  });
}

export function summarizeWaydevRows(rows: CsvRow[]): ExternalPlatformInsight[] {
  return rows.slice(0, 10).map(row => {
    const metric = firstValue(row, ["metric", "name", "kpi"]) || "Waydev metric";
    const value = firstValue(row, ["value", "current", "score"]);
    const change = numeric(firstValue(row, ["change", "delta", "change_pct", "wow", "mom"]));
    const summary = firstValue(row, ["summary", "insight", "description"]) || `${metric} ${value}`.trim();
    const lowerMetric = metric.toLowerCase();
    const costRisk = lowerMetric.includes("cost") && change > 20;
    const deliveryRisk = (lowerMetric.includes("acceptance") || lowerMetric.includes("deploy") || lowerMetric.includes("merge")) && change < -10;
    const positive = (lowerMetric.includes("acceptance") || lowerMetric.includes("deploy") || lowerMetric.includes("merge")) && change > 5;
    const label = costRisk || deliveryRisk ? "운영 리스크" : positive ? "운영 개선" : "운영 관찰";
    const score = Math.max(0, Math.min(100, Math.round(50 + (positive ? 20 : 0) - (costRisk || deliveryRisk ? 25 : 0) + Math.min(10, Math.abs(change) / 2))));

    return {
      source: "Waydev",
      label,
      score,
      summary,
      evidence: [
        `metric ${metric}`,
        value ? `value ${value}` : "value 없음",
        change ? `change ${change}` : "change 없음",
      ],
    };
  });
}

export function summarizeAirbyteRows(rows: CsvRow[]): ExternalPlatformInsight[] {
  return rows.slice(0, 10).map(row => {
    const connection = firstValue(row, ["connection", "connection_name", "name", "source", "connector"]) || "Airbyte connection";
    const status = firstValue(row, ["status", "state", "health", "job_status"]).toLowerCase();
    const records = numeric(firstValue(row, ["records", "records_synced", "row_count", "rows"]));
    const errors = numeric(firstValue(row, ["errors", "failures", "failed_jobs", "error_count"]));
    const lastSync = firstValue(row, ["last_sync", "last_sync_at", "updated_at", "created_at"]);
    const summary = firstValue(row, ["summary", "insight", "description"]) || `${connection} ${status}`.trim();
    const healthy = ["succeeded", "success", "healthy", "active", "running"].some(keyword => status.includes(keyword));
    const failing = ["failed", "error", "unhealthy", "inactive", "cancelled"].some(keyword => status.includes(keyword)) || errors > 0;
    const label = failing ? "데이터 파이프라인 리스크" : healthy ? "데이터 파이프라인 정상" : "데이터 파이프라인 관찰";
    const score = Math.max(
      0,
      Math.min(100, Math.round(55 + (healthy ? 25 : 0) - (failing ? 35 : 0) + Math.min(10, Math.log10(Math.max(records, 1)))))
    );

    return {
      source: "Airbyte",
      label,
      score,
      summary,
      evidence: [
        `connection ${connection}`,
        status ? `status ${status}` : "status 없음",
        records ? `records ${records.toLocaleString("ko-KR")}` : "records 없음",
        errors ? `errors ${errors.toLocaleString("ko-KR")}` : "errors 없음",
        lastSync ? `last_sync ${lastSync}` : "last_sync 없음",
      ],
    };
  });
}

async function readCsvIfExists(filePath: string | undefined) {
  if (!filePath) {
    return null;
  }

  try {
    await access(filePath);
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

export async function callStreamableHttpMcpTool(options: McpClientOptions): Promise<CsvRow[]> {
  const headers: HeadersInit = options.token
    ? {
        Authorization: `Bearer ${options.token}`,
      }
    : {};
  const transport = new StreamableHTTPClientTransport(new URL(options.url), {
    requestInit: {
      headers,
    },
  });
  const client = new Client({
    name: "billionaire-stock-agent",
    version: "1.0.0",
  });

  try {
    await client.connect(transport);
    const result = await client.callTool(
      {
        name: options.toolName,
        arguments: options.arguments,
      },
      undefined,
      { timeout: 15_000 },
    );
    return extractMcpRows(result as McpToolResult);
  } finally {
    await transport.close().catch(() => undefined);
  }
}

export async function collectExternalPlatformInsights(options: {
  orianePath?: string;
  waydevPath?: string;
  airbytePath?: string;
  orianeMcpUrl?: string;
  waydevMcpUrl?: string;
  airbyteMcpUrl?: string;
  orianeMcpToken?: string;
  waydevMcpToken?: string;
  airbyteMcpToken?: string;
  orianeMcpTool?: string;
  waydevMcpTool?: string;
  airbyteMcpTool?: string;
  mcpClient?: ExternalPlatformMcpClient;
} = {}): Promise<ExternalPlatformReport> {
  const orianePath = options.orianePath ?? process.env.ORIANE_EXPORT_PATH;
  const waydevPath = options.waydevPath ?? process.env.WAYDEV_EXPORT_PATH;
  const airbytePath = options.airbytePath ?? process.env.AIRBYTE_EXPORT_PATH;
  const orianeMcpUrl = options.orianeMcpUrl ?? process.env.ORIANE_MCP_URL;
  const waydevMcpUrl = options.waydevMcpUrl ?? process.env.WAYDEV_MCP_URL;
  const airbyteMcpUrl = options.airbyteMcpUrl ?? process.env.AIRBYTE_MCP_URL;
  const mcpClient = options.mcpClient ?? callStreamableHttpMcpTool;
  const [orianeCsv, waydevCsv, airbyteCsv] = await Promise.all([
    readCsvIfExists(orianePath),
    readCsvIfExists(waydevPath),
    readCsvIfExists(airbytePath),
  ]);
  const enabled: ExternalPlatformName[] = [];
  const disabled: string[] = [];
  const insights: ExternalPlatformInsight[] = [];
  const notes: string[] = [];

  if (orianeCsv) {
    enabled.push("Oriane");
    insights.push(...summarizeOrianeRows(parseFlexibleCsv(orianeCsv)));
  } else if (orianeMcpUrl) {
    try {
      const rows = await mcpClient({
        platform: "Oriane",
        url: orianeMcpUrl,
        token: options.orianeMcpToken ?? process.env.ORIANE_MCP_TOKEN,
        toolName: options.orianeMcpTool ?? process.env.ORIANE_MCP_TOOL ?? "search_video_intelligence",
        arguments: {
          query: "KOSPI KOSDAQ stock catalysts breakout bottom limit-up candidates",
          market: "KR",
          lookbackDays: 14,
        },
      });
      enabled.push("Oriane");
      insights.push(...summarizeOrianeRows(rows));
      notes.push("Oriane MCP Streamable HTTP endpoint에서 영상 인텔리전스를 수집했습니다.");
    } catch (error) {
      disabled.push(`Oriane MCP: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    disabled.push("Oriane: ORIANE_EXPORT_PATH or ORIANE_MCP_URL not configured");
  }

  if (waydevCsv) {
    enabled.push("Waydev");
    insights.push(...summarizeWaydevRows(parseFlexibleCsv(waydevCsv)));
  } else if (waydevMcpUrl) {
    try {
      const rows = await mcpClient({
        platform: "Waydev",
        url: waydevMcpUrl,
        token: options.waydevMcpToken ?? process.env.WAYDEV_MCP_TOKEN,
        toolName: options.waydevMcpTool ?? process.env.WAYDEV_MCP_TOOL ?? "get_engineering_feed",
        arguments: {
          lookbackDays: 14,
          includeAiAgentMetrics: true,
        },
      });
      enabled.push("Waydev");
      insights.push(...summarizeWaydevRows(rows));
      notes.push("Waydev MCP Streamable HTTP endpoint에서 운영 품질 지표를 수집했습니다.");
    } catch (error) {
      disabled.push(`Waydev MCP: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    disabled.push("Waydev: WAYDEV_EXPORT_PATH or WAYDEV_MCP_URL not configured");
  }

  if (airbyteCsv) {
    enabled.push("Airbyte");
    insights.push(...summarizeAirbyteRows(parseFlexibleCsv(airbyteCsv)));
  } else if (airbyteMcpUrl) {
    try {
      const rows = await mcpClient({
        platform: "Airbyte",
        url: airbyteMcpUrl,
        token: options.airbyteMcpToken ?? process.env.AIRBYTE_MCP_TOKEN,
        toolName: options.airbyteMcpTool ?? process.env.AIRBYTE_MCP_TOOL ?? "list_connections",
        arguments: {
          organizationId: process.env.AIRBYTE_ORGANIZATION_ID,
          workspaceId: process.env.AIRBYTE_WORKSPACE_ID,
          includeJobStatus: true,
          lookbackDays: 7,
        },
      });
      enabled.push("Airbyte");
      insights.push(...summarizeAirbyteRows(rows));
      notes.push("Airbyte MCP Streamable HTTP endpoint에서 데이터 파이프라인 상태를 수집했습니다.");
    } catch (error) {
      disabled.push(`Airbyte MCP: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    disabled.push("Airbyte: AIRBYTE_EXPORT_PATH or AIRBYTE_MCP_URL not configured");
  }

  return {
    generatedAt: new Date().toISOString(),
    enabled,
    disabled,
    insights: insights.sort((a, b) => b.score - a.score).slice(0, 8),
    notes: [
      ...notes,
      "Oriane은 영상/소셜 트렌드 보조 인텔리전스로만 사용하며, 차트 기반 스윙 점수를 직접 대체하지 않습니다.",
      "Waydev는 개발/자동화 운영 품질 관찰용이며, 종목 추천 점수에는 반영하지 않습니다.",
      "Airbyte는 데이터 수집/동기화 상태 관찰용이며, 종목 추천 점수에는 직접 반영하지 않습니다.",
      "외부 통합은 CSV/MCP 설정이 없거나 연결이 실패하면 비활성 상태로 보고하고 자동화는 계속 실행됩니다.",
    ],
  };
}
