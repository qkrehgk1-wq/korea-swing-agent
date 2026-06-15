export type MaintenanceRunLike = {
  generatedAt: string;
  success: boolean;
  warnings: string[];
  failures: string[];
  pipeline: {
    matchedSwingCandidates?: number;
    matchedLimitUpCandidates?: number;
    matchedFollowThroughCandidates?: number;
    approvedCandidates?: number;
    heldCandidates?: number;
    youtubeRules?: number;
  };
  notificationStatus: {
    telegramConfigured: boolean;
    ownerConfigured: boolean;
    kakaoConfigured: boolean;
  };
  contract?: {
    drift?: {
      score: number;
      status: "aligned" | "watch" | "high";
      findings: string[];
    };
  };
};

export type MaintenanceHistoryLike = {
  generatedAt: string;
  success: boolean;
  approvedCandidates: number;
  heldCandidates: number;
  matchedSwingCandidates: number;
  matchedLimitUpCandidates: number;
  matchedFollowThroughCandidates: number;
  exactFailingStep?: string;
};

export type SelfReviewAction = {
  title: string;
  priority: "high" | "medium" | "low";
  owner: "Self-Review Team" | "Strategy Scout Team" | "Engineering Scout Team" | "Upgrade Coordinator";
  rationale: string;
};

export type SelfReviewReport = {
  generatedAt: string;
  healthScores: {
    operationalReliability: number;
    signalQuality: number;
    learningFreshness: number;
    deliveryCoverage: number;
  };
  findings: string[];
  actions: SelfReviewAction[];
  notes: string[];
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function average(values: number[]) {
  if (!values.length) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function countConsecutiveZeroApprovals(history: MaintenanceHistoryLike[]) {
  let count = 0;

  for (const run of [...history].reverse()) {
    if (run.success && run.approvedCandidates === 0) {
      count += 1;
      continue;
    }
    break;
  }

  return count;
}

export function buildSelfReviewReport(input: {
  maintenanceReport: MaintenanceRunLike;
  maintenanceHistory?: MaintenanceHistoryLike[];
  learnedOverrideGeneratedAt?: string;
  now?: Date;
}): SelfReviewReport {
  const { maintenanceReport, maintenanceHistory = [], learnedOverrideGeneratedAt } = input;
  const now = input.now ?? new Date();
  const findings: string[] = [];
  const actions: SelfReviewAction[] = [];

  const consecutiveZeroApprovals = countConsecutiveZeroApprovals(maintenanceHistory);
  const recentHistory = maintenanceHistory.slice(-7);
  const averageApproved = average(recentHistory.map(item => item.approvedCandidates));
  const averageHeld = average(recentHistory.map(item => item.heldCandidates));
  const averageSignals = average(
    recentHistory.map(item => item.matchedSwingCandidates + item.matchedLimitUpCandidates + item.matchedFollowThroughCandidates)
  );
  const activeNotificationChannels = [
    maintenanceReport.notificationStatus.telegramConfigured,
    maintenanceReport.notificationStatus.ownerConfigured,
    maintenanceReport.notificationStatus.kakaoConfigured,
  ].filter(Boolean).length;

  const operationalReliability = clamp(
    92 -
      (maintenanceReport.success ? 0 : 38) -
      maintenanceReport.failures.length * 12 -
      maintenanceReport.warnings.length * 4 -
      (maintenanceReport.contract?.drift?.status === "high" ? 12 : 0) -
      (maintenanceReport.contract?.drift?.status === "watch" ? 5 : 0),
    0,
    100
  );
  const signalQuality = clamp(
    55 +
      Math.min(18, (maintenanceReport.pipeline.approvedCandidates ?? 0) * 10) +
      Math.min(10, (maintenanceReport.pipeline.matchedLimitUpCandidates ?? 0) * 4) +
      Math.min(8, (maintenanceReport.pipeline.matchedSwingCandidates ?? 0) * 3) -
      consecutiveZeroApprovals * 9 -
      (averageHeld >= 5 ? 7 : 0) -
      Math.min(18, Math.round((maintenanceReport.contract?.drift?.score ?? 0) / 4)),
    0,
    100
  );

  const learnedOverrideAgeDays = learnedOverrideGeneratedAt
    ? Math.max(
        0,
        Math.round((now.getTime() - new Date(learnedOverrideGeneratedAt).getTime()) / (1000 * 60 * 60 * 24))
      )
    : undefined;
  const learningFreshness = clamp(
    82 -
      (learnedOverrideAgeDays === undefined ? 25 : Math.min(36, learnedOverrideAgeDays * 2)) +
      Math.min(10, (maintenanceReport.pipeline.youtubeRules ?? 0) * 3),
    0,
    100
  );
  const deliveryCoverage = clamp(30 + activeNotificationChannels * 22, 0, 100);

  if (!maintenanceReport.success) {
    findings.push("최근 유지보수 런이 실패해 실행 신뢰도 복원이 최우선입니다.");
    actions.push({
      title: "실패 단계 재현 및 보호로직 강화",
      priority: "high",
      owner: "Self-Review Team",
      rationale: "실패 런이 한 번만 나와도 다음 학습 루프가 멈춥니다.",
    });
  }

  if (maintenanceReport.contract?.drift?.status === "high") {
    findings.push(`seed 대비 실행 이탈이 큽니다 (${maintenanceReport.contract.drift.score}점).`);
    actions.push({
      title: "seed-실행 drift 축소",
      priority: "high",
      owner: "Upgrade Coordinator",
      rationale: "후보 생성, 승인, 전달 결과가 계약 기대와 어긋나면 개선 루프 기준점이 흔들립니다.",
    });
  } else if (maintenanceReport.contract?.drift?.status === "watch") {
    findings.push(`seed 대비 실행 이탈을 관찰할 필요가 있습니다 (${maintenanceReport.contract.drift.score}점).`);
  }

  if (consecutiveZeroApprovals >= 2) {
    findings.push(`연속 ${consecutiveZeroApprovals}회 승인 0건으로, 필터가 과도하거나 유니버스가 좁을 가능성이 큽니다.`);
    actions.push({
      title: "승인 기준과 유니버스 재조정",
      priority: "high",
      owner: "Upgrade Coordinator",
      rationale: "보류만 누적되면 운영 효용이 빠르게 떨어집니다.",
    });
  }

  if ((maintenanceReport.pipeline.youtubeRules ?? 0) === 0) {
    findings.push("유튜브 학습 규칙이 비어 있어 외부 차트 학습 보조축이 약합니다.");
    actions.push({
      title: "학습 소스 다변화",
      priority: "medium",
      owner: "Strategy Scout Team",
      rationale: "단테 채널 외 규칙 소스를 추가해야 편향을 줄일 수 있습니다.",
    });
  }

  if (activeNotificationChannels <= 1) {
    findings.push("알림 채널이 사실상 Telegram 단일 경로라 전달 복원력이 낮습니다.");
    actions.push({
      title: "보조 알림 채널 복구",
      priority: "medium",
      owner: "Engineering Scout Team",
      rationale: "단일 채널 장애 시 사용자 가시성이 사라집니다.",
    });
  }

  if (learnedOverrideAgeDays === undefined || learnedOverrideAgeDays >= 7) {
    findings.push("학습 오버라이드가 오래됐거나 없어 최근 장세 변화 반영이 부족할 수 있습니다.");
    actions.push({
      title: "백테스트-학습 파이프라인 재가동",
      priority: "medium",
      owner: "Self-Review Team",
      rationale: "패턴 가중치와 승인 기준이 최근 장세를 따라가야 합니다.",
    });
  }

  if (!findings.length) {
    findings.push("운영, 신호, 학습, 전달 구조가 모두 치명적 문제 없이 유지되고 있습니다.");
  }

  if (averageSignals < 1 && recentHistory.length >= 3) {
    actions.push({
      title: "새 후보 발굴용 패턴 실험 추가",
      priority: "medium",
      owner: "Strategy Scout Team",
      rationale: "최근 런 평균 후보 수가 너무 적어 탐색 다양성이 떨어집니다.",
    });
  }

  return {
    generatedAt: now.toISOString(),
    healthScores: {
      operationalReliability,
      signalQuality,
      learningFreshness,
      deliveryCoverage,
    },
    findings,
    actions,
    notes: [
      `최근 ${recentHistory.length || 1}회 평균 승인 ${averageApproved.toFixed(1)}건 / 평균 보류 ${averageHeld.toFixed(1)}건`,
      `최근 유지보수 평균 후보수 ${averageSignals.toFixed(1)}건`,
      "Self-Review Team은 실거래가 아니라 자동화 품질과 추천 체계 건강도만 점검합니다.",
    ],
  };
}
