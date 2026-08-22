/**
 * Collects pending Telegram taps into the decision journal.
 *
 * Runs once per scheduled pipeline run, before the day's alert is built, so the
 * new alert can confirm what yesterday's taps recorded. That confirmation is the
 * only feedback the commander gets — Telegram's own button spinner has long
 * expired by then — so it is deliberately part of the message, not a log line.
 */

import { fetchTelegramTaps, answerTelegramCallback } from "./_core/telegramNotification";
import { ENV } from "./_core/env";
import {
  actionLabel,
  loadDecisionJournal,
  mergeDecisions,
  parseCallbackData,
  parseTextDecision,
  saveDecisionJournal,
  type CommanderDecision,
  type DecisionJournal,
} from "./commanderDecisionJournal";
import { kstDate } from "./recommendationJournalAgent";

// getUpdates is bot-wide, not chat-scoped, so anything the bot token can see
// comes back — including a DM from a stranger who found the bot's username.
// Restrict to the chat(s) the alert is actually sent to. A tap with no
// chat id at all (Telegram omits callback_query.message in rare cases) is
// let through rather than dropped, since that is the legitimate flow, not
// the injection vector.
function allowedChatIds(): Set<string> {
  return new Set([ENV.telegramChatId, ENV.commanderChatId].filter(Boolean));
}

export type CollectionResult = {
  journal: DecisionJournal;
  added: CommanderDecision[];
  /** Short confirmation for the next alert, or "" when nothing was tapped. */
  confirmationLine: string;
};

export function formatConfirmation(added: CommanderDecision[]): string {
  if (!added.length) return "";
  const parts = added
    .slice(0, 6)
    .map(decision => `${decision.companyName ?? decision.ticker} ${actionLabel(decision.action)}`);
  const more = added.length > parts.length ? ` 외 ${added.length - parts.length}건` : "";
  return `✅ 지난 기록 반영: ${parts.join(" · ")}${more}`;
}

export async function collectCommanderDecisions(
  now = new Date(),
  nameByTicker: Record<string, string> = {}
): Promise<CollectionResult> {
  const journal = await loadDecisionJournal();
  const offset = journal.lastUpdateId != null ? journal.lastUpdateId + 1 : undefined;

  const { taps, lastUpdateId } = await fetchTelegramTaps(offset).catch(error => {
    console.warn("[Decision Journal] getUpdates failed:", error);
    return { taps: [], lastUpdateId: null };
  });

  const decidedAt = now.toISOString();
  const today = kstDate(now);
  const added: CommanderDecision[] = [];
  const trustedChats = allowedChatIds();

  // Always log, even when empty — the alternative is an unreadable silence
  // that makes "nothing was tapped" and "something broke upstream" identical.
  console.log(
    `[Decision Journal] polled offset=${offset ?? "(none)"}: ${taps.length} raw update(s) from Telegram`
  );

  for (const tap of taps) {
    if (tap.chatId && trustedChats.size && !trustedChats.has(tap.chatId)) {
      console.warn(`[Decision Journal] ignored tap from untrusted chat ${tap.chatId}`);
      continue;
    }
    const parsed =
      tap.kind === "tap"
        ? parseCallbackData(tap.data)
        : parseTextDecision(tap.data, today);
    if (!parsed) {
      console.warn(`[Decision Journal] could not parse ${tap.kind} update: ${JSON.stringify(tap.data)}`);
      continue;
    }

    added.push({
      ...parsed,
      companyName: nameByTicker[parsed.ticker],
      decidedAt,
      source: tap.kind === "tap" ? "tap" : "text",
    });

    if (tap.callbackQueryId) {
      // Best-effort: the query is normally expired by now, which is fine.
      await answerTelegramCallback(
        tap.callbackQueryId,
        `${actionLabel(parsed.action)} 기록됨`
      ).catch(() => undefined);
    }
  }

  const next: DecisionJournal = {
    lastUpdateId: lastUpdateId ?? journal.lastUpdateId,
    decisions: mergeDecisions(journal.decisions, added),
  };

  if (added.length || next.lastUpdateId !== journal.lastUpdateId) {
    await saveDecisionJournal(next);
    console.log(`[Decision Journal] saved: ${added.length} decision(s) added, offset now ${next.lastUpdateId}`);
  }

  return { journal: next, added, confirmationLine: formatConfirmation(added) };
}
