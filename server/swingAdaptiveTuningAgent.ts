import "dotenv/config";

import {
  runSwingAdaptiveLearning,
  SWING_BACKTEST_REPORT_PATH,
  SWING_LEARNED_OVERRIDES_PATH,
} from "./swingAdaptiveLearning";
import {
  runSwingPredictionQualityAgent,
  SWING_PREDICTION_QUALITY_OVERRIDES_PATH,
} from "./swingPredictionQualityAgent";

async function main() {
  const overrides = await runSwingAdaptiveLearning();
  const qualityOverrides = await runSwingPredictionQualityAgent();
  console.log("[Swing Adaptive Tuning Agent] Source:", SWING_BACKTEST_REPORT_PATH);
  console.log("[Swing Adaptive Tuning Agent] Overrides:", SWING_LEARNED_OVERRIDES_PATH);
  console.log("[Swing Adaptive Tuning Agent] Quality Overrides:", SWING_PREDICTION_QUALITY_OVERRIDES_PATH);
  console.log(
    `[Swing Adaptive Tuning Agent] Total trades ${overrides.totalTrades}, overall winRate ${overrides.overallWinRate.toFixed(1)}%`
  );
  console.log(
    `[Swing Adaptive Tuning Agent] Weight adjustments: ${JSON.stringify(overrides.patternWeightAdjustments)}`
  );
  console.log(
    `[Swing Adaptive Tuning Agent] Workflow policy: agreement ${overrides.workflowApprovalPolicy.minAgreementScore}, conflict ${overrides.workflowApprovalPolicy.maxConflictScore}, workflow ${overrides.workflowApprovalPolicy.minWorkflowScore}, elliott ${overrides.workflowApprovalPolicy.minElliottScore}`
  );
  console.log(
    `[Swing Adaptive Tuning Agent] Quality policy: default score ${qualityOverrides.minDefaultSwingScore}, early bowl score ${qualityOverrides.minEarlyBowlSwingScore}, volume ${qualityOverrides.minVolumeRatio.toFixed(2)}x, RSI ${qualityOverrides.maxRsi14}, vol ${qualityOverrides.maxVolatility20}`
  );
}

main().catch(error => {
  console.error("[Swing Adaptive Tuning Agent] Fatal error:", error);
  process.exit(1);
});
