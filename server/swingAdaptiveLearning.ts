import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  resolveSwingPatternWeights,
  SWING_PATTERN_BASE_WEIGHTS,
  type PatternName,
} from "./technicalSwingScreener";

type PatternStat = {
  pattern: string;
  trades: number;
  wins: number;
  losses: number;
  noTriggers: number;
  winRate: number;
  avgReturnPct: number;
};

type ElliottLabelStat = {
  label: string;
  trades: number;
  wins: number;
  losses: number;
  noTriggers: number;
  winRate: number;
  avgReturnPct: number;
};

type BacktestReportLike = {
  generatedAt: string;
  totalTrades: number;
  winRate: number;
  avgReturnPct: number;
  medianReturnPct?: number;
  stopRate?: number;
  targetRate?: number;
  noTriggerRate?: number;
  patternStats: PatternStat[];
  elliottLabelStats?: ElliottLabelStat[];
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

type MaintenanceHistoryContext = {
  recentRuns: MaintenanceHistoryEntry[];
  consecutiveZeroApprovalRuns: number;
  averageApprovedCandidates: number;
  averageHeldCandidates: number;
};

export type WorkflowApprovalPolicy = {
  minAgreementScore: number;
  maxConflictScore: number;
  minWorkflowScore: number;
  minElliottScore: number;
};

export type SwingLearnedOverrides = {
  generatedAt: string;
  sourceReport: string;
  totalTrades: number;
  overallWinRate: number;
  overallAvgReturnPct: number;
  minTradesForAdjustment: number;
  patternWeightAdjustments: Partial<Record<PatternName, number>>;
  effectivePatternWeights: Record<PatternName, number>;
  workflowApprovalPolicy: WorkflowApprovalPolicy;
  notes: string[];
};

const REPORT_PATH = path.join(process.cwd(), ".data", "backtests", "latest-swing-backtest.json");
const OVERRIDES_PATH = path.join(process.cwd(), ".data", "backtests", "learned-swing-overrides.json");
const MAINTENANCE_HISTORY_PATH = path.join(process.cwd(), ".data", "swing-maintenance", "history.json");
const MIN_TRADES_FOR_ADJUSTMENT = Number(process.env.SWING_TUNING_MIN_TRADES ?? "5");

function clampAdjustment(value: number) {
  return Math.max(-3, Math.min(3, Math.round(value)));
}

function isPatternName(value: string): value is PatternName {
  return value in SWING_PATTERN_BASE_WEIGHTS;
}

function toNote(stat: PatternStat, adjustment: number) {
  if (adjustment > 0) {
    return `${stat.pattern}: 백테스트 ${stat.trades}건, 승률 ${stat.winRate.toFixed(1)}%, 평균수익 ${stat.avgReturnPct.toFixed(2)}%로 가중치를 ${adjustment} 올렸습니다.`;
  }
  if (adjustment < 0) {
    return `${stat.pattern}: 백테스트 ${stat.trades}건, 승률 ${stat.winRate.toFixed(1)}%, 평균수익 ${stat.avgReturnPct.toFixed(2)}%로 가중치를 ${adjustment} 낮췄습니다.`;
  }
  return `${stat.pattern}: 표본은 있으나 편차가 작아 가중치를 유지했습니다.`;
}

function deriveMaintenanceHistoryContext(
  history: MaintenanceHistoryEntry[] | undefined
): MaintenanceHistoryContext | undefined {
  if (!history?.length) {
    return undefined;
  }

  const recentRuns = history.slice(-5);
  let consecutiveZeroApprovalRuns = 0;
  for (const run of [...recentRuns].reverse()) {
    if (
      run.success &&
      run.approvedCandidates === 0 &&
      run.heldCandidates >= 4
    ) {
      consecutiveZeroApprovalRuns += 1;
      continue;
    }
    break;
  }

  const averageApprovedCandidates =
    recentRuns.reduce((sum, run) => sum + run.approvedCandidates, 0) / recentRuns.length;
  const averageHeldCandidates =
    recentRuns.reduce((sum, run) => sum + run.heldCandidates, 0) / recentRuns.length;

  return {
    recentRuns,
    consecutiveZeroApprovalRuns,
    averageApprovedCandidates,
    averageHeldCandidates,
  };
}

function deriveWorkflowApprovalPolicy(
  report: BacktestReportLike,
  maintenanceContext?: MaintenanceHistoryContext
): WorkflowApprovalPolicy {
  let minAgreementScore = 55;
  let maxConflictScore = 50;
  let minWorkflowScore = 56;
  let minElliottScore = 45;

  if (report.winRate >= 62 && report.avgReturnPct >= 1.2) {
    minAgreementScore += 3;
    minWorkflowScore += 4;
    maxConflictScore -= 5;
  } else if (report.winRate < 50 || report.avgReturnPct < 0.5) {
    minAgreementScore += 6;
    minWorkflowScore += 8;
    maxConflictScore -= 10;
  }

  if ((report.stopRate ?? 0) >= 18) {
    minAgreementScore += 3;
    minWorkflowScore += 3;
  }

  if ((report.targetRate ?? 0) >= 60) {
    minWorkflowScore += 2;
  }

  const mixedLabel = report.elliottLabelStats?.find(stat => stat.label === "교정/혼조");
  const bullishLabel = report.elliottLabelStats?.find(
    stat => stat.label === "강한 상승 5파 진행" || stat.label === "초기 3파 확장"
  );
  if (mixedLabel && mixedLabel.trades >= 5 && (mixedLabel.winRate < 45 || mixedLabel.avgReturnPct < 0)) {
    minElliottScore += 6;
  }
  if (bullishLabel && bullishLabel.trades >= 5 && bullishLabel.winRate >= 60) {
    minElliottScore += 2;
  }

  if (maintenanceContext?.consecutiveZeroApprovalRuns && maintenanceContext.consecutiveZeroApprovalRuns >= 3) {
    minAgreementScore -= 2;
    minWorkflowScore -= 3;
    maxConflictScore += 4;
    minElliottScore -= 2;
  } else if (
    maintenanceContext &&
    maintenanceContext.recentRuns.length >= 1 &&
    maintenanceContext.averageApprovedCandidates < 0.6 &&
    maintenanceContext.averageHeldCandidates >= 5
  ) {
    minAgreementScore -= 1;
    minWorkflowScore -= 2;
    maxConflictScore += 2;
    minElliottScore -= 1;
  }

  return {
    minAgreementScore: Math.max(50, Math.min(70, Math.round(minAgreementScore))),
    maxConflictScore: Math.max(30, Math.min(55, Math.round(maxConflictScore))),
    minWorkflowScore: Math.max(52, Math.min(72, Math.round(minWorkflowScore))),
    minElliottScore: Math.max(40, Math.min(65, Math.round(minElliottScore))),
  };
}

export function deriveSwingLearnedOverrides(
  report: BacktestReportLike,
  sourceReport = REPORT_PATH,
  maintenanceContext?: MaintenanceHistoryContext
): SwingLearnedOverrides {
  const patternWeightAdjustments: Partial<Record<PatternName, number>> = {};
  const notes: string[] = [];
  const bonusScale = report.winRate >= 60 ? 1 : 0.5;
  const workflowApprovalPolicy = deriveWorkflowApprovalPolicy(report, maintenanceContext);

  for (const stat of report.patternStats) {
    if (!isPatternName(stat.pattern)) {
      continue;
    }
    if (stat.trades < MIN_TRADES_FOR_ADJUSTMENT) {
      notes.push(`${stat.pattern}: 표본 ${stat.trades}건으로 아직 자동 조정하지 않았습니다.`);
      continue;
    }

    let adjustment = 0;
    if (stat.winRate >= 70 && stat.avgReturnPct >= 2) {
      adjustment = 2 * bonusScale;
    } else if (stat.winRate >= 60 && stat.avgReturnPct >= 1) {
      adjustment = 1 * bonusScale;
    } else if (stat.winRate < 45 || stat.avgReturnPct < 0) {
      adjustment = -2;
    } else if (stat.winRate < 55 && stat.avgReturnPct < 1) {
      adjustment = -1;
    }

    const roundedAdjustment = clampAdjustment(adjustment);
    if (roundedAdjustment !== 0) {
      patternWeightAdjustments[stat.pattern] = roundedAdjustment;
    }
    notes.push(toNote(stat, roundedAdjustment));
  }

  if (report.totalTrades < 20) {
    notes.push("전체 체결 표본이 20건 미만이라 자동 조정 신뢰도가 낮습니다.");
  }
  notes.push(
    `워크플로우 승인 기준: 합의 ${workflowApprovalPolicy.minAgreementScore}점 이상, 충돌 ${workflowApprovalPolicy.maxConflictScore}점 이하, 워크플로우 ${workflowApprovalPolicy.minWorkflowScore}점 이상, 엘리엇 ${workflowApprovalPolicy.minElliottScore}점 이상`
  );
  if (maintenanceContext?.recentRuns.length) {
    notes.push(
      `운영 보정 참고: 최근 ${maintenanceContext.recentRuns.length}회 유지보수 런 평균 승인 ${maintenanceContext.averageApprovedCandidates.toFixed(1)}건 / 평균 보류 ${maintenanceContext.averageHeldCandidates.toFixed(1)}건 / 연속 승인 0회 ${maintenanceContext.consecutiveZeroApprovalRuns}회`
    );
  }

  const effectivePatternWeights = resolveSwingPatternWeights(
    Object.fromEntries(
      (Object.keys(SWING_PATTERN_BASE_WEIGHTS) as PatternName[]).map(pattern => [
        pattern,
        SWING_PATTERN_BASE_WEIGHTS[pattern] + (patternWeightAdjustments[pattern] ?? 0),
      ])
    ) as Record<PatternName, number>
  );

  return {
    generatedAt: new Date().toISOString(),
    sourceReport,
    totalTrades: report.totalTrades,
    overallWinRate: report.winRate,
    overallAvgReturnPct: report.avgReturnPct,
    minTradesForAdjustment: MIN_TRADES_FOR_ADJUSTMENT,
    patternWeightAdjustments,
    effectivePatternWeights,
    workflowApprovalPolicy,
    notes,
  };
}

export async function loadLatestBacktestReport(reportPath = REPORT_PATH): Promise<BacktestReportLike> {
  const raw = await readFile(reportPath, "utf8");
  return JSON.parse(raw) as BacktestReportLike;
}

export async function loadMaintenanceHistory(
  historyPath = MAINTENANCE_HISTORY_PATH
): Promise<MaintenanceHistoryContext | undefined> {
  try {
    const raw = await readFile(historyPath, "utf8");
    const parsed = JSON.parse(raw) as MaintenanceHistoryEntry[];
    return deriveMaintenanceHistoryContext(parsed);
  } catch {
    return undefined;
  }
}

export async function writeSwingLearnedOverrides(overrides: SwingLearnedOverrides) {
  await mkdir(path.dirname(OVERRIDES_PATH), { recursive: true });
  await writeFile(OVERRIDES_PATH, `${JSON.stringify(overrides, null, 2)}\n`, "utf8");
}

export async function runSwingAdaptiveLearning(reportPath = REPORT_PATH) {
  const report = await loadLatestBacktestReport(reportPath);
  const maintenanceContext = await loadMaintenanceHistory();
  const overrides = deriveSwingLearnedOverrides(report, reportPath, maintenanceContext);
  await writeSwingLearnedOverrides(overrides);
  return overrides;
}

export {
  MAINTENANCE_HISTORY_PATH as SWING_MAINTENANCE_HISTORY_PATH,
  OVERRIDES_PATH as SWING_LEARNED_OVERRIDES_PATH,
  REPORT_PATH as SWING_BACKTEST_REPORT_PATH,
};
