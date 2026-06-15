import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type BenchmarkFinding = {
  title: string;
  sourcePath: string;
  applicabilityScore: number;
  summary: string;
  adoptionIdea: string;
  caution: string;
  targetFiles: string[];
};

export type LocalBenchmarkReport = {
  generatedAt: string;
  scannedRoot: string;
  findings: BenchmarkFinding[];
  notes: string[];
};

type LocalBenchmarkInput = {
  scannerPy?: string;
  patternsPy?: string;
  analyzerPy?: string;
  chiefOrchestratorPy?: string;
};

const DEFAULT_BENCHMARK_ROOT = path.join("C:\\Users\\user\\Desktop", "돈", "prediction_arbitrage");
const REPORT_DIR = path.join(process.cwd(), ".data", "local-benchmark");

function hasAll(text: string | undefined, keywords: string[]) {
  const normalized = (text ?? "").toLowerCase();
  return keywords.every(keyword => normalized.includes(keyword.toLowerCase()));
}

async function readLocalBenchmarkInput(root: string): Promise<LocalBenchmarkInput> {
  const entries = await Promise.allSettled([
    readFile(path.join(root, "scanner.py"), "utf8"),
    readFile(path.join(root, "patterns.py"), "utf8"),
    readFile(path.join(root, "analyzer.py"), "utf8"),
    readFile(path.join(root, "upgrade_agents", "chief_orchestrator.py"), "utf8"),
  ]);

  return {
    scannerPy: entries[0].status === "fulfilled" ? entries[0].value : undefined,
    patternsPy: entries[1].status === "fulfilled" ? entries[1].value : undefined,
    analyzerPy: entries[2].status === "fulfilled" ? entries[2].value : undefined,
    chiefOrchestratorPy: entries[3].status === "fulfilled" ? entries[3].value : undefined,
  };
}

function buildBenchmarkFindings(root: string, input: LocalBenchmarkInput): BenchmarkFinding[] {
  const findings: BenchmarkFinding[] = [];

  if (hasAll(input.scannerPy, ["_filter_cache_ttl", "coingecko", "_exclude_keywords"])) {
    findings.push({
      title: "외부 유니버스 캐시 필터",
      sourcePath: path.join(root, "scanner.py"),
      applicabilityScore: 82,
      summary: "암호화폐 스캐너는 외부 시총 필터를 캐시하고, 제외 키워드로 비정상 종목군을 초기에 제거합니다.",
      adoptionIdea: "KRX 스윙 유니버스에도 테마/유동성/관리종목 제외 규칙을 캐시된 메타 필터로 분리해 MCP 호출 낭비를 줄입니다.",
      caution: "코인 시총 필터를 주식에 그대로 옮기면 안 되고, KRX 상장상태·거래대금·ETF/우선주 제외 규칙으로 번역해야 합니다.",
      targetFiles: ["server/technicalSwingScreener.ts", "server/kosdaqSwingTeam.ts", "server/koreaStockMcp.ts"],
    });
  }

  if (hasAll(input.scannerPy, ["_build_execution_plan", "posture", "confidence_grade", "catalysts"])) {
    findings.push({
      title: "후보별 실행 계획 구조화",
      sourcePath: path.join(root, "scanner.py"),
      applicabilityScore: 91,
      summary: "신호 자체만 내지 않고 진입 구간, 추격 금지 구간, 반익절, 무효화 가격, 촉매를 구조화해 함께 반환합니다.",
      adoptionIdea: "우리 Telegram 추천에도 후보별 `posture`, `noChaseAbove`, `entryZone`, `catalysts`를 표준 필드로 추가해 보류 사유와 실행 가능성을 분리합니다.",
      caution: "실행 계획이 곧 매매 지시처럼 보이지 않도록 현재의 no-live-trading 경고와 보조 판단 성격을 유지해야 합니다.",
      targetFiles: ["server/notificationService.ts", "server/swingTelegramPipeline.ts", "server/agentTeams/orchestrator.ts"],
    });
  }

  if (hasAll(input.patternsPy, ["detect_flag_pattern", "detect_v_bounce", "pattern_bonus_pts"])) {
    findings.push({
      title: "기하학 패턴 모듈 분리",
      sourcePath: path.join(root, "patterns.py"),
      applicabilityScore: 86,
      summary: "패턴 탐지를 순수 함수로 분리하고, 탐지 결과를 신뢰도와 보너스 점수까지 포함한 표준 객체로 돌려줍니다.",
      adoptionIdea: "밥그릇, 컵앤핸들, 하이힐, 돌파매매도 동일한 순수 함수 계약으로 분리해 패턴별 설명 가능성과 백테스트 재사용성을 높입니다.",
      caution: "코인의 초단기 패턴 길이는 KRX 일봉과 다르므로 lookback과 거래량 감소 조건은 새로 보정해야 합니다.",
      targetFiles: ["server/technicalSwingScreener.ts", "server/limitUpPredictionAgent.ts", "server/firstLimitUpFollowThroughAgent.ts"],
    });
  }

  if (hasAll(input.analyzerPy, ["bullish analyst", "bearish analyst", "judge", "news_context"])) {
    findings.push({
      title: "찬반 논증형 승인 설명",
      sourcePath: path.join(root, "analyzer.py"),
      applicabilityScore: 72,
      summary: "기술 점수 위에 찬성/반대 논거를 각각 만들고 최종 판정자가 승인 여부를 설명하는 구조를 둡니다.",
      adoptionIdea: "우리 회사/뉴스 인텔리전스를 승인 점수에 직접 섞기기보다 `approve vs hold` 설명 레이어로 사용해 보류 이유를 더 명확히 남깁니다.",
      caution: "LLM 판정은 환각 위험이 커서 승인 점수의 근간이 아니라 설명 보조와 리스크 경고에 한정해야 합니다.",
      targetFiles: ["server/agentTeams/orchestrator.ts", "server/companyIntelligenceService.ts", "server/notificationService.ts"],
    });
  }

  if (hasAll(input.chiefOrchestratorPy, ["run_backtest_and_get_metrics", "baseline_metrics", "new_metrics"])) {
    findings.push({
      title: "기준선 대비 백테스트 승인",
      sourcePath: path.join(root, "upgrade_agents", "chief_orchestrator.py"),
      applicabilityScore: 94,
      summary: "새 기법을 바로 배포하지 않고 기존 로직과 백테스트 지표를 직접 비교해 개선일 때만 채택합니다.",
      adoptionIdea: "우리 improve/evolve 단계에도 `proposal -> baseline backtest -> comparative accept/reject` 절차를 붙여 drift 대응을 수치로 승인하도록 만듭니다.",
      caution: "자동 배포는 위험하므로 현재 저장소에서는 코드 변경 자동 적용이 아니라 제안 리포트와 테스트 생성까지만 허용하는 편이 맞습니다.",
      targetFiles: ["server/swingBacktestAgent.ts", "server/swingAdaptiveLearning.ts", "server/agentTeams/continuousImprovementCoordinator.ts"],
    });
  }

  return findings.sort((left, right) => right.applicabilityScore - left.applicabilityScore);
}

async function writeReport(report: LocalBenchmarkReport) {
  await mkdir(REPORT_DIR, { recursive: true });
  const jsonPath = path.join(REPORT_DIR, "latest-report.json");
  const mdPath = path.join(REPORT_DIR, "latest-report.md");
  const markdown = [
    "# Local Benchmark Report",
    "",
    `- Generated: ${report.generatedAt}`,
    `- Scanned root: ${report.scannedRoot}`,
    "",
    "## Findings",
    ...(report.findings.length
      ? report.findings.flatMap(item => [
          `- ${item.title} (${item.applicabilityScore})`,
          `  - Source: ${item.sourcePath}`,
          `  - Summary: ${item.summary}`,
          `  - Adoption: ${item.adoptionIdea}`,
          `  - Caution: ${item.caution}`,
        ])
      : ["- 없음"]),
    "",
    "## Notes",
    ...report.notes.map(item => `- ${item}`),
  ].join("\n");

  await Promise.all([
    writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8"),
    writeFile(mdPath, `${markdown}\n`, "utf8"),
  ]);
}

export async function collectLocalBenchmarkReport(options: {
  rootDir?: string;
  now?: Date;
} = {}): Promise<LocalBenchmarkReport> {
  const rootDir = options.rootDir ?? DEFAULT_BENCHMARK_ROOT;
  const input = await readLocalBenchmarkInput(rootDir);
  const findings = buildBenchmarkFindings(rootDir, input);
  const missingFiles = [
    input.scannerPy ? null : "scanner.py",
    input.patternsPy ? null : "patterns.py",
    input.analyzerPy ? null : "analyzer.py",
    input.chiefOrchestratorPy ? null : "upgrade_agents/chief_orchestrator.py",
  ].filter((value): value is string => Boolean(value));

  const report: LocalBenchmarkReport = {
    generatedAt: (options.now ?? new Date()).toISOString(),
    scannedRoot: rootDir,
    findings,
    notes: [
      missingFiles.length ? `일부 벤치마크 파일을 읽지 못했습니다: ${missingFiles.join(", ")}` : "핵심 벤치마크 파일을 모두 읽었습니다.",
      "암호화폐 전용 로직은 그대로 이식하지 않고, 패턴 계약·실행 계획·검증 절차처럼 시장 불문 운영 구조만 우선 차용합니다.",
    ],
  };

  await writeReport(report);
  return report;
}
