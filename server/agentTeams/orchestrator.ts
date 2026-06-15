import type { CompanyIntelligenceInsight } from "./companyIntelligenceAgent";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ElliottFractalInsight } from "./elliottFractalAgent";
import {
  scoreDanteAlignment,
  type DanteLearningReport,
} from "./youtubeLearningAgent";
import type { WorkflowApprovalPolicy } from "../swingAdaptiveLearning";

type BaseCandidate = {
  ticker: string;
  companyName: string;
  market: "코스피" | "코스닥";
  currentPrice: number;
  triggerPrice: number;
  stopLossPrice: number;
  volumeRatio?: number;
  rsi14?: number;
};

type SwingCandidate = BaseCandidate & {
  swingScore: number;
  swingFit?: "상" | "중" | "관찰";
  patterns: string[];
};

type LimitUpCandidate = BaseCandidate & {
  limitUpScore: number;
  limitUpFit: "상" | "중" | "관찰";
  estimatedLimitPrice: number;
  dayReturn: number;
  turnoverPulse: number;
  setup: string[];
};

type FirstLimitUpCandidate = BaseCandidate & {
  firstLimitUpScore: number;
  strategy: "첫 상한가 눌림목" | "연속 상한가 후보" | "후발 추격 제외";
  firstLimitUpDate: string;
  firstLimitUpClose: number;
  daysSinceFirstLimitUp: number;
  pullbackPct: number;
  turnoverPulse: number;
  setup: string[];
  reason: string[];
};

export type AgentTeamCandidateReview = {
  ticker: string;
  companyName: string;
  source: "스윙" | "상한가";
  alphaScore: number;
  workflowScore: number;
  agreementScore: number;
  conflictScore: number;
  validation: "승인" | "보류";
  riskGrade: "A" | "B" | "C" | "D";
  recommendedCapitalPct: number;
  maxLossPct: number;
  rewardRiskRatio: number;
  reasons: string[];
  blockers: string[];
};

export type AgentTeamReport = {
  generatedAt: string;
  phaseSummary: string[];
  companyInsights: CompanyIntelligenceInsight[];
  elliottFractalInsights?: ElliottFractalInsight[];
  danteLearning?: DanteLearningReport;
  approved: AgentTeamCandidateReview[];
  rejected: AgentTeamCandidateReview[];
  notes: string[];
};

type RunAgentTeamInput = {
  swingCandidates: SwingCandidate[];
  limitUpCandidates: LimitUpCandidate[];
  companyInsights?: CompanyIntelligenceInsight[];
  elliottFractalInsights?: ElliottFractalInsight[];
  danteLearning?: DanteLearningReport;
  accountRiskPct?: number;
  firstLimitUpCandidates?: FirstLimitUpCandidate[];
};

const LEARNED_OVERRIDES_PATH = path.join(
  process.cwd(),
  ".data",
  "backtests",
  "learned-swing-overrides.json"
);

const DEFAULT_WORKFLOW_APPROVAL_POLICY: WorkflowApprovalPolicy = {
  minAgreementScore: 55,
  maxConflictScore: 50,
  minWorkflowScore: 56,
  minElliottScore: 45,
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

async function loadWorkflowApprovalPolicy(): Promise<WorkflowApprovalPolicy> {
  try {
    const raw = await readFile(LEARNED_OVERRIDES_PATH, "utf8");
    const parsed = JSON.parse(raw) as {
      workflowApprovalPolicy?: Partial<WorkflowApprovalPolicy>;
    };

    return {
      minAgreementScore: clamp(
        Math.round(parsed.workflowApprovalPolicy?.minAgreementScore ?? DEFAULT_WORKFLOW_APPROVAL_POLICY.minAgreementScore),
        50,
        70
      ),
      maxConflictScore: clamp(
        Math.round(parsed.workflowApprovalPolicy?.maxConflictScore ?? DEFAULT_WORKFLOW_APPROVAL_POLICY.maxConflictScore),
        30,
        55
      ),
      minWorkflowScore: clamp(
        Math.round(parsed.workflowApprovalPolicy?.minWorkflowScore ?? DEFAULT_WORKFLOW_APPROVAL_POLICY.minWorkflowScore),
        52,
        72
      ),
      minElliottScore: clamp(
        Math.round(parsed.workflowApprovalPolicy?.minElliottScore ?? DEFAULT_WORKFLOW_APPROVAL_POLICY.minElliottScore),
        40,
        65
      ),
    };
  } catch {
    return DEFAULT_WORKFLOW_APPROVAL_POLICY;
  }
}

function percentChange(base: number, current: number) {
  if (!base) {
    return 0;
  }
  return ((current - base) / base) * 100;
}

function calculateRewardRiskRatio(candidate: BaseCandidate) {
  const downside = Math.max(candidate.triggerPrice - candidate.stopLossPrice, 1);
  const upside = Math.max(candidate.triggerPrice * 1.08 - candidate.triggerPrice, 1);
  return Number((upside / downside).toFixed(2));
}

function calculateMaxLossPct(candidate: BaseCandidate) {
  return Number(Math.abs(percentChange(candidate.triggerPrice, candidate.stopLossPrice)).toFixed(1));
}

function calculateKellyPct(winRate: number, rewardRiskRatio: number) {
  if (rewardRiskRatio <= 0) {
    return 0;
  }

  const lossRate = 1 - winRate;
  return clamp(winRate - lossRate / rewardRiskRatio, 0, 0.25) * 100;
}

function riskGrade(maxLossPct: number, rsi14?: number) {
  if (maxLossPct <= 6 && (!rsi14 || rsi14 <= 75)) {
    return "A";
  }
  if (maxLossPct <= 10 && (!rsi14 || rsi14 <= 82)) {
    return "B";
  }
  if (maxLossPct <= 16) {
    return "C";
  }
  return "D";
}

function findCompanyInsight(
  insights: CompanyIntelligenceInsight[],
  ticker: string
) {
  return insights.find(insight => insight.ticker === ticker);
}

function findElliottFractalInsight(
  insights: ElliottFractalInsight[],
  ticker: string
) {
  return insights.find(insight => insight.ticker === ticker);
}

function applyCompanyIntelligence(
  reasons: string[],
  blockers: string[],
  insight: CompanyIntelligenceInsight | undefined
) {
  if (!insight) {
    return;
  }

  reasons.push(
    `Company_Intelligence: 자료심리 ${insight.sentimentLabel} / 촉매 ${insight.catalystScore} / 리스크 ${insight.riskScore}`
  );

  if (insight.sentimentLabel === "부정" && insight.riskScore >= insight.catalystScore + 2) {
    blockers.push("회사 뉴스/자료 리스크가 촉매보다 강함");
  }
}

function applyElliottFractalInsight(
  reasons: string[],
  blockers: string[],
  insight: ElliottFractalInsight | undefined,
  approvalPolicy: WorkflowApprovalPolicy
) {
  if (!insight) {
    return;
  }

  reasons.push(
    `Elliott_Fractal_Agent: ${insight.label} / 점수 ${insight.score} / 파동 ${insight.waveCountEstimate} / 프랙털 ${insight.fractalCompressionScore}`
  );

  if (insight.score < approvalPolicy.minElliottScore) {
    blockers.push("엘리엇/프랙털 구조가 아직 교정 또는 혼조로 해석됨");
  }
  blockers.push(...insight.warnings.slice(0, 2));
}

type WorkflowSignal = {
  agent: string;
  vote: "strong_yes" | "yes" | "neutral" | "no";
  score: number;
  note: string;
};

function scoreToVote(score: number): WorkflowSignal["vote"] {
  if (score >= 82) {
    return "strong_yes";
  }
  if (score >= 64) {
    return "yes";
  }
  if (score >= 45) {
    return "neutral";
  }
  return "no";
}

function buildWorkflowSummary(signals: WorkflowSignal[]) {
  const positiveVotes = signals.filter(signal => signal.vote === "strong_yes" || signal.vote === "yes").length;
  const negativeVotes = signals.filter(signal => signal.vote === "no").length;
  const baseScore = Math.round(signals.reduce((sum, signal) => sum + signal.score, 0) / Math.max(signals.length, 1));
  const agreementBonus = positiveVotes >= 3 ? 8 : positiveVotes >= 2 ? 4 : 0;
  const conflictPenalty = negativeVotes * 9;
  const workflowScore = clamp(baseScore + agreementBonus - conflictPenalty, 0, 100);
  const agreementScore = clamp(Math.round((positiveVotes / Math.max(signals.length, 1)) * 100), 0, 100);
  const conflictScore = negativeVotes * 25;

  return {
    workflowScore,
    agreementScore,
    conflictScore,
    positiveVotes,
    negativeVotes,
    notes: signals.map(signal => `${signal.agent}: ${signal.note}`),
  };
}

function reviewSwingCandidate(
  candidate: SwingCandidate,
  accountRiskPct: number,
  companyInsight?: CompanyIntelligenceInsight,
  elliottFractalInsight?: ElliottFractalInsight,
  danteLearning?: DanteLearningReport,
  approvalPolicy: WorkflowApprovalPolicy = DEFAULT_WORKFLOW_APPROVAL_POLICY
): AgentTeamCandidateReview {
  const rewardRiskRatio = calculateRewardRiskRatio(candidate);
  const maxLossPct = calculateMaxLossPct(candidate);
  const grade = riskGrade(maxLossPct, candidate.rsi14);
  const reasons = [
    `Tech_Analyst: ${candidate.patterns.join(", ")} / 점수 ${candidate.swingScore}점`,
    `Chief_Risk_Officer: 손익비 ${rewardRiskRatio.toFixed(2)}, 손절폭 ${maxLossPct.toFixed(1)}%`,
  ];
  const blockers: string[] = [];

  if (candidate.volumeRatio !== undefined && candidate.volumeRatio < 1) {
    blockers.push("거래량이 20일 평균보다 낮아 신호 신뢰도 부족");
  }
  if (candidate.rsi14 !== undefined && candidate.rsi14 > 84) {
    blockers.push("RSI 과열권으로 추격 리스크 큼");
  }
  if (rewardRiskRatio < 0.7) {
    blockers.push("트리거 대비 손절폭이 넓어 손익비 부족");
  }
  if (grade === "D") {
    blockers.push("손절폭 기준 리스크 등급 D");
  }
  applyCompanyIntelligence(reasons, blockers, companyInsight);
  applyElliottFractalInsight(reasons, blockers, elliottFractalInsight, approvalPolicy);
  if (danteLearning?.rules.length) {
    const alignment = scoreDanteAlignment(candidate, danteLearning);
    reasons.push(
      `Dante_Strategy_Extractor: 정합도 ${alignment.score}점 / 규칙 ${alignment.matchedRules.join(", ") || "없음"}`
    );
    blockers.push(...alignment.warnings);
  }

  const workflow = buildWorkflowSummary([
    {
      agent: "Tech_Analyst",
      vote: scoreToVote(candidate.swingScore),
      score: candidate.swingScore,
      note: `${candidate.patterns.join(", ")} / ${candidate.swingScore}점`,
    },
    {
      agent: "Volume_Analyst",
      vote: scoreToVote((candidate.volumeRatio ?? 0) >= 1.4 ? 84 : (candidate.volumeRatio ?? 0) >= 1 ? 68 : 32),
      score: (candidate.volumeRatio ?? 0) >= 1.4 ? 84 : (candidate.volumeRatio ?? 0) >= 1 ? 68 : 32,
      note: `거래량비 ${candidate.volumeRatio?.toFixed(2) ?? "n/a"}x`,
    },
    {
      agent: "Company_Intelligence",
      vote: scoreToVote(
        companyInsight?.sentimentLabel === "긍정"
          ? 78 + companyInsight.catalystScore * 2
          : companyInsight?.sentimentLabel === "부정"
            ? 28
            : companyInsight?.sentimentLabel === "자료부족"
              ? 48
              : 58
      ),
      score: companyInsight?.sentimentLabel === "긍정"
        ? clamp(78 + companyInsight.catalystScore * 2, 0, 100)
        : companyInsight?.sentimentLabel === "부정"
          ? 28
          : companyInsight?.sentimentLabel === "자료부족"
            ? 48
            : 58,
      note: companyInsight
        ? `${companyInsight.sentimentLabel} / 촉매 ${companyInsight.catalystScore} / 리스크 ${companyInsight.riskScore}`
        : "자료 없음",
    },
    {
      agent: "Elliott_Fractal_Agent",
      vote: scoreToVote(elliottFractalInsight?.score ?? 48),
      score: elliottFractalInsight?.score ?? 48,
      note: elliottFractalInsight
        ? `${elliottFractalInsight.label} / 파동 ${elliottFractalInsight.waveCountEstimate}`
        : "파동 데이터 없음",
    },
    {
      agent: "Dante_Strategy_Extractor",
      vote: scoreToVote(danteLearning?.rules.length ? scoreDanteAlignment(candidate, danteLearning).score : 50),
      score: danteLearning?.rules.length ? scoreDanteAlignment(candidate, danteLearning).score : 50,
      note: danteLearning?.rules.length ? "단테 규칙 정합 반영" : "학습 규칙 없음",
    },
    {
      agent: "Chief_Risk_Officer",
      vote: scoreToVote(
        grade === "A" && rewardRiskRatio >= 1.2 ? 88 :
        grade !== "D" && rewardRiskRatio >= 0.9 ? 70 :
        grade === "D" || rewardRiskRatio < 0.7 ? 25 : 48
      ),
      score: grade === "A" && rewardRiskRatio >= 1.2 ? 88 :
        grade !== "D" && rewardRiskRatio >= 0.9 ? 70 :
        grade === "D" || rewardRiskRatio < 0.7 ? 25 : 48,
      note: `등급 ${grade} / 손익비 ${rewardRiskRatio.toFixed(2)} / 손절폭 ${maxLossPct.toFixed(1)}%`,
    },
  ]);
  reasons.push(
    `Workflow_Orchestrator: 합의 ${workflow.agreementScore}점 / 충돌 ${workflow.conflictScore}점 / 워크플로우 ${workflow.workflowScore}점`
  );
  reasons.push(...workflow.notes.slice(0, 3));
  if (workflow.agreementScore < approvalPolicy.minAgreementScore) {
    blockers.push("에이전트 간 합의 점수가 낮음");
  }
  if (workflow.conflictScore > approvalPolicy.maxConflictScore) {
    blockers.push("에이전트 간 반대 의견 충돌이 큼");
  }
  if (workflow.workflowScore < approvalPolicy.minWorkflowScore) {
    blockers.push("워크플로우 종합 점수가 승인 기준보다 낮음");
  }

  const baseWinRate = candidate.swingScore >= 78 ? 0.55 : candidate.swingScore >= 66 ? 0.5 : 0.44;
  const kellyPct = calculateKellyPct(baseWinRate, rewardRiskRatio);
  const recommendedCapitalPct = blockers.length
    ? 0
    : Number(clamp(Math.min(kellyPct, accountRiskPct / Math.max(maxLossPct, 1) * 100), 0, 12).toFixed(1));

  return {
    ticker: candidate.ticker,
    companyName: candidate.companyName,
    source: "스윙",
    alphaScore: candidate.swingScore,
    workflowScore: workflow.workflowScore,
    agreementScore: workflow.agreementScore,
    conflictScore: workflow.conflictScore,
    validation: blockers.length ? "보류" : "승인",
    riskGrade: grade,
    recommendedCapitalPct,
    maxLossPct,
    rewardRiskRatio,
    reasons,
    blockers,
  };
}

function reviewLimitUpCandidate(
  candidate: LimitUpCandidate,
  accountRiskPct: number,
  companyInsight?: CompanyIntelligenceInsight,
  elliottFractalInsight?: ElliottFractalInsight,
  danteLearning?: DanteLearningReport,
  approvalPolicy: WorkflowApprovalPolicy = DEFAULT_WORKFLOW_APPROVAL_POLICY
): AgentTeamCandidateReview {
  const rewardTarget = Math.max(candidate.estimatedLimitPrice, candidate.triggerPrice * 1.08);
  const downside = Math.max(candidate.triggerPrice - candidate.stopLossPrice, 1);
  const rewardRiskRatio = Number(((rewardTarget - candidate.triggerPrice) / downside).toFixed(2));
  const maxLossPct = calculateMaxLossPct(candidate);
  const grade = riskGrade(maxLossPct, candidate.rsi14);
  const reasons = [
    `Tech_Analyst: ${candidate.setup.join(", ")} / 상한가점수 ${candidate.limitUpScore}점`,
    `Chief_Risk_Officer: 상한가 추정가 기준 손익비 ${rewardRiskRatio.toFixed(2)}, 손절폭 ${maxLossPct.toFixed(1)}%`,
  ];
  const blockers: string[] = [];

  if ((candidate.volumeRatio ?? 0) < 1.25 && candidate.dayReturn < 5) {
    blockers.push("상한가 후보치고 거래량 또는 당일 탄력 부족");
  }
  if (candidate.rsi14 !== undefined && candidate.rsi14 > 88) {
    blockers.push("RSI 극단 과열로 갭하락 리스크 큼");
  }
  if (rewardRiskRatio < 0.9) {
    blockers.push("상한가 추정가 대비 손익비 부족");
  }
  if (grade === "D") {
    blockers.push("손절폭 기준 리스크 등급 D");
  }
  applyCompanyIntelligence(reasons, blockers, companyInsight);
  applyElliottFractalInsight(reasons, blockers, elliottFractalInsight, approvalPolicy);
  if (danteLearning?.rules.length) {
    const alignment = scoreDanteAlignment(candidate, danteLearning);
    reasons.push(
      `Dante_Strategy_Extractor: 정합도 ${alignment.score}점 / 규칙 ${alignment.matchedRules.join(", ") || "없음"}`
    );
    blockers.push(...alignment.warnings);
  }

  const workflow = buildWorkflowSummary([
    {
      agent: "Tech_Analyst",
      vote: scoreToVote(candidate.limitUpScore),
      score: candidate.limitUpScore,
      note: `${candidate.setup.join(", ")} / ${candidate.limitUpScore}점`,
    },
    {
      agent: "Momentum_Analyst",
      vote: scoreToVote(candidate.dayReturn >= 2 && candidate.dayReturn <= 9 ? 82 : candidate.dayReturn > 0 ? 62 : 35),
      score: candidate.dayReturn >= 2 && candidate.dayReturn <= 9 ? 82 : candidate.dayReturn > 0 ? 62 : 35,
      note: `당일등락 ${candidate.dayReturn.toFixed(1)}% / 거래펄스 ${candidate.turnoverPulse.toFixed(2)}x`,
    },
    {
      agent: "Company_Intelligence",
      vote: scoreToVote(
        companyInsight?.sentimentLabel === "긍정"
          ? 74 + companyInsight.catalystScore * 2
          : companyInsight?.sentimentLabel === "부정"
            ? 26
            : companyInsight?.sentimentLabel === "자료부족"
              ? 46
              : 56
      ),
      score: companyInsight?.sentimentLabel === "긍정"
        ? clamp(74 + companyInsight.catalystScore * 2, 0, 100)
        : companyInsight?.sentimentLabel === "부정"
          ? 26
          : companyInsight?.sentimentLabel === "자료부족"
            ? 46
            : 56,
      note: companyInsight
        ? `${companyInsight.sentimentLabel} / 촉매 ${companyInsight.catalystScore} / 리스크 ${companyInsight.riskScore}`
        : "자료 없음",
    },
    {
      agent: "Elliott_Fractal_Agent",
      vote: scoreToVote(elliottFractalInsight?.score ?? 48),
      score: elliottFractalInsight?.score ?? 48,
      note: elliottFractalInsight
        ? `${elliottFractalInsight.label} / 파동 ${elliottFractalInsight.waveCountEstimate}`
        : "파동 데이터 없음",
    },
    {
      agent: "Dante_Strategy_Extractor",
      vote: scoreToVote(danteLearning?.rules.length ? scoreDanteAlignment(candidate, danteLearning).score : 50),
      score: danteLearning?.rules.length ? scoreDanteAlignment(candidate, danteLearning).score : 50,
      note: danteLearning?.rules.length ? "단테 규칙 정합 반영" : "학습 규칙 없음",
    },
    {
      agent: "Chief_Risk_Officer",
      vote: scoreToVote(
        grade === "A" && rewardRiskRatio >= 1.25 ? 86 :
        grade !== "D" && rewardRiskRatio >= 1 ? 68 :
        grade === "D" || rewardRiskRatio < 0.9 ? 24 : 46
      ),
      score: grade === "A" && rewardRiskRatio >= 1.25 ? 86 :
        grade !== "D" && rewardRiskRatio >= 1 ? 68 :
        grade === "D" || rewardRiskRatio < 0.9 ? 24 : 46,
      note: `등급 ${grade} / 손익비 ${rewardRiskRatio.toFixed(2)} / 손절폭 ${maxLossPct.toFixed(1)}%`,
    },
  ]);
  reasons.push(
    `Workflow_Orchestrator: 합의 ${workflow.agreementScore}점 / 충돌 ${workflow.conflictScore}점 / 워크플로우 ${workflow.workflowScore}점`
  );
  reasons.push(...workflow.notes.slice(0, 3));
  if (workflow.agreementScore < approvalPolicy.minAgreementScore) {
    blockers.push("에이전트 간 합의 점수가 낮음");
  }
  if (workflow.conflictScore > approvalPolicy.maxConflictScore) {
    blockers.push("에이전트 간 반대 의견 충돌이 큼");
  }
  if (workflow.workflowScore < approvalPolicy.minWorkflowScore) {
    blockers.push("워크플로우 종합 점수가 승인 기준보다 낮음");
  }

  const baseWinRate = candidate.limitUpScore >= 78 ? 0.48 : candidate.limitUpScore >= 66 ? 0.42 : 0.36;
  const kellyPct = calculateKellyPct(baseWinRate, rewardRiskRatio);
  const recommendedCapitalPct = blockers.length
    ? 0
    : Number(clamp(Math.min(kellyPct, accountRiskPct / Math.max(maxLossPct, 1) * 100), 0, 6).toFixed(1));

  return {
    ticker: candidate.ticker,
    companyName: candidate.companyName,
    source: "상한가",
    alphaScore: candidate.limitUpScore,
    workflowScore: workflow.workflowScore,
    agreementScore: workflow.agreementScore,
    conflictScore: workflow.conflictScore,
    validation: blockers.length ? "보류" : "승인",
    riskGrade: grade,
    recommendedCapitalPct,
    maxLossPct,
    rewardRiskRatio,
    reasons,
    blockers,
  };
}

function reviewFirstLimitUpCandidate(
  candidate: FirstLimitUpCandidate,
  accountRiskPct: number,
  companyInsight?: CompanyIntelligenceInsight,
  elliottFractalInsight?: ElliottFractalInsight,
  danteLearning?: DanteLearningReport,
  approvalPolicy: WorkflowApprovalPolicy = DEFAULT_WORKFLOW_APPROVAL_POLICY
): AgentTeamCandidateReview {
  const rewardTarget = candidate.strategy === "연속 상한가 후보"
    ? candidate.triggerPrice * 1.18
    : candidate.triggerPrice * 1.12;
  const downside = Math.max(candidate.triggerPrice - candidate.stopLossPrice, 1);
  const rewardRiskRatio = Number(((rewardTarget - candidate.triggerPrice) / downside).toFixed(2));
  const maxLossPct = calculateMaxLossPct(candidate);
  const grade = riskGrade(maxLossPct, candidate.rsi14);
  const reasons = [
    `Tech_Analyst: ${candidate.setup.join(", ")} / 후속점수 ${candidate.firstLimitUpScore}점 / 전략 ${candidate.strategy}`,
    `Chief_Risk_Officer: 후속 시나리오 손익비 ${rewardRiskRatio.toFixed(2)}, 손절폭 ${maxLossPct.toFixed(1)}%`,
  ];
  const blockers: string[] = [];

  if ((candidate.volumeRatio ?? 0) < 1 && (candidate.turnoverPulse ?? 0) < 1) {
    blockers.push("상한가 후속 후보치고 거래량 유지가 약함");
  }
  if (candidate.rsi14 !== undefined && candidate.rsi14 > 84) {
    blockers.push("RSI 과열로 후속 추격 리스크 큼");
  }
  if (candidate.daysSinceFirstLimitUp >= 8) {
    blockers.push("첫 상한가 이후 경과일이 길어 후속 탄력 둔화 가능성");
  }
  if (candidate.pullbackPct < -14) {
    blockers.push("눌림폭이 깊어 상한가 후속 구조가 약화됨");
  }
  if (rewardRiskRatio < 0.85) {
    blockers.push("후속 시나리오 기준 손익비 부족");
  }
  if (grade === "D") {
    blockers.push("손절폭 기준 리스크 등급 D");
  }
  applyCompanyIntelligence(reasons, blockers, companyInsight);
  applyElliottFractalInsight(reasons, blockers, elliottFractalInsight, approvalPolicy);
  if (danteLearning?.rules.length) {
    const alignment = scoreDanteAlignment(candidate, danteLearning);
    reasons.push(
      `Dante_Strategy_Extractor: 정합도 ${alignment.score}점 / 규칙 ${alignment.matchedRules.join(", ") || "없음"}`
    );
    blockers.push(...alignment.warnings);
  }

  const workflow = buildWorkflowSummary([
    {
      agent: "Tech_Analyst",
      vote: scoreToVote(candidate.firstLimitUpScore),
      score: candidate.firstLimitUpScore,
      note: `${candidate.strategy} / ${candidate.setup.join(", ")} / ${candidate.firstLimitUpScore}점`,
    },
    {
      agent: "Momentum_Analyst",
      vote: scoreToVote(
        candidate.daysSinceFirstLimitUp <= 3 && candidate.pullbackPct >= -8 ? 80 :
        candidate.daysSinceFirstLimitUp <= 6 && candidate.pullbackPct >= -12 ? 64 : 30
      ),
      score: candidate.daysSinceFirstLimitUp <= 3 && candidate.pullbackPct >= -8 ? 80 :
        candidate.daysSinceFirstLimitUp <= 6 && candidate.pullbackPct >= -12 ? 64 : 30,
      note: `경과 ${candidate.daysSinceFirstLimitUp}일 / 눌림 ${candidate.pullbackPct.toFixed(1)}%`,
    },
    {
      agent: "Company_Intelligence",
      vote: scoreToVote(
        companyInsight?.sentimentLabel === "긍정"
          ? 72 + companyInsight.catalystScore * 2
          : companyInsight?.sentimentLabel === "부정"
            ? 24
            : companyInsight?.sentimentLabel === "자료부족"
              ? 46
              : 56
      ),
      score: companyInsight?.sentimentLabel === "긍정"
        ? clamp(72 + companyInsight.catalystScore * 2, 0, 100)
        : companyInsight?.sentimentLabel === "부정"
          ? 24
          : companyInsight?.sentimentLabel === "자료부족"
            ? 46
            : 56,
      note: companyInsight
        ? `${companyInsight.sentimentLabel} / 촉매 ${companyInsight.catalystScore} / 리스크 ${companyInsight.riskScore}`
        : "자료 없음",
    },
    {
      agent: "Elliott_Fractal_Agent",
      vote: scoreToVote(elliottFractalInsight?.score ?? 48),
      score: elliottFractalInsight?.score ?? 48,
      note: elliottFractalInsight
        ? `${elliottFractalInsight.label} / 파동 ${elliottFractalInsight.waveCountEstimate}`
        : "파동 데이터 없음",
    },
    {
      agent: "Dante_Strategy_Extractor",
      vote: scoreToVote(danteLearning?.rules.length ? scoreDanteAlignment(candidate, danteLearning).score : 50),
      score: danteLearning?.rules.length ? scoreDanteAlignment(candidate, danteLearning).score : 50,
      note: danteLearning?.rules.length ? "단테 규칙 정합 반영" : "학습 규칙 없음",
    },
    {
      agent: "Chief_Risk_Officer",
      vote: scoreToVote(
        grade === "A" && rewardRiskRatio >= 1.15 ? 84 :
        grade !== "D" && rewardRiskRatio >= 0.95 ? 66 :
        grade === "D" || rewardRiskRatio < 0.85 ? 22 : 44
      ),
      score: grade === "A" && rewardRiskRatio >= 1.15 ? 84 :
        grade !== "D" && rewardRiskRatio >= 0.95 ? 66 :
        grade === "D" || rewardRiskRatio < 0.85 ? 22 : 44,
      note: `등급 ${grade} / 손익비 ${rewardRiskRatio.toFixed(2)} / 손절폭 ${maxLossPct.toFixed(1)}%`,
    },
  ]);
  reasons.push(
    `Workflow_Orchestrator: 합의 ${workflow.agreementScore}점 / 충돌 ${workflow.conflictScore}점 / 워크플로우 ${workflow.workflowScore}점`
  );
  reasons.push(...workflow.notes.slice(0, 3));
  if (workflow.agreementScore < approvalPolicy.minAgreementScore) {
    blockers.push("에이전트 간 합의 점수가 낮음");
  }
  if (workflow.conflictScore > approvalPolicy.maxConflictScore) {
    blockers.push("에이전트 간 반대 의견 충돌이 큼");
  }
  if (workflow.workflowScore < approvalPolicy.minWorkflowScore) {
    blockers.push("워크플로우 종합 점수가 승인 기준보다 낮음");
  }

  const baseWinRate = candidate.firstLimitUpScore >= 78 ? 0.46 : candidate.firstLimitUpScore >= 66 ? 0.41 : 0.35;
  const kellyPct = calculateKellyPct(baseWinRate, rewardRiskRatio);
  const recommendedCapitalPct = blockers.length
    ? 0
    : Number(clamp(Math.min(kellyPct, accountRiskPct / Math.max(maxLossPct, 1) * 100), 0, 5).toFixed(1));

  return {
    ticker: candidate.ticker,
    companyName: candidate.companyName,
    source: "상한가",
    alphaScore: candidate.firstLimitUpScore,
    workflowScore: workflow.workflowScore,
    agreementScore: workflow.agreementScore,
    conflictScore: workflow.conflictScore,
    validation: blockers.length ? "보류" : "승인",
    riskGrade: grade,
    recommendedCapitalPct,
    maxLossPct,
    rewardRiskRatio,
    reasons,
    blockers,
  };
}

export async function runAgentTeamReview({
  swingCandidates,
  limitUpCandidates,
  firstLimitUpCandidates = [],
  companyInsights = [],
  elliottFractalInsights = [],
  danteLearning,
  accountRiskPct = 1,
}: RunAgentTeamInput): Promise<AgentTeamReport> {
  const approvalPolicy = await loadWorkflowApprovalPolicy();
  const reviews = [
    ...swingCandidates.map(candidate =>
      reviewSwingCandidate(
        candidate,
        accountRiskPct,
        findCompanyInsight(companyInsights, candidate.ticker),
        findElliottFractalInsight(elliottFractalInsights, candidate.ticker),
        danteLearning,
        approvalPolicy
      )
    ),
    ...limitUpCandidates.map(candidate =>
      reviewLimitUpCandidate(
        candidate,
        accountRiskPct,
        findCompanyInsight(companyInsights, candidate.ticker),
        findElliottFractalInsight(elliottFractalInsights, candidate.ticker),
        danteLearning,
        approvalPolicy
      )
    ),
    ...firstLimitUpCandidates.map(candidate =>
      reviewFirstLimitUpCandidate(
        candidate,
        accountRiskPct,
        findCompanyInsight(companyInsights, candidate.ticker),
        findElliottFractalInsight(elliottFractalInsights, candidate.ticker),
        danteLearning,
        approvalPolicy
      )
    ),
  ].sort((a, b) => {
    if (a.validation !== b.validation) {
      return a.validation === "승인" ? -1 : 1;
    }
    if (a.workflowScore !== b.workflowScore) {
      return b.workflowScore - a.workflowScore;
    }
    return b.alphaScore - a.alphaScore;
  });

  const approved = reviews.filter(review => review.validation === "승인");
  const rejected = reviews.filter(review => review.validation === "보류");

  return {
    generatedAt: new Date().toISOString(),
    phaseSummary: [
      "Data Pipeline Team: 기존 OHLCV/MCP 수집 결과를 후보 입력으로 사용",
      "Company Intelligence Team: 회사 뉴스/RSS 자료를 촉매와 리스크로 분류",
      "Elliott Fractal Team: 피벗 파동과 수렴/확장 프랙털 구조를 점수화",
      "YouTube Learning Team: 주식단테 공개 영상 메타데이터/자막 요약에서 차트 규칙을 추출",
      "Alpha Research Team: 스윙 패턴, 파동 구조, 상한가 점수, 거래량, RSI를 표준 점수로 통합",
      "Workflow Orchestrator: 기술, 뉴스, 단테, 모멘텀, 리스크 에이전트의 합의/충돌 점수를 계산",
      "Validation Team: Red_Teamer가 과열, 거래량 부족, 손익비 부족을 필터링",
      "Execution Team: 실거래 제외, Chief_Risk_Officer가 Kelly 기반 최대 비중만 산출",
    ],
    companyInsights,
    elliottFractalInsights,
    danteLearning,
    approved,
    rejected,
    notes: [
      "실거래 주문 기능은 포함하지 않았습니다.",
      `단일 후보 기본 계좌 리스크 한도는 ${accountRiskPct.toFixed(1)}%로 계산했습니다.`,
      "최종 승인에는 개별 점수뿐 아니라 에이전트 간 합의 점수와 충돌 점수를 함께 반영합니다.",
      `현재 승인 기준: 합의 ${approvalPolicy.minAgreementScore}점 이상 / 충돌 ${approvalPolicy.maxConflictScore}점 이하 / 워크플로우 ${approvalPolicy.minWorkflowScore}점 이상 / 엘리엇 ${approvalPolicy.minElliottScore}점 이상`,
      "권장 비중은 자동 주문 지시가 아니라 수동 검토용 리스크 상한입니다.",
    ],
  };
}
