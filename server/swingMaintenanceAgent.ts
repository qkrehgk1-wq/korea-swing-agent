import "dotenv/config";

import { exec } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { ENV } from "./_core/env";
import { runContinuousImprovementCycle } from "./agentTeams/continuousImprovementCoordinator";
import {
  assessSwingPipelineDrift,
  type SwingPipelineDriftReport,
  type SwingPipelineExecutionReport,
  type SwingPipelineSeed,
} from "./swingPipelineContract";

const execAsync = promisify(exec);
const REPORT_DIR = path.join(process.cwd(), ".data", "swing-maintenance");
const COREPACK_COMMAND = process.platform === "win32" ? "corepack.cmd" : "corepack";

type RunReport = {
  generatedAt: string;
  command: string[];
  success: boolean;
  exitCode: number;
  runtimeMs: number;
  exactFailingStep?: string;
  notificationStatus: {
    telegramConfigured: boolean;
    ownerConfigured: boolean;
    kakaoConfigured: boolean;
  };
  contract?: {
    seedGeneratedAt?: string;
    executionGeneratedAt?: string;
    executionStatus?: "completed" | "completed_no_candidates" | "failed";
    drift?: SwingPipelineDriftReport;
  };
  pipeline: {
    scannedSwingTickers?: number;
    matchedSwingCandidates?: number;
    scannedLimitUpTickers?: number;
    matchedLimitUpCandidates?: number;
    scannedFollowThroughTickers?: number;
    matchedFollowThroughCandidates?: number;
    approvedCandidates?: number;
    heldCandidates?: number;
    externalIntegrations?: string;
    youtubeRules?: number;
    youtubeVideos?: number;
  };
  warnings: string[];
  failures: string[];
  summary: string[];
  stdoutTail: string[];
  stderrTail: string[];
};

type MaintenanceHistoryEntry = {
  generatedAt: string;
  success: boolean;
  approvedCandidates: number;
  heldCandidates: number;
  matchedSwingCandidates: number;
  matchedLimitUpCandidates: number;
  matchedFollowThroughCandidates: number;
  exactFailingStep?: string;
};

function hasKakaoConfig() {
  return Boolean(
    ENV.kakaoRestApiKey &&
    (ENV.kakaoRefreshToken || ENV.kakaoAccessToken)
  );
}

function takeTail(text: string, limit = 30) {
  return text
    .split(/\r?\n/)
    .map(line => line.trimEnd())
    .filter(Boolean)
    .slice(-limit);
}

function parseNumberMatch(line: string, pattern: RegExp) {
  const match = line.match(pattern);
  return match?.slice(1).map(value => Number(value));
}

function buildExactFailingStep(lines: string[], failures: string[]) {
  if (failures.some(item => item.includes("Telegram delivery failed"))) {
    return "텔레그램 전송 단계";
  }
  if (failures.some(item => item.includes("ENOENT")) || failures.some(item => item.includes("spawn"))) {
    return "유지보수 에이전트 명령 실행 단계";
  }
  if (lines.some(line => line.includes("[First Limit-Up Agent] Dynamic seed collection failed"))) {
    return "첫 상한가 동적 시드 수집 단계";
  }
  if (lines.some(line => line.includes("[Notification] Failed channels"))) {
    return "보조 알림 채널 전송 단계";
  }
  if (lines.some(line => line.includes("[Swing Pipeline] Fatal error:"))) {
    return "스윙 파이프라인 실행 단계";
  }
  return undefined;
}

async function readJsonFile<T>(filePath: string): Promise<T | undefined> {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

async function readPipelineContractSummary() {
  const contractDir = path.join(process.cwd(), ".data", "swing-pipeline");
  const seed = await readJsonFile<SwingPipelineSeed>(path.join(contractDir, "latest-seed.json"));
  const execution = await readJsonFile<SwingPipelineExecutionReport>(
    path.join(contractDir, "latest-execution.json")
  );

  if (!seed || !execution) {
    return undefined;
  }

  return {
    seedGeneratedAt: seed.generatedAt,
    executionGeneratedAt: execution.generatedAt,
    executionStatus: execution.status,
    drift: assessSwingPipelineDrift(seed, execution),
  };
}

async function analyzeOutput(stdout: string, stderr: string, runtimeMs: number, exitCode: number): Promise<RunReport> {
  const mergedLines = [...stdout.split(/\r?\n/), ...stderr.split(/\r?\n/)].filter(Boolean);
  const warnings = mergedLines.filter(line =>
    line.includes("Dynamic seed collection failed") ||
    line.includes("[Notification] Failed channels") ||
    line.includes("YouTube learning skipped")
  );
  const failures = mergedLines.filter(line =>
    line.includes("[Swing Pipeline] Fatal error:") ||
    line.includes("Telegram delivery failed") ||
    line.includes("is not recognized") ||
    line.includes("spawn") ||
    line.includes("ENOENT")
  );

  const swingMatched = mergedLines.find(line => line.includes("[Swing Pipeline] Scanned"));
  const limitUpMatched = mergedLines.find(line => line.includes("Limit-up agent scanned"));
  const followThroughMatched = mergedLines.find(line => line.includes("follow-through agent scanned"));
  const reviewMatched = mergedLines.find(line => line.includes("Agent team approved"));
  const externalMatched = mergedLines.find(line => line.includes("External platform integrations enabled"));
  const youtubeMatched = mergedLines.find(line => line.includes("YouTube learning extracted"));
  const telegramSent = mergedLines.some(line => line.includes("Telegram swing and limit-up alert sent"));

  const [scannedSwingTickers, matchedSwingCandidates] =
    swingMatched ? parseNumberMatch(swingMatched, /Scanned (\d+) tickers, matched (\d+) candidates/) ?? [] : [];
  const [scannedLimitUpTickers, matchedLimitUpCandidates] =
    limitUpMatched ? parseNumberMatch(limitUpMatched, /scanned (\d+) tickers, matched (\d+) candidates/i) ?? [] : [];
  const [scannedFollowThroughTickers, matchedFollowThroughCandidates] =
    followThroughMatched ? parseNumberMatch(followThroughMatched, /scanned (\d+) tickers, matched (\d+) candidates/i) ?? [] : [];
  const [approvedCandidates, heldCandidates] =
    reviewMatched ? parseNumberMatch(reviewMatched, /approved (\d+), held (\d+)/i) ?? [] : [];
  const [youtubeRules, youtubeVideos] =
    youtubeMatched ? parseNumberMatch(youtubeMatched, /extracted (\d+) .* from (\d+) videos/i) ?? [] : [];
  const externalIntegrations = externalMatched?.split(":").slice(1).join(":").trim();

  const summary = [
    telegramSent ? "텔레그램 전송 성공" : "텔레그램 전송 성공 로그 없음",
    swingMatched ? `스윙 ${matchedSwingCandidates ?? 0}개 / ${scannedSwingTickers ?? 0}개 스캔` : "스윙 스캔 요약 없음",
    limitUpMatched ? `상한가 예측 ${matchedLimitUpCandidates ?? 0}개 / ${scannedLimitUpTickers ?? 0}개 스캔` : "상한가 예측 요약 없음",
    followThroughMatched ? `상한가 후속 ${matchedFollowThroughCandidates ?? 0}개 / ${scannedFollowThroughTickers ?? 0}개 스캔` : "상한가 후속 요약 없음",
    reviewMatched ? `에이전트팀 승인 ${approvedCandidates ?? 0} / 보류 ${heldCandidates ?? 0}` : "에이전트팀 검토 요약 없음",
    externalIntegrations ? `외부 통합: ${externalIntegrations}` : "외부 통합 요약 없음",
  ];
  const contract = await readPipelineContractSummary();
  if (contract?.drift) {
    summary.push(`계약 이탈 ${contract.drift.score}점 (${contract.drift.status})`);
  }

  return {
    generatedAt: new Date().toISOString(),
    command: [COREPACK_COMMAND, "pnpm", "start:swing"],
    success: exitCode === 0,
    exitCode,
    runtimeMs,
    exactFailingStep: exitCode === 0 && failures.length === 0
      ? undefined
      : buildExactFailingStep(mergedLines, failures),
    notificationStatus: {
      telegramConfigured: Boolean(ENV.telegramBotToken && ENV.telegramChatId),
      ownerConfigured: Boolean(ENV.forgeApiUrl && ENV.forgeApiKey),
      kakaoConfigured: hasKakaoConfig(),
    },
    contract,
    pipeline: {
      scannedSwingTickers,
      matchedSwingCandidates,
      scannedLimitUpTickers,
      matchedLimitUpCandidates,
      scannedFollowThroughTickers,
      matchedFollowThroughCandidates,
      approvedCandidates,
      heldCandidates,
      externalIntegrations,
      youtubeRules,
      youtubeVideos,
    },
    warnings,
    failures,
    summary,
    stdoutTail: takeTail(stdout),
    stderrTail: takeTail(stderr),
  };
}

async function writeReport(report: RunReport) {
  await mkdir(REPORT_DIR, { recursive: true });
  const jsonPath = path.join(REPORT_DIR, "latest-report.json");
  const mdPath = path.join(REPORT_DIR, "latest-report.md");
  const historyPath = path.join(REPORT_DIR, "history.json");
  const markdown = [
    `# Swing Maintenance Report`,
    ``,
    `- Generated: ${report.generatedAt}`,
    `- Success: ${report.success}`,
    `- Exit code: ${report.exitCode}`,
    `- Runtime(ms): ${report.runtimeMs}`,
    `- Exact failing step: ${report.exactFailingStep ?? "없음"}`,
    ``,
    `## Summary`,
    ...report.summary.map(line => `- ${line}`),
    ``,
    `## Notification status`,
    `- Telegram configured: ${report.notificationStatus.telegramConfigured}`,
    `- Owner configured: ${report.notificationStatus.ownerConfigured}`,
    `- Kakao configured: ${report.notificationStatus.kakaoConfigured}`,
    ``,
    `## Contract`,
    `- Seed generated: ${report.contract?.seedGeneratedAt ?? "없음"}`,
    `- Execution generated: ${report.contract?.executionGeneratedAt ?? "없음"}`,
    `- Execution status: ${report.contract?.executionStatus ?? "없음"}`,
    `- Drift score: ${report.contract?.drift?.score ?? "없음"}`,
    `- Drift status: ${report.contract?.drift?.status ?? "없음"}`,
    ...(report.contract?.drift?.findings.length
      ? report.contract.drift.findings.map(line => `- ${line}`)
      : ["- Drift 메모 없음"]),
    ``,
    `## Warnings`,
    ...(report.warnings.length ? report.warnings.map(line => `- ${line}`) : ["- 없음"]),
    ``,
    `## Failures`,
    ...(report.failures.length ? report.failures.map(line => `- ${line}`) : ["- 없음"]),
  ].join("\n");

  let history: MaintenanceHistoryEntry[] = [];
  try {
    const raw = await readFile(historyPath, "utf8");
    const parsed = JSON.parse(raw) as MaintenanceHistoryEntry[];
    if (Array.isArray(parsed)) {
      history = parsed;
    }
  } catch {
    history = [];
  }

  history.push({
    generatedAt: report.generatedAt,
    success: report.success,
    approvedCandidates: report.pipeline.approvedCandidates ?? 0,
    heldCandidates: report.pipeline.heldCandidates ?? 0,
    matchedSwingCandidates: report.pipeline.matchedSwingCandidates ?? 0,
    matchedLimitUpCandidates: report.pipeline.matchedLimitUpCandidates ?? 0,
    matchedFollowThroughCandidates: report.pipeline.matchedFollowThroughCandidates ?? 0,
    exactFailingStep: report.exactFailingStep,
  });
  const trimmedHistory = history.slice(-30);

  await Promise.all([
    writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8"),
    writeFile(mdPath, `${markdown}\n`, "utf8"),
    writeFile(historyPath, `${JSON.stringify(trimmedHistory, null, 2)}\n`, "utf8"),
  ]);
}

async function run() {
  const startedAt = Date.now();

  try {
    const { stdout, stderr } = await execAsync(`${COREPACK_COMMAND} pnpm start:swing`, {
      cwd: process.cwd(),
      timeout: 10 * 60 * 1000,
      maxBuffer: 8 * 1024 * 1024,
      env: process.env,
    });
    const report = await analyzeOutput(stdout, stderr, Date.now() - startedAt, 0);
    await writeReport(report);
    const improvementReport = await runContinuousImprovementCycle({
      maintenanceReport: report,
    });
    console.log("[Swing Maintenance Agent] Report written:", path.join(REPORT_DIR, "latest-report.json"));
    console.log("[Swing Maintenance Agent] Summary:", report.summary.join(" | "));
    console.log(
      "[Swing Maintenance Agent] Improvement roadmap:",
      improvementReport.roadmap.slice(0, 3).map(item => `${item.priority}:${item.title}`).join(" | ") || "없음"
    );
  } catch (error) {
    const failure = error as Error & {
      code?: number;
      stdout?: string;
      stderr?: string;
    };
    const report = await analyzeOutput(
      failure.stdout ?? "",
      [failure.stderr, failure.message].filter(Boolean).join("\n"),
      Date.now() - startedAt,
      typeof failure.code === "number" ? failure.code : 1
    );
    await writeReport(report);
    await runContinuousImprovementCycle({
      maintenanceReport: report,
    }).catch(improvementError => {
      console.warn("[Swing Maintenance Agent] Improvement cycle skipped:", improvementError);
    });
    console.error("[Swing Maintenance Agent] Pipeline failed.");
    console.error("[Swing Maintenance Agent] Exact failing step:", report.exactFailingStep ?? "미확인");
    process.exit(report.exitCode || 1);
  }
}

run();
