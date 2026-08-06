import "dotenv/config";

import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * Standalone technical swing pipeline.
 *
 * This mirrors the batch-style orchestration pattern from PRISM-INSIGHT:
 * run the screener independently, then fan out Telegram/Kakao/owner alerts.
 */

import {
  screenTechnicalSwingCandidates,
  type TechnicalSwingCandidate,
} from "./technicalSwingScreener";
import { fetchSupplyTrend } from "./koreaStockMcp";
import { assessNewsSentiment } from "./newsSentimentAgent";
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
  loadRecommendationJournal,
  recordRecommendations,
  summarizeJournal,
  isSettledStatus,
} from "./recommendationJournalAgent";
import { computeExpectancy } from "./expectancy";
import { routeToCommander } from "./commanderChannel";
import {
  createSwingPipelineExecutionReport,
  createSwingPipelineSeed,
  persistSwingPipelineExecutionReport,
  persistSwingPipelineSeed,
} from "./swingPipelineContract";
import { verifyMarketDataCandidates } from "./marketDataAccuracyAgent";
import { collectCommanderDecisions } from "./commanderDecisionCollector";
import {
  buildCommanderScorecard,
  formatScorecardLine,
} from "./commanderDecisionJournal";

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

/**
 * Final-pick enrichment (cheap — only the survivors): foreign/institutional
 * supply (smart-money accumulation/distribution) + behavioral news sentiment.
 * They surface evidence and risk notes in the alert. They do not change the
 * technical score: otherwise the live journal no longer measures the same
 * strategy as the historical backtest.
 */
async function enrichSwingCandidates(
  candidates: TechnicalSwingCandidate[]
): Promise<void> {
  await Promise.all(
    candidates.map(async candidate => {
      const [supply, news] = await Promise.all([
        fetchSupplyTrend(candidate.ticker),
        assessNewsSentiment(candidate.companyName),
      ]);
      if (supply) {
        candidate.supplyState = supply.state;
        candidate.supplyNote = supply.note;
        candidate.reason = [...candidate.reason, supply.note];
      }
      if (news && news.state !== "neutral") {
        candidate.newsState = news.state;
        candidate.newsNote = news.note;
        candidate.reason = [...candidate.reason, news.note];
      }
    })
  );
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
    const firstLimitUpResult =
      await predictFirstLimitUpFollowThroughCandidates();
    const externalPlatformReport = await externalPlatformPromise;
    const { candidates, notes, scannedTickers, watchlist = [] } = result;
    const dataDegraded = result.dataReliability?.degraded ?? false;
    // The technical screener is the canonical core strategy. The KOSDAQ team
    // remains a secondary research track and must not replace a core candidate
    // with the same ticker or contaminate the core journal/backtest comparison.
    const mergedSwingCandidates = uniqueByTicker([
      ...candidates,
      ...kosdaqTeamResult.candidates,
    ]);
    await enrichSwingCandidates([...mergedSwingCandidates, ...watchlist]);

    // Send and journal only candidates whose ticker, name, latest quote, and
    // price plan agree with a fresh market-data fetch.
    const accuracyCheck = await verifyMarketDataCandidates(
      [
        ...mergedSwingCandidates,
        ...watchlist,
        ...limitUpResult.candidates,
        ...firstLimitUpResult.candidates,
      ],
      { writeReport: true }
    );
    const verifiedCandidates = new Set(accuracyCheck.accepted);
    const verifiedSwingCandidates = mergedSwingCandidates.filter(candidate =>
      verifiedCandidates.has(candidate)
    );
    const verifiedKosdaqCandidates = kosdaqTeamResult.candidates.filter(candidate =>
      verifiedCandidates.has(candidate)
    );
    const verifiedWatchlist = watchlist.filter(candidate =>
      verifiedCandidates.has(candidate)
    );
    const verifiedLimitUpCandidates = limitUpResult.candidates.filter(candidate =>
      verifiedCandidates.has(candidate)
    );
    const verifiedFirstLimitUpCandidates = firstLimitUpResult.candidates.filter(candidate =>
      verifiedCandidates.has(candidate)
    );
    const accuracyLine = accuracyCheck.rejected.length
      ? `⚠️ 시세 확인 실패 ${accuracyCheck.rejected.length}개 제외`
      : "";

    // 최근 결과 1줄(저널 정산 기반) — 표본이 최소치 이상일 때만 표기.
    const journalEntries = await loadRecommendationJournal();
    const journalSummary = summarizeJournal(journalEntries);
    const liveExpectancy = computeExpectancy(
      journalEntries
        .filter(entry => !entry.watchOnly && isSettledStatus(entry.status))
        .map(entry => ({
          triggerPrice: entry.triggerPrice,
          stopLossPrice: entry.stopLossPrice,
          returnPct: entry.returnPct ?? 0,
        }))
    );
    const safetyLine =
      liveExpectancy.edgeVerdict === "negative"
        ? "⚠ 실거래 금지 · 현재는 관찰용"
        : "";
    const performanceStatsLine =
      journalSummary.triggered >=
      Number(process.env.JOURNAL_MIN_REPORT_TRADES || 5)
        ? `📈 최근 결과: ${journalSummary.triggered}건 · 승률 ${journalSummary.winRate}% · 평균 ${journalSummary.avgReturnPct}%`
        : "";
    const performanceLine = [safetyLine, performanceStatsLine].filter(Boolean).join(" | ");

    // Fold in the taps made since the last run, then report back what landed.
    // A tap gets no instant feedback (the callback has long expired by now), so
    // this confirmation in the next alert is the only receipt the commander sees.
    const nameByTicker: Record<string, string> = {};
    for (const candidate of [...mergedSwingCandidates, ...watchlist]) {
      nameByTicker[candidate.ticker] = candidate.companyName;
    }
    const decisionCollection = await collectCommanderDecisions(new Date(), nameByTicker).catch(
      error => {
        console.warn("[Swing Pipeline] decision collection failed:", error);
        return null;
      }
    );
    const scorecard = buildCommanderScorecard(
      decisionCollection?.journal.decisions ?? [],
      journalEntries
    );
    const decisionLine = [
      decisionCollection?.confirmationLine ?? "",
      formatScorecardLine(scorecard),
    ]
      .filter(Boolean)
      .join("\n");

    if (dataDegraded) {
      await routeToCommander({
        ticker: "DATA",
        companyName: "데이터 신뢰도",
        kind: "high_risk",
        headline: "수집 신뢰도 저하 — 신규 검토 후보 생성 중단",
        detail: [
          `수집 실패 ${result.dataReliability?.dataFailures ?? "?"}/${result.dataReliability?.scanned ?? "?"} · 거래정지 의심 ${result.dataReliability?.staleTickers ?? 0}`,
          "이번 회차는 관찰 정보만 발송합니다.",
        ],
      }).catch(error =>
        console.warn("[Swing Pipeline] degraded notify failed:", error)
      );
    }

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

    if (
      verifiedSwingCandidates.length ||
      verifiedLimitUpCandidates.length ||
      verifiedFirstLimitUpCandidates.length ||
      verifiedWatchlist.length
    ) {
      const companyInsights = await collectCompanyIntelligence([
        ...verifiedSwingCandidates,
        ...verifiedLimitUpCandidates,
        ...verifiedFirstLimitUpCandidates,
      ]);
      const elliottFractalInsights = await collectElliottFractalInsights([
        ...verifiedSwingCandidates,
        ...verifiedLimitUpCandidates,
        ...verifiedFirstLimitUpCandidates,
      ]);
      console.log(
        `[Swing Pipeline] Company intelligence collected for ${companyInsights.length} candidates`
      );
      console.log(
        `[Swing Pipeline] Elliott-fractal insights collected for ${elliottFractalInsights.length} candidates`
      );
      // 유튜브 학습은 비용·쿼터가 커서 주 1회(월요일 KST)만 실행. ENABLE_YOUTUBE_LEARNING=true로 강제 가능.
      const kstDay = new Date(
        new Date().toLocaleString("en-US", { timeZone: "Asia/Seoul" })
      ).getDay();
      const runYoutubeLearning =
        process.env.ENABLE_YOUTUBE_LEARNING === "true" || kstDay === 1;
      const danteLearning = runYoutubeLearning
        ? await collectDanteLearningReport({
            maxVideos: 30,
            transcriptLimit: 5,
          }).catch(error => {
            console.warn("[Swing Pipeline] YouTube learning skipped:", error);
            return undefined;
          })
        : undefined;
      if (danteLearning) {
        console.log(
          `[Swing Pipeline] YouTube learning extracted ${danteLearning.rules.length} Dante-style rules from ${danteLearning.sources.length} videos`
        );
      }

      const agentTeamReport = await runAgentTeamReview({
        swingCandidates: verifiedSwingCandidates,
        limitUpCandidates: verifiedLimitUpCandidates,
        firstLimitUpCandidates: verifiedFirstLimitUpCandidates,
        companyInsights,
        elliottFractalInsights,
        danteLearning,
      });
      console.log(
        `[Swing Pipeline] Agent team approved ${agentTeamReport.approved.length}, held ${agentTeamReport.rejected.length}`
      );

      const delivery = await notifyDailySwingCandidates(
        verifiedSwingCandidates,
        verifiedLimitUpCandidates,
        verifiedFirstLimitUpCandidates,
        externalPlatformReport,
        agentTeamReport,
        verifiedKosdaqCandidates,
        verifiedWatchlist,
        { performanceLine, dataDegraded, accuracyLine, decisionLine }
      );
      if (!delivery.primaryDelivered) {
        await persistSwingPipelineExecutionReport(
          createSwingPipelineExecutionReport({
            seed,
            technicalSwing: result,
            kosdaqTeam: kosdaqTeamResult,
            limitUp: { ...limitUpResult, candidates: verifiedLimitUpCandidates },
            firstLimitUp: { ...firstLimitUpResult, candidates: verifiedFirstLimitUpCandidates },
            mergedSwingCandidates: verifiedSwingCandidates,
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
            ...(accuracyLine ? [accuracyLine] : []),
            ...agentTeamReport.notes,
          ],
          "텔레그램 전송 실패"
        );
        throw new Error(
          `Telegram delivery failed (${delivery.failedChannels.join(", ") || "telegram"})`
        );
      }
      await persistSwingPipelineExecutionReport(
        createSwingPipelineExecutionReport({
          seed,
          technicalSwing: result,
          kosdaqTeam: kosdaqTeamResult,
          limitUp: { ...limitUpResult, candidates: verifiedLimitUpCandidates },
          firstLimitUp: { ...firstLimitUpResult, candidates: verifiedFirstLimitUpCandidates },
          mergedSwingCandidates: verifiedSwingCandidates,
          externalPlatformReport,
          agentTeamReport,
          danteLearning,
          telegramDelivered: true,
        })
      );
      // 섀도 포함 기록: 관찰 후보도 채점 대상으로 남겨 약세장에도 검증이 굶지
      // 않게 한다(장애 시엔 가격 신뢰 불가라 섀도 제외).
      await recordRecommendations(
        verifiedSwingCandidates.filter(candidate =>
          candidates.some(item => item.ticker === candidate.ticker)
        ),
        new Date(),
        dataDegraded ? [] : verifiedWatchlist
      ).catch(error =>
        console.warn("[Swing Pipeline] Journal record failed:", error)
      );
      console.log("[Swing Pipeline] Telegram swing and limit-up alert sent");
    } else {
      await persistSwingPipelineExecutionReport(
        createSwingPipelineExecutionReport({
          seed,
          technicalSwing: result,
          kosdaqTeam: kosdaqTeamResult,
          limitUp: { ...limitUpResult, candidates: verifiedLimitUpCandidates },
          firstLimitUp: { ...firstLimitUpResult, candidates: verifiedFirstLimitUpCandidates },
          mergedSwingCandidates: verifiedSwingCandidates,
          externalPlatformReport,
          telegramDelivered: false,
        })
      );
      await notifyDailySwingFailure([
        ...notes,
        ...kosdaqTeamResult.notes,
        ...limitUpResult.notes,
        ...firstLimitUpResult.notes,
        ...(accuracyLine ? [accuracyLine] : []),
      ]);
      console.log(
        "[Swing Pipeline] No qualified swing or limit-up candidates; failure alert sent"
      );
    }

    process.exit(0);
  } catch (error) {
    console.error("[Swing Pipeline] Fatal error:", error);
    const message = error instanceof Error ? error.message : String(error);
    await persistSwingPipelineExecutionReport(
      createSwingPipelineExecutionReport({
        seed,
        technicalSwing: {
          bible: [],
          candidates: [],
          scannedTickers: [],
          notes: [],
        },
        kosdaqTeam: { candidates: [], scannedTickers: [], notes: [] },
        limitUp: { candidates: [], scannedTickers: [], notes: [] },
        firstLimitUp: { candidates: [], scannedTickers: [], notes: [] },
        mergedSwingCandidates: [],
        telegramDelivered: false,
        failureCause: message,
      })
    ).catch(reportError => {
      console.warn(
        "[Swing Pipeline] Failed to persist execution report:",
        reportError
      );
    });
    await notifyDailySwingFailure(
      ["스윙 파이프라인이 예외로 중단되었습니다."],
      message
    ).catch(() => {});
    process.exit(1);
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  runSwingTelegramPipeline();
}
