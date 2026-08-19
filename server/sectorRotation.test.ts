import { describe, expect, it } from "vitest";

import type { OhlcvRow } from "./koreaStockMcp";
import {
  buildSectorIndex,
  buildTickerSectorMap,
  computeSectorStrength,
  diversifyBySector,
  indexAtOrBefore,
  parseSectorList,
  parseSectorMembers,
  rankSectors,
  summarizeSectorConcentration,
  type SectorSeries,
} from "./sectorRotation";

/** Real calendar dates so string ordering matches chronological ordering. */
function isoDay(offset: number): string {
  const date = new Date(Date.UTC(2026, 0, 1));
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function series(name: string, closes: number[]): SectorSeries {
  return {
    name,
    dates: closes.map((_, i) => isoDay(i)),
    closes,
    members: 5,
  };
}

function bars(closes: number[]): OhlcvRow[] {
  return closes.map((close, i) => ({
    날짜: `2026-01-${String(i + 1).padStart(2, "0")}`,
    시가: close,
    고가: close,
    저가: close,
    종가: close,
    거래량: 1000,
  }));
}

describe("parseSectorList", () => {
  it("extracts sector number, name, and change from table rows", () => {
    const html = `
      <tr><td><a href="/sise/sise_group_detail.naver?type=upjong&no=278">반도체</a></td><td>+2.50%</td></tr>
      <tr><td><a href="/sise/sise_group_detail.naver?type=upjong&no=279">화장품</a></td><td>-1.20%</td></tr>
    `;
    const rows = parseSectorList(html);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ no: "278", name: "반도체", changePct: 2.5 });
    expect(rows[1].changePct).toBe(-1.2);
  });

  it("de-duplicates a sector repeated across rows", () => {
    const html = `
      <tr><td><a href="/sise/sise_group_detail.naver?type=upjong&no=278">반도체</a></td><td>+1.00%</td></tr>
      <tr><td><a href="/sise/sise_group_detail.naver?type=upjong&no=278">반도체</a></td><td>+1.00%</td></tr>
    `;
    expect(parseSectorList(html)).toHaveLength(1);
  });
});

describe("parseSectorMembers", () => {
  it("collects member tickers and drops ETFs", () => {
    const html = `
      <a href="/item/main.naver?code=005930">삼성전자</a>
      <a href="/item/main.naver?code=000660">SK하이닉스</a>
      <a href="/item/main.naver?code=069500">KODEX 200</a>
      <a href="/item/main.naver?code=005930">삼성전자</a>
    `;
    expect(parseSectorMembers(html)).toEqual(["005930", "000660"]);
  });
});

describe("buildSectorIndex", () => {
  it("averages members as an equal-weight index starting at 1.0", () => {
    const index = buildSectorIndex(
      "테스트",
      ["A", "B"],
      { A: bars([100, 110, 120]), B: bars([50, 55, 60]) },
      { minMembers: 2 }
    );
    // Both members double-step by the same ratio, so the index tracks the ratio.
    expect(index).not.toBeNull();
    expect(index!.closes[0]).toBeCloseTo(1, 5);
    expect(index!.closes[1]).toBeCloseTo(1.1, 5);
    expect(index!.closes[2]).toBeCloseTo(1.2, 5);
    expect(index!.members).toBe(2);
  });

  it("drops members whose history is too short to avoid a fake step", () => {
    const index = buildSectorIndex(
      "테스트",
      ["A", "B", "SHORT"],
      {
        A: bars([100, 110, 120, 130, 140, 150, 160, 170, 180, 190]),
        B: bars([100, 110, 120, 130, 140, 150, 160, 170, 180, 190]),
        SHORT: bars([100, 200]),
      },
      { minMembers: 2 }
    );
    expect(index!.members).toBe(2);
  });

  it("returns null when too few members have usable data", () => {
    expect(
      buildSectorIndex("테스트", ["A"], { A: bars([100, 110]) }, { minMembers: 3 })
    ).toBeNull();
  });
});

describe("indexAtOrBefore", () => {
  it("finds the last bar at or before the date (no look-ahead)", () => {
    const dates = ["2026-01-01", "2026-01-03", "2026-01-06"];
    expect(indexAtOrBefore(dates, "2026-01-05")).toBe(1);
    expect(indexAtOrBefore(dates, "2026-01-06")).toBe(2);
    expect(indexAtOrBefore(dates, "2025-12-31")).toBe(-1);
  });
});

describe("computeSectorStrength", () => {
  it("scores a sector outperforming a flat benchmark as positive RS", () => {
    const closes = [...Array(80).fill(1)];
    for (let i = 0; i < 20; i += 1) closes.push(1 + (i + 1) * 0.01);
    const sector = series("강한섹터", closes);
    const benchmark = series("벤치마크", Array(100).fill(1));

    const strength = computeSectorStrength(sector, benchmark, sector.dates.at(-1)!);
    expect(strength).not.toBeNull();
    expect(strength!.relativeStrength20).toBeGreaterThan(0);
    expect(strength!.aboveMa20).toBe(true);
  });

  it("returns null before there is enough history", () => {
    const short = series("짧은섹터", Array(30).fill(1));
    expect(computeSectorStrength(short, short, short.dates.at(-1)!)).toBeNull();
  });
});

describe("rankSectors", () => {
  const base = {
    members: 10,
    return5d: 0,
    return20d: 0,
    return60d: 0,
    relativeStrength60: 0,
    aboveMa20: true,
  };

  it("ranks by relative strength and separates rotation direction", () => {
    const ranking = rankSectors(
      [
        { ...base, name: "선두", relativeStrength20: 8, rotationDelta: 5 },
        { ...base, name: "중간", relativeStrength20: 1, rotationDelta: 0 },
        { ...base, name: "후미", relativeStrength20: -6, rotationDelta: -4 },
      ],
      "2026-01-10",
      { topN: 1 }
    );
    expect(ranking.ranked[0].name).toBe("선두");
    expect(ranking.leaders).toEqual(["선두"]);
    expect(ranking.laggards).toEqual(["후미"]);
    expect(ranking.rotatingIn).toEqual(["선두"]);
    expect(ranking.rotatingOut).toEqual(["후미"]);
  });

  it("excludes an improving-but-still-broken sector from rotatingIn", () => {
    // RS improving, but the sector is below its own MA20 — falling slower than
    // the market is not the same as turning up.
    const ranking = rankSectors(
      [{ ...base, name: "덜빠짐", relativeStrength20: -2, rotationDelta: 3, aboveMa20: false }],
      "2026-01-10"
    );
    expect(ranking.rotatingIn).toEqual([]);
  });
});

describe("buildTickerSectorMap", () => {
  it("maps every member ticker to its sector name", () => {
    const map = buildTickerSectorMap([
      { no: "1", name: "반도체", changePct: null, tickers: ["005930", "000660"] },
      { no: "2", name: "화장품", changePct: null, tickers: ["090430"] },
    ]);
    expect(map["005930"]).toBe("반도체");
    expect(map["090430"]).toBe("화장품");
  });
});

describe("summarizeSectorConcentration", () => {
  it("counts tickers per sector, worst (most concentrated) first", () => {
    const map = { A: "제약", B: "제약", C: "은행", D: "제약" };
    const result = summarizeSectorConcentration(["A", "B", "C", "D"], map);
    expect(result[0]).toEqual({ sector: "제약", count: 3 });
    expect(result[1]).toEqual({ sector: "은행", count: 1 });
  });

  it("ignores tickers with no known sector", () => {
    expect(summarizeSectorConcentration(["X"], {})).toEqual([]);
  });
});

describe("diversifyBySector", () => {
  const item = (ticker: string, score: number) => ({ ticker, swingScore: score });

  it("keeps the highest scorer of an over-represented sector, demotes the rest", () => {
    const map = { A: "제약", B: "제약", C: "제약", D: "은행" };
    const ranked = [item("A", 90), item("B", 85), item("C", 80), item("D", 70)];

    const { kept, overflow } = diversifyBySector(ranked, map, 1);

    expect(kept.map(i => i.ticker)).toEqual(["A", "D"]);
    expect(overflow.map(i => i.ticker)).toEqual(["B", "C"]);
  });

  it("never demotes a stronger candidate in favour of a weaker one", () => {
    // Best-first input: A is the strongest name in 제약 and must survive
    // regardless of how many weaker 제약 names precede it in some other order.
    const map = { A: "제약", B: "은행", C: "제약" };
    const ranked = [item("A", 95), item("B", 80), item("C", 60)];
    const { kept } = diversifyBySector(ranked, map, 1);
    expect(kept.map(i => i.ticker)).toContain("A");
  });

  it("fails open on an unmapped ticker instead of blocking it", () => {
    const ranked = [item("UNKNOWN", 99)];
    const { kept, overflow } = diversifyBySector(ranked, {}, 1);
    expect(kept.map(i => i.ticker)).toEqual(["UNKNOWN"]);
    expect(overflow).toEqual([]);
  });

  it("is a no-op when maxPerSector is 0 or negative (feature off)", () => {
    const map = { A: "제약", B: "제약" };
    const ranked = [item("A", 90), item("B", 85)];
    expect(diversifyBySector(ranked, map, 0).kept).toEqual(ranked);
  });

  it("respects a higher cap", () => {
    const map = { A: "제약", B: "제약", C: "제약" };
    const ranked = [item("A", 90), item("B", 85), item("C", 80)];
    const { kept, overflow } = diversifyBySector(ranked, map, 2);
    expect(kept.map(i => i.ticker)).toEqual(["A", "B"]);
    expect(overflow.map(i => i.ticker)).toEqual(["C"]);
  });
});
