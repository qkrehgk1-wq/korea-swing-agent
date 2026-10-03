// 연구용(2026-10-03): 코스피·코스닥 전 종목 일봉을 JSON으로 내려받는다. 결과 파일은 수십 MB라 커밋하지 않는다.
// 사용: npx tsx scripts/research/fetchWideMarket.mts <저장경로.json>
// 주의: 유니버스는 "오늘" 상장·시총 기준이라 상장폐지 종목이 빠진다(생존편향).
import fs from "node:fs";
import { fetchNaverUniverse, fetchKoreanOhlcvRowsBatch } from "../../server/koreaStockMcp";
const OUT = process.argv[2];
const [kospi, kosdaq] = await Promise.all([fetchNaverUniverse("KOSPI", 1000), fetchNaverUniverse("KOSDAQ", 1800)]);
const uni = [...kospi, ...kosdaq];
console.log("유니버스", uni.length, "(코스피", kospi.length, "코스닥", kosdaq.length, ")");
const meta: Record<string, any> = {};
uni.forEach((u: any, i: number) => (meta[u.ticker] = { name: u.name ?? u.companyName, market: u.market, capRank: i < kospi.length ? i + 1 : i - kospi.length + 1 }));
const tickers = Object.keys(meta);
const rows: Record<string, any[]> = {};
const CH = 120;
for (let i = 0; i < tickers.length; i += CH) {
  const got = await fetchKoreanOhlcvRowsBatch(tickers.slice(i, i + CH), 1000);
  for (const [t, r] of Object.entries(got)) if (r && r.length > 60) rows[t] = r.map((x: any) => [x.날짜, x.시가, x.고가, x.저가, x.종가, x.거래량]);
  console.log("진행", Math.min(i + CH, tickers.length), "/", tickers.length, "확보", Object.keys(rows).length);
}
fs.writeFileSync(OUT, JSON.stringify({ meta, rows }));
console.log("저장", OUT, Object.keys(rows).length, "종목");
