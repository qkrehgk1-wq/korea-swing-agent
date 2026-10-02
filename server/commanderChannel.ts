/**
 * Commander-only channel — raw, unfiltered high-conviction / high-risk signals.
 *
 * Adapted from avatar_core's "commander eyes only" fork: while the public
 * Telegram channel gets the polished daily recommendations, the commander
 * (owner) gets the raw signal the moment a high-conviction setup or a
 * high-risk alert is detected. Persisted to secure_zone/commander_eyes_only.md
 * and delivered to COMMANDER_CHAT_ID (falls back to the normal chat).
 *
 * Digest mode (daily workflow only): the daily job used to fire the main alert
 * and then two or three commander alerts within ~5 seconds of it (journal at
 * +4s, steward at +5s, measured 2026-09-29..10-01), so they landed on the phone
 * on top of each other. In that workflow signals are queued to a file instead
 * and the last step sends them as one message, a fixed gap after the main
 * alert. Everywhere else — other workflows, the web server, local runs — sends
 * immediately as before, so nothing is queued that no step will ever flush.
 */

import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { ENV } from "./_core/env";
import { readMainChatSentAt, sendTelegramMessage } from "./_core/telegramNotification";

const SECURE_DIR = path.join(process.cwd(), "secure_zone");
const SECURE_PATH = path.join(SECURE_DIR, "commander_eyes_only.md");
const OUTBOX_PATH = path.join(process.cwd(), ".data", "commander-outbox.json");

/** Only this workflow ends in a step that flushes the queue (the steward). */
export const DIGEST_WORKFLOW = "Daily Swing Recommendations";

export type CommanderSignal = {
  ticker: string;
  companyName: string;
  kind: "high_conviction" | "high_risk";
  headline: string;
  detail: string[];
};

function kindLabel(kind: CommanderSignal["kind"]): string {
  return kind === "high_conviction" ? "고확신 신호" : "고위험 경보";
}

/**
 * Queue only inside the daily workflow, whose final step flushes. If the
 * workflow is ever renamed this returns false and alerts go out immediately —
 * the old behaviour, never a silent loss.
 */
export function shouldQueueCommander(
  env: Record<string, string | undefined> = process.env
): boolean {
  return (
    env.GITHUB_ACTIONS === "true" &&
    env.GITHUB_WORKFLOW === DIGEST_WORKFLOW &&
    (env.COMMANDER_DIGEST ?? "").trim().toLowerCase() !== "off"
  );
}

/** Pure: one message for the whole run, risks first. */
export function formatCommanderDigest(signals: CommanderSignal[]): {
  title: string;
  content: string;
} {
  const ordered = [...signals].sort((a, b) =>
    a.kind === b.kind ? 0 : a.kind === "high_risk" ? -1 : 1
  );
  const risks = ordered.filter(signal => signal.kind === "high_risk").length;
  const title =
    `🔒 지휘관 전용 — 오늘의 점검 ${ordered.length}건` +
    (risks ? ` (경보 ${risks})` : "");
  const blocks = ordered.map(signal =>
    [
      `■ ${kindLabel(signal.kind)} · ${signal.companyName}(${signal.ticker})`,
      signal.headline,
      ...signal.detail.map(line => `  ${line}`),
    ].join("\n")
  );
  return { title, content: blocks.join("\n\n") };
}

/** Pure: how long to wait so the digest lands at least `minGapMs` after the main alert. */
export function digestWaitMs(
  mainSentAt: number | null,
  nowMs: number,
  minGapMs: number
): number {
  if (mainSentAt === null) return 0;
  return Math.max(0, mainSentAt + minGapMs - nowMs);
}

async function readOutbox(): Promise<CommanderSignal[]> {
  try {
    const parsed = JSON.parse(await readFile(OUTBOX_PATH, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function sendNow(title: string, content: string): Promise<boolean> {
  const chatId = ENV.commanderChatId || ENV.telegramChatId;
  if (!chatId) return false;
  return sendTelegramMessage(title, content, chatId);
}

export async function routeToCommander(signal: CommanderSignal): Promise<boolean> {
  const label = kindLabel(signal.kind);
  const title = `🔒 지휘관 전용 — ${label}: ${signal.companyName}(${signal.ticker})`;
  const content = [signal.headline, "", ...signal.detail].join("\n");

  // 1. Raw record in the commander-only secure zone (gitignored).
  try {
    await mkdir(SECURE_DIR, { recursive: true });
    await appendFile(
      SECURE_PATH,
      `\n\n---\n## ${new Date().toISOString()} — ${title}\n\n${content}\n`,
      "utf8"
    );
  } catch (error) {
    console.warn("[Commander] Failed to write secure log:", error);
  }

  // 2a. Daily workflow: queue for the end-of-run digest.
  if (shouldQueueCommander()) {
    try {
      const queued = await readOutbox();
      queued.push(signal);
      await mkdir(path.dirname(OUTBOX_PATH), { recursive: true });
      await writeFile(OUTBOX_PATH, `${JSON.stringify(queued, null, 2)}\n`, "utf8");
      console.log(`[Commander] queued for digest (${queued.length}): ${signal.headline}`);
      return true;
    } catch (error) {
      // Queueing failed — sending now beats losing the alert.
      console.warn("[Commander] queue failed, sending immediately:", error);
    }
  }

  // 2b. Everywhere else: deliver now (falls back to public chat).
  return sendNow(title, content);
}

/**
 * Sends everything queued during the run as one message. Called by the last
 * step of the daily workflow. Leaves the outbox in place if sending fails, and
 * says so — the runner is about to be discarded, so the log is the only trace.
 */
export async function flushCommanderDigest(
  options: {
    minGapMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  } = {}
): Promise<number> {
  const signals = await readOutbox();
  if (!signals.length) return 0;

  const minGapMs =
    options.minGapMs ?? (Number(process.env.COMMANDER_DIGEST_GAP_MS) || 90_000);
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));

  const wait = digestWaitMs(await readMainChatSentAt(), now(), minGapMs);
  if (wait > 0) {
    console.log(`[Commander] digest waits ${Math.round(wait / 1000)}s to stay clear of the main alert`);
    await sleep(wait);
  }

  const { title, content } = formatCommanderDigest(signals);
  const sent = await sendNow(title, content);
  if (sent) {
    await rm(OUTBOX_PATH, { force: true });
    console.log(`[Commander] digest sent: ${signals.length} signal(s) in one message`);
  } else {
    console.warn(`[Commander] digest NOT sent — ${signals.length} signal(s) undelivered`);
  }
  return sent ? signals.length : 0;
}
