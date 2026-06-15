/**
 * DataValidator Harness — constitution check for LLM-generated analysis.
 *
 * Adapted from avatar_core's harness.py. Every LLM-written analysis section
 * passes through this gate before it reaches the user. It enforces the
 * "constitution":
 *   - No scam / guaranteed-return language (severe → block, use deterministic).
 *   - No hype / fear-marketing tone unfit for sober investment analysis (logged).
 * Violations are appended to .data/logs/constitution-violations.jsonl.
 */

import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

const LOG_DIR = path.join(process.cwd(), ".data", "logs");
const LOG_PATH = path.join(LOG_DIR, "constitution-violations.jsonl");

// Severe — outright scam / "guaranteed profit" framing. Block the text.
const SCAM_PATTERNS = [
  "원금 보장",
  "수익 보장",
  "확정 수익",
  "손실 없",
  "묻지마 매수",
  "급등 확정",
  "100% 수익",
  "guaranteed profit",
  "100x",
  "get rich quick",
];

// Tone — hype / certainty / fear-marketing unfit for sober analysis. Log it.
const TONE_PATTERNS = [
  "무조건",
  "절대 놓치",
  "지금 당장 매수",
  "반드시 오른다",
  "반드시 상승",
  "확실한 수익",
  "마지막 기회",
  "절호의 기회",
];

export type ConstitutionCheck = {
  ok: boolean;
  severe: boolean; // true → caller should fall back to deterministic text
  violations: string[];
};

export function checkAnalysisConstitution(text: string): ConstitutionCheck {
  const lower = text.toLowerCase();
  const violations: string[] = [];
  let severe = false;

  for (const pattern of SCAM_PATTERNS) {
    if (lower.includes(pattern.toLowerCase())) {
      violations.push(`SCAM: '${pattern}'`);
      severe = true;
    }
  }
  for (const pattern of TONE_PATTERNS) {
    if (text.includes(pattern)) {
      violations.push(`TONE: '${pattern}'`);
    }
  }

  return { ok: violations.length === 0, severe, violations };
}

export async function logConstitutionViolation(
  role: string,
  violations: string[]
): Promise<void> {
  try {
    await mkdir(LOG_DIR, { recursive: true });
    const entry = {
      timestamp: new Date().toISOString(),
      role,
      violations,
    };
    await appendFile(LOG_PATH, `${JSON.stringify(entry)}\n`, "utf8");
    console.warn(`[Constitution] ${role} violations: ${violations.join(", ")}`);
  } catch {
    // Logging is best-effort — never let it break analysis.
  }
}
