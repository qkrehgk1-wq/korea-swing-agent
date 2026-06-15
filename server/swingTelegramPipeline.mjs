/**
 * Standalone technical swing pipeline.
 *
 * This mirrors the batch-style orchestration pattern from PRISM-INSIGHT:
 * run the screener independently, then fan out Telegram/Kakao/owner alerts.
 */

import { screenTechnicalSwingCandidates } from "./technicalSwingScreener.js";
import {
  notifyDailySwingCandidates,
  notifyDailySwingFailure,
} from "./notificationService.js";

async function runSwingTelegramPipeline() {
  console.log("[Swing Pipeline] Starting technical swing scan...");

  try {
    const result = await screenTechnicalSwingCandidates();
    const { candidates, notes, scannedTickers } = result;

    console.log(
      `[Swing Pipeline] Scanned ${scannedTickers.length} tickers, matched ${candidates.length} candidates`
    );

    if (candidates.length) {
      await notifyDailySwingCandidates(candidates);
      console.log("[Swing Pipeline] Telegram swing alert sent");
    } else {
      await notifyDailySwingFailure(notes);
      console.log("[Swing Pipeline] No qualified candidates; failure alert sent");
    }

    process.exit(0);
  } catch (error) {
    console.error("[Swing Pipeline] Fatal error:", error);
    const message = error instanceof Error ? error.message : String(error);
    await notifyDailySwingFailure(["스윙 파이프라인이 예외로 중단되었습니다."], message).catch(() => {});
    process.exit(1);
  }
}

runSwingTelegramPipeline();
