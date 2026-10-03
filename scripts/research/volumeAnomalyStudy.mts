// 연구용(2026-10-03): 이상 거래량 → 가격 미반응 → 거래량 고갈 → 재점화 가설의 사건 연구(PROJECT_CHARTER 2026-10-03 기각 기록).
// 사용: npx tsx scripts/research/volumeAnomalyStudy.mts <fetchWideMarket 결과.json>
// 기준선: 같은 시총 구간(현재 순위 ≤200 / 그 밖)·같은 진입일의 무조건 평균. 진입은 신호 다음날 시가, 왕복비용 0.35%.
// 한계: 현재 시총 순위로 구간을 나눠 승자 편향이 있고, 거래대금은 거래량×종가 근사이며, 공시·블록딜 구분은 못 한다.
import fs from "node:fs";
const D = JSON.parse(fs.readFileSync(process.argv[2], "utf8")) as { meta: Record<string, any>; rows: Record<string, any[]> };
const COST = 0.35 / 100, HALF = COST / 2;
const HOLDS = [10, 20, 30];
type Bar = { d: string; o: number; h: number; l: number; c: number; v: number };
const bars: Record<string, Bar[]> = {};
for (const [t, r] of Object.entries(D.rows)) {
  const b = r.map(x => ({ d: x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[5] })).filter(x => x.c > 0 && x.o > 0).sort((a, b) => a.d.localeCompare(b.d));
  if (b.length > 80) bars[t] = b;
}
const tickers = Object.keys(bars);
console.log("종목", tickers.length, "| 기간", bars[tickers[0]][0].d, "~", bars[tickers[0]].at(-1)!.d);

// ── 날짜별 무조건 기준선(같은 날 진입·같은 보유, 비용 동일) ──
const strat = (t: string) => ((D.meta[t]?.capRank ?? 9999) <= 200 ? "T" : "R");
const base: Record<number, Map<string, { s: number; n: number }>> = {};
for (const N of HOLDS) base[N] = new Map();
const fwd = (b: Bar[], i: number, N: number) => (i + N < b.length && i + 1 < b.length ? (b[i + N].c * (1 - HALF)) / (b[i + 1].o * (1 + HALF)) - 1 : null);
for (const t of tickers) { const b = bars[t]; for (let i = 20; i < b.length - 1; i++) for (const N of HOLDS) { const r = fwd(b, i, N); if (r === null || Math.abs(r) > 1.5) continue; const m = base[N]; const key = strat(t) + b[i].d; const e = m.get(key) ?? { s: 0, n: 0 }; e.s += r; e.n++; m.set(key, e); } }
const baseAvg = (N: number, d: string, t: string) => { const e = base[N].get(strat(t) + d); return e && e.n > 20 ? e.s / e.n : null; };

// ── 이상 거래량 사건 ──
type Ev = { t: string; s: number; ref: number; ratio: number; turn: number; intraday: number; closeChg: number; cap: number };
const events: Ev[] = [];
const spikeByDate = new Map<string, number>(); const totByDate = new Map<string, number>();
for (const t of tickers) {
  const b = bars[t]; let lastS = -99; let sum = 0;
  for (let i = 0; i < 20; i++) sum += b[i].v;
  for (let s = 20; s < b.length; s++) {
    const avg = sum / 20;
    totByDate.set(b[s].d, (totByDate.get(b[s].d) ?? 0) + 1);
    const ratio = avg > 0 ? b[s].v / avg : 0;
    if (ratio >= 3) spikeByDate.set(b[s].d, (spikeByDate.get(b[s].d) ?? 0) + 1);
    const turn = b[s].v * b[s].c;
    if (ratio >= 3 && turn >= 10e9 && s - lastS > 30 && s >= 1) {
      const ref = b[s - 1].c;
      events.push({ t, s, ref, ratio, turn, intraday: (b[s].h - ref) / ref, closeChg: (b[s].c - ref) / ref, cap: D.meta[t]?.capRank ?? 9999 });
      lastS = s;
    }
    sum += b[s].v - b[s - 20].v;
  }
}
console.log("1·3차(3배↑·거래대금 100억↑) 사건:", events.length, "건 /", new Set(events.map(e => e.t)).size, "종목");

// 전 종목 동시 폭증일(기계적 거래 의심) — 그날 폭증 종목 비율
const shares = [...spikeByDate.entries()].map(([d, n]) => ({ d, share: n / (totByDate.get(d) ?? 1) }));
const sorted = shares.map(x => x.share).sort((a, b) => a - b);
const q = (p: number) => sorted[Math.floor(sorted.length * p)] ?? 0;
const mech = new Set(shares.filter(x => x.share >= Math.max(q(0.95), 0.04)).map(x => x.d));
console.log(`일별 폭증 비율 중앙 ${(q(0.5) * 100).toFixed(1)}% · 95% ${(q(0.95) * 100).toFixed(1)}% · 최대 ${(sorted.at(-1)! * 100).toFixed(1)}% → 동시폭증일 ${mech.size}일 제외 기준`);
const topMech = shares.sort((a, b) => b.share - a.share).slice(0, 5).map(x => `${x.d}(${(x.share * 100).toFixed(0)}%)`).join(", ");
console.log("동시폭증 상위일:", topMech);

// ── 단계별 필터 (모두 사건 후 s+5 시점 평가 = 같은 타이밍) ──
type Sig = { t: string; i: number; ev: Ev; tag: string };
function stats(label: string, sigs: Sig[]) {
  const row: string[] = [label.padEnd(34), String(sigs.length).padStart(4) + "건", String(new Set(sigs.map(x => x.t)).size).padStart(4) + "종목"];
  for (const N of HOLDS) {
    const rs: number[] = [], ex: number[] = [];
    for (const g of sigs) { const b = bars[g.t]; const r = fwd(b, g.i, N); if (r === null) continue; const ba = baseAvg(N, b[g.i].d, g.t); rs.push(r); if (ba !== null) ex.push(r - ba); }
    if (rs.length < 5) { row.push(`${N}d n=${rs.length}`); continue; }
    const mean = rs.reduce((a, b) => a + b, 0) / rs.length; const med = [...rs].sort((a, b) => a - b)[Math.floor(rs.length / 2)];
    const exm = ex.length ? ex.reduce((a, b) => a + b, 0) / ex.length : NaN;
    const se = [...ex].sort((a, b) => a - b); const k = Math.floor(se.length * 0.05); const tr = se.slice(k, se.length - k); const trm = tr.length ? tr.reduce((a, b) => a + b, 0) / tr.length : NaN;
    const win = rs.filter(x => x > 0).length / rs.length;
    row.push(`${N}d n=${rs.length} 평균${(mean * 100).toFixed(1)}% 중앙${(med * 100).toFixed(1)}% 승${(win * 100).toFixed(0)}% 초과${(exm * 100).toFixed(1)}% 절사${(trm * 100).toFixed(1)}%`);
  }
  console.log(row.join(" | "));
}
function evalAt(ev: Ev, off: number) { const b = bars[ev.t]; const i = ev.s + off; if (i >= b.length - 1) return null; return i; }
function cond(ev: Ev, i: number) {
  const b = bars[ev.t]; const px = b[i].c / ev.ref - 1;
  let mn = Infinity; for (let k = ev.s; k <= i; k++) mn = Math.min(mn, b[k].l);
  let v5 = 0; for (let k = i - 4; k <= i; k++) v5 += b[k].v; v5 /= 5;
  return { priceFlat: Math.abs(px) <= 0.03, support: mn >= ev.ref * 0.95, dry: v5 / b[ev.s].v <= 0.10, px };
}
const mk = (evs: Ev[], f: (c: ReturnType<typeof cond>, ev: Ev) => boolean): Sig[] => { const o: Sig[] = []; for (const ev of evs) { const i = evalAt(ev, 5); if (i === null) continue; if (f(cond(ev, i), ev)) o.push({ t: ev.t, i, ev, tag: "" }); } return o; };
const universes: [string, Ev[]][] = [["전체", events], ["동시폭증일 제외", events.filter(e => !mech.has(bars[e.t][e.s].d))], ["시총상위200(현 스크리너)", events.filter(e => e.cap <= 200)], ["시총200위 밖", events.filter(e => e.cap > 200)]];
for (const [uname, evs] of universes) {
  console.log(`\n=== 사건 유니버스: ${uname} (${evs.length}건) ===`);
  stats("S0 3배↑ + 100억↑ (s+5일 진입)", mk(evs, () => true));
  stats("S1 + 종가 ±3% 이내", mk(evs, c => c.priceFlat));
  stats("S2 + 이후 저가 -5% 안 깨짐", mk(evs, c => c.priceFlat && c.support));
  stats("S3 + 거래량 고갈(≤10%) = A", mk(evs, c => c.priceFlat && c.support && c.dry));
  stats("(대조) 가격 반응 O: 종가 +10%↑", mk(evs, c => c.px >= 0.10));
  stats("(대조) 가격 붕괴: 저가 -5% 이탈", mk(evs, c => !c.support));
}
// 장중 윗꼬리 태그
console.log("\n=== 5차 태그(장중 +5%↑ · 종가 +3%↓)가 A 안에서 추가 효과가 있나 (전체) ===");
const A = mk(events, c => c.priceFlat && c.support && c.dry);
stats("A + 윗꼬리태그", A.filter(g => g.ev.intraday >= 0.05 && g.ev.closeChg < 0.03));
stats("A − 윗꼬리태그 없음", A.filter(g => !(g.ev.intraday >= 0.05 && g.ev.closeChg < 0.03)));

// ── 재점화(두 번째 거래량): s+1..s+30 중 지지 유지 상태에서 거래량 2배↑ + 기준가 +6% 돌파 ──
console.log("\n=== 재점화 신호 (첫 이상거래 → 지지 → 2차 거래량 + 기준가 +6% 돌파) ===");
function secondSignals(evs: Ev[], needDry: boolean): Sig[] {
  const out: Sig[] = [];
  for (const ev of evs) {
    const b = bars[ev.t]; let mn = Infinity; let hadDry = false;
    for (let u = ev.s + 1; u <= Math.min(ev.s + 30, b.length - 2); u++) {
      mn = Math.min(mn, b[u - 1].l, b[ev.s].l);
      if (u >= ev.s + 5) { let v5 = 0; for (let k = u - 5; k < u; k++) v5 += b[k].v; if (v5 / 5 / b[ev.s].v <= 0.10) hadDry = true; }
      if (mn < ev.ref * 0.95) break;
      let a = 0; for (let k = u - 20; k < u; k++) a += b[k].v; a /= 20;
      if (u >= ev.s + 3 && a > 0 && b[u].v / a >= 2 && b[u].c >= ev.ref * 1.06 && (!needDry || hadDry)) { out.push({ t: ev.t, i: u, ev, tag: "" }); break; }
    }
  }
  return out;
}
for (const [uname, evs] of universes) {
  console.log(`-- ${uname}`);
  stats("재점화(고갈 불문)", secondSignals(evs, false));
  stats("재점화(고갈 선행 필수)", secondSignals(evs, true));
}
// 시간 분할(최근 40% = OOS) — 재점화(고갈 선행), 전체
const secAll = secondSignals(events, true);
const dates = secAll.map(g => bars[g.t][g.i].d).sort(); const cut = dates[Math.floor(dates.length * 0.6)];
console.log(`\n-- 시간분할 (재점화·고갈선행, 분할일 ${cut})`);
stats("과거 60%", secAll.filter(g => bars[g.t][g.i].d < cut));
stats("최근 40% (OOS)", secAll.filter(g => bars[g.t][g.i].d >= cut));
// 무조건 대조: 같은 종목 수·같은 기간의 평균 = 초과수익 열이 이미 반영

// ── 보강 점검: 상위200 재점화(고갈선행)의 쏠림, 그리고 지휘관 사례 종목 ──
{
  const top = secondSignals(events.filter(e => e.cap <= 200), true);
  const rows = top.map(g => { const b = bars[g.t]; const r = fwd(b, g.i, 30); const ba = baseAvg(30, b[g.i].d, g.t); return r === null || ba === null ? null : { t: g.t, ex: r - ba, r }; }).filter(Boolean) as { t: string; ex: number; r: number }[];
  rows.sort((a, b) => b.ex - a.ex);
  const tot = rows.reduce((s, x) => s + x.ex, 0);
  const top5 = rows.slice(0, 5);
  console.log(`\n[쏠림] 상위200 재점화(고갈선행) 30일 n=${rows.length}: 초과수익 합 ${(tot * 100).toFixed(0)}%p 중 상위 5건이 ${(top5.reduce((s, x) => s + x.ex, 0) * 100).toFixed(0)}%p (${((top5.reduce((s, x) => s + x.ex, 0) / tot) * 100).toFixed(0)}%)`);
  console.log("상위 5건:", top5.map(x => `${D.meta[x.t]?.name}(${x.t}) +${(x.r * 100).toFixed(0)}%`).join(", "));
  const without = rows.slice(5); console.log("상위 5건 제외 평균 초과:", ((without.reduce((s, x) => s + x.ex, 0) / without.length) * 100).toFixed(1) + "%", "n=" + without.length);
  const byYear: Record<string, number[]> = {}; for (const g of top) { const y = bars[g.t][g.i].d.slice(0, 4); const r = fwd(bars[g.t], g.i, 30); const ba = baseAvg(30, bars[g.t][g.i].d, g.t); if (r !== null && ba !== null) (byYear[y] ||= []).push(r - ba); }
  console.log("연도별 30일 초과:", Object.entries(byYear).map(([y, a]) => `${y}: n=${a.length} ${((a.reduce((s, x) => s + x, 0) / a.length) * 100).toFixed(1)}%`).join(" | "));
  // 지휘관 사례 (이름 일치)
  for (const nm of ["경동제약", "풍국주정", "넷마블"]) {
    const t = Object.keys(D.meta).find(k => D.meta[k].name === nm); if (!t || !bars[t]) { console.log(nm, "→ 데이터 없음(상폐·미포함 가능)"); continue; }
    const evs = events.filter(e => e.t === t);
    console.log(`${nm}(${t}, 시총순위 ${D.meta[t].capRank}) 3배↑·100억↑ 사건 ${evs.length}건:`, evs.map(e => { const b = bars[t]; const i = e.s + 5; const c = i < b.length ? cond(e, i) : null; return `${b[e.s].d} ${e.ratio.toFixed(0)}배 ${(e.turn / 1e8).toFixed(0)}억 A=${c ? c.priceFlat && c.support && c.dry : "?"}`; }).join("; "));
  }
}
