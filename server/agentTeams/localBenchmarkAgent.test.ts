import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { collectLocalBenchmarkReport } from "./localBenchmarkAgent";

// Self-contained fixture: write a minimal project layout to a temp dir so the
// test does not depend on any external folder on the developer's machine.
let root: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "local-benchmark-"));

  await writeFile(
    path.join(root, "scanner.py"),
    "_filter_cache_ttl coingecko _exclude_keywords _build_execution_plan posture confidence_grade catalysts",
    "utf8"
  );
  await writeFile(
    path.join(root, "patterns.py"),
    "detect_flag_pattern detect_v_bounce pattern_bonus_pts",
    "utf8"
  );
  await writeFile(
    path.join(root, "analyzer.py"),
    "bullish analyst bearish analyst judge news_context",
    "utf8"
  );
  await mkdir(path.join(root, "upgrade_agents"), { recursive: true });
  await writeFile(
    path.join(root, "upgrade_agents", "chief_orchestrator.py"),
    "run_backtest_and_get_metrics baseline_metrics new_metrics",
    "utf8"
  );
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("localBenchmarkAgent", () => {
  it("extracts reusable benchmark findings from a project layout", async () => {
    const report = await collectLocalBenchmarkReport({
      rootDir: root,
      now: new Date("2026-05-26T00:00:00.000Z"),
    });

    expect(report.findings.length).toBeGreaterThan(0);
    expect(report.findings.some((item) => item.title.includes("백테스트"))).toBe(true);
    expect(report.findings.some((item) => item.title.includes("실행 계획"))).toBe(true);
  });
});
