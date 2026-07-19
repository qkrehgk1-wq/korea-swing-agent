import { describe, expect, it } from "vitest";

import { isoDaysBetween } from "./technicalSwingScreener";

describe("isoDaysBetween", () => {
  it("computes calendar-day gaps", () => {
    expect(isoDaysBetween("2026-07-01", "2026-07-10")).toBe(9);
    expect(isoDaysBetween("2026-06-28", "2026-07-03")).toBe(5);
  });

  it("is negative when the ticker is ahead of the benchmark", () => {
    expect(isoDaysBetween("2026-07-10", "2026-07-01")).toBe(-9);
  });

  it("returns 0 on malformed input", () => {
    expect(isoDaysBetween("", "2026-07-10")).toBe(0);
    expect(isoDaysBetween("2026-07-10", "not-a-date")).toBe(0);
  });
});
