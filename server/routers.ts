import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, protectedProcedure, router } from "./_core/trpc";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  getOrCreateStock,
  createAnalysis,
  createAgentReport,
  getUserAnalysisHistory,
  getAnalysisByIdWithReports,
  addToWatchlist,
  getUserWatchlist,
  removeFromWatchlist,
} from "./db";
import {
  notifyAnalysisComplete,
  notifyHighOpportunity,
} from "./notificationService";
import { runKoreanAgentAnalysis } from "./koreanAgentEngine";
import { routeToCommander } from "./commanderChannel";
import { fetchKoreanStockAnalysisData, isKoreanTicker } from "./koreaStockMcp";
import { screenTechnicalSwingCandidates } from "./technicalSwingScreener";

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query((opts) => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return {
        success: true,
      } as const;
    }),
  }),

  stocks: router({
    analyze: protectedProcedure
      .input(z.object({ ticker: z.string() }))
      .mutation(async ({ ctx, input }) => {
        const ticker = input.ticker.trim();

        if (!isKoreanTicker(ticker)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "현재는 한국 종목만 분석할 수 있습니다. 6자리 종목 코드로 입력하세요 (예: 005930).",
          });
        }

        try {
          const koreanData = await fetchKoreanStockAnalysisData(ticker);
          const analysis = await runKoreanAgentAnalysis(ticker, koreanData);
          const hasLiveData = !analysis.dataQuality.usedFallbackData;

          const stock = await getOrCreateStock(ticker, {
            name: analysis.companyName,
            industry: "Korean Equity",
            website: "",
            description: "한국 주식 MCP 기반 스윙 분석 종목",
          });

          const savedAnalysis = await createAnalysis({
            userId: ctx.user.id,
            stockId: stock?.id || 0,
            ticker,
            fundamentalAnalysis: analysis.fundamentalAnalysis,
            technicalAnalysis: analysis.technicalAnalysis,
            insiderAnalysis: analysis.insiderAnalysis,
            riskAnalysis: analysis.riskAnalysis,
            billionaireFramework: JSON.stringify(analysis.framework),
            investmentInsight: analysis.investmentInsight,
            asymmetricGrowthScore: analysis.framework.asymmetricGrowthScore,
          });

          if (savedAnalysis?.id) {
            const baseConfidence = hasLiveData ? 80 : 54;
            await Promise.all([
              createAgentReport({
                analysisId: savedAnalysis.id,
                agentRole: "패턴 구조 분석가",
                report: analysis.fundamentalAnalysis,
                confidence: baseConfidence + 2,
              }),
              createAgentReport({
                analysisId: savedAnalysis.id,
                agentRole: "기술적 지표 분석가",
                report: analysis.technicalAnalysis,
                confidence: baseConfidence,
              }),
              createAgentReport({
                analysisId: savedAnalysis.id,
                agentRole: "수급 분석가",
                report: analysis.insiderAnalysis,
                confidence: baseConfidence - 2,
              }),
              createAgentReport({
                analysisId: savedAnalysis.id,
                agentRole: "리스크 관리자",
                report: analysis.riskAnalysis,
                confidence: baseConfidence - 1,
              }),
              createAgentReport({
                analysisId: savedAnalysis.id,
                agentRole: "스윙 전략가",
                report: analysis.marketIntelligenceAnalysis,
                confidence: baseConfidence - 3,
              }),
            ]);
          }

          // Notifications only on trustworthy (live-data) analyses, so the
          // owner is not spammed by fallback-only runs.
          const score = analysis.framework.asymmetricGrowthScore || 0;
          if (hasLiveData) {
            if (score >= 80) {
              await notifyHighOpportunity(
                ticker,
                score,
                `${analysis.companyName}(${ticker})가 스윙 기준 높은 점수를 기록했습니다.`
              );
            }
            await notifyAnalysisComplete({
              ticker,
              asymmetricGrowthScore: score,
              investmentInsight: analysis.investmentInsight,
              framework: analysis.framework as unknown as Record<string, unknown>,
            });

            // Commander-only raw alert on extreme conviction or risk.
            const council = analysis.signalCouncil;
            if (council) {
              if (council.decision === "ACT" && council.total >= 85) {
                await routeToCommander({
                  ticker,
                  companyName: analysis.companyName,
                  kind: "high_conviction",
                  headline: council.summary,
                  detail: council.rationale,
                });
              } else if (council.score.riskLevel >= 9) {
                await routeToCommander({
                  ticker,
                  companyName: analysis.companyName,
                  kind: "high_risk",
                  headline: council.summary,
                  detail: council.rationale,
                });
              }
            }
          }

          return {
            success: true,
            analysisId: savedAnalysis?.id,
            ticker,
            companyName: analysis.companyName,
            dataQuality: analysis.dataQuality,
            framework: analysis.framework,
            investmentInsight: analysis.investmentInsight,
            fundamentalAnalysis: analysis.fundamentalAnalysis,
            technicalAnalysis: analysis.technicalAnalysis,
            insiderAnalysis: analysis.insiderAnalysis,
            riskAnalysis: analysis.riskAnalysis,
            marketIntelligenceAnalysis: analysis.marketIntelligenceAnalysis,
          };
        } catch (error) {
          if (error instanceof TRPCError) throw error;
          console.error("Analysis error:", error);
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "분석 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.",
          });
        }
      }),

    getHistory: protectedProcedure.query(async ({ ctx }) => {
      return getUserAnalysisHistory(ctx.user.id);
    }),

    getById: protectedProcedure
      .input(z.object({ analysisId: z.number() }))
      .query(async ({ ctx, input }) => {
        const result = await getAnalysisByIdWithReports(input.analysisId);
        // Ownership check: never expose another user's analysis (IDOR guard).
        if (!result.analysis || result.analysis.userId !== ctx.user.id) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "분석을 찾을 수 없습니다.",
          });
        }
        return result;
      }),

    screenSwing: protectedProcedure
      .input(
        z
          .object({
            tickers: z.array(z.string()).max(24).optional(),
          })
          .optional()
      )
      .query(async ({ input }) => {
        return screenTechnicalSwingCandidates(input?.tickers);
      }),
  }),

  watchlist: router({
    add: protectedProcedure
      .input(z.object({ ticker: z.string() }))
      .mutation(async ({ ctx, input }) => {
        const ticker = input.ticker.trim();
        if (!isKoreanTicker(ticker)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "한국 종목 코드(6자리)만 관심종목에 추가할 수 있습니다.",
          });
        }
        await addToWatchlist(ctx.user.id, ticker);
        return { success: true };
      }),

    list: protectedProcedure.query(async ({ ctx }) => {
      return getUserWatchlist(ctx.user.id);
    }),

    remove: protectedProcedure
      .input(z.object({ ticker: z.string() }))
      .mutation(async ({ ctx, input }) => {
        await removeFromWatchlist(ctx.user.id, input.ticker.trim());
        return { success: true };
      }),
  }),
});

export type AppRouter = typeof appRouter;
