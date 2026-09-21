import { describe, expect, it } from "vitest";

import { resolveEvolutionDay, shouldRunFullEvolution } from "./swingEvolutionAgent";

describe("resolveEvolutionDay", () => {
  it("treats an empty string as unset — what a workflow passes for an unset repo variable", () => {
    // Regression: Number("") is 0, so the documented "default Monday" silently
    // became Sunday.
    expect(resolveEvolutionDay("")).toBe(1);
    expect(resolveEvolutionDay("   ")).toBe(1);
    expect(resolveEvolutionDay(undefined)).toBe(1);
  });

  it("still honours an explicit Sunday", () => {
    expect(resolveEvolutionDay("0")).toBe(0);
  });

  it("accepts every valid weekday and rejects garbage back to the default", () => {
    expect(resolveEvolutionDay("6")).toBe(6);
    expect(resolveEvolutionDay("7")).toBe(1);
    expect(resolveEvolutionDay("-1")).toBe(1);
    expect(resolveEvolutionDay("mon")).toBe(1);
    expect(resolveEvolutionDay("1.5")).toBe(1);
  });
});

describe("shouldRunFullEvolution", () => {
  // The daily job actually starts ~21:00 UTC, which is 06:00 KST of the next day.
  const sundayKst = new Date("2026-09-19T21:00:00Z"); // Sun 2026-09-20 06:00 KST
  const mondayKst = new Date("2026-09-20T21:00:00Z"); // Mon 2026-09-21 06:00 KST

  it("runs on Monday KST when the day variable is blank", () => {
    expect(shouldRunFullEvolution({ EVOLUTION_DAY: "" }, mondayKst)).toBe(true);
  });

  it("does not run on Sunday KST when the day variable is blank", () => {
    // This is the day it used to run.
    expect(shouldRunFullEvolution({ EVOLUTION_DAY: "" }, sundayKst)).toBe(false);
  });

  it("uses the KST weekday, not the UTC one", () => {
    // 2026-09-20T21:00Z is still Sunday in UTC but already Monday in Seoul.
    expect(shouldRunFullEvolution({}, mondayKst)).toBe(true);
  });

  it("lets an explicit day and the force flag override the default", () => {
    expect(shouldRunFullEvolution({ EVOLUTION_DAY: "0" }, sundayKst)).toBe(true);
    expect(shouldRunFullEvolution({ EVOLUTION_FORCE: "true" }, new Date("2026-09-22T00:00:00Z"))).toBe(true);
  });
});
