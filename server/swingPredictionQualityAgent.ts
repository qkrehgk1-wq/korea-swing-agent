import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

type BacktestTradeLike = {
  patterns: string[];
  outcome: "target" | "stop" | "time_exit" | "not_triggered";
  returnPct: number;
  swingScore?: number;
  volumeRatio?: number;
  rsi14?: number;
  volatility20?: number;
  marketRegimeLabel?: "강세" | "중립" | "약세";
};

type BacktestReportLike = {
  generatedAt: string;
  totalTrades: number;
  winRate: number;
  avgReturnPct: number;
  trades: BacktestTradeLike[];
};

export type SwingPredictionQualityOverrides = {
  generatedAt: string;
  sourceReport: string;
  totalTrades: number;
  sampleSize: number;
  minDefaultSwingScore: number;
  minEarlyBowlSwingScore: number;
  minVolumeRatio: number;
  maxRsi14: number;
  maxVolatility20: number;
  notes: string[];
};

const REPORT_PATH = path.join(process.cwd(), ".data", "backtests", "latest-swing-backtest.json");
const OVERRIDES_PATH = path.join(process.cwd(), ".data", "backtests", "prediction-quality-overrides.json");
const MIN_SAMPLE = Number(process.env.SWING_QUALITY_MIN_SAMPLE ?? "8");

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function average(values: number[]) {
  if (!values.length) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value: number, digits = 1) {
  return Number(value.toFixed(digits));
}

function winRate(trades: BacktestTradeLike[]) {
  const active = trades.filter(trade => trade.outcome !== "not_triggered");
  if (!active.length) {
    return 0;
  }
  const wins = active.filter(trade => trade.returnPct > 0).length;
  return (wins / active.length) * 100;
}

function hasEarlyBowlPattern(patterns: string[]) {
  return patterns.includes("밥그릇 1번자리") || patterns.includes("밥그릇 2번자리");
}

export function deriveSwingPredictionQualityOverrides(
  report: BacktestReportLike,
  sourceReport = REPORT_PATH
): SwingPredictionQualityOverrides {
  const activeTrades = report.trades.filter(trade => trade.outcome !== "not_triggered");
  const winners = activeTrades.filter(trade => trade.returnPct > 0);
  const losers = activeTrades.filter(trade => trade.returnPct <= 0);
  const overallWinRate = winRate(activeTrades);
  const notes: string[] = [];

  let minDefaultSwingScore = 62;
  let minEarlyBowlSwingScore = 48;
  let minVolumeRatio = 0.9;
  let maxRsi14 = 76;
  let maxVolatility20 = 45;

  const scoredTrades = activeTrades.filter(
    trade =>
      typeof trade.swingScore === "number" &&
      typeof trade.volumeRatio === "number" &&
      typeof trade.rsi14 === "number" &&
      typeof trade.volatility20 === "number"
  );

  if (scoredTrades.length < MIN_SAMPLE) {
    notes.push(`활성 표본 ${scoredTrades.length}건으로 아직 품질 필터 자동 보정 신뢰도가 낮습니다.`);
  } else {
    const winnerScoreAvg = average(winners.map(trade => trade.swingScore ?? 0));
    const loserScoreAvg = average(losers.map(trade => trade.swingScore ?? 0));
    if (winnerScoreAvg >= loserScoreAvg + 4) {
      minDefaultSwingScore = clamp(Math.round((winnerScoreAvg + loserScoreAvg) / 2), 60, 72);
      notes.push(`승자 평균 점수 ${round(winnerScoreAvg)}점, 패자 평균 점수 ${round(loserScoreAvg)}점으로 기본 최소 점수를 ${minDefaultSwingScore}점으로 상향했습니다.`);
    }

    const earlyBowlTrades = scoredTrades.filter(trade => hasEarlyBowlPattern(trade.patterns));
    const earlyBowlLosers = earlyBowlTrades.filter(trade => trade.returnPct <= 0);
    if (earlyBowlTrades.length >= MIN_SAMPLE && winRate(earlyBowlTrades) < overallWinRate - 5) {
      const winnerEarlyScoreAvg = average(earlyBowlTrades.filter(trade => trade.returnPct > 0).map(trade => trade.swingScore ?? 0));
      const loserEarlyScoreAvg = average(earlyBowlLosers.map(trade => trade.swingScore ?? 0));
      minEarlyBowlSwingScore = clamp(Math.round((winnerEarlyScoreAvg + loserEarlyScoreAvg) / 2), 46, 58);
      notes.push(`초기 밥그릇 패턴 성과가 약해 최소 점수를 ${minEarlyBowlSwingScore}점으로 조정했습니다.`);
    }

    const lowVolumeTrades = scoredTrades.filter(trade => (trade.volumeRatio ?? 0) < 1);
    if (lowVolumeTrades.length >= 5 && winRate(lowVolumeTrades) < overallWinRate - 8) {
      minVolumeRatio = 1.0;
      notes.push(`거래량비 1.0배 미만 구간의 성과가 약해 최소 거래량비를 ${minVolumeRatio.toFixed(2)}배로 높였습니다.`);
    }

    const highRsiTrades = scoredTrades.filter(trade => (trade.rsi14 ?? 0) >= 72);
    if (highRsiTrades.length >= 5 && winRate(highRsiTrades) < overallWinRate - 8) {
      maxRsi14 = 72;
      notes.push(`RSI 72 이상 구간의 성과가 약해 RSI 상한을 ${maxRsi14}로 낮췄습니다.`);
    }

    const veryHighRsiTrades = scoredTrades.filter(trade => (trade.rsi14 ?? 0) >= 76);
    if (veryHighRsiTrades.length >= 5 && winRate(veryHighRsiTrades) < overallWinRate - 12) {
      maxRsi14 = 70;
      notes.push(`RSI 과열 구간 손실이 커서 RSI 상한을 ${maxRsi14}로 더 강화했습니다.`);
    }

    const highVolTrades = scoredTrades.filter(trade => (trade.volatility20 ?? 0) > 45);
    if (highVolTrades.length >= 5 && winRate(highVolTrades) < overallWinRate - 8) {
      maxVolatility20 = 42;
      notes.push(`20일 변동성 45 초과 구간의 성과가 약해 변동성 상한을 ${maxVolatility20}로 낮췄습니다.`);
    }

    const weakRegimeTrades = scoredTrades.filter(trade => trade.marketRegimeLabel === "약세");
    if (weakRegimeTrades.length >= 5 && winRate(weakRegimeTrades) < overallWinRate - 10) {
      minDefaultSwingScore = Math.max(minDefaultSwingScore, 66);
      minVolumeRatio = Math.max(minVolumeRatio, 1.0);
      notes.push("약세장 진입의 성과가 특히 약해 약세장에서도 통과하려면 더 높은 점수와 거래량이 필요하도록 조정했습니다.");
    }
  }

  if (!notes.length) {
    notes.push("뚜렷한 품질 필터 열위 구간이 아직 확인되지 않아 기본 필터를 유지합니다.");
  }

  return {
    generatedAt: new Date().toISOString(),
    sourceReport,
    totalTrades: report.totalTrades,
    sampleSize: scoredTrades.length,
    minDefaultSwingScore,
    minEarlyBowlSwingScore,
    minVolumeRatio: round(minVolumeRatio, 2),
    maxRsi14,
    maxVolatility20,
    notes,
  };
}

export async function loadLatestBacktestReport(reportPath = REPORT_PATH) {
  const raw = await readFile(reportPath, "utf8");
  return JSON.parse(raw) as BacktestReportLike;
}

export async function writeSwingPredictionQualityOverrides(
  overrides: SwingPredictionQualityOverrides,
  outputPath = OVERRIDES_PATH
) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(overrides, null, 2)}\n`, "utf8");
}

export async function runSwingPredictionQualityAgent(reportPath = REPORT_PATH) {
  const report = await loadLatestBacktestReport(reportPath);
  const overrides = deriveSwingPredictionQualityOverrides(report, reportPath);
  await writeSwingPredictionQualityOverrides(overrides);
  return overrides;
}

export {
  OVERRIDES_PATH as SWING_PREDICTION_QUALITY_OVERRIDES_PATH,
  REPORT_PATH as SWING_PREDICTION_QUALITY_REPORT_PATH,
};
