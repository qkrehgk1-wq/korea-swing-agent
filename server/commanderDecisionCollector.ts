/**
 * Collects pending Telegram taps into the decision journal.
 *
 * Runs once per scheduled pipeline run, before the day's alert is built, so the
 * new alert can confirm what yesterday's taps recorded. That confirmation is the
 * only feedback the commander gets — Telegram's own button spinner has long
 * expired by then — so it is deliberately part of the message, not a log line.
 */

import { fetchTelegramTaps, answerTelegramCallback } from "./_core/telegramNotification";
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

  for (const tap of taps) {
    const parsed =
      tap.kind === "tap"
        ? parseCallbackData(tap.data)
        : parseTextDecision(tap.data, today);
    if (!parsed) continue;

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
  }

  return { journal: next, added, confirmationLine: formatConfirmation(added) };
}
