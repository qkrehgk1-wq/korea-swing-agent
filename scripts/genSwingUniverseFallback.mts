/**
 * Regenerates server/swingUniverseFallback.ts — the baked top market-cap
 * universe snapshot used as the offline fallback when every live universe
 * source is unreachable (e.g. a geo-blocked CI runner).
 *
 * Run: pnpm gen:universe   (refresh periodically; top-cap names drift slowly)
 */
import { writeFile } from "node:fs/promises";
import { fetchNaverUniverse } from "../server/koreaStockMcp";

const KOSPI_COUNT = Number(process.env.SWING_FALLBACK_KOSPI) || 130;
const KOSDAQ_COUNT = Number(process.env.SWING_FALLBACK_KOSDAQ) || 90;

async function main() {
  const [kospi, kosdaq] = await Promise.all([
    fetchNaverUniverse("KOSPI", KOSPI_COUNT),
    fetchNaverUniverse("KOSDAQ", KOSDAQ_COUNT),
  ]);
  const all = [...kospi, ...kosdaq];
  if (all.length < 50) {
    throw new Error(`Refusing to write a thin fallback (${all.length} entries) — check Naver access`);
  }
  const today = new Date().toISOString().slice(0, 10);
  const body = `/**
 * Baked top market-cap universe snapshot (KOSPI + KOSDAQ), generated from Naver.
 * Offline fallback for resolveSwingUniverse() when every LIVE universe source
 * (Naver API, pykrx) is unreachable — e.g. a geo-blocked CI runner. Guarantees a
 * broad universe with zero network dependency.
 *
 * Snapshot: ${today}. Regenerate with: pnpm gen:universe
 */
import type { NaverUniverseEntry } from "./koreaStockMcp";

export const SWING_UNIVERSE_FALLBACK: NaverUniverseEntry[] = ${JSON.stringify(all, null, 2)};
`;
  await writeFile("server/swingUniverseFallback.ts", body, "utf8");
  console.log(`wrote ${all.length} entries (KOSPI ${kospi.length} + KOSDAQ ${kosdaq.length})`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
