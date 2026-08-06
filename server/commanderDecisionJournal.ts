/**
 * Commander decision journal — what the human actually did with each pick.
 *
 * Everything measured so far grades the *screener*: the recommendation journal
 * scores every pick the system emits, whether or not anyone acted on it. That
 * cannot answer the question the commander actually cares about — "am I getting
 * better?" — because the commander's own choices were never recorded anywhere.
 *
 * Design constraint that drove everything here: Korean market hours sit inside
 * the commander's working day, so any design that needs input while the market
 * is open will simply not be used. So the entry cost is one tap on the alert
 * that already arrives every morning, and nothing else. No prices, no quantity,
 * no prose. The system already knows each pick's trigger, stop and target, so a
 * single tap is enough to score the decision with the exact same engine that
 * scores the system's own picks.
 *
 * Taps are collected on the next scheduled run rather than in real time. For a
 * multi-week swing horizon a day of latency costs nothing, and it keeps the
 * whole feature free of servers, webhooks and extra CI minutes.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { RecommendationEntry } from "./recommendationJournalAgent";
import { isSettledStatus } from "./recommendationJournalAgent";

export type CommanderAction = "entered" | "watching" | "passed";

export type CommanderDecision = {
  /** KST date of the alert the decision belongs to. */
  date: string;
  ticker: string;
  companyName?: string;
  action: CommanderAction;
  decidedAt: string;
  source: "tap" | "text";
};

export type DecisionJournal = {
  /** Telegram update offset — persisted here because CI runners are ephemeral. */
  lastUpdateId: number | null;
  decisions: CommanderDecision[];
};

export const DECISION_JOURNAL_PATH = path.join(
  process.cwd(),
  "data",
  "journal",
  "decisions.json"
);

const ACTION_CODES: Record<string, CommanderAction> = {
  e: "entered",
  w: "watching",
  p: "passed",
};

const ACTION_LABELS: Record<CommanderAction, string> = {
  entered: "진입",
  watching: "관심",
  passed: "패스",
};

export function actionLabel(action: CommanderAction): string {
  return ACTION_LABELS[action];
}

/** callback_data payload: `d|<action>|<ticker>|<date>` (well under 64 bytes). */
export function buildCallbackData(
  action: CommanderAction,
  ticker: string,
  date: string
): string {
  const code = Object.keys(ACTION_CODES).find(key => ACTION_CODES[key] === action) ?? "w";
  return `d|${code}|${ticker}|${date}`;
}

/** Pure: decode one button tap. Returns null for anything unrecognised. */
export function parseCallbackData(data: string): Omit<CommanderDecision, "decidedAt" | "source"> | null {
  const parts = data.split("|");
  if (parts.length !== 4 || parts[0] !== "d") return null;
  const action = ACTION_CODES[parts[1]];
  const ticker = parts[2];
  const date = parts[3];
  if (!action || !/^\d{6}$/.test(ticker) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return null;
  }
  return { action, ticker, date };
}

/**
 * Pure: decode a typed reply, for a stock that was never in the alert.
 * Accepts "005930 진입" / "005930 패스" / "진입 005930".
 */
export function parseTextDecision(
  text: string,
  fallbackDate: string
): Omit<CommanderDecision, "decidedAt" | "source"> | null {
  const tickerMatch = /(?:^|\s)(\d{6})(?:\s|$)/.exec(text);
  if (!tickerMatch) return null;

  const normalized = text.replace(/\s+/g, "");
  const action: CommanderAction | null = normalized.includes("진입")
    ? "entered"
    : normalized.includes("관심")
      ? "watching"
      : normalized.includes("패스")
        ? "passed"
        : null;
  if (!action) return null;

  return { action, ticker: tickerMatch[1], date: fallbackDate };
}

/**
 * Pure: fold new decisions in. One decision per (date, ticker) — a later tap is
 * the commander changing their mind, so it replaces the earlier one rather than
 * stacking a contradictory second record.
 */
export function mergeDecisions(
  existing: CommanderDecision[],
  incoming: CommanderDecision[]
): CommanderDecision[] {
  const byKey = new Map<string, CommanderDecision>();
  for (const decision of [...existing, ...incoming]) {
    byKey.set(`${decision.date}:${decision.ticker}`, decision);
  }
  return Array.from(byKey.values()).sort((a, b) =>
    a.date === b.date ? a.ticker.localeCompare(b.ticker) : a.date.localeCompare(b.date)
  );
}

export type DecisionOutcome = {
  ticker: string;
  companyName?: string;
  date: string;
  action: CommanderAction;
  returnPct: number;
  status: string;
};

export type CommanderScorecard = {
  /** Settled picks the commander acted on. */
  taken: { count: number; winRate: number; avgReturnPct: number };
  /** Settled picks the commander explicitly passed on. */
  passed: { count: number; winRate: number; avgReturnPct: number };
  /** Every settled system pick, decided or not — the baseline to beat. */
  system: { count: number; winRate: number; avgReturnPct: number };
  /** taken avg − system avg. Positive means the commander's selection added value. */
  selectionEdgePct: number;
  undecided: number;
};

function aggregate(outcomes: DecisionOutcome[]) {
  if (!outcomes.length) return { count: 0, winRate: 0, avgReturnPct: 0 };
  const wins = outcomes.filter(item => item.returnPct > 0).length;
  const total = outcomes.reduce((sum, item) => sum + item.returnPct, 0);
  return {
    count: outcomes.length,
    winRate: Number(((wins / outcomes.length) * 100).toFixed(1)),
    avgReturnPct: Number((total / outcomes.length).toFixed(2)),
  };
}

/**
 * Pure: join decisions onto settled picks to compare the commander's selection
 * against the system's own record. Watch-only (shadow) picks are excluded so the
 * comparison uses the same population the headline stats use.
 */
export function buildCommanderScorecard(
  decisions: CommanderDecision[],
  journal: RecommendationEntry[]
): CommanderScorecard {
  const settled = journal.filter(
    entry => !entry.watchOnly && isSettledStatus(entry.status)
  );
  const decisionByKey = new Map<string, CommanderDecision>();
  for (const decision of decisions) {
    decisionByKey.set(`${decision.date}:${decision.ticker}`, decision);
  }

  const taken: DecisionOutcome[] = [];
  const passedOn: DecisionOutcome[] = [];
  let undecided = 0;

  for (const entry of settled) {
    const decision = decisionByKey.get(`${entry.date}:${entry.ticker}`);
    if (!decision) {
      undecided += 1;
      continue;
    }
    const outcome: DecisionOutcome = {
      ticker: entry.ticker,
      companyName: entry.companyName,
      date: entry.date,
      action: decision.action,
      returnPct: entry.returnPct ?? 0,
      status: entry.status,
    };
    if (decision.action === "entered") taken.push(outcome);
    else if (decision.action === "passed") passedOn.push(outcome);
  }

  const system = aggregate(
    settled.map(entry => ({
      ticker: entry.ticker,
      date: entry.date,
      action: "watching" as CommanderAction,
      returnPct: entry.returnPct ?? 0,
      status: entry.status,
    }))
  );
  const takenStats = aggregate(taken);

  return {
    taken: takenStats,
    passed: aggregate(passedOn),
    system,
    selectionEdgePct:
      takenStats.count && system.count
        ? Number((takenStats.avgReturnPct - system.avgReturnPct).toFixed(2))
        : 0,
    undecided,
  };
}

/** One line for the daily alert, or "" while the sample is too thin to mean anything. */
export function formatScorecardLine(
  scorecard: CommanderScorecard,
  minSamples = 5
): string {
  if (scorecard.taken.count < minSamples) {
    return scorecard.taken.count
      ? `🧭 내 기록 ${scorecard.taken.count}건 축적 중(${minSamples}건부터 비교 시작)`
      : "";
  }
  const edge = scorecard.selectionEdgePct;
  const verdict = edge > 0 ? "선택이 시스템보다 좋음" : edge < 0 ? "시스템 평균보다 낮음" : "시스템과 동일";
  return `🧭 내 선택 ${scorecard.taken.count}건 · 승률 ${scorecard.taken.winRate}% · 평균 ${scorecard.taken.avgReturnPct}% (시스템 ${scorecard.system.avgReturnPct}% · ${verdict})`;
}

// ── IO ──

export async function loadDecisionJournal(): Promise<DecisionJournal> {
  try {
    const raw = await readFile(DECISION_JOURNAL_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<DecisionJournal>;
    return {
      lastUpdateId: typeof parsed.lastUpdateId === "number" ? parsed.lastUpdateId : null,
      decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [],
    };
  } catch {
    return { lastUpdateId: null, decisions: [] };
  }
}

export async function saveDecisionJournal(journal: DecisionJournal): Promise<void> {
  await mkdir(path.dirname(DECISION_JOURNAL_PATH), { recursive: true });
  await writeFile(
    DECISION_JOURNAL_PATH,
    `${JSON.stringify(journal, null, 2)}\n`,
    "utf8"
  );
}
