import { describe, expect, it } from "vitest";

import {
  buildDanteStrategyInsights,
  parseYouTubeChannelHtml,
  parseYouTubeVideoFeed,
  scoreDanteAlignment,
} from "./youtubeLearningAgent";

describe("youtubeLearningAgent", () => {
  it("parses public YouTube RSS entries into compact source records", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <feed>
        <entry>
          <yt:videoId>abc123</yt:videoId>
          <title>기준봉 이후 눌림목 매수와 손절 기준</title>
          <published>2026-05-01T01:00:00+00:00</published>
          <media:group>
            <media:description>거래량 터진 기준봉 이후 20일선 지지 확인</media:description>
          </media:group>
        </entry>
      </feed>`;

    expect(parseYouTubeVideoFeed(xml)).toEqual([
      {
        videoId: "abc123",
        title: "기준봉 이후 눌림목 매수와 손절 기준",
        publishedAt: "2026-05-01T01:00:00+00:00",
        url: "https://www.youtube.com/watch?v=abc123",
        description: "거래량 터진 기준봉 이후 20일선 지지 확인",
      },
    ]);
  });

  it("falls back to public channel HTML when YouTube RSS is unavailable", () => {
    const html = `
      {"videoId":"abc123","thumbnail":{"thumbnails":[]},"title":{"runs":[{"text":"바닥 탈출 신호, 거래량과 20일선"}]}}
      {"videoId":"abc123","thumbnail":{"thumbnails":[]},"title":{"runs":[{"text":"중복"}]}}
      {"videoId":"def456","thumbnail":{"thumbnails":[]},"title":{"runs":[{"text":"밥그릇 2번자리 우측 회복"}]}}
    `;

    expect(parseYouTubeChannelHtml(html)).toEqual([
      {
        videoId: "abc123",
        title: "바닥 탈출 신호, 거래량과 20일선",
        publishedAt: "",
        url: "https://www.youtube.com/watch?v=abc123",
        description: "",
      },
      {
        videoId: "def456",
        title: "밥그릇 2번자리 우측 회복",
        publishedAt: "",
        url: "https://www.youtube.com/watch?v=def456",
        description: "",
      },
    ]);
  });

  it("keeps YouTube learning alive when channel HTML only exposes video IDs", () => {
    expect(parseYouTubeChannelHtml('{"videoId":"abc123"}{"videoId":"abc123"}{"videoId":"def456"}')).toEqual([
      {
        videoId: "abc123",
        title: "YouTube channel video",
        publishedAt: "",
        url: "https://www.youtube.com/watch?v=abc123",
        description: "",
      },
      {
        videoId: "def456",
        title: "YouTube channel video",
        publishedAt: "",
        url: "https://www.youtube.com/watch?v=def456",
        description: "",
      },
    ]);
  });

  it("parses modern YouTube channel HTML lockup labels into usable titles", () => {
    const html = `
      {"contentId":"abc123","contentType":"LOCKUP_CONTENT_TYPE_VIDEO","rendererContext":{"accessibilityContext":{"label":"주식 초보 맞춤 강의! 쉽고 간단한 이 기법으로 수익 내보세요 3분 4초"}}}
      {"contentId":"def456","contentType":"LOCKUP_CONTENT_TYPE_VIDEO","rendererContext":{"accessibilityContext":{"label":"[5월 첫 거래일] 코스피 6,800선 안착ㅣ외인·기관이 선택한 주도주 공개ㅣ2026.05.04(월) 하이라이트 1시간 24분"}}}
    `;

    expect(parseYouTubeChannelHtml(html)).toEqual([
      {
        videoId: "abc123",
        title: "주식 초보 맞춤 강의! 쉽고 간단한 이 기법으로 수익 내보세요",
        publishedAt: "",
        url: "https://www.youtube.com/watch?v=abc123",
        description: "",
      },
      {
        videoId: "def456",
        title: "[5월 첫 거래일] 코스피 6,800선 안착ㅣ외인·기관이 선택한 주도주 공개ㅣ2026.05.04(월) 하이라이트",
        publishedAt: "",
        url: "https://www.youtube.com/watch?v=def456",
        description: "",
      },
    ]);
  });

  it("extracts strategy rules without storing full transcripts", () => {
    const report = buildDanteStrategyInsights([
      {
        videoId: "v1",
        title: "세력주 기준봉 이후 거래량 눌림목",
        publishedAt: "2026-05-01T00:00:00+00:00",
        url: "https://www.youtube.com/watch?v=v1",
        description: "기준봉 거래량 이후 20일선 지지와 손절 기준을 확인",
        transcriptSummary: "고점 추격보다 눌림목에서 기준봉 저점 이탈 시 손절",
      },
      {
        videoId: "v2",
        title: "밥그릇 2번자리 우측 회복",
        publishedAt: "2026-05-02T00:00:00+00:00",
        url: "https://www.youtube.com/watch?v=v2",
        description: "밥그릇 우측 20일선 회복과 거래량 증가",
      },
    ]);

    expect(report.rules.map(rule => rule.id)).toEqual(
      expect.arrayContaining(["base-candle-pullback", "bowl-right-side"])
    );
    expect(report.notes.join(" ")).toContain("원문 전체");
  });

  it("scores candidates higher when their setup matches learned Dante-style rules", () => {
    const report = buildDanteStrategyInsights([
      {
        videoId: "v1",
        title: "밥그릇 1번자리와 2번자리 거래량 회복",
        publishedAt: "2026-05-01T00:00:00+00:00",
        url: "https://www.youtube.com/watch?v=v1",
        description: "20일선 지지와 손절 기준",
      },
    ]);

    const aligned = scoreDanteAlignment(
      {
        patterns: ["밥그릇 2번자리"],
        reason: ["20일선 회복", "거래량 증가"],
        volumeRatio: 1.35,
        rsi14: 58,
      },
      report
    );

    const weak = scoreDanteAlignment(
      {
        patterns: ["돌파매매"],
        reason: ["신고가 돌파"],
        volumeRatio: 0.7,
        rsi14: 86,
      },
      report
    );

    expect(aligned.score).toBeGreaterThan(weak.score);
    expect(aligned.matchedRules).toContain("bowl-right-side");
    expect(weak.warnings).toContain("고점 추격/과열 위험");
  });
});
