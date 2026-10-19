/**
 * Jev 섀도 기록 실행기 — 일일 워크플로의 별도 단계로 돈다(실패해도 다른 단계에 영향 없음).
 * 새 후보에 질문을 던져 data/journal/jev-shadow.json에 기록하고, 정산된 건으로 사전 고정 채점 현황을 출력한다.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readJournalFile, readShadowFile, runJevShadow, scoreJevShadow } from "./jevShadow";

async function runFromCli() {
  await runJevShadow();
  const file = await readShadowFile();
  const journal = await readJournalFile();
  const score = scoreJevShadow(Object.values(file.records), journal);
  const pct = (v: number | null) => (v === null ? "-" : v.toFixed(3));
  console.log(`[Jev Shadow] 누적 ${Object.keys(file.records).length}건 · 정산·답변 ${score.settledWithAnswers}건 — ${score.verdict}`);
  for (const row of score.rows) {
    console.log(`[Jev Shadow]   ${row.name}: 높음 n=${row.nHigh} ${pct(row.meanRHigh)}R vs 낮음 n=${row.nLow} ${pct(row.meanRLow)}R · 차이 ${pct(row.diff)}±${pct(row.twoSe)}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  runFromCli().catch(error => {
    console.warn("[Jev Shadow] 건너뜀:", error instanceof Error ? error.message : "unknown");
  });
}
