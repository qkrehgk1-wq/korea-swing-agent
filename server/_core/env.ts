import dotenv from "dotenv";

// Load .env.local first (takes precedence — dotenv never overwrites an
// already-set var), then .env. This lets a shared .env.local supply real keys
// (ANTHROPIC_API_KEY, TELEGRAM_*, news/search keys) without committing them.
dotenv.config({ path: ".env.local" });
dotenv.config();

export const ENV = {
  appId: process.env.VITE_APP_ID ?? "",
  cookieSecret: process.env.JWT_SECRET ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "",
  oAuthServerUrl: process.env.OAUTH_SERVER_URL ?? "",
  ownerOpenId: process.env.OWNER_OPEN_ID ?? "",
  isProduction: process.env.NODE_ENV === "production",
  allowLocalStoreFallback:
    process.env.NODE_ENV !== "production" ||
    process.env.ALLOW_LOCAL_STORE_FALLBACK === "true",
  forgeApiUrl: process.env.BUILT_IN_FORGE_API_URL ?? "",
  forgeApiKey: process.env.BUILT_IN_FORGE_API_KEY ?? "",
  // LLM model + tuning. Defaults to the most capable Claude model the Forge
  // proxy exposes; override with FORGE_MODEL if the gateway uses a different id.
  forgeModel: process.env.FORGE_MODEL ?? "claude-sonnet-4-6",
  forgeModelFallback: process.env.FORGE_MODEL_FALLBACK ?? "gemini-2.5-flash",
  llmTimeoutMs: Number(process.env.LLM_TIMEOUT_MS ?? 60000),
  llmMaxRetries: Number(process.env.LLM_MAX_RETRIES ?? 2),
  llmMaxTokens: Number(process.env.LLM_MAX_TOKENS ?? 4096),
  llmThinkingBudget: Number(process.env.LLM_THINKING_BUDGET ?? 0),
  // Anthropic direct — preferred path when ANTHROPIC_API_KEY is present.
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  anthropicModel: process.env.ANTHROPIC_MODEL ?? "claude-opus-4-8",
  llmEffort: (process.env.LLM_EFFORT ?? "high") as "low" | "medium" | "high" | "max",
  // Commander-only Telegram channel (raw high-conviction signals).
  commanderChatId: process.env.COMMANDER_CHAT_ID ?? "",
  // News / market-sentiment sources (optional).
  newsApiKey: process.env.NEWS_API_KEY ?? "",
  serperApiKey: process.env.SERPER_API_KEY ?? "",
  tavilyApiKey: process.env.TAVILY_API_KEY ?? "",
  kakaoRestApiKey: process.env.KAKAO_REST_API_KEY ?? "",
  kakaoClientSecret: process.env.KAKAO_CLIENT_SECRET ?? "",
  kakaoAccessToken: process.env.KAKAO_ACCESS_TOKEN ?? "",
  kakaoRefreshToken: process.env.KAKAO_REFRESH_TOKEN ?? "",
  kakaoWebUrl: process.env.KAKAO_WEB_URL ?? "",
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
  telegramChatId: process.env.TELEGRAM_CHAT_ID ?? "",
};
