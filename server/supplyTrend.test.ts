import { describe, expect, it } from "vitest";

import { assessSupplyTrend } from "./koreaStockMcp";

function entry(foreign: string, organ: string) {
  return { foreignerPureBuyQuant: foreign, organPureBuyQuant: organ };
}

describe("assessSupplyTrend", () => {
  it("flags sustained foreign + institutional buying as accumulating", () => {
    const trend = assessSupplyTrend(Array.from({ length: 20 }, () => entry("+1,000", "+500")));
    expect(trend.state).toBe("accumulating");
    expect(trend.foreignNet5).toBe(5000);
    expect(trend.institutionNet5).toBe(2500);
  });

  it("flags sustained selling as distributing", () => {
    const trend = assessSupplyTrend(Array.from({ length: 20 }, () => entry("-2,000", "-1,000")));
    expect(trend.state).toBe("distributing");
  });

  it("returns neutral when 5d and 20d disagree", () => {
    const trend = assessSupplyTrend([
      ...Array.from({ length: 5 }, () => entry("+1,000", "+1,000")),
      ...Array.from({ length: 15 }, () => entry("-2,000", "-2,000")),
    ]);
    expect(trend.state).toBe("neutral");
  });

  it("parses signed comma-grouped numbers", () => {
    expect(assessSupplyTrend([entry("+2,424,675", "-4,166")]).foreignNet5).toBe(2424675);
  });
});
