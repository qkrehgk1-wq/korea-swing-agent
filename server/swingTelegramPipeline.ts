import "dotenv/config";

/**
 * Standalone technical swing pipeline.
 *
 * This mirrors the batch-style orchestration pattern from PRISM-INSIGHT:
 * run the screener independently, then fan out Telegram/Kakao/owner alerts.
 */

import { screenTechnicalSwingCandidates } from "./technicalSwingScreener";
import { predictLimitUpCandidates } from "./limitUpPredictionAgent";
import { predictFirstLimitUpFollowThroughCandidates } from "./firstLimitUpFollowThroughAgent";
import { collectCompanyIntelligence } from "./agentTeams/companyIntelligenceAgent";
import { collectElliottFractalInsights } from "./agentTeams/elliottFractalAgent";
import { collectExternalPlatformInsights } from "./agentTeams/externalPlatformIntegrationAgent";
import { collectDanteLearningReport } from "./agentTeams/youtubeLearningAgent";
import { runAgentTeamReview } from "./agentTeams/orchestrator";
import { runKosdaqSwingTeam } from "./agentTeams/kosdaqSwingTeam";
import {
  notifyDailySwingCandidates,
  notifyDailySwingFailure,
} from "./notificationService";
import {
  createSwingPipelineExecutionReport,
  createSwingPipelineSeed,
  persistSwingPipelineExecutionReport,
  persistSwingPipelineSeed,
} from "./swingPipelineContract";

function uniqueByTicker<T extends { ticker: string }>(items: T[]) {
  const seen = new Set<string>();
  return items.filter(item => {
    if (seen.has(item.ticker)) {
      return false;
    }
    seen.add(item.ticker);
    return true;
  });
}

async function runSwingTelegramPipeline() {
  console.log("[Swing Pipeline] Starting technical swing scan...");
  const seed = createSwingPipelineSeed();
  await persistSwingPipelineSeed(seed);

  try {
    // The Korean-market scanners share the same MCP-backed OHLCV source.
    // Running them one-by-one avoids concurrent cold starts that can trip the SDK's default request timeout.
    const externalPlatformPromise = collectExternalPlatformInsights();
    const result = await screenTechnicalSwingCandidates();
    const kosdaqTeamResult = await runKosdaqSwingTeam();
    const limitUpResult = await predictLimitUpCandidates();
    const firstLimitUpResult = await predictFirstLimitUpFollowThroughCandidates();
    const externalPlatformReport = await externalPlatformPromise;
    const { candidates, notes, scannedTickers } = result;
    const mergedSwingCandidates = uniqueByTicker([...kosdaqTeamResult.candidates, ...candidates]);

    console.log(
      `[Swing Pipeline] Scanned ${scannedTickers.length} tickers, matched ${candidates.length} candidates`
    );
    console.log(
      `[Swing Pipeline] Kosdaq team scanned ${kosdaqTeamResult.scannedTickers.length} tickers, matched ${kosdaqTeamResult.candidates.length} candidates`
    );
    console.log(
      `[Swing Pipeline] Limit-up agent scanned ${limitUpResult.scannedTickers.length} tickers, matched ${limitUpResult.candidates.length} candidates`
    );
    console.log(
      `[Swing Pipeline] Limit-up follow-through agent scanned ${firstLimitUpResult.scannedTickers.length} tickers, matched ${firstLimitUpResult.candidates.length} candidates`
    );
    console.log(
      `[Swing Pipeline] External platform integrations enabled: ${externalPlatformReport.enabled.join(", ") || "none"}`
    );

    if (mergedSwingCandidates.length || limitUpResult.candidates.length || firstLimitUpResult.candidates.length) {
      const companyInsights = await collectCompanyIntelligence([
        ...mergedSwingCandidates,
        ...limitUpResult.candidates,
        ...firstLimitUpResult.candidates,
      ]);
      const elliottFractalInsights = await collectElliottFractalInsights([
        ...mergedSwingCandidates,
        ...limitUpResult.candidates,
        ...firstLimitUpResult.candidates,
      ]);
      console.log(
        `[Swing Pipeline] Company intelligence collected for ${companyInsights.length} candidates`
      );
      console.log(
        `[Swing Pipeline] Elliott-fractal insights collected for ${elliottFractalInsights.length} candidates`
      );
      const danteLearning = await collectDanteLearningReport({
        maxVideos: 30,
        transcriptLimit: 5,
      }).catch(error => {
        console.warn("[Swing Pipeline] YouTube learning skipped:", error);
        return undefined;
      });
      if (danteLearning) {
        console.log(
          `[Swing Pipeline] YouTube learning extracted ${danteLearning.rules.length} Dante-style rules from ${danteLearning.sources.length} videos`
        );
      }

      const agentTeamReport = await runAgentTeamReview({
        swingCandidates: mergedSwingCandidates,
        limitUpCandidates: limitUpResult.candidates,
        firstLimitUpCandidates: firstLimitUpResult.candidates,
        companyInsights,
        elliottFractalInsights,
        danteLearning,
      });
      console.log(
        `[Swing Pipeline] Agent team approved ${agentTeamReport.approved.length}, held ${agentTeamReport.rejected.length}`
      );

      const delivery = await notifyDailySwingCandidates(
        mergedSwingCandidates,
        limitUpResult.candidates,
        firstLimitUpResult.candidates,
        externalPlatformReport,
        agentTeamReport,
        kosdaqTeamResult.candidates
      );
      if (!delivery.primaryDelivered) {
        await persistSwingPipelineExecutionReport(
          createSwingPipelineExecutionReport({
            seed,
            technicalSwing: result,
            kosdaqTeam: kosdaqTeamResult,
            limitUp: limitUpResult,
            firstLimitUp: firstLimitUpResult,
            mergedSwingCandidates,
            externalPlatformReport,
            agentTeamReport,
            danteLearning,
            telegramDelivered: false,
            failureCause: `Telegram delivery failed (${delivery.failedChannels.join(", ") || "telegram"})`,
          })
        );
        await notifyDailySwingFailure(
          [
            "추천 후보는 산출됐지만 텔레그램 전송이 실패했습니다.",
            `실패 채널: ${delivery.failedChannels.join(", ") || "telegram"}`,
            ...kosdaqTeamResult.notes,
            ...limitUpResult.notes,
            ...firstLimitUpResult.notes,
            ...agentTeamReport.notes,
          ],
          "텔레그램 전송 실패"
        );
        throw new Error(`Telegram delivery failed (${delivery.failedChannels.join(", ") || "telegram"})`);
      }
      await persistSwingPipelineExecutionReport(
        createSwingPipelineExecutionReport({
          seed,
          technicalSwing: result,
          kosdaqTeam: kosdaqTeamResult,
          limitUp: limitUpResult,
          firstLimitUp: firstLimitUpResult,
          mergedSwingCandidates,
          externalPlatformReport,
          agentTeamReport,
          danteLearning,
          telegramDelivered: true,
        })
      );
      console.log("[Swing Pipeline] Telegram swing and limit-up alert sent");
    } else {
      await persistSwingPipelineExecutionReport(
        createSwingPipelineExecutionReport({
          seed,
          technicalSwing: result,
          kosdaqTeam: kosdaqTeamResult,
          limitUp: limitUpResult,
          firstLimitUp: firstLimitUpResult,
          mergedSwingCandidates,
          externalPlatformReport,
          telegramDelivered: false,
        })
      );
      await notifyDailySwingFailure([
        ...notes,
        ...kosdaqTeamResult.notes,
        ...limitUpResult.notes,
        ...firstLimitUpResult.notes,
      ]);
      console.log("[Swing Pipeline] No qualified swing or limit-up candidates; failure alert sent");
    }

    process.exit(0);
  } catch (error) {
    console.error("[Swing Pipeline] Fatal error:", error);
    const message = error instanceof Error ? error.message : String(error);
    await persistSwingPipelineExecutionReport(
      createSwingPipelineExecutionReport({
        seed,
        technicalSwing: { bible: [], candidates: [], scannedTickers: [], notes: [] },
        kosdaqTeam: { candidates: [], scannedTickers: [], notes: [] },
        limitUp: { candidates: [], scannedTickers: [], notes: [] },
        firstLimitUp: { candidates: [], scannedTickers: [], notes: [] },
        mergedSwingCandidates: [],
        telegramDelivered: false,
        failureCause: message,
      })
    ).catch(reportError => {
      console.warn("[Swing Pipeline] Failed to persist execution report:", reportError);
    });
    await notifyDailySwingFailure(["스윙 파이프라인이 예외로 중단되었습니다."], message).catch(() => {});
    process.exit(1);
  }
}

runSwingTelegramPipeline();
