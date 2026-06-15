import {
  fetchKoreanOhlcvRowsBatch,
  type OhlcvRow,
} from "../koreaStockMcp";

type CandidateInput = {
  ticker: string;
  companyName: string;
};

type PivotPoint = {
  index: number;
  price: number;
  type: "high" | "low";
};

export type ElliottFractalInsight = {
  ticker: string;
  companyName: string;
  score: number;
  label: "강한 상승 5파 진행" | "초기 3파 확장" | "수렴 후 확장 대기" | "교정/혼조";
  waveBias: "impulse" | "early_impulse" | "compression" | "mixed";
  waveCountEstimate: string;
  fractalCompressionScore: number;
  notes: string[];
  warnings: string[];
};

export function deriveElliottFractalInsightFromRows(
  candidate: CandidateInput,
  rows: OhlcvRow[] | null
): ElliottFractalInsight | null {
  return buildInsight(candidate, rows);
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function average(values: number[]) {
  if (!values.length) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentChange(base: number, current: number) {
  if (!base) {
    return 0;
  }
  return ((current - base) / base) * 100;
}

function toCloses(rows: OhlcvRow[]) {
  return rows.map(row => row.종가);
}

function buildPivots(closes: number[], left = 2, right = 2): PivotPoint[] {
  const pivots: PivotPoint[] = [];

  for (let index = left; index < closes.length - right; index += 1) {
    const price = closes[index];
    const before = closes.slice(index - left, index);
    const after = closes.slice(index + 1, index + 1 + right);
    const window = [...before, ...after];

    if (window.every(value => price >= value)) {
      pivots.push({ index, price, type: "high" });
    } else if (window.every(value => price <= value)) {
      pivots.push({ index, price, type: "low" });
    }
  }

  return pivots.filter((pivot, index, array) => {
    const previous = array[index - 1];
    return !previous || previous.type !== pivot.type;
  });
}

type WaveDiagnostics = {
  impulseScore: number;
  earlyImpulseScore: number;
  fractalCompressionScore: number;
  waveCountEstimate: string;
  notes: string[];
  warnings: string[];
};

export function scoreElliottFractalFromRows(rows: OhlcvRow[] | null): WaveDiagnostics | null {
  if (!rows?.length || rows.length < 80) {
    return null;
  }

  const closes = toCloses(rows);
  const recentCloses = closes.slice(-120);
  const pivots = buildPivots(recentCloses).slice(-8);
  if (pivots.length < 5) {
    return {
      impulseScore: 38,
      earlyImpulseScore: 40,
      fractalCompressionScore: 35,
      waveCountEstimate: "파동 식별 부족",
      notes: ["의미 있는 스윙 피벗 수가 부족해 파동 구조를 약하게만 해석했습니다."],
      warnings: ["최근 파동 구조가 매끈하지 않아 엘리엇 판독 신뢰도가 낮음"],
    };
  }

  const notes: string[] = [];
  const warnings: string[] = [];
  const last6 = pivots.slice(-6);
  const startsWithLow = last6[0]?.type === "low";
  const alternating = last6.every((pivot, index) =>
    index === 0 ? true : pivot.type !== last6[index - 1]?.type
  );

  let impulseScore = 42;
  let earlyImpulseScore = 42;
  let waveCountEstimate = "혼조";

  if (last6.length === 6 && alternating && startsWithLow) {
    const [w0, w1, w2, w3, w4, w5] = last6;
    const highsAscending = w1.price < w3.price && w3.price < w5.price;
    const lowsAscending = w0.price < w2.price && w2.price < w4.price;
    const wave1 = w1.price - w0.price;
    const wave3 = w3.price - w2.price;
    const wave5 = w5.price - w4.price;
    const wave2Retrace = percentChange(w1.price, w2.price);
    const wave4Retrace = percentChange(w3.price, w4.price);

    if (highsAscending && lowsAscending) {
      impulseScore += 18;
      notes.push("고점과 저점이 차례로 높아져 상승 파동 골격이 유지됩니다.");
    }
    if (wave3 > Math.max(wave1 * 0.9, wave5 * 0.85)) {
      impulseScore += 16;
      notes.push("3파 구간이 충분히 확장돼 엘리엇 상승 추진 파동 성격이 보입니다.");
    }
    if (w4.price > w1.price * 0.98) {
      impulseScore += 12;
      notes.push("4파 조정이 1파 고점 위에서 버텨 충격파 훼손이 크지 않습니다.");
    } else {
      warnings.push("4파 눌림이 깊어 1파 중첩 위험이 있습니다.");
      impulseScore -= 10;
    }
    if (wave2Retrace >= -55 && wave4Retrace >= -38) {
      impulseScore += 8;
      notes.push("2파와 4파 조정 폭이 과도하지 않아 우상향 리듬이 자연스럽습니다.");
    }

    waveCountEstimate = impulseScore >= 74 ? "5파 진행형" : "상승 3~5파 혼합";
  }

  const last5 = pivots.slice(-5);
  if (last5.length === 5 && last5[0]?.type === "low" && alternating) {
    const [a0, a1, a2, a3, a4] = last5;
    if (a1.price > a0.price && a3.price > a1.price && a4.price > a2.price) {
      earlyImpulseScore += 24;
      notes.push("저점-고점이 단계적으로 높아져 초기 1-2-3파 확장 가능성이 있습니다.");
      waveCountEstimate = impulseScore > earlyImpulseScore ? waveCountEstimate : "초기 3파 확장";
    }
  }

  const returns20 = recentCloses.slice(-20);
  const returns60 = recentCloses.slice(-60);
  const range20 = Math.max(...returns20) - Math.min(...returns20);
  const range60 = Math.max(...returns60) - Math.min(...returns60);
  const pivotDistances = pivots
    .slice(-5)
    .map((pivot, index, array) =>
      index === 0 ? 0 : Math.abs(percentChange(array[index - 1]!.price, pivot.price))
    )
    .slice(1);
  const recentDistances = pivotDistances.slice(-3);
  const olderDistances = pivotDistances.slice(0, Math.max(1, pivotDistances.length - 3));
  const compressionRatio = average(recentDistances) / Math.max(average(olderDistances), 0.1);

  let fractalCompressionScore = 40;
  if (range20 <= range60 * 0.6) {
    fractalCompressionScore += 20;
    notes.push("최근 20봉 변동폭이 60봉 대비 줄어들어 프랙털 수렴 구조가 나타납니다.");
  }
  if (compressionRatio <= 0.85) {
    fractalCompressionScore += 18;
    notes.push("최근 파동 진폭이 이전보다 줄어 단기 프랙털 압축이 확인됩니다.");
  } else if (compressionRatio >= 1.2) {
    fractalCompressionScore -= 10;
    warnings.push("최근 파동 진폭이 다시 커져 수렴보다 확산 쪽에 가깝습니다.");
  }
  if (recentCloses.at(-1)! > average(recentCloses.slice(-20))) {
    fractalCompressionScore += 8;
  }

  if (impulseScore < 55 && earlyImpulseScore < 55) {
    warnings.push("완성도 높은 상승 파동보다 교정/혼조 구간일 가능성이 큽니다.");
  }

  return {
    impulseScore: clamp(Math.round(impulseScore), 0, 100),
    earlyImpulseScore: clamp(Math.round(earlyImpulseScore), 0, 100),
    fractalCompressionScore: clamp(Math.round(fractalCompressionScore), 0, 100),
    waveCountEstimate,
    notes,
    warnings,
  };
}

function buildInsight(candidate: CandidateInput, rows: OhlcvRow[] | null): ElliottFractalInsight | null {
  const diagnostics = scoreElliottFractalFromRows(rows);
  if (!diagnostics) {
    return null;
  }

  const score = Math.round(
    Math.max(diagnostics.impulseScore, diagnostics.earlyImpulseScore) * 0.6 +
    diagnostics.fractalCompressionScore * 0.4
  );

  let label: ElliottFractalInsight["label"] = "교정/혼조";
  let waveBias: ElliottFractalInsight["waveBias"] = "mixed";

  if (diagnostics.impulseScore >= 74) {
    label = "강한 상승 5파 진행";
    waveBias = "impulse";
  } else if (diagnostics.earlyImpulseScore >= 68) {
    label = "초기 3파 확장";
    waveBias = "early_impulse";
  } else if (diagnostics.fractalCompressionScore >= 68) {
    label = "수렴 후 확장 대기";
    waveBias = "compression";
  }

  return {
    ticker: candidate.ticker,
    companyName: candidate.companyName,
    score: clamp(score, 0, 100),
    label,
    waveBias,
    waveCountEstimate: diagnostics.waveCountEstimate,
    fractalCompressionScore: diagnostics.fractalCompressionScore,
    notes: diagnostics.notes,
    warnings: diagnostics.warnings,
  };
}

export async function collectElliottFractalInsights(
  candidates: CandidateInput[]
): Promise<ElliottFractalInsight[]> {
  const uniqueCandidates = Array.from(
    new Map(candidates.map(candidate => [candidate.ticker, candidate])).values()
  );
  if (!uniqueCandidates.length) {
    return [];
  }

  const rowsByTicker = await fetchKoreanOhlcvRowsBatch(
    uniqueCandidates.map(candidate => candidate.ticker),
    260
  );

  return uniqueCandidates
    .map(candidate => deriveElliottFractalInsightFromRows(candidate, rowsByTicker[candidate.ticker] ?? null))
    .filter((insight): insight is ElliottFractalInsight => Boolean(insight));
}
