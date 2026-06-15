import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runContinuousImprovementCycle } from "./continuousImprovementCoordinator";

describe("runContinuousImprovementCycle", () => {
  it("combines self-review and research into a roadmap", async () => {
    const cwd = process.cwd();
    const tempRoot = await mkdir(path.join(os.tmpdir(), "swing-improvement-test-"), { recursive: true })
      .then(() => path.join(os.tmpdir(), "swing-improvement-test-"));
    const packageJsonPath = path.join(cwd, "package.json");
    const maintenanceDir = path.join(cwd, ".data", "swing-maintenance");
    const backtestDir = path.join(cwd, ".data", "backtests");
    await mkdir(maintenanceDir, { recursive: true });
    await mkdir(backtestDir, { recursive: true });
    await writeFile(
      path.join(maintenanceDir, "history.json"),
      JSON.stringify([
        {
          generatedAt: "2026-05-20T00:00:00.000Z",
          success: true,
          approvedCandidates: 0,
          heldCandidates: 6,
          matchedSwingCandidates: 0,
          matchedLimitUpCandidates: 1,
          matchedFollowThroughCandidates: 0,
        },
      ]),
      "utf8"
    );
    await writeFile(
      path.join(backtestDir, "learned-swing-overrides.json"),
      JSON.stringify({ generatedAt: "2026-05-10T00:00:00.000Z" }),
      "utf8"
    );

    const report = await runContinuousImprovementCycle({
      maintenanceReport: {
        generatedAt: "2026-05-22T00:00:00.000Z",
        success: true,
        warnings: [],
        failures: [],
        pipeline: {
          matchedSwingCandidates: 0,
          matchedLimitUpCandidates: 1,
          matchedFollowThroughCandidates: 0,
          approvedCandidates: 0,
          heldCandidates: 5,
          youtubeRules: 1,
        },
        notificationStatus: {
          telegramConfigured: true,
          ownerConfigured: false,
          kakaoConfigured: false,
        },
        contract: {
          drift: {
            score: 52,
            status: "high",
            findings: ["후보는 생성됐지만 승인 후보가 0건입니다."],
          },
        },
      },
      packageJsonPath,
      fetchImpl: async input => {
        const url = String(input);
        if (url.includes("registry.npmjs.org")) {
          return new Response(JSON.stringify({ version: "99.0.0" }), { status: 200 });
        }
        if (url.includes("support%20resistance")) {
          return new Response(
            `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Dynamic Support and Resistance</title><id>http://example.test/sr</id><published>2026-05-21T00:00:00Z</published><summary>Support resistance technical analysis for stock trading.</summary><link href="http://example.test/sr" /></entry></feed>`,
            { status: 200, headers: { "content-type": "application/atom+xml" } }
          );
        }
        if (url.includes("candlestick%20chart")) {
          return new Response(
            `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Candlestick Chart Forecasting Limits</title><id>http://example.test/chart</id><published>2026-05-21T00:00:00Z</published><summary>Candlestick chart forecasting and VLM limits in stock prediction.</summary><link href="http://example.test/chart" /></entry></feed>`,
            { status: 200, headers: { "content-type": "application/atom+xml" } }
          );
        }
        return new Response(
          `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Market Regime Forecasting</title><id>http://example.test/1</id><published>2026-05-20T00:00:00Z</published><summary>Market regime and volatility timing for momentum trading.</summary><link href="http://example.test/1" /></entry></feed>`,
          { status: 200, headers: { "content-type": "application/atom+xml" } }
        );
      },
      now: new Date("2026-05-22T00:00:00.000Z"),
    });

    expect(report.roadmap.length).toBeGreaterThan(0);
    expect(report.roadmap.some(item => item.lane === "strategy")).toBe(true);
    expect(report.roadmap.some(item => item.lane === "librarian")).toBe(true);
    expect(report.roadmap.some(item => item.lane === "benchmark")).toBe(true);
    expect(report.roadmap.some(item => item.lane === "engineering")).toBe(true);
  });
});
