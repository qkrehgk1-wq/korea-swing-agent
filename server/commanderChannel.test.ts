import { describe, expect, it } from "vitest";

import {
  DIGEST_WORKFLOW,
  digestWaitMs,
  formatCommanderDigest,
  shouldQueueCommander,
  type CommanderSignal,
} from "./commanderChannel";

const risk = (headline: string): CommanderSignal => ({
  ticker: "DATA",
  companyName: "데이터 총괄",
  kind: "high_risk",
  headline,
  detail: ["상세 1"],
});

describe("shouldQueueCommander", () => {
  it("queues only inside the daily workflow on CI", () => {
    expect(shouldQueueCommander({ GITHUB_ACTIONS: "true", GITHUB_WORKFLOW: DIGEST_WORKFLOW })).toBe(true);
  });

  it("sends immediately in any other workflow, which has no step that would flush", () => {
    // Queueing there would silently lose the alert when the runner is discarded.
    expect(shouldQueueCommander({ GITHUB_ACTIONS: "true", GITHUB_WORKFLOW: "Weekly Alpha Research & Self-Improvement" })).toBe(false);
    expect(shouldQueueCommander({ GITHUB_ACTIONS: "true", GITHUB_WORKFLOW: "Daily Market Monitor" })).toBe(false);
  });

  it("sends immediately outside CI and when switched off", () => {
    expect(shouldQueueCommander({ GITHUB_WORKFLOW: DIGEST_WORKFLOW })).toBe(false);
    expect(shouldQueueCommander({ GITHUB_ACTIONS: "true", GITHUB_WORKFLOW: DIGEST_WORKFLOW, COMMANDER_DIGEST: "off" })).toBe(false);
  });
});

describe("digestWaitMs", () => {
  const minGap = 90_000;

  it("holds the digest back when it would land right after the main alert", () => {
    // Measured 2026-10-01: main alert, then the steward step 5 seconds later.
    expect(digestWaitMs(1_000_000, 1_005_000, minGap)).toBe(85_000);
  });

  it("does not wait once the gap has already passed", () => {
    expect(digestWaitMs(1_000_000, 1_200_000, minGap)).toBe(0);
  });

  it("does not wait when no main alert went out this run", () => {
    expect(digestWaitMs(null, 1_005_000, minGap)).toBe(0);
  });
});

describe("formatCommanderDigest", () => {
  it("folds every queued signal into one message, risks first", () => {
    const { title, content } = formatCommanderDigest([
      { ticker: "005930", companyName: "삼성전자", kind: "high_conviction", headline: "고확신", detail: [] },
      risk("엣지 괴리"),
      risk("실행 공백"),
    ]);
    expect(title).toContain("3건");
    expect(title).toContain("경보 2");
    expect(content.indexOf("엣지 괴리")).toBeLessThan(content.indexOf("고확신"));
    expect(content.split("■").length - 1).toBe(3);
  });
});
