/**
 * Commander-only channel — raw, unfiltered high-conviction / high-risk signals.
 *
 * Adapted from avatar_core's "commander eyes only" fork: while the public
 * Telegram channel gets the polished daily recommendations, the commander
 * (owner) gets the raw signal the moment a high-conviction setup or a
 * high-risk alert is detected. Persisted to secure_zone/commander_eyes_only.md
 * and delivered to COMMANDER_CHAT_ID (falls back to the normal chat).
 */

import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { ENV } from "./_core/env";
import { sendTelegramMessage } from "./_core/telegramNotification";

const SECURE_DIR = path.join(process.cwd(), "secure_zone");
const SECURE_PATH = path.join(SECURE_DIR, "commander_eyes_only.md");

export type CommanderSignal = {
  ticker: string;
  companyName: string;
  kind: "high_conviction" | "high_risk";
  headline: string;
  detail: string[];
};

export async function routeToCommander(signal: CommanderSignal): Promise<boolean> {
  const label = signal.kind === "high_conviction" ? "고확신 신호" : "고위험 경보";
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

  // 2. Deliver to the commander-only Telegram chat (falls back to public chat).
  const chatId = ENV.commanderChatId || ENV.telegramChatId;
  if (!chatId) return false;
  return sendTelegramMessage(title, content, chatId);
}
