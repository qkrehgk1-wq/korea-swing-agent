import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  buildSelfReviewReport,
  type MaintenanceHistoryLike,
  type MaintenanceRunLike,
  type SelfReviewReport,
} from "./selfReviewAgent";
import {
  collectStrategyDiscoveryReport,
  type StrategyDiscoveryReport,
} from "./strategyDiscoveryAgent";
import {
  collectInformationCuratorReport,
  type InformationCuratorReport,
} from "./informationCuratorAgent";
import {
  collectLocalBenchmarkReport,
  type LocalBenchmarkReport,
} from "./localBenchmarkAgent";
import {
  collectEngineeringUpgradeReport,
  type EngineeringUpgradeReport,
} from "./engineeringUpgradeScoutAgent";

export type ImprovementRoadmapItem = {
  title: string;
  lane: "self-review" | "strategy" | "engineering" | "librarian" | "benchmark";
  priority: "high" | "medium" | "low";
  summary: string;
};

export type ContinuousImprovementReport = {
  generatedAt: string;
  selfReview: SelfReviewReport;
  strategyDiscovery: StrategyDiscoveryReport;
  informationCurator: InformationCuratorReport;
  localBenchmark: LocalBenchmarkReport;
  engineeringUpgrades: EngineeringUpgradeReport;
  roadmap: ImprovementRoadmapItem[];
  notes: string[];
};

const REPORT_DIR = path.join(process.cwd(), ".data", "continuous-improvement");
const DEFAULT_MAINTENANCE_HISTORY_PATH = path.join(process.cwd(), ".data", "swing-maintenance", "history.json");
const DEFAULT_LEARNED_OVERRIDES_PATH = path.join(process.cwd(), ".data", "backtests", "learned-swing-overrides.json");

type LearnedOverridesLike = {
  generatedAt?: string;
};

async function readJsonFile<T>(filePath: string): Promise<T | undefined> {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function buildRoadmap(input: {
  selfReview: SelfReviewReport;
  strategyDiscovery: StrategyDiscoveryReport;
  informationCurator: InformationCuratorReport;
  localBenchmark: LocalBenchmarkReport;
  engineeringUpgrades: EngineeringUpgradeReport;
}): ImprovementRoadmapItem[] {
  const roadmap: ImprovementRoadmapItem[] = [];
  const seen = new Set<string>();
  const pushRoadmap = (item: ImprovementRoadmapItem) => {
    const key = `${item.lane}|${item.title}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    roadmap.push(item);
  };

  for (const action of input.selfReview.actions) {
    pushRoadmap({
      title: action.title,
      lane: "self-review",
      priority: action.priority,
      summary: action.rationale,
    });
  }

  for (const finding of input.strategyDiscovery.findings.slice(0, 3)) {
    pushRoadmap({
      title: finding.title,
      lane: "strategy",
      priority: finding.relevanceScore >= 75 ? "high" : finding.relevanceScore >= 60 ? "medium" : "low",
      summary: finding.adoptionIdea,
    });
  }

  for (const finding of input.informationCurator.findings.slice(0, 4)) {
    pushRoadmap({
      title: finding.title,
      lane: "librarian",
      priority: finding.fitScore >= 80 ? "high" : finding.fitScore >= 65 ? "medium" : "low",
      summary: finding.implementationPlan,
    });
  }

  for (const finding of input.localBenchmark.findings.slice(0, 3)) {
    pushRoadmap({
      title: finding.title,
      lane: "benchmark",
      priority: finding.applicabilityScore >= 90 ? "high" : finding.applicabilityScore >= 75 ? "medium" : "low",
      summary: finding.adoptionIdea,
    });
  }

  for (const finding of input.engineeringUpgrades.findings.slice(0, 3)) {
    pushRoadmap({
      title: `${finding.packageName} ${finding.currentVersion} -> ${finding.latestVersion}`,
      lane: "engineering",
      priority: finding.priority,
      summary: finding.rationale,
    });
  }

  return roadmap.sort((left, right) => {
    const priorityOrder = { high: 0, medium: 1, low: 2 };
    return priorityOrder[left.priority] - priorityOrder[right.priority];
  });
}

async function writeImprovementReport(report: ContinuousImprovementReport) {
  await mkdir(REPORT_DIR, { recursive: true });
  const jsonPath = path.join(REPORT_DIR, "latest-report.json");
  const mdPath = path.join(REPORT_DIR, "latest-report.md");
  const markdown = [
    "# Continuous Improvement Report",
    "",
    `- Generated: ${report.generatedAt}`,
    "",
    "## Health",
    `- Operational reliability: ${report.selfReview.healthScores.operationalReliability}`,
    `- Signal quality: ${report.selfReview.healthScores.signalQuality}`,
    `- Learning freshness: ${report.selfReview.healthScores.learningFreshness}`,
    `- Delivery coverage: ${report.selfReview.healthScores.deliveryCoverage}`,
    "",
    "## Self Review Findings",
    ...(report.selfReview.findings.length ? report.selfReview.findings.map(item => `- ${item}`) : ["- 없음"]),
    "",
    "## Strategy Discoveries",
    ...(report.strategyDiscovery.findings.length
      ? report.strategyDiscovery.findings.map(item => `- ${item.source}: ${item.title} / ${item.adoptionIdea}`)
      : ["- 없음"]),
    "",
    "## Information Curator Findings",
    ...(report.informationCurator.findings.length
      ? report.informationCurator.findings.map(item => `- [${item.category}] ${item.title} / ${item.implementationPlan}`)
      : ["- 없음"]),
    "",
    "## Local Benchmark Findings",
    ...(report.localBenchmark.findings.length
      ? report.localBenchmark.findings.map(item => `- ${item.title} / ${item.adoptionIdea}`)
      : ["- 없음"]),
    "",
    "## Engineering Upgrade Candidates",
    ...(report.engineeringUpgrades.findings.length
      ? report.engineeringUpgrades.findings.map(item => `- ${item.packageName}: ${item.currentVersion} -> ${item.latestVersion} (${item.priority})`)
      : ["- 없음"]),
    "",
    "## Roadmap",
    ...(report.roadmap.length
      ? report.roadmap.map(item => `- [${item.priority}] ${item.title}: ${item.summary}`)
      : ["- 없음"]),
  ].join("\n");

  await Promise.all([
    writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8"),
    writeFile(mdPath, `${markdown}\n`, "utf8"),
  ]);
}

export async function runContinuousImprovementCycle(options: {
  maintenanceReport: MaintenanceRunLike;
  maintenanceHistoryPath?: string;
  learnedOverridesPath?: string;
  packageJsonPath?: string;
  fetchImpl?: typeof fetch;
  now?: Date;
}): Promise<ContinuousImprovementReport> {
  const maintenanceHistory =
    await readJsonFile<MaintenanceHistoryLike[]>(options.maintenanceHistoryPath ?? DEFAULT_MAINTENANCE_HISTORY_PATH);
  const learnedOverrides =
    await readJsonFile<LearnedOverridesLike>(options.learnedOverridesPath ?? DEFAULT_LEARNED_OVERRIDES_PATH);

  const selfReview = buildSelfReviewReport({
    maintenanceReport: options.maintenanceReport,
    maintenanceHistory,
    learnedOverrideGeneratedAt: learnedOverrides?.generatedAt,
    now: options.now,
  });
  const strategyDiscovery = await collectStrategyDiscoveryReport({
    fetchImpl: options.fetchImpl,
    now: options.now,
  });
  const informationCurator = await collectInformationCuratorReport({
    fetchImpl: options.fetchImpl,
    now: options.now,
  });
  const localBenchmark = await collectLocalBenchmarkReport({
    now: options.now,
  });
  const engineeringUpgrades = await collectEngineeringUpgradeReport({
    packageJsonPath: options.packageJsonPath,
    fetchImpl: options.fetchImpl,
    now: options.now,
  });
  const roadmap = buildRoadmap({
    selfReview,
    strategyDiscovery,
    informationCurator,
    localBenchmark,
    engineeringUpgrades,
  });

  const report: ContinuousImprovementReport = {
    generatedAt: (options.now ?? new Date()).toISOString(),
    selfReview,
    strategyDiscovery,
    informationCurator,
    localBenchmark,
    engineeringUpgrades,
    roadmap,
    notes: [
      "Upgrade Coordinator는 자체 점검 결과와 외부 리서치 결과를 하나의 실행 가능한 개선 큐로 통합합니다.",
      "새 기법은 바로 실거래나 추천 점수에 주입하지 않고, 먼저 백테스트/보류후보 재평가 단계로 보냅니다.",
      "정보관 에이전트는 최신 차트/논문 소스를 우리 코드 파일 단위의 실행 아이디어로 번역합니다.",
      "Local Benchmark Agent는 바탕화면 `돈/prediction_arbitrage` 프로젝트에서 운영 구조를 읽어 재사용 가능한 개선안만 뽑아냅니다.",
    ],
  };

  await writeImprovementReport(report);
  return report;
}

async function runFromCli() {
  const maintenanceReport = await readJsonFile<MaintenanceRunLike>(
    path.join(process.cwd(), ".data", "swing-maintenance", "latest-report.json")
  );

  if (!maintenanceReport) {
    throw new Error("latest swing maintenance report not found");
  }

  const report = await runContinuousImprovementCycle({
    maintenanceReport,
  });
  console.log(
    "[Continuous Improvement Coordinator] Roadmap:",
    report.roadmap.slice(0, 5).map(item => `${item.priority}:${item.title}`).join(" | ") || "없음"
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  runFromCli().catch(error => {
    console.error("[Continuous Improvement Coordinator] Failed:", error);
    process.exit(1);
  });
}
