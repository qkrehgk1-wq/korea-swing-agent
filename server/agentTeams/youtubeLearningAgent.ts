const DANTE_CHANNEL_ID = "UC6ij59Gy_HnqO4pFu9A_zgQ";
const DANTE_CHANNEL_NAME = "주식단테_20년차트고수";
const DEFAULT_MAX_VIDEOS = 30;

export type YouTubeStrategySource = {
  videoId: string;
  title: string;
  publishedAt: string;
  url: string;
  description: string;
  transcriptSummary?: string;
};

export type DanteStrategyRule = {
  id: string;
  label: string;
  confidence: number;
  evidenceCount: number;
  keywords: string[];
  summary: string;
};

export type DanteLearningReport = {
  channelId: string;
  channelName: string;
  generatedAt: string;
  sources: YouTubeStrategySource[];
  rules: DanteStrategyRule[];
  notes: string[];
};

export type DanteCandidateInput = {
  patterns?: string[];
  setup?: string[];
  reason?: string[];
  volumeRatio?: number;
  rsi14?: number;
};

export type DanteAlignmentScore = {
  score: number;
  matchedRules: string[];
  warnings: string[];
};

type RuleDefinition = {
  id: string;
  label: string;
  keywords: string[];
  candidateKeywords: string[];
  summary: string;
  minHits?: number;
};

const RULE_DEFINITIONS: RuleDefinition[] = [
  {
    id: "base-candle-pullback",
    label: "기준봉 이후 눌림목",
    keywords: ["기준봉", "눌림목", "20일선", "지지", "거래량"],
    candidateKeywords: ["기준봉", "눌림", "20일선", "지지", "거래량"],
    summary: "거래량이 실린 기준봉 이후 고점 추격보다 눌림과 지지 확인을 우선합니다.",
  },
  {
    id: "technical-chart-discipline",
    label: "차트 원칙 우선",
    keywords: ["차트 분석", "차트 공부", "기법", "수익", "초보"],
    candidateKeywords: ["차트", "패턴", "이평선", "RSI", "거래량"],
    summary: "복잡한 재료보다 차트 원칙, 반복 기법, 리스크 관리가 먼저라는 관점입니다.",
    minHits: 1,
  },
  {
    id: "market-leader-flow",
    label: "주도주 수급 흐름",
    keywords: ["주도주", "외인", "기관", "시총", "코스피"],
    candidateKeywords: ["주도", "수급", "거래량", "돌파", "상한가"],
    summary: "시장 자금이 몰리는 주도주와 외국인/기관 수급 흐름을 우선 관찰합니다.",
    minHits: 1,
  },
  {
    id: "bowl-right-side",
    label: "밥그릇 우측 회복",
    keywords: ["밥그릇", "1번자리", "2번자리", "우측", "회복", "20일선"],
    candidateKeywords: ["밥그릇", "1번자리", "2번자리", "우측", "회복", "20일선"],
    summary: "밥그릇 초입은 저점 이탈이 멈춘 뒤 우측 회복과 20일선 회복을 봅니다.",
  },
  {
    id: "volume-before-price",
    label: "거래량 선행 확인",
    keywords: ["거래량", "수급", "세력", "기준봉", "급등"],
    candidateKeywords: ["거래량", "수급", "세력", "급등", "상한가"],
    summary: "가격보다 거래량과 수급 흔적을 먼저 확인하고, 거래량 없는 신호는 낮게 봅니다.",
  },
  {
    id: "stop-loss-invalidated",
    label: "기준 이탈 손절",
    keywords: ["손절", "이탈", "저점", "기준", "리스크"],
    candidateKeywords: ["손절", "이탈", "저점", "리스크"],
    summary: "진입 근거가 되는 기준선이나 저점이 깨지면 보유 논리를 재검토합니다.",
  },
  {
    id: "avoid-overheated-chase",
    label: "고점 추격 경계",
    keywords: ["고점", "추격", "과열", "욕심", "리스크"],
    candidateKeywords: ["신고가", "고점", "돌파", "과열", "추격"],
    summary: "고점 추격은 보상보다 리스크가 커질 수 있어 거래량과 손절폭 검증이 필요합니다.",
  },
];

function decodeXml(value: string) {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .trim();
}

function decodeJsEscapes(value: string) {
  try {
    return JSON.parse(`"${value.replace(/"/g, '\\"')}"`);
  } catch {
    return value;
  }
}

function stripTags(value: string) {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeYouTubeLabelTitle(value: string) {
  return decodeXml(decodeJsEscapes(value))
    .replace(/\s+\d+\s*시간\s*\d+\s*분\s*$/, "")
    .replace(/\s+\d+\s*시간\s*$/, "")
    .replace(/\s+\d+\s*분\s*\d+\s*초\s*$/, "")
    .replace(/\s+\d+\s*분\s*$/, "")
    .replace(/\s+\d+\s*초\s*$/, "")
    .trim();
}

function firstMatch(entry: string, pattern: RegExp) {
  const match = entry.match(pattern);
  return match ? decodeXml(stripTags(match[1] ?? "")) : "";
}

export function parseYouTubeVideoFeed(xml: string): YouTubeStrategySource[] {
  const entries = xml.match(/<entry[\s\S]*?<\/entry>/g) ?? [];

  return entries
    .map(entry => {
      const videoId = firstMatch(entry, /<yt:videoId>([\s\S]*?)<\/yt:videoId>/);
      if (!videoId) {
        return null;
      }

      return {
        videoId,
        title: firstMatch(entry, /<title>([\s\S]*?)<\/title>/),
        publishedAt: firstMatch(entry, /<published>([\s\S]*?)<\/published>/),
        url: `https://www.youtube.com/watch?v=${videoId}`,
        description: firstMatch(entry, /<media:description>([\s\S]*?)<\/media:description>/),
      };
    })
    .filter((source): source is YouTubeStrategySource => Boolean(source));
}

export function parseYouTubeChannelHtml(html: string): YouTubeStrategySource[] {
  const seen = new Set<string>();
  const sources: YouTubeStrategySource[] = [];
  const videoMatches = Array.from(html.matchAll(/"videoId":"([^"]+)"[\s\S]{0,1200}?"title":\{"runs":\[\{"text":"([^"]+)"/g));

  for (const match of videoMatches) {
    const videoId = decodeXml(match[1] ?? "");
    if (!videoId || seen.has(videoId)) {
      continue;
    }
    seen.add(videoId);
    sources.push({
      videoId,
      title: decodeXml(match[2] ?? ""),
      publishedAt: "",
      url: `https://www.youtube.com/watch?v=${videoId}`,
      description: "",
    });
  }

  if (sources.length) {
    return sources;
  }

  const contentBlocks = html.split('"contentId":"').slice(1);
  for (const block of contentBlocks) {
    const videoId = decodeXml(block.slice(0, block.indexOf('"')));
    if (!videoId || seen.has(videoId)) {
      continue;
    }

    const window = block.slice(0, 3500);
    const labelMatch = window.match(/"label":"([^"]+)"/);
    const titleMatch = window.match(/"title":\{"content":"([^"]+)"/);
    const title = normalizeYouTubeLabelTitle(titleMatch?.[1] ?? labelMatch?.[1] ?? "");

    if (!title || title === "현재 재생목록에 추가" || title === "추가됨") {
      continue;
    }

    seen.add(videoId);
    sources.push({
      videoId,
      title,
      publishedAt: "",
      url: `https://www.youtube.com/watch?v=${videoId}`,
      description: "",
    });
  }

  if (sources.length) {
    return sources;
  }

  for (const match of html.match(/"videoId":"[^"]+"/g) ?? []) {
    const videoId = decodeXml(match.replace(/^"videoId":"|"$|\\u0026.*$/g, ""));
    if (!videoId || seen.has(videoId)) {
      continue;
    }
    seen.add(videoId);
    sources.push({
      videoId,
      title: "YouTube channel video",
      publishedAt: "",
      url: `https://www.youtube.com/watch?v=${videoId}`,
      description: "",
    });
  }

  return sources;
}

function sourceText(source: YouTubeStrategySource) {
  return [source.title, source.description, source.transcriptSummary].filter(Boolean).join(" ");
}

function countKeywordHits(text: string, keywords: string[]) {
  return keywords.reduce((count, keyword) => count + (text.includes(keyword) ? 1 : 0), 0);
}

export function buildDanteStrategyInsights(
  sources: YouTubeStrategySource[],
  now = new Date()
): DanteLearningReport {
  const rules = RULE_DEFINITIONS.map(definition => {
    const evidenceCount = sources.filter(source => {
      const text = sourceText(source);
      return countKeywordHits(text, definition.keywords) >= (definition.minHits ?? 2);
    }).length;

    if (!evidenceCount) {
      return null;
    }

    return {
      id: definition.id,
      label: definition.label,
      confidence: Math.min(95, 45 + evidenceCount * 12),
      evidenceCount,
      keywords: definition.keywords,
      summary: definition.summary,
    };
  }).filter((rule): rule is DanteStrategyRule => Boolean(rule));

  return {
    channelId: DANTE_CHANNEL_ID,
    channelName: DANTE_CHANNEL_NAME,
    generatedAt: now.toISOString(),
    sources,
    rules: rules.sort((a, b) => b.confidence - a.confidence),
    notes: [
      "공개 영상 메타데이터와 접근 가능한 자막 요약만 사용했습니다.",
      "저작권 보호를 위해 영상 원문 전체나 자막 원문 전체는 저장하지 않고 규칙/요약만 보관합니다.",
      "유튜브 학습 결과는 투자 조언 복제가 아니라 차트 규칙 보조 점수로만 사용합니다.",
    ],
  };
}

export function scoreDanteAlignment(
  candidate: DanteCandidateInput,
  report: DanteLearningReport
): DanteAlignmentScore {
  const text = [
    ...(candidate.patterns ?? []),
    ...(candidate.setup ?? []),
    ...(candidate.reason ?? []),
  ].join(" ");
  const matchedRules = report.rules
    .filter(rule => {
      const definition = RULE_DEFINITIONS.find(item => item.id === rule.id);
      return definition ? countKeywordHits(text, definition.candidateKeywords) >= 1 : false;
    })
    .map(rule => rule.id);

  let score = Math.min(80, matchedRules.length * 18);
  const warnings: string[] = [];

  if ((candidate.volumeRatio ?? 0) >= 1.2) {
    score += 10;
  } else if (candidate.volumeRatio !== undefined && candidate.volumeRatio < 0.9) {
    warnings.push("거래량 확인 부족");
    score -= 8;
  }

  if ((candidate.rsi14 ?? 0) >= 82 || text.includes("신고가")) {
    warnings.push("고점 추격/과열 위험");
    score -= 10;
  }

  return {
    score: Math.max(0, Math.min(100, score)),
    matchedRules,
    warnings,
  };
}

function compactTranscriptSummary(text: string) {
  const normalized = stripTags(decodeXml(text)).replace(/\s+/g, " ");
  const sentences = normalized
    .split(/(?<=[.!?。！？])\s+|(?<=다)\s+/)
    .filter(sentence => countKeywordHits(sentence, RULE_DEFINITIONS.flatMap(rule => rule.keywords)) > 0)
    .slice(0, 5);

  return sentences.join(" ").slice(0, 700);
}

function extractCaptionUrl(watchHtml: string) {
  const match = watchHtml.match(/"captionTracks":(\[.*?\])/);
  if (!match?.[1]) {
    return null;
  }

  try {
    const tracks = JSON.parse(match[1].replace(/\\"/g, "\""));
    const koTrack = tracks.find((track: { languageCode?: string }) => track.languageCode === "ko") ?? tracks[0];
    return koTrack?.baseUrl ? String(koTrack.baseUrl).replace(/\\u0026/g, "&") : null;
  } catch {
    return null;
  }
}

async function fetchTranscriptSummary(videoId: string, timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const watchResponse = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      signal: controller.signal,
      headers: { "user-agent": "Mozilla/5.0" },
    });
    const watchHtml = await watchResponse.text();
    const captionUrl = extractCaptionUrl(watchHtml);
    if (!captionUrl) {
      return undefined;
    }

    const captionResponse = await fetch(captionUrl, {
      signal: controller.signal,
      headers: { "user-agent": "Mozilla/5.0" },
    });
    const captionXml = await captionResponse.text();
    return compactTranscriptSummary(captionXml) || undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

export async function collectDanteLearningReport(options: {
  channelId?: string;
  maxVideos?: number;
  transcriptLimit?: number;
  timeoutMs?: number;
} = {}): Promise<DanteLearningReport> {
  const channelId = options.channelId ?? DANTE_CHANNEL_ID;
  const maxVideos = options.maxVideos ?? DEFAULT_MAX_VIDEOS;
  const transcriptLimit = options.transcriptLimit ?? 6;
  const timeoutMs = options.timeoutMs ?? 8000;
  const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`;
  const response = await fetch(feedUrl, {
    headers: { "user-agent": "Mozilla/5.0" },
  });

  if (!response.ok) {
    const channelResponse = await fetch(`https://www.youtube.com/channel/${encodeURIComponent(channelId)}/videos`, {
      headers: { "user-agent": "Mozilla/5.0" },
    });
    if (!channelResponse.ok) {
      throw new Error(`YouTube RSS fetch failed: ${response.status}; channel page fetch failed: ${channelResponse.status}`);
    }
    const fallbackSources = parseYouTubeChannelHtml(await channelResponse.text()).slice(0, maxVideos);
    if (!fallbackSources.length) {
      throw new Error(`YouTube RSS fetch failed: ${response.status}; channel page had no parseable videos`);
    }
    return buildDanteStrategyInsights(fallbackSources);
  }

  const sources = parseYouTubeVideoFeed(await response.text()).slice(0, maxVideos);
  const withTranscripts = await Promise.all(
    sources.map(async (source, index) => {
      if (index >= transcriptLimit) {
        return source;
      }
      return {
        ...source,
        transcriptSummary: await fetchTranscriptSummary(source.videoId, timeoutMs),
      };
    })
  );

  return buildDanteStrategyInsights(withTranscripts);
}
