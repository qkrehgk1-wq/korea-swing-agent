/**
 * Multi-factor technical confluence — proven institutional techniques distilled
 * into one quality score so the screener only surfaces high-confidence setups,
 * not single-pattern noise. Pure functions, no IO.
 *
 * Factors: relative strength vs the index (O'Neil/Minervini leadership), moving
 * average trend alignment (Dow/Stage analysis), ADX trend strength + MACD
 * momentum, Fibonacci golden-ratio retracement/extension, volatility
 * contraction (Minervini VCP) + volume dry-up, and an anti-extension guard that
 * encodes the behavioral rule "don't chase" (FOMO).
 */

export type ConfluenceBar = { close: number; high: number; low: number; volume: number };

export type ConfluenceResult = {
  qualityScore: number; // 0-100 composite
  relativeStrength20: number; // stock 20d return minus index 20d return (pp)
  relativeStrength60: number;
  rsPositive: boolean;
  trendAligned: boolean;
  adx: number;
  macdBullish: boolean;
  fibRetracement: number | null; // 0 = at swing high, 1 = back at swing low
  nearGoldenSupport: boolean;
  fibExtensionTarget: number | null; // 1.618 projection of the up-leg
  volatilityContraction: boolean;
  volumeDryUp: boolean;
  overExtended: boolean;
  signals: string[];
};

function sma(values: number[], period: number): number {
  if (values.length < period || period <= 0) return 0;
  const slice = values.slice(-period);
  return slice.reduce((sum, value) => sum + value, 0) / period;
}

function emaSeries(values: number[], period: number): number[] {
  if (!values.length) return [];
  const k = 2 / (period + 1);
  const out: number[] = [values[0]];
  for (let i = 1; i < values.length; i += 1) {
    out.push(values[i] * k + out[i - 1] * (1 - k));
  }
  return out;
}

function ret(values: number[], lookback: number): number {
  if (values.length <= lookback) return 0;
  const past = values[values.length - 1 - lookback];
  if (!past) return 0;
  return ((values[values.length - 1] - past) / past) * 100;
}

/** MACD histogram sign (12/26/9). Bullish = MACD line above its signal line. */
export function macdBullish(closes: number[]): boolean {
  if (closes.length < 35) return false;
  const ema12 = emaSeries(closes, 12);
  const ema26 = emaSeries(closes, 26);
  const macdLine = closes.map((_, i) => ema12[i] - ema26[i]);
  const signal = emaSeries(macdLine, 9);
  const last = macdLine.length - 1;
  return macdLine[last] - signal[last] > 0;
}

/** Wilder's ADX (trend strength). Returns 0 when there is not enough data. */
export function computeAdx(bars: ConfluenceBar[], period = 14): number {
  if (bars.length < period * 2 + 1) return 0;
  const trs: number[] = [];
  const plusDM: number[] = [];
  const minusDM: number[] = [];
  for (let i = 1; i < bars.length; i += 1) {
    const upMove = bars[i].high - bars[i - 1].high;
    const downMove = bars[i - 1].low - bars[i].low;
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    trs.push(
      Math.max(
        bars[i].high - bars[i].low,
        Math.abs(bars[i].high - bars[i - 1].close),
        Math.abs(bars[i].low - bars[i - 1].close)
      )
    );
  }

  const wilder = (values: number[]): number[] => {
    const out: number[] = [];
    let prev = values.slice(0, period).reduce((sum, value) => sum + value, 0);
    out.push(prev);
    for (let i = period; i < values.length; i += 1) {
      prev = prev - prev / period + values[i];
      out.push(prev);
    }
    return out;
  };

  const trS = wilder(trs);
  const plusS = wilder(plusDM);
  const minusS = wilder(minusDM);
  const dx: number[] = [];
  for (let i = 0; i < trS.length; i += 1) {
    const plusDI = trS[i] ? (100 * plusS[i]) / trS[i] : 0;
    const minusDI = trS[i] ? (100 * minusS[i]) / trS[i] : 0;
    const sum = plusDI + minusDI;
    dx.push(sum ? (100 * Math.abs(plusDI - minusDI)) / sum : 0);
  }
  if (dx.length < period) return 0;
  let adx = dx.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  for (let i = period; i < dx.length; i += 1) {
    adx = (adx * (period - 1) + dx[i]) / period;
  }
  return Math.round(adx);
}

function atr(bars: ConfluenceBar[], start: number, end: number): number {
  const trs: number[] = [];
  for (let i = Math.max(1, start); i < end && i < bars.length; i += 1) {
    trs.push(
      Math.max(
        bars[i].high - bars[i].low,
        Math.abs(bars[i].high - bars[i - 1].close),
        Math.abs(bars[i].low - bars[i - 1].close)
      )
    );
  }
  return trs.length ? trs.reduce((sum, value) => sum + value, 0) / trs.length : 0;
}

/** Most recent up-leg (swing low → subsequent swing high) golden-ratio analysis. */
export function fibonacciLeg(bars: ConfluenceBar[], window = 80): {
  retracement: number | null;
  nearGolden: boolean;
  extensionTarget: number | null;
} {
  const slice = bars.slice(-window);
  if (slice.length < 10) return { retracement: null, nearGolden: false, extensionTarget: null };
  let lowIdx = 0;
  for (let i = 1; i < slice.length; i += 1) {
    if (slice[i].low < slice[lowIdx].low) lowIdx = i;
  }
  let highIdx = lowIdx;
  for (let i = lowIdx + 1; i < slice.length; i += 1) {
    if (slice[i].high > slice[highIdx].high) highIdx = i;
  }
  const swingLow = slice[lowIdx].low;
  const swingHigh = slice[highIdx].high;
  const range = swingHigh - swingLow;
  if (highIdx <= lowIdx || range <= 0) {
    return { retracement: null, nearGolden: false, extensionTarget: null };
  }
  const close = slice[slice.length - 1].close;
  const retracement = (swingHigh - close) / range;
  const nearGolden = retracement >= 0.382 && retracement <= 0.66;
  const extensionTarget = Math.round(swingLow + 1.618 * range);
  return { retracement: Number(retracement.toFixed(3)), nearGolden, extensionTarget };
}

/**
 * Scores a stock against its index benchmark. Returns a 0-100 confluence quality
 * score plus the individual signals so the screener can gate and explain picks.
 */
export function analyzeTechnicalConfluence(
  bars: ConfluenceBar[],
  benchmarkBars: ConfluenceBar[]
): ConfluenceResult {
  const closes = bars.map(bar => bar.close);
  const volumes = bars.map(bar => bar.volume);
  const benchCloses = benchmarkBars.map(bar => bar.close);
  const close = closes[closes.length - 1] ?? 0;

  const ma20 = sma(closes, 20);
  const ma60 = sma(closes, 60);
  const trendAligned = ma20 > 0 && ma60 > 0 && ma20 >= ma60 && close >= ma60;

  const stock20 = ret(closes, 20);
  const stock60 = ret(closes, 60);
  const hasBench = benchCloses.length >= 61;
  const relativeStrength20 = hasBench ? Number((stock20 - ret(benchCloses, 20)).toFixed(2)) : Number(stock20.toFixed(2));
  const relativeStrength60 = hasBench ? Number((stock60 - ret(benchCloses, 60)).toFixed(2)) : Number(stock60.toFixed(2));
  const rsPositive = relativeStrength60 >= 0;

  const adx = computeAdx(bars);
  const macdUp = macdBullish(closes);
  const fib = fibonacciLeg(bars);

  const recentAtr = atr(bars, bars.length - 10, bars.length);
  const priorAtr = atr(bars, bars.length - 30, bars.length - 20);
  const volatilityContraction = priorAtr > 0 && recentAtr < priorAtr * 0.85;
  const volumeDryUp = sma(volumes, 5) > 0 && sma(volumes, 5) < sma(volumes, 20) * 0.85;
  const overExtended = ma20 > 0 && close > ma20 * 1.15;

  const rsi = computeRsi(closes);
  const rsiHealthy = rsi >= 45 && rsi <= 68;

  const signals: string[] = [];
  let score = 0;
  if (trendAligned) {
    score += 18;
    signals.push("정배열 추세(20MA≥60MA, 종가≥60MA)");
  }
  if (relativeStrength60 > 0) {
    score += 16;
    signals.push(`지수대비 강세 RS60 +${relativeStrength60}%`);
  }
  if (relativeStrength20 > 0) score += 8;
  if (adx >= 20) {
    score += 10;
    signals.push(`추세강도 ADX ${adx}`);
    if (adx >= 30) score += 4;
  }
  if (macdUp) {
    score += 8;
    signals.push("MACD 상승 전환");
  }
  if (fib.nearGolden) {
    score += 12;
    signals.push(`황금비 되돌림 지지(${Math.round((fib.retracement ?? 0) * 100)}%)`);
  }
  if (volatilityContraction) {
    score += 8;
    signals.push("변동성 수축(VCP)");
  }
  if (volumeDryUp) {
    score += 4;
    signals.push("거래량 마름(매물 소화)");
  }
  if (rsiHealthy) score += 6;
  if (!overExtended) {
    score += 6;
  } else {
    signals.push("⚠ 20MA 대비 과확장(추격 주의)");
  }

  return {
    qualityScore: Math.max(0, Math.min(100, Math.round(score))),
    relativeStrength20,
    relativeStrength60,
    rsPositive,
    trendAligned,
    adx,
    macdBullish: macdUp,
    fibRetracement: fib.retracement,
    nearGoldenSupport: fib.nearGolden,
    fibExtensionTarget: fib.extensionTarget,
    volatilityContraction,
    volumeDryUp,
    overExtended,
    signals,
  };
}

function computeRsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  const changes = closes.slice(1).map((value, i) => value - closes[i]);
  const gains = changes.map(value => (value > 0 ? value : 0)).slice(-period);
  const losses = changes.map(value => (value < 0 ? Math.abs(value) : 0)).slice(-period);
  const avgGain = gains.reduce((sum, value) => sum + value, 0) / period;
  const avgLoss = losses.reduce((sum, value) => sum + value, 0) / period;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}
