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

  it("uses review language (no directive terms) with 기준가/손실관리 wording", () => {
    const { body } = buildDailySwingMessage([cand({ swingScore: 80 })], [], [], NOW);
    expect(body).toContain("유력검토");
    expect(body).toContain("기준가 ");
    expect(body).toContain("손실관리 ");
    expect(body).not.toContain("ACT");
    expect(body).not.toContain("진입 ");
  });

  it("shows the data-degradation banner and realized performance line", () => {
    const { body } = buildDailySwingMessage([cand()], [], [], NOW, [], {
      dataDegraded: true,
      performanceLine: "📈 실측 성과: 체결 12건 · 승률 58.3% · 평균 2.1% (타겟 41.7%·손절 16.7%)",
    });
    expect(body).toContain("데이터 신뢰도 저하");
    expect(body).toContain("실측 성과");
  });

  it("keeps the degradation banner even when there is nothing to show", () => {
    const { body } = buildDailySwingMessage([], [], [], NOW, [], { dataDegraded: true });
    expect(body).toContain("데이터 신뢰도 저하");
    expect(body).toContain("후보가 없습니다");
  });

  it("surfaces a watch-only floor instead of going silent", () => {
    const { body } = buildDailySwingMessage([], [], [], NOW, [
      cand({
        ticker: "W",
        companyName: "관찰주",
        swingScore: 55,
        supplyState: "accumulating",
        reason: ["황금비 되돌림 지지(55%)"],
      }),
    ]);
    expect(body).toContain("관찰");
    expect(body).toContain("관찰주 W");
    expect(body).not.toContain("후보가 없습니다");
  });
});
