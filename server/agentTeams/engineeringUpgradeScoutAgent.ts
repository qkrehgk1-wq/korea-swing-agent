import { readFile } from "node:fs/promises";

export type EngineeringUpgradeFinding = {
  packageName: string;
  currentVersion: string;
  latestVersion: string;
  priority: "high" | "medium" | "low";
  rationale: string;
};

export type EngineeringUpgradeReport = {
  generatedAt: string;
  findings: EngineeringUpgradeFinding[];
  notes: string[];
};

type PackageManifest = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const DEFAULT_TRACKED_PACKAGES = [
  "@modelcontextprotocol/sdk",
  "pnpm",
  "tsx",
  "typescript",
  "vitest",
];

function cleanVersion(value: string) {
  const match = value.match(/\d+(?:\.\d+){0,2}/);
  return match?.[0] ?? value;
}

function compareVersions(left: string, right: string) {
  const leftParts = cleanVersion(left).split(".").map(value => Number(value) || 0);
  const rightParts = cleanVersion(right).split(".").map(value => Number(value) || 0);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const delta = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (delta !== 0) {
      return delta;
    }
  }

  return 0;
}

function toPriority(currentVersion: string, latestVersion: string): EngineeringUpgradeFinding["priority"] {
  const current = cleanVersion(currentVersion).split(".").map(value => Number(value) || 0);
  const latest = cleanVersion(latestVersion).split(".").map(value => Number(value) || 0);

  if ((latest[0] ?? 0) > (current[0] ?? 0)) {
    return "high";
  }
  if ((latest[1] ?? 0) > (current[1] ?? 0)) {
    return "medium";
  }
  return "low";
}

function rationaleForPackage(packageName: string) {
  switch (packageName) {
    case "@modelcontextprotocol/sdk":
      return "MCP SDK는 연결 안정성, 타임아웃, 툴 호환성 개선이 추천 파이프라인 신뢰도와 직접 연결됩니다.";
    case "pnpm":
      return "패키지 매니저 업데이트는 설치 속도와 재현성, CI 안정성 개선으로 이어질 수 있습니다.";
    case "tsx":
      return "런타임 타입스크립트 실행 계층은 자동화 시작 속도와 개발자 운영 편의에 영향을 줍니다.";
    case "typescript":
      return "타입 정확도 강화는 에이전트 간 계약 불일치를 조기에 차단합니다.";
    case "vitest":
      return "테스트 러너 개선은 에이전트 팀 회귀 검증 주기를 빠르게 만듭니다.";
    default:
      return "핵심 실행 계층 패키지라 정기 업그레이드 검토 가치가 있습니다.";
  }
}

export async function collectEngineeringUpgradeReport(options: {
  packageJsonPath?: string;
  trackedPackages?: string[];
  fetchImpl?: typeof fetch;
  now?: Date;
} = {}): Promise<EngineeringUpgradeReport> {
  const packageJsonPath = options.packageJsonPath ?? "package.json";
  const trackedPackages = options.trackedPackages ?? DEFAULT_TRACKED_PACKAGES;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? new Date();
  const raw = await readFile(packageJsonPath, "utf8");
  const manifest = JSON.parse(raw) as PackageManifest;
  const installed = {
    ...(manifest.dependencies ?? {}),
    ...(manifest.devDependencies ?? {}),
  };

  const findings: EngineeringUpgradeFinding[] = [];
  const notes: string[] = [];

  for (const packageName of trackedPackages) {
    const currentVersion = installed[packageName];
    if (!currentVersion) {
      continue;
    }

    try {
      const response = await fetchImpl(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`, {
        headers: {
          Accept: "application/json",
        },
      });
      if (!response.ok) {
        notes.push(`${packageName}: npm registry fetch failed (${response.status})`);
        continue;
      }

      const latest = await response.json() as { version?: string };
      const latestVersion = latest.version ?? currentVersion;
      if (compareVersions(latestVersion, currentVersion) <= 0) {
        continue;
      }

      findings.push({
        packageName,
        currentVersion: cleanVersion(currentVersion),
        latestVersion: cleanVersion(latestVersion),
        priority: toPriority(currentVersion, latestVersion),
        rationale: rationaleForPackage(packageName),
      });
    } catch (error) {
      notes.push(`${packageName}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    generatedAt: now.toISOString(),
    findings: findings.sort((a, b) => compareVersions(b.latestVersion, a.latestVersion)),
    notes: [
      ...notes,
      "Engineering Scout Team은 최신 버전을 바로 올리지 않고, 핵심 런타임 계층만 업그레이드 후보로 제시합니다.",
    ],
  };
}
