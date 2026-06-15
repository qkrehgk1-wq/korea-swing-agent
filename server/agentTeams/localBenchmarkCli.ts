import { fileURLToPath } from "node:url";
import path from "node:path";

import { collectLocalBenchmarkReport } from "./localBenchmarkAgent";

async function runFromCli() {
  const report = await collectLocalBenchmarkReport();
  console.log(
    "[Local Benchmark Agent] Findings:",
    report.findings.slice(0, 5).map(item => item.title).join(" | ") || "없음"
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  runFromCli().catch(error => {
    console.error("[Local Benchmark Agent] Failed:", error);
    process.exit(1);
  });
}
