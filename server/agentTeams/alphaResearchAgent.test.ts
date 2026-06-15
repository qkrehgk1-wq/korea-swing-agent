import { describe, expect, it } from "vitest";

import { collectAlphaResearchReport } from "./alphaResearchAgent";

describe("alphaResearchAgent", () => {
  it("returns actionable techniques (deterministic fallback in test env)", async () => {
    const report = await collectAlphaResearchReport({
      persist: false,
      now: new Date("2026-06-16T00:00:00.000Z"),
    });

    // In NODE_ENV=test the agent skips web/LLM and uses the curated set.
    expect(report.source).toBe("deterministic");
    expect(report.techniques.length).toBeGreaterThan(0);

    for (const technique of report.techniques) {
      expect(technique.title.length).toBeGreaterThan(0);
      expect(["entry", "exit", "risk", "regime", "volume", "ai-quant"]).toContain(
        technique.category
      );
      expect(["high", "medium", "low"]).toContain(technique.priority);
      expect(technique.confidence).toBeGreaterThanOrEqual(1);
      expect(technique.confidence).toBeLessThanOrEqual(100);
      // Every technique must map to a concrete system change.
      expect(technique.implementation.length).toBeGreaterThan(0);
    }
  });
});
