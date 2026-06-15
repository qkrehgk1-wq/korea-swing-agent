import { describe, expect, it } from "vitest";

import { scoreElliottFractalFromRows } from "./elliottFractalAgent";
import type { OhlcvRow } from "../koreaStockMcp";

function buildRows(closes: number[]): OhlcvRow[] {
  return closes.map((close, index) => ({
    날짜: `2026-01-${String((index % 28) + 1).padStart(2, "0")}`,
    시가: close * 0.99,
    고가: close * 1.01,
    저가: close * 0.98,
    종가: close,
    거래량: 100000 + index * 1000,
    등락률: 0,
  }));
}

describe("scoreElliottFractalFromRows", () => {
  it("detects a bullish impulse and compression-friendly structure", () => {
    const base = Array.from({ length: 90 }, (_, index) => 100 + index * 0.2);
    const impulse = [
      120, 123, 126, 124, 122, 120, 122, 126, 131, 137,
      143, 140, 136, 133, 135, 139, 144, 150, 157, 163,
      160, 156, 152, 154, 158, 163, 169, 175, 182, 188,
    ];
    const result = scoreElliottFractalFromRows(buildRows([...base, ...impulse]));

    expect(result).not.toBeNull();
    expect(result!.earlyImpulseScore).toBeGreaterThanOrEqual(65);
    expect(result!.fractalCompressionScore).toBeGreaterThanOrEqual(60);
  });

  it("keeps noisy corrective structures in a low-confidence regime", () => {
    const noisy = Array.from({ length: 140 }, (_, index) =>
      100 + Math.sin(index / 2) * 8 + (index % 3 === 0 ? -4 : 4)
    );
    const result = scoreElliottFractalFromRows(buildRows(noisy));

    expect(result).not.toBeNull();
    expect(result!.impulseScore).toBeLessThan(70);
    expect(result!.warnings.length).toBeGreaterThan(0);
  });
});
