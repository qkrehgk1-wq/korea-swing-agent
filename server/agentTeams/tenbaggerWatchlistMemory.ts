import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TenbaggerCandidate } from "../tenbaggerPipeline";
import type { TenbaggerAgentReview, TenbaggerAgentTeamReport } from "./tenbaggerOrchestrator";

export type TenbaggerWatchlistMemoryEntry = {
  ticker: string;
  companyName: string;
  status: "승인" | "보류";
  riskGrade: "A" | "B" | "C" | "D";
  recommendedCapitalPct: number;
  updatedAt: string;
  score: number;
  frameworkScore: number;
  currentPrice: number;
  return120d: number;
  return240d: number;
  volumeRatio: number;
  maxDrawdown: number;
  revenueYoY?: number;
  operatingProfitYoY?: number;
  marketCap?: number;
  tradingValue?: number;
  marketCategory?: string;
  lastReasons: string[];
  lastBlockers: string[];
  recheckTriggers: string[];
};

type TenbaggerWatchlistMemoryStore = {
  updatedAt: string;
  entries: TenbaggerWatchlistMemoryEntry[];
};

export type TenbaggerWatchlistMemoryChange = {
  ticker: string;
  companyName: string;
  summary: string;
};

export type TenbaggerWatchlistMemoryPersistResult = {
  updatedAt: string;
  entries: TenbaggerWatchlistMemoryEntry[];
  changes: TenbaggerWatchlistMemoryChange[];
};

const MEMORY_PATH = path.join(process.cwd(), ".data", "tenbagger-watchlist-memory.json");

function unique(items: string[]) {
  return Array.from(new Set(items.filter(Boolean)));
}

function deriveRecheckTriggers(
  candidate: TenbaggerCandidate,
  review: TenbaggerAgentReview
) {
  const triggers: string[] = [];

  if (candidate.revenueYoY === undefined) {
    triggers.push("다음 런에서 매출 YoY 데이터 재확인");
  } else if (candidate.revenueYoY < 10) {
    triggers.push("매출 YoY가 10% 이상으로 회복되는지 확인");
  }

  if (candidate.operatingProfitYoY === undefined) {
    triggers.push("다음 런에서 영업이익 YoY 데이터 재확인");
  } else if (candidate.operatingProfitYoY < 10) {
    triggers.push("영업이익 YoY가 10% 이상으로 회복되는지 확인");
  }

  if (candidate.volumeRatio < 0.95) {
    triggers.push("거래량이 20일 평균 대비 0.95배 이상으로 회복되는지 확인");
  }

  if (review.blockers.some(blocker => blocker.includes("뉴스") || blocker.includes("리스크가 촉매보다 우세"))) {
    triggers.push("뉴스 리스크 점수가 촉매 점수와 균형을 되찾는지 확인");
  }

  if (review.blockers.some(blocker => blocker.includes("KRX 구조 데이터"))) {
    triggers.push("체급·유동성·상장 이력 보강 데이터가 확보되는지 확인");
  }

  if (review.validation === "승인") {
    triggers.push("20일선 이탈 없이 추세와 거래대금이 유지되는지 확인");
  }

  if (triggers.length === 0) {
    triggers.push("다음 런에서 추세, 뉴스, 재무 3축이 그대로 유지되는지 확인");
  }

  return unique(triggers);
}

async function loadMemoryStore(): Promise<TenbaggerWatchlistMemoryStore> {
  try {
    const raw = await readFile(MEMORY_PATH, "utf8");
    return JSON.parse(raw) as TenbaggerWatchlistMemoryStore;
  } catch {
    return {
      updatedAt: new Date().toISOString(),
      entries: [],
    };
  }
}

async function saveMemoryStore(store: TenbaggerWatchlistMemoryStore) {
  await mkdir(path.dirname(MEMORY_PATH), { recursive: true });
  await writeFile(MEMORY_PATH, JSON.stringify(store, null, 2), "utf8");
}

function diffTriggers(previous: string[], current: string[]) {
  const previousSet = new Set(previous);
  const currentSet = new Set(current);
  return {
    added: current.filter(item => !previousSet.has(item)),
    removed: previous.filter(item => !currentSet.has(item)),
  };
}

export async function persistTenbaggerWatchlistMemory(
  candidates: TenbaggerCandidate[],
  teamReport: TenbaggerAgentTeamReport
): Promise<TenbaggerWatchlistMemoryPersistResult> {
  const reviews = [...teamReport.approved, ...teamReport.rejected];
  const reviewByTicker = new Map(reviews.map(review => [review.ticker, review]));
  const store = await loadMemoryStore();
  const previousByTicker = new Map(store.entries.map(entry => [entry.ticker, entry]));
  const nextEntries = [...store.entries];
  const changes: TenbaggerWatchlistMemoryChange[] = [];

  for (const candidate of candidates) {
    const review = reviewByTicker.get(candidate.ticker);
    if (!review) {
      continue;
    }

    const entry: TenbaggerWatchlistMemoryEntry = {
      ticker: candidate.ticker,
      companyName: candidate.companyName,
      status: review.validation,
      riskGrade: review.riskGrade,
      recommendedCapitalPct: review.recommendedCapitalPct,
      updatedAt: new Date().toISOString(),
      score: candidate.score,
      frameworkScore: candidate.frameworkScore,
      currentPrice: candidate.currentPrice,
      return120d: candidate.return120d,
      return240d: candidate.return240d,
      volumeRatio: candidate.volumeRatio,
      maxDrawdown: candidate.maxDrawdown,
      revenueYoY: candidate.revenueYoY,
      operatingProfitYoY: candidate.operatingProfitYoY,
      marketCap: candidate.marketCap,
      tradingValue: candidate.tradingValue,
      marketCategory: candidate.marketCategory,
      lastReasons: review.reasons,
      lastBlockers: review.blockers,
      recheckTriggers: deriveRecheckTriggers(candidate, review),
    };
    const previous = previousByTicker.get(candidate.ticker);

    if (!previous) {
      changes.push({
        ticker: candidate.ticker,
        companyName: candidate.companyName,
        summary: `신규 추적 시작 / 상태 ${entry.status} / 재평가 조건 ${entry.recheckTriggers.join(" | ")}`,
      });
    } else {
      const deltaMessages: string[] = [];
      if (previous.status !== entry.status) {
        deltaMessages.push(`상태 ${previous.status} -> ${entry.status}`);
      }
      if (previous.riskGrade !== entry.riskGrade) {
        deltaMessages.push(`리스크 등급 ${previous.riskGrade} -> ${entry.riskGrade}`);
      }
      if (previous.recommendedCapitalPct !== entry.recommendedCapitalPct) {
        deltaMessages.push(`권장상한 ${previous.recommendedCapitalPct}% -> ${entry.recommendedCapitalPct}%`);
      }
      const triggerDiff = diffTriggers(previous.recheckTriggers, entry.recheckTriggers);
      if (triggerDiff.added.length) {
        deltaMessages.push(`추가 조건 ${triggerDiff.added.join(" | ")}`);
      }
      if (triggerDiff.removed.length) {
        deltaMessages.push(`해소 조건 ${triggerDiff.removed.join(" | ")}`);
      }
      if (deltaMessages.length) {
        changes.push({
          ticker: candidate.ticker,
          companyName: candidate.companyName,
          summary: deltaMessages.join(" / "),
        });
      }
    }

    const existingIndex = nextEntries.findIndex(item => item.ticker === candidate.ticker);
    if (existingIndex >= 0) {
      nextEntries[existingIndex] = entry;
    } else {
      nextEntries.push(entry);
    }
  }

  nextEntries.sort((a, b) => {
    if (a.status !== b.status) {
      return a.status === "승인" ? -1 : 1;
    }
    return b.score - a.score;
  });

  const nextStore: TenbaggerWatchlistMemoryStore = {
    updatedAt: new Date().toISOString(),
    entries: nextEntries,
  };
  await saveMemoryStore(nextStore);
  return {
    updatedAt: nextStore.updatedAt,
    entries: nextStore.entries,
    changes,
  };
}
