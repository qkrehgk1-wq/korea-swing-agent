import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ExternalPlatformReport } from "./agentTeams/externalPlatformIntegrationAgent";
import type { AgentTeamReport } from "./agentTeams/orchestrator";
import type { DanteLearningReport } from "./agentTeams/youtubeLearningAgent";
import type { FirstLimitUpFollowThroughResult } from "./firstLimitUpFollowThroughAgent";
import type { LimitUpPredictionResult } from "./limitUpPredictionAgent";
import type { TechnicalSwingScreenerResult } from "./technicalSwingScreener";

const CONTRACT_DIR = path.join(process.cwd(), ".data", "swing-pipeline");
const LATEST_SEED_PATH = path.join(CONTRACT_DIR, "latest-seed.json");
const LATEST_EXECUTION_PATH = path.join(CONTRACT_DIR, "latest-execution.json");
const HISTORY_PATH = path.join(CONTRACT_DIR, "history.json");

export type SwingPipelineSeed = {
  generatedAt: string;
  version: 1;
  intent: string;
  universePolicy: {
    technicalSwingMaxTickers: number;
    limitUpMaxTickers: number;
    firstLimitUpMaxTickers: number;
  };
  patternPolicy: {
    swingPatterns: string[];
    limitUpFocus: string[];
    firstLimitUpFocus: string[];
  };
  deliveryPolicy: {
    targetChannel: "telegram";
    recommendationLimit: number;
    noLiveTrading: true;
  };
  externalIntegrations: Array<{
    name: "Oriane" | "Waydev" | "Airbyte";
    enabled: boolean;
    mode: "export" | "mcp" | "disabled";
  }>;
  stages: string[];
  notes: string[];
};

export type SwingPipelineExecutionReport = {
  generatedAt: string;
  seedGeneratedAt: string;
  status: "completed" | "completed_no_candidates" | "failed";
  failureCause?: string;
  telegramDelivered: boolean;
  counts: {
    scannedSwingTickers: number;
    scannedKosdaqTickers: number;
    scannedLimitUpTickers: number;
    scannedFirstLimitUpTickers: number;
    mergedSwingCandidates: number;
    limitUpCandidates: number;
    firstLimitUpCandidates: number;
    approvedCandidates: number;
    heldCandidates: number;
  };
  danteLearning: {
    rules: number;
    sources: number;
  };
  externalPlatformStatus: {
    enabled: string[];
    disabled: string[];
  };
  approvals: {
    approvedTickers: string[];
    heldTickers: string[];
  };
  notes: string[];
};

export type SwingPipelineDriftReport = {
  score: number;
  status: "aligned" | "watch" | "high";
  findings: string[];
};

type PipelineExecutionInput = {
  seed: SwingPipelineSeed;
  technicalSwing: TechnicalSwingScreenerResult;
  kosdaqTeam: Pick<TechnicalSwingScreenerResult, "candidates" | "scannedTickers" | "notes">;
  limitUp: LimitUpPredictionResult;
  firstLimitUp: FirstLimitUpFollowThroughResult;
  mergedSwingCandidates: Array<{ ticker: string }>;
  externalPlatformReport?: ExternalPlatformReport;
  agentTeamReport?: AgentTeamReport;
  danteLearning?: DanteLearningReport;
  telegramDelivered: boolean;
  failureCause?: string;
  now?: Date;
};

type SwingPipelineHistoryEntry = {
  generatedAt: string;
  status: SwingPipelineExecutionReport["status"];
  telegramDelivered: boolean;
  approvedCandidates: number;
  heldCandidates: number;
  mergedSwingCandidates: number;
  limitUpCandidates: number;
  firstLimitUpCandidates: number;
  failureCause?: string;
};

function uniqueTickers(items: Array<{ ticker: string }>) {
  return Array.from(new Set(items.map(item => item.ticker)));
}

function detectIntegrationMode(name: "ORIANE" | "WAYDEV" | "AIRBYTE", env: NodeJS.ProcessEnv) {
  if (env[`${name}_EXPORT_PATH`]) {
    return "export" as const;
  }
  if (env[`${name}_MCP_URL`] && env[`${name}_MCP_TOKEN`] && env[`${name}_MCP_TOOL`]) {
    return "mcp" as const;
  }
  return "disabled" as const;
}

export function createSwingPipelineSeed(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
  now = new Date()
): SwingPipelineSeed {
  const runtimeEnv = env as NodeJS.ProcessEnv;

  return {
    generatedAt: now.toISOString(),
    version: 1,
    intent: "기술적 스윙/상한가 후보를 차트·거래량·지표 기준으로 스캔하고 Telegram 추천까지 완료한다.",
    universePolicy: {
      technicalSwingMaxTickers: 30,
      limitUpMaxTickers: 30,
      firstLimitUpMaxTickers: 36,
    },
    patternPolicy: {
      swingPatterns: ["밥그릇 1번자리", "밥그릇 2번자리", "밥그릇 패턴", "하이힐 패턴", "돌파매매", "컵앤핸들"],
      limitUpFocus: ["바닥권 상한가 예측", "거래량 점화", "20일선 회복 초입"],
      firstLimitUpFocus: ["첫 상한가 눌림목", "연속 상한가 후보"],
    },
    deliveryPolicy: {
      targetChannel: "telegram",
      recommendationLimit: 5,
      noLiveTrading: true,
    },
    externalIntegrations: [
      {
        name: "Oriane",
        enabled: detectIntegrationMode("ORIANE", runtimeEnv) !== "disabled",
        mode: detectIntegrationMode("ORIANE", runtimeEnv),
      },
      {
        name: "Waydev",
        enabled: detectIntegrationMode("WAYDEV", runtimeEnv) !== "disabled",
        mode: detectIntegrationMode("WAYDEV", runtimeEnv),
      },
      {
        name: "Airbyte",
        enabled: detectIntegrationMode("AIRBYTE", runtimeEnv) !== "disabled",
        mode: detectIntegrationMode("AIRBYTE", runtimeEnv),
      },
    ],
    stages: [
      "seed",
      "technical-scan",
      "company-intelligence",
      "youtube-learning",
      "agent-review",
      "telegram-delivery",
      "evaluation-report",
    ],
    notes: [
      "실거래 주문 API는 호출하지 않는다.",
      "외부 통합은 export 또는 MCP 설정이 있을 때만 읽고, 없으면 비활성으로 기록한다.",
      "에이전트 평가는 추천 종목의 승인/보류와 리스크 점검까지만 수행한다.",
    ],
  };
}

export function createSwingPipelineExecutionReport(
  input: PipelineExecutionInput
): SwingPipelineExecutionReport {
  const approved = input.agentTeamReport?.approved ?? [];
  const held = input.agentTeamReport?.rejected ?? [];
  const externalEnabled = input.externalPlatformReport?.enabled ?? [];
  const externalDisabled = input.externalPlatformReport?.disabled ?? [];
  const hasAnyCandidates =
    input.mergedSwingCandidates.length > 0 ||
    input.limitUp.candidates.length > 0 ||
    input.firstLimitUp.candidates.length > 0;
  const status: SwingPipelineExecutionReport["status"] = input.failureCause
    ? "failed"
    : hasAnyCandidates
      ? "completed"
      : "completed_no_candidates";

  return {
    generatedAt: (input.now ?? new Date()).toISOString(),
    seedGeneratedAt: input.seed.generatedAt,
    status,
    failureCause: input.failureCause,
    telegramDelivered: input.telegramDelivered,
    counts: {
      scannedSwingTickers: input.technicalSwing.scannedTickers.length,
      scannedKosdaqTickers: input.kosdaqTeam.scannedTickers.length,
      scannedLimitUpTickers: input.limitUp.scannedTickers.length,
      scannedFirstLimitUpTickers: input.firstLimitUp.scannedTickers.length,
      mergedSwingCandidates: input.mergedSwingCandidates.length,
      limitUpCandidates: input.limitUp.candidates.length,
      firstLimitUpCandidates: input.firstLimitUp.candidates.length,
      approvedCandidates: approved.length,
      heldCandidates: held.length,
    },
    danteLearning: {
      rules: input.danteLearning?.rules.length ?? 0,
      sources: input.danteLearning?.sources.length ?? 0,
    },
    externalPlatformStatus: {
      enabled: externalEnabled,
      disabled: externalDisabled,
    },
    approvals: {
      approvedTickers: uniqueTickers(approved),
      heldTickers: uniqueTickers(held),
    },
    notes: [
      ...input.technicalSwing.notes.slice(0, 4),
      ...input.kosdaqTeam.notes.slice(0, 2),
      ...input.limitUp.notes.slice(0, 2),
      ...input.firstLimitUp.notes.slice(0, 2),
      ...(input.agentTeamReport?.notes.slice(0, 3) ?? []),
      input.telegramDelivered
        ? "Telegram 전달 완료"
        : "Telegram 전달 미완료 또는 실패 알림 경로 사용",
    ],
  };
}

async function writeJson(filePath: string, value: unknown) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readHistory() {
  try {
    const raw = await readFile(HISTORY_PATH, "utf8");
    const parsed = JSON.parse(raw) as SwingPipelineHistoryEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function persistSwingPipelineSeed(seed: SwingPipelineSeed) {
  await mkdir(CONTRACT_DIR, { recursive: true });
  await writeJson(LATEST_SEED_PATH, seed);
}

export async function persistSwingPipelineExecutionReport(report: SwingPipelineExecutionReport) {
  await mkdir(CONTRACT_DIR, { recursive: true });
  const history = await readHistory();
  history.push({
    generatedAt: report.generatedAt,
    status: report.status,
    telegramDelivered: report.telegramDelivered,
    approvedCandidates: report.counts.approvedCandidates,
    heldCandidates: report.counts.heldCandidates,
    mergedSwingCandidates: report.counts.mergedSwingCandidates,
    limitUpCandidates: report.counts.limitUpCandidates,
    firstLimitUpCandidates: report.counts.firstLimitUpCandidates,
    failureCause: report.failureCause,
  });

  await Promise.all([
    writeJson(LATEST_EXECUTION_PATH, report),
    writeJson(HISTORY_PATH, history.slice(-30)),
  ]);
}

export function assessSwingPipelineDrift(
  seed: SwingPipelineSeed,
  execution: SwingPipelineExecutionReport
): SwingPipelineDriftReport {
  let score = 0;
  const findings: string[] = [];

  if (seed.deliveryPolicy.targetChannel === "telegram" && !execution.telegramDelivered) {
    score += 35;
    findings.push("seed는 Telegram 전달을 요구했지만 실제 전달이 완료되지 않았습니다.");
  }

  if (execution.status === "failed") {
    score += 40;
    findings.push(`파이프라인이 실패 상태로 종료됐습니다: ${execution.failureCause ?? "원인 미상"}`);
  }

  if (
    execution.counts.mergedSwingCandidates +
      execution.counts.limitUpCandidates +
      execution.counts.firstLimitUpCandidates >
      0 &&
    execution.counts.approvedCandidates === 0
  ) {
    score += 22;
    findings.push("후보는 생성됐지만 승인 후보가 0건이라 실행 계약의 품질 기대와 어긋났습니다.");
  }

  const enabledIntegrations = seed.externalIntegrations.filter(item => item.enabled).map(item => item.name);
  if (enabledIntegrations.length > 0 && execution.externalPlatformStatus.enabled.length === 0) {
    score += 18;
    findings.push("seed 기준 활성 외부 통합이 있었지만 실행 보고서에 활성 통합 결과가 남지 않았습니다.");
  }

  if (execution.counts.scannedSwingTickers > seed.universePolicy.technicalSwingMaxTickers) {
    score += 10;
    findings.push("기술 스윙 스캔 수가 seed 상한을 초과했습니다.");
  }
  if (execution.counts.scannedLimitUpTickers > seed.universePolicy.limitUpMaxTickers) {
    score += 10;
    findings.push("상한가 스캔 수가 seed 상한을 초과했습니다.");
  }
  if (execution.counts.scannedFirstLimitUpTickers > seed.universePolicy.firstLimitUpMaxTickers) {
    score += 10;
    findings.push("첫 상한가 후속 스캔 수가 seed 상한을 초과했습니다.");
  }

  const status: SwingPipelineDriftReport["status"] =
    score >= 45 ? "high" : score >= 20 ? "watch" : "aligned";

  if (!findings.length) {
    findings.push("seed 계약과 실행 결과가 큰 이탈 없이 맞춰졌습니다.");
  }

  return {
    score,
    status,
    findings,
  };
}
