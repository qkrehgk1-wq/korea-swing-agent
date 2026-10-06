// 연구용(2026-10-06): 새 스윙 전략 후보 6종의 사건 연구 — 1~4주 보유, 같은 시총 구간·같은 진입일 기준선 대비 초과수익.
// 사용: npx tsx scripts/research/swingCandidatesStudy.mts <fetchWideMarket 결과.json>
// 진입은 신호 다음날 시가, 청산은 N일째 종가, 왕복비용 0.35%. 종목당 보유기간 내 중복 신호 제거.
// 판정 기준: 첫 실행에서 "초과 > 0"으로 고정했으나, 조건 없는 대조군 자체가 음수(거래대금 필터 효과 + 분포 치우침)로 나와 기준이 잘못 잡혀 있었다.
// 그래서 결과를 본 뒤 "대조군 대비"로 바꿨다(사후 변경임을 기록): n≥100, 평균·절사·IS·OOS 초과가 모두 대조군보다 높고, 연도별로도 대조군보다 높을 것.
// 대조군 대비 평균 차이가 2SE를 넘는지도 함께 본다. 6개를 동시에 보므로 하나쯤 우연히 통과할 수 있다.
// 한계: 오늘 상장 기준 유니버스(상폐 제외 → 낙폭과대 반등류가 특히 낙관적), 현재 시총 순위로 구간 분할, 손절 없는 고정 보유.
import fs from "node:fs";
const D = JSON.parse(fs.readFileSync(process.argv[2], "utf8")) as { meta: Record<string, any>; rows: Record<string, any[]> };
const HALF = 0.35 / 100 / 2;
const HOLDS = [10, 20];
type Bar = { d: string; o: number; h: number; l: number; c: number; v: number };
const bars: Record<string, Bar[]> = {};
for (const [t, r] of Object.entries(D.rows)) {
  const b = r.map(x => ({ d: x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[5] })).filter(x => x.c > 0 && x.o > 0).sort((a, b) => a.d.localeCompare(b.d));
  if (b.length > 260) bars[t] = b;
}
const tickers = Object.keys(bars).filter(t => (D.meta[t]?.capRank ?? 9999) <= 800);
console.log("종목(시총 800위 이내, 260봉 이상)", tickers.length);
const strat = (t: string) => ((D.meta[t]?.capRank ?? 9999) <= 200 ? "T" : "R");
const fwd = (b: Bar[], i: number, N: number) => (i + N < b.length ? (b[i + N].c * (1 - HALF)) / (b[i + 1].o * (1 + HALF)) - 1 : null);
const base: Record<number, Map<string, { s: number; n: number }>> = {};
for (const N of HOLDS) base[N] = new Map();
for (const t of tickers) { const b = bars[t]; for (let i = 250; i < b.length - 1; i++) for (const N of HOLDS) { const r = fwd(b, i, N); if (r === null || Math.abs(r) > 1.5) continue; const k = strat(t) + b[i].d; const e = base[N].get(k) ?? { s: 0, n: 0 }; e.s += r; e.n++; base[N].set(k, e); } }
const baseAvg = (N: number, d: string, t: string) => { const e = base[N].get(strat(t) + d); return e && e.n > 20 ? e.s / e.n : null; };

// ── 지표 ──
const sma = (b: Bar[], i: number, n: number) => { let s = 0; for (let k = i - n + 1; k <= i; k++) s += b[k].c; return s / n; };
const avgVol = (b: Bar[], i: number, n: number) => { let s = 0; for (let k = i - n; k < i; k++) s += b[k].v; return s / n; };
const turnover20 = (b: Bar[], i: number) => { let s = 0; for (let k = i - 19; k <= i; k++) s += b[k].v * b[k].c; return s / 20; };
function rsi2(b: Bar[], i: number) { let up = 0, dn = 0; for (let k = i - 1; k <= i; k++) { const d = b[k].c - b[k - 1].c; if (d > 0) up += d; else dn -= d; } return dn === 0 ? 100 : 100 - 100 / (1 + up / dn); }
const hi = (b: Bar[], i: number, n: number) => { let m = -Infinity; for (let k = i - n + 1; k <= i; k++) m = Math.max(m, b[k].h); return m; };
const lo = (b: Bar[], i: number, n: number) => { let m = Infinity; for (let k = i - n + 1; k <= i; k++) m = Math.min(m, b[k].l); return m; };

type Rule = { name: string; f: (b: Bar[], i: number) => boolean };
const rules: Rule[] = [
  // 0) 대조(위약): 조건 없음 — 같은 거래대금 필터·같은 20일 간격. 절사·중앙 초과는 수익률 분포가 오른쪽으로 치우쳐 구조적으로 음수이므로,
  //    각 전략의 절사·중앙 수치는 이 대조와 비교해야 한다(0과 비교하면 안 됨).
  { name: "대조: 조건 없음", f: () => true },
  // 1) 상승추세 속 단기 과매도(코너스류): 120일선 위 + RSI(2)<5 + 5일 수익률 ≤ -6%
  { name: "추세 속 단기 과매도", f: (b, i) => b[i].c > sma(b, i, 120) && rsi2(b, i) < 5 && b[i].c / b[i - 5].c - 1 <= -0.06 },
  // 2) 단기 반전(무조건): 5일 수익률 ≤ -12%
  { name: "5일 급락 반전(-12%↓)", f: (b, i) => b[i].c / b[i - 5].c - 1 <= -0.12 },
  // 3) 52주 신고가 근접: 종가 ≥ 250일 고가의 97%, 그리고 그 고가가 20일 이상 전에 형성(돌파 직전 자리)
  { name: "52주 신고가 근접", f: (b, i) => b[i].c >= hi(b, i, 250) * 0.97 && hi(b, i - 20, 230) >= hi(b, i, 250) * 0.999 },
  // 4) 중기 모멘텀: 126일 수익률(최근 21일 제외) ≥ +50%, 최근 21일은 -10%~+10%(과열 직후 아님)
  { name: "중기 모멘텀 6-1", f: (b, i) => b[i - 21].c / b[i - 126].c - 1 >= 0.5 && Math.abs(b[i].c / b[i - 21].c - 1) <= 0.10 },
  // 5) 변동성 수축 후 돌파: 직전 20일 고저폭 ≤ 12% + 오늘 종가가 그 고가 돌파 + 거래량 1.5배↑
  { name: "수축 후 돌파", f: (b, i) => (hi(b, i - 1, 20) - lo(b, i - 1, 20)) / b[i - 1].c <= 0.12 && b[i].c > hi(b, i - 1, 20) && b[i].v >= 1.5 * avgVol(b, i, 20) },
  // 6) 갭하락 후 양봉 회복: 시가가 전일 종가 -4%↓, 종가 > 시가, 60일선 위
  { name: "갭하락 양봉 회복", f: (b, i) => b[i].o <= b[i - 1].c * 0.96 && b[i].c > b[i].o && b[i].c > sma(b, i, 60) },
];

type Sig = { t: string; i: number };
function collect(rule: Rule): Sig[] {
  const out: Sig[] = [];
  for (const t of tickers) {
    const b = bars[t]; let last = -999;
    for (let i = 250; i < b.length - 1; i++) {
      if (i - last < 20) continue;
      if (turnover20(b, i) < 3e9) continue; // 20일 평균 거래대금 30억 미만 제외(체결 현실성)
      if (rule.f(b, i)) { out.push({ t, i }); last = i; }
    }
  }
  return out;
}
const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const trim = (a: number[]) => { const s = [...a].sort((x, y) => x - y); const k = Math.floor(s.length * 0.05); return mean(s.slice(k, s.length - k)); };
const pct = (x: number) => (Number.isFinite(x) ? (x * 100).toFixed(1) + "%" : "-");
function measure(sigs: Sig[], N: number) {
  const r: number[] = [], ex: number[] = [], dates: string[] = [];
  for (const g of sigs) { const b = bars[g.t]; const x = fwd(b, g.i, N); const ba = baseAvg(N, b[g.i].d, g.t); if (x === null || ba === null) continue; r.push(x); ex.push(x - ba); dates.push(b[g.i].d); }
  return { r, ex, dates };
}
const allDates = [...new Set(tickers.flatMap(t => bars[t].slice(250).map(x => x.d)))].sort();
const CUT = allDates[Math.floor(allDates.length * 0.6)];
console.log("측정 구간", allDates[0], "~", allDates.at(-1), "| OOS 분할일", CUT, "\n");
const verdicts: string[] = [];
let ctl: { m: number; tr: number; is: number; oos: number; se: number; y: Record<string, number> } | null = null;
for (const rule of rules) {
  const sigs = collect(rule);
  console.log(`=== ${rule.name}: 신호 ${sigs.length}건 / ${new Set(sigs.map(s => s.t)).size}종목 ===`);
  for (const N of HOLDS) {
    const { r, ex, dates } = measure(sigs, N);
    if (r.length < 5) { console.log(`  ${N}일 n=${r.length}`); continue; }
    const isEx = ex.filter((_, k) => dates[k] < CUT), oosEx = ex.filter((_, k) => dates[k] >= CUT);
    const byY: Record<string, number[]> = {}; ex.forEach((x, k) => (byY[dates[k].slice(0, 4)] ||= []).push(x));
    const sorted = [...ex].sort((a, b) => b - a); const tot = ex.reduce((s, x) => s + x, 0); const top5 = sorted.slice(0, 5).reduce((s, x) => s + x, 0);
    const sd = Math.sqrt(mean(ex.map(x => (x - mean(ex)) ** 2))); const se = sd / Math.sqrt(ex.length);
    console.log(`  ${N}일 n=${r.length} 평균${pct(mean(r))} 초과±2SE ${pct(mean(ex) - 2 * se)}~${pct(mean(ex) + 2 * se)}`);
    console.log(`        평균${pct(mean(r))} 승${pct(r.filter(x => x > 0).length / r.length)} | 초과 ${pct(mean(ex))} 절사 ${pct(trim(ex))} 중앙 ${pct([...ex].sort((a, b) => a - b)[Math.floor(ex.length / 2)])} | IS ${pct(mean(isEx))}(${isEx.length}) OOS ${pct(mean(oosEx))}(${oosEx.length}) | 상위5 몫 ${tot > 0 ? ((top5 / tot) * 100).toFixed(0) + "%" : "-"} | ` + Object.entries(byY).map(([y, a]) => `${y} ${pct(mean(a))}(${a.length})`).join(" "));
    if (N === 20) {
      const ym: Record<string, number> = {}; for (const [y, a] of Object.entries(byY)) if (a.length >= 20) ym[y] = mean(a);
      if (!ctl) { ctl = { m: mean(ex), tr: trim(ex), is: mean(isEx), oos: mean(oosEx), se, y: ym }; verdicts.push(`${rule.name.padEnd(16)} (기준) 평균 ${pct(ctl.m)} 절사 ${pct(ctl.tr)} IS ${pct(ctl.is)} OOS ${pct(ctl.oos)}`); continue; }
      const d = mean(ex) - ctl.m; const dse = Math.sqrt(se ** 2 + ctl.se ** 2);
      const beats = mean(ex) > ctl.m && trim(ex) > ctl.tr && mean(isEx) > ctl.is && mean(oosEx) > ctl.oos && Object.entries(ym).every(([y, v]) => ctl!.y[y] === undefined || v > ctl!.y[y]);
      const pass = r.length >= 100 && beats;
      verdicts.push(`${rule.name.padEnd(16)} ${pass ? (d > 2 * dse ? "통과(유의)" : "방향만 통과(유의 아님)") : "탈락"} — n=${r.length} 대조 대비: 평균 ${pct(d)}(±2SE ${pct(2 * dse)}) 절사 ${pct(trim(ex) - ctl.tr)} IS ${pct(mean(isEx) - ctl.is)} OOS ${pct(mean(oosEx) - ctl.oos)}`);
    }
  }
}
console.log("\n=== 사전 기준 판정(20일) ===\n" + verdicts.join("\n"));
