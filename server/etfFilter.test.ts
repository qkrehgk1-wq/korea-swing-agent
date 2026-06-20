import { describe, expect, it } from "vitest";

import { isLikelyEtf } from "./koreaStockMcp";

describe("isLikelyEtf", () => {
  it("flags ETFs and ETNs", () => {
    for (const name of [
      "KODEX 200",
      "TIGER 미국S&P500",
      "RISE 200",
      "KODEX 레버리지",
      "KODEX 200선물인버스2X",
      "ACE 미국30년국채액티브",
      "삼성 인버스 ETN",
    ]) {
      expect(isLikelyEtf(name)).toBe(true);
    }
  });

  it("does not flag real stocks (no false positives)", () => {
    for (const name of [
      "삼성전자",
      "파마리서치",
      "파워로직스",
      "솔브레인",
      "HK이노엔",
      "HLB",
      "SK하이닉스",
      "에코프로비엠",
      "SOLUM",
    ]) {
      expect(isLikelyEtf(name)).toBe(false);
    }
  });
});
