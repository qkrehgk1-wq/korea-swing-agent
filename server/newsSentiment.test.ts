import { describe, expect, it } from "vitest";

import { scoreHeadlines } from "./newsSentimentAgent";

describe("scoreHeadlines", () => {
  it("flags a negative headline flow", () => {
    const result = scoreHeadlines([
      "A사 3분기 영업손실 적자 전환",
      "A사 경영진 횡령 의혹 검찰 조사",
    ]);
    expect(result.state).toBe("negative");
    expect(result.negativeHits.length).toBeGreaterThan(0);
  });

  it("flags a positive headline flow", () => {
    const result = scoreHeadlines([
      "B사 대규모 수주 공급계약 체결",
      "B사 신고가 경신·목표가 상향",
    ]);
    expect(result.state).toBe("positive");
  });

  it("stays neutral for generic headlines", () => {
    expect(scoreHeadlines(["C사 신제품 공개", "C사 주가 보합세"]).state).toBe("neutral");
  });

  it("stays neutral when positive and negative balance out", () => {
    expect(scoreHeadlines(["D사 수주 성공", "D사 소송 발생"]).state).toBe("neutral");
  });
});
