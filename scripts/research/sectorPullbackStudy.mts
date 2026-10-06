// 연구용(2026-10-07): "섹터 상태(순환 유입·주도·소외)가 눌림목 진입의 성과를 바꾸는가" 사건 연구.
// 사용: npx tsx scripts/research/sectorPullbackStudy.mts <fetchWideMarket 결과.json>
// 질문: 같은 눌림목 신호라도 "RS가 개선되며 MA20 위로 올라선 섹터" 안의 것이 그 밖의 눌림목보다 나은가?
// 방법: 눌림목은 technicalSwingScreener.detectPullbackPattern 조건을 OHLCV로 그대로 재현(MA20≥MA60·종가>MA60·60일수익률≥8%·고점대비 -3~-14%·MA20 이격 -4~+8%·RSI14 40~65·거래량비≤1.6).
//   섹터 상태는 sectorRotation.computeSectorStrength/rankSectors(topN=5)로 신호일 기준(point-in-time 지수, 단 업종 구성은 오늘 스냅샷).
//   진입 신호 다음날 시가, N일째 종가 청산, 왕복 0.35%. 같은 날 전 종목 평균을 뺀 초과수익으로 비교. 판정은 "그 밖의 눌림목 대비".
// 한계: 손절·트레일 없는 고정 보유(실제 엔진은 R 기준), 현재 업종 구성(과거 이동 무시), 오늘 상장 유니버스(생존편향), 지수에 신호 종목 자신이 포함됨.
import fs from "node:fs";
import { buildSectorIndex, computeSectorStrength, rankSectors, buildTickerSectorMap } from "../../server/sectorRotation";

const D = JSON.parse(fs.readFileSync(process.argv[2], "utf8")) as { meta: Record<string, any>; rows: Record<string, any[]> };
const HALF = 0.35 / 100 / 2;
const HOLDS = [10, 15];
type Bar = { d: string; o: number; h: number; l: number; c: number; v: number };
const bars: Record<string, Bar[]> = {};
const ohlcv: Record<string, any[]> = {};
for (const [t, r] of Object.entries(D.rows)) {
  const b = r.map(x => ({ d: x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[5] })).filter(x => x.c > 0 && x.o > 0).sort((a, b) => a.d.localeCompare(b.d));
  if (b.length > 130) { bars[t] = b; ohlcv[t] = b.map(x => ({ 날짜: x.d, 시가: x.o, 고가: x.h, 저가: x.l, 종가: x.c, 거래량: x.v })); }
}
const tickers = Object.keys(bars).filter(t => (D.meta[t]?.capRank ?? 9999) <= 800);
console.log("종목", tickers.length);

// ── 섹터 지수·벤치마크 ──
// 네이버 업종 페이지가 2026-10 현재 새 구조로 바뀌어 fetchSectorDefinitions 스크레이퍼가 0건을 돌려준다(헌장 2026-10-07). 마지막 정상 수집본(2026-09-02)을 직접 읽는다.
const defs = JSON.parse(fs.readFileSync(".data/sectors/definitions.json", "utf8")).sectors as Array<{ name: string; tickers: string[] }>;
const sectorOf = buildTickerSectorMap(defs as any);
const bench = buildSectorIndex("시장", Object.keys(ohlcv), ohlcv as any)!;
const series = defs.map(s => buildSectorIndex(s.name, s.tickers.filter(t => ohlcv[t]), ohlcv as any)).filter((x): x is NonNullable<typeof x> => !!x);
console.log("업종", defs.length, "→ 지수 구성", series.length, "| 벤치 구성종목", bench.members);

const allDates = bench.dates.slice(130);
const state: Record<string, { leaders: Set<string>; laggards: Set<string>; rotIn: Set<string>; rotBroad: Set<string>; byName: Map<string, { rs20: number; delta: number; above: boolean }> }> = {};
for (const d of allDates) {
  const st = series.map(s => computeSectorStrength(s, bench, d)).filter((x): x is NonNullable<typeof x> => !!x);
  if (st.length < 20) continue;
  const rk = rankSectors(st, d, { topN: 5 });
  state[d] = {
    leaders: new Set(rk.leaders), laggards: new Set(rk.laggards), rotIn: new Set(rk.rotatingIn),
    rotBroad: new Set(st.filter(x => x.rotationDelta > 0 && x.aboveMa20).map(x => x.name)),
    byName: new Map(st.map(x => [x.name, { rs20: x.relativeStrength20, delta: x.rotationDelta, above: x.aboveMa20 }])),
  };
}
console.log("섹터 상태 계산일", Object.keys(state).length, Object.keys(state)[0], "~", Object.keys(state).at(-1));

// ── 눌림목 재현 ──
const sma = (b: Bar[], i: number, n: number) => { let s = 0; for (let k = i - n + 1; k <= i; k++) s += b[k].c; return s / n; };
function rsi14(b: Bar[], i: number) { let up = 0, dn = 0; for (let k = i - 13; k <= i; k++) { const d = b[k].c - b[k - 1].c; if (d > 0) up += d; else dn -= d; } return dn === 0 ? 100 : 100 - 100 / (1 + up / dn); }
function pullback(b: Bar[], i: number) {
  const c = b[i].c, ma20 = sma(b, i, 20), ma60 = sma(b, i, 60);
  if (!(ma20 >= ma60 && c > ma60)) return false;
  if ((c / b[i - 60].c - 1) * 100 < 8) return false;
  let hi = 0; for (let k = i - 24; k <= i; k++) hi = Math.max(hi, b[k].c);
  const depth = (c / hi - 1) * 100; if (depth > -3 || depth < -14) return false;
  const dist = (c / ma20 - 1) * 100; if (dist < -4 || dist > 8) return false;
  const r = rsi14(b, i); if (r < 40 || r > 65) return false;
  let v = 0; for (let k = i - 20; k < i; k++) v += b[k].v;
  return b[i].v / (v / 20) <= 1.6;
}
const turn20 = (b: Bar[], i: number) => { let s = 0; for (let k = i - 19; k <= i; k++) s += b[k].v * b[k].c; return s / 20; };
const fwd = (b: Bar[], i: number, N: number) => (i + 1 + N < b.length ? (b[i + 1 + N].c * (1 - HALF)) / (b[i + 1].o * (1 + HALF)) - 1 : null);

const base: Record<number, Map<string, { s: number; n: number }>> = {}; for (const N of HOLDS) base[N] = new Map();
for (const t of tickers) { const b = bars[t]; for (let i = 130; i < b.length - 2; i++) for (const N of HOLDS) { const r = fwd(b, i, N); if (r === null || Math.abs(r) > 1.5) continue; const e = base[N].get(b[i].d) ?? { s: 0, n: 0 }; e.s += r; e.n++; base[N].set(b[i].d, e); } }

type Sig = { t: string; i: number; d: string; sec: string; ex: Record<number, number | null> };
const sigs: Sig[] = [];
for (const t of tickers) {
  const b = bars[t]; let last = -999; const sec = sectorOf[t];
  for (let i = 130; i < b.length - 2; i++) {
    if (i - last < 15 || !state[b[i].d] || !sec) continue;
    if (turn20(b, i) < 3e9 || !pullback(b, i)) continue;
    const ex: Record<number, number | null> = {};
    for (const N of HOLDS) { const r = fwd(b, i, N); const e = base[N].get(b[i].d); ex[N] = r === null || !e || e.n < 50 ? null : r - e.s / e.n; }
    sigs.push({ t, i, d: b[i].d, sec, ex }); last = i;
  }
}
console.log("눌림목 신호(섹터 분류 가능)", sigs.length, "/", new Set(sigs.map(s => s.t)).size, "종목\n");
const cut = [...new Set(sigs.map(s => s.d))].sort()[Math.floor(new Set(sigs.map(s => s.d)).size * 0.6)];
const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
const se = (a: number[]) => Math.sqrt(mean(a.map(x => (x - mean(a)) ** 2)) / a.length);
const pc = (x: number) => (x * 100).toFixed(2) + "%";
const groups: [string, (s: Sig) => boolean][] = [
  ["순환유입 TOP5(RS개선+MA20위)", s => state[s.d].rotIn.has(s.sec)],
  ["순환유입(넓게: 개선+MA20위 전부)", s => state[s.d].rotBroad.has(s.sec)],
  ["주도섹터 TOP5(RS20)", s => state[s.d].leaders.has(s.sec)],
  ["소외섹터 하위5", s => state[s.d].laggards.has(s.sec)],
  ["섹터RS20 > 0", s => (state[s.d].byName.get(s.sec)?.rs20 ?? 0) > 0],
  ["섹터RS20 ≤ 0", s => (state[s.d].byName.get(s.sec)?.rs20 ?? 0) <= 0],
];
console.log(`분할일(OOS 시작) ${cut}`);
for (const N of HOLDS) {
  const all = sigs.filter(s => s.ex[N] !== null);
  console.log(`\n=== ${N}일 보유 | 전체 눌림목 n=${all.length} 초과 ${pc(mean(all.map(s => s.ex[N]!)))}±${pc(2 * se(all.map(s => s.ex[N]!)))} ===`);
  for (const [name, f] of groups) {
    const g = all.filter(f), rest = all.filter(s => !f(s));
    if (g.length < 30) { console.log(name.padEnd(30), "n=" + g.length, "(표본 부족)"); continue; }
    const gx = g.map(s => s.ex[N]!), rx = rest.map(s => s.ex[N]!);
    const diff = mean(gx) - mean(rx), dse = Math.sqrt(se(gx) ** 2 + se(rx) ** 2);
    const part = (f2: (s: Sig) => boolean) => { const a = g.filter(f2).map(s => s.ex[N]!), b2 = rest.filter(f2).map(s => s.ex[N]!); return a.length >= 10 && b2.length >= 10 ? `${pc(mean(a) - mean(b2))}(${a.length})` : "-"; };
    console.log(`${name.padEnd(30)} n=${String(g.length).padStart(4)} 초과 ${pc(mean(gx)).padStart(7)} | 그 밖 대비 ${pc(diff).padStart(7)} ±${pc(2 * dse)} | IS ${part(s => s.d < cut)} OOS ${part(s => s.d >= cut)} | 2025 ${part(s => s.d.startsWith("2025"))} 2026 ${part(s => s.d.startsWith("2026"))}`);
  }
}

// ── 강건성: 군집(같은 섹터·같은 달 신호는 서로 닮는다) ──
{
  const N = 15;
  const all = sigs.filter(s => s.ex[N] !== null);
  const inG = (s: Sig) => state[s.d].rotIn.has(s.sec);
  const g = all.filter(inG), rest = all.filter(s => !inG(s));
  const key = (s: Sig) => s.sec + "|" + s.d.slice(0, 7);
  const clusterSE = (a: Sig[]) => { const m = new Map<string, number[]>(); a.forEach(s => (m.get(key(s)) ?? m.set(key(s), []).get(key(s))!).push(s.ex[N]!)); const mu = mean(a.map(s => s.ex[N]!)); let ss = 0; for (const v of m.values()) { const d = v.reduce((x, y) => x + (y - mu), 0); ss += d * d; } return Math.sqrt(ss) / a.length; };
  const gx = g.map(s => s.ex[N]!), rx = rest.map(s => s.ex[N]!);
  const clusters = new Set(g.map(key)).size;
  console.log(`\n[강건성·15일·순환유입 TOP5] n=${g.length} 군집(섹터·월)=${clusters} | 그 밖 대비 ${pc(mean(gx) - mean(rx))} 군집보정 ±2SE ${pc(2 * Math.sqrt(clusterSE(g) ** 2 + clusterSE(rest) ** 2))}`);
  const bySec = new Map<string, number[]>(); g.forEach(s => (bySec.get(s.sec) ?? bySec.set(s.sec, []).get(s.sec)!).push(s.ex[N]!));
  const top = [...bySec.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 8);
  console.log("섹터별 건수·평균초과(상위8):", top.map(([k, v]) => `${k} ${v.length}건 ${pc(mean(v))}`).join(" | "));
  const tot = [...bySec.entries()].map(([k, v]) => [k, v.reduce((x, y) => x + y, 0)] as [string, number]).sort((a, b) => b[1] - a[1]);
  const drop = new Set(tot.slice(0, 3).map(x => x[0]));
  const g2 = g.filter(s => !drop.has(s.sec)).map(s => s.ex[N]!);
  console.log(`기여 상위 3섹터(${[...drop].join(", ")}) 제외: n=${g2.length} 초과 ${pc(mean(g2))} (그 밖 대비 ${pc(mean(g2) - mean(rx))})`);
  const byM = new Map<string, number[]>(); g.forEach(s => (byM.get(s.d.slice(0, 7)) ?? byM.set(s.d.slice(0, 7), []).get(s.d.slice(0, 7))!).push(s.ex[N]!));
  const months = [...byM.entries()].sort(); const pos = months.filter(([, v]) => mean(v) > 0).length;
  console.log(`월별: ${months.length}개월 중 평균초과 양수 ${pos}개월 |`, months.map(([m, v]) => `${m.slice(2)}:${(mean(v) * 100).toFixed(0)}(${v.length})`).join(" "));
  const sh = [...gx].sort((a, b) => b - a); console.log(`상위 5% 건 제외 평균 ${pc(mean(sh.slice(Math.floor(sh.length * 0.05))))} / 중앙값 ${pc(sh[Math.floor(sh.length / 2)])} / 승률(초과>0) ${(gx.filter(x => x > 0).length / gx.length * 100).toFixed(0)}%`);
}
{
  const N = 15; const all = sigs.filter(s => s.ex[N] !== null);
  const rx = all.filter(s => !state[s.d].rotIn.has(s.sec)).map(s => s.ex[N]!).sort((a, b) => b - a);
  console.log(`[대조] 그 밖 눌림목 n=${rx.length}: 상위5% 제외 평균 ${pc(mean(rx.slice(Math.floor(rx.length * 0.05))))} / 중앙값 ${pc(rx[Math.floor(rx.length / 2)])} / 승률 ${(rx.filter(x => x > 0).length / rx.length * 100).toFixed(0)}%`);
}
