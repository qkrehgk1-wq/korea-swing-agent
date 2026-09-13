import { describe, expect, it } from "vitest";

import { geminiGenerationConfig, mapGeminiFinishReason } from "./_core/llm";

describe("geminiGenerationConfig", () => {
  it("grants thinking on top of the answer budget for 2.5 models", () => {
    expect(geminiGenerationConfig("gemini-2.5-flash", 4096, 1024)).toEqual({
      maxOutputTokens: 5120,
      thinkingConfig: { thinkingBudget: 1024 },
    });
  });

  it("keeps the whole answer budget even when thinking uses all of its share", () => {
    // Regression: a flat 4096 left 163 answer tokens after 3,929 thinking
    // tokens, cutting the alpha research JSON off mid-object.
    const config = geminiGenerationConfig("gemini-2.5-flash", 4096, 1024) as {
      maxOutputTokens: number;
      thinkingConfig: { thinkingBudget: number };
    };
    expect(config.maxOutputTokens - config.thinkingConfig.thinkingBudget).toBeGreaterThanOrEqual(4096);
  });

  it("can turn thinking off on Flash", () => {
    expect(geminiGenerationConfig("gemini-2.5-flash", 2000, 0)).toEqual({
      maxOutputTokens: 2000,
      thinkingConfig: { thinkingBudget: 0 },
    });
  });

  it("clamps Pro to the API minimum, since Pro cannot stop thinking", () => {
    expect(geminiGenerationConfig("gemini-2.5-pro", 2000, 0)).toEqual({
      maxOutputTokens: 2128,
      thinkingConfig: { thinkingBudget: 128 },
    });
  });

  it("sends no thinkingConfig to models that would reject it", () => {
    expect(geminiGenerationConfig("gemini-2.0-flash", 4096, 1024)).toEqual({
      maxOutputTokens: 4096,
    });
  });
});

describe("mapGeminiFinishReason", () => {
  it("reports a token-limit cut-off as length, never as stop", () => {
    expect(mapGeminiFinishReason("MAX_TOKENS")).toBe("length");
  });

  it("maps a normal finish to stop", () => {
    expect(mapGeminiFinishReason("STOP")).toBe("stop");
    expect(mapGeminiFinishReason(undefined)).toBe("stop");
  });

  it("passes other reasons through so they are not mistaken for success", () => {
    expect(mapGeminiFinishReason("SAFETY")).toBe("safety");
  });
});
