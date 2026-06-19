import { describe, expect, it } from "vitest";

import { buildDailySwingMessage } from "./notificationService";

type Cand = Parameters<typeof buildDailySwingMessage>[0][number];

function cand(overrides: Partial<Cand> = {}): Cand {
  return {
    ticker: "005930",
    companyName: "삼성전자",
    market: "코스피",
    swingScore: 70,
    patterns: ["밥그릇 1번자리"],
    currentPrice: 100,
    triggerPrice: 101,
    stopLossPrice: 95,
    ...overrides,
  };
}

const NOW = new Date("2026-06-19T01:00:00Z");

describe("buildDailySwingMessage", () => {
  it("shows a risk-off banner and caps picks in a bearish regime", () => {
    const { body } = buildDailySwingMessage(
      [
        cand({ ticker: "A", companyName: "가", marketRegimeLabel: "약세", swingScore: 80 }),
        cand({ ticker: "B", companyName: "나", marketRegimeLabel: "약세", swingScore: 70 }),
        cand({ ticker: "C", companyName: "다", marketRegimeLabel: "약세", swingScore: 60 }),
      ],
      [],
      [],
      NOW
    );
    expect(body).toContain("시장 약세");
    expect(body).toContain("가 A");
    expect(body).not.toContain("다 C"); // bearish → only 1 pick per horizon group
  });

  it("shows a bullish banner, supply marker and relative strength", () => {
    const { body } = buildDailySwingMessage(
      [
        cand({
          marketRegimeLabel: "강세",
          supplyState: "accumulating",
          relativeStrength: 5.2,
          reason: ["황금비 되돌림 지지(50%)"],
        }),
      ],
      [],
      [],
      NOW
    );
    expect(body).toContain("시장 강세");
    expect(body).toContain("🟢매집");
    expect(body).toContain("RS+5.2");
    expect(body).toContain("황금비");
  });

  it("marks smart-money distribution", () => {
    const { body } = buildDailySwingMessage([cand({ supplyState: "distributing" })], [], [], NOW);
    expect(body).toContain("🔴분산");
  });

  it("handles an empty candidate list", () => {
    expect(buildDailySwingMessage([], [], [], NOW).body).toContain("후보가 없습니다");
  });
});
