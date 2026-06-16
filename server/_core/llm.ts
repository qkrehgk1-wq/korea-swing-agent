import Anthropic from "@anthropic-ai/sdk";
import { ENV } from "./env";

export type Role = "system" | "user" | "assistant" | "tool" | "function";

export type TextContent = {
  type: "text";
  text: string;
};

export type ImageContent = {
  type: "image_url";
  image_url: {
    url: string;
    detail?: "auto" | "low" | "high";
  };
};

export type FileContent = {
  type: "file_url";
  file_url: {
    url: string;
    mime_type?: "audio/mpeg" | "audio/wav" | "application/pdf" | "audio/mp4" | "video/mp4" ;
  };
};

export type MessageContent = string | TextContent | ImageContent | FileContent;

export type Message = {
  role: Role;
  content: MessageContent | MessageContent[];
  name?: string;
  tool_call_id?: string;
};

export type Tool = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
};

export type ToolChoicePrimitive = "none" | "auto" | "required";
export type ToolChoiceByName = { name: string };
export type ToolChoiceExplicit = {
  type: "function";
  function: {
    name: string;
  };
};

export type ToolChoice =
  | ToolChoicePrimitive
  | ToolChoiceByName
  | ToolChoiceExplicit;

export type InvokeParams = {
  messages: Message[];
  tools?: Tool[];
  toolChoice?: ToolChoice;
  tool_choice?: ToolChoice;
  maxTokens?: number;
  max_tokens?: number;
  outputSchema?: OutputSchema;
  output_schema?: OutputSchema;
  responseFormat?: ResponseFormat;
  response_format?: ResponseFormat;
};

export type ToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type InvokeResult = {
  id: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: Role;
      content: string | Array<TextContent | ImageContent | FileContent>;
      tool_calls?: ToolCall[];
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

export type JsonSchema = {
  name: string;
  schema: Record<string, unknown>;
  strict?: boolean;
};

export type OutputSchema = JsonSchema;

export type ResponseFormat =
  | { type: "text" }
  | { type: "json_object" }
  | { type: "json_schema"; json_schema: JsonSchema };

const ensureArray = (
  value: MessageContent | MessageContent[]
): MessageContent[] => (Array.isArray(value) ? value : [value]);

const normalizeContentPart = (
  part: MessageContent
): TextContent | ImageContent | FileContent => {
  if (typeof part === "string") {
    return { type: "text", text: part };
  }

  if (part.type === "text") {
    return part;
  }

  if (part.type === "image_url") {
    return part;
  }

  if (part.type === "file_url") {
    return part;
  }

  throw new Error("Unsupported message content part");
};

const normalizeMessage = (message: Message) => {
  const { role, name, tool_call_id } = message;

  if (role === "tool" || role === "function") {
    const content = ensureArray(message.content)
      .map(part => (typeof part === "string" ? part : JSON.stringify(part)))
      .join("\n");

    return {
      role,
      name,
      tool_call_id,
      content,
    };
  }

  const contentParts = ensureArray(message.content).map(normalizeContentPart);

  // If there's only text content, collapse to a single string for compatibility
  if (contentParts.length === 1 && contentParts[0].type === "text") {
    return {
      role,
      name,
      content: contentParts[0].text,
    };
  }

  return {
    role,
    name,
    content: contentParts,
  };
};

const normalizeToolChoice = (
  toolChoice: ToolChoice | undefined,
  tools: Tool[] | undefined
): "none" | "auto" | ToolChoiceExplicit | undefined => {
  if (!toolChoice) return undefined;

  if (toolChoice === "none" || toolChoice === "auto") {
    return toolChoice;
  }

  if (toolChoice === "required") {
    if (!tools || tools.length === 0) {
      throw new Error(
        "tool_choice 'required' was provided but no tools were configured"
      );
    }

    if (tools.length > 1) {
      throw new Error(
        "tool_choice 'required' needs a single tool or specify the tool name explicitly"
      );
    }

    return {
      type: "function",
      function: { name: tools[0].function.name },
    };
  }

  if ("name" in toolChoice) {
    return {
      type: "function",
      function: { name: toolChoice.name },
    };
  }

  return toolChoice;
};

const resolveApiUrl = () =>
  ENV.forgeApiUrl && ENV.forgeApiUrl.trim().length > 0
    ? `${ENV.forgeApiUrl.replace(/\/$/, "")}/v1/chat/completions`
    : "https://forge.manus.im/v1/chat/completions";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Retry only on transient failures (network errors, timeouts, 429, 5xx).
// A 4xx other than 429 usually means a bad request/model and should fail fast.
const isRetriableStatus = (status: number) =>
  status === 408 || status === 429 || status >= 500;

const normalizeResponseFormat = ({
  responseFormat,
  response_format,
  outputSchema,
  output_schema,
}: {
  responseFormat?: ResponseFormat;
  response_format?: ResponseFormat;
  outputSchema?: OutputSchema;
  output_schema?: OutputSchema;
}):
  | { type: "json_schema"; json_schema: JsonSchema }
  | { type: "text" }
  | { type: "json_object" }
  | undefined => {
  const explicitFormat = responseFormat || response_format;
  if (explicitFormat) {
    if (
      explicitFormat.type === "json_schema" &&
      !explicitFormat.json_schema?.schema
    ) {
      throw new Error(
        "responseFormat json_schema requires a defined schema object"
      );
    }
    return explicitFormat;
  }

  const schema = outputSchema || output_schema;
  if (!schema) return undefined;

  if (!schema.name || !schema.schema) {
    throw new Error("outputSchema requires both name and schema");
  }

  return {
    type: "json_schema",
    json_schema: {
      name: schema.name,
      schema: schema.schema,
      ...(typeof schema.strict === "boolean" ? { strict: schema.strict } : {}),
    },
  };
};

type HttpError = Error & { status?: number };

function buildOpenAIPayload(params: InvokeParams, model: string): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    model,
    messages: params.messages.map(normalizeMessage),
    max_tokens: params.maxTokens ?? params.max_tokens ?? ENV.llmMaxTokens,
  };

  if (params.tools && params.tools.length > 0) {
    payload.tools = params.tools;
  }
  const normalizedToolChoice = normalizeToolChoice(params.toolChoice || params.tool_choice, params.tools);
  if (normalizedToolChoice) {
    payload.tool_choice = normalizedToolChoice;
  }
  const normalizedResponseFormat = normalizeResponseFormat({
    responseFormat: params.responseFormat,
    response_format: params.response_format,
    outputSchema: params.outputSchema,
    output_schema: params.output_schema,
  });
  if (normalizedResponseFormat) {
    payload.response_format = normalizedResponseFormat;
  }
  return payload;
}

async function postJsonOnce(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number
): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      const error: HttpError = new Error(
        `${response.status} ${response.statusText} – ${errorText.slice(0, 300)}`
      );
      error.status = response.status;
      throw error;
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

// Retry a single provider call on transient failures; fail fast otherwise so
// the caller can move to the next provider in the chain.
async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  const maxRetries = Math.max(0, ENV.llmMaxRetries);
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const status = (error as HttpError).status;
      const isAbort = error instanceof Error && error.name === "AbortError";
      const retriable = isAbort || status === undefined || isRetriableStatus(status);
      if (!retriable || attempt === maxRetries) break;
      await sleep(400 * 2 ** attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`${label} failed`);
}

// OpenAI-compatible /chat/completions — used by OpenAI, OpenRouter, and Forge.
async function callOpenAICompatible(
  params: InvokeParams,
  opts: { url: string; apiKey: string; model: string }
): Promise<InvokeResult> {
  const payload = buildOpenAIPayload(params, opts.model);
  return (await withRetry(
    () => postJsonOnce(opts.url, { authorization: `Bearer ${opts.apiKey}` }, payload, ENV.llmTimeoutMs),
    `openai-compatible(${opts.model})`
  )) as InvokeResult;
}

// Google Gemini (Generative Language API) — different request/response shape.
async function callGemini(params: InvokeParams): Promise<InvokeResult> {
  const systemParts: string[] = [];
  const contents: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }> = [];
  for (const message of params.messages) {
    const text = messageToText(message);
    if (!text) continue;
    if (message.role === "system") {
      systemParts.push(text);
    } else {
      contents.push({
        role: message.role === "assistant" ? "model" : "user",
        parts: [{ text }],
      });
    }
  }

  const body: Record<string, unknown> = {
    contents: contents.length ? contents : [{ role: "user", parts: [{ text: " " }] }],
    generationConfig: {
      maxOutputTokens: params.maxTokens ?? params.max_tokens ?? ENV.llmMaxTokens,
    },
  };
  if (systemParts.length) {
    body.systemInstruction = { parts: [{ text: systemParts.join("\n\n") }] };
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${ENV.geminiModel}:generateContent?key=${ENV.geminiApiKey}`;
  const data = await withRetry(
    () => postJsonOnce(url, {}, body, ENV.llmTimeoutMs),
    `gemini(${ENV.geminiModel})`
  );

  const text = (data?.candidates?.[0]?.content?.parts ?? [])
    .map((part: any) => (typeof part?.text === "string" ? part.text : ""))
    .join("");
  const usage = data?.usageMetadata ?? {};
  return {
    id: `gemini-${Date.now()}`,
    created: Date.now(),
    model: ENV.geminiModel,
    choices: [
      { index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" },
    ],
    usage: {
      prompt_tokens: usage.promptTokenCount ?? 0,
      completion_tokens: usage.candidatesTokenCount ?? 0,
      total_tokens: usage.totalTokenCount ?? 0,
    },
  };
}

let anthropicClient: Anthropic | null = null;

function getAnthropicClient(): Anthropic {
  if (!anthropicClient) {
    anthropicClient = new Anthropic({ apiKey: ENV.anthropicApiKey });
  }
  return anthropicClient;
}

function messageToText(message: Message): string {
  const parts = Array.isArray(message.content) ? message.content : [message.content];
  return parts
    .map(part => (typeof part === "string" ? part : part.type === "text" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

// Direct Anthropic Messages API call. Translates the OpenAI-shaped InvokeParams
// (system role inside messages) into Anthropic's shape (separate system field,
// only user/assistant turns) and adapts the response back to InvokeResult so
// callers stay unchanged. The SDK retries 429/5xx automatically.
async function callAnthropic(params: InvokeParams): Promise<InvokeResult> {
  const client = getAnthropicClient();

  const systemParts: string[] = [];
  const conversation: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const message of params.messages) {
    const text = messageToText(message);
    if (!text) continue;
    if (message.role === "system") {
      systemParts.push(text);
    } else if (message.role === "user" || message.role === "assistant") {
      conversation.push({ role: message.role, content: text });
    }
  }

  const message = await client.messages.create({
    model: ENV.anthropicModel,
    max_tokens: params.maxTokens ?? params.max_tokens ?? ENV.llmMaxTokens,
    ...(systemParts.length ? { system: systemParts.join("\n\n") } : {}),
    thinking: { type: "adaptive" },
    output_config: { effort: ENV.llmEffort },
    messages: conversation.length ? conversation : [{ role: "user", content: " " }],
  });

  const text = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map(block => block.text)
    .join("\n");

  return {
    id: message.id,
    created: Date.now(),
    model: message.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: message.stop_reason ?? "stop",
      },
    ],
    usage: {
      prompt_tokens: message.usage.input_tokens,
      completion_tokens: message.usage.output_tokens,
      total_tokens: message.usage.input_tokens + message.usage.output_tokens,
    },
  };
}

type LlmProvider = { name: string; available: boolean; call: () => Promise<InvokeResult> };

/**
 * Multi-provider LLM with a fallback chain. Tries each configured provider in
 * priority order (LLM_PROVIDER_ORDER) and moves to the next on any failure —
 * so a capped/rate-limited Anthropic key transparently falls through to
 * OpenAI → Gemini → OpenRouter → Forge instead of dropping to deterministic.
 */
export async function invokeLLM(params: InvokeParams): Promise<InvokeResult> {
  const registry: Record<string, () => LlmProvider> = {
    anthropic: () => ({
      name: "anthropic",
      available: Boolean(ENV.anthropicApiKey),
      call: () => callAnthropic(params),
    }),
    openai: () => ({
      name: "openai",
      available: Boolean(ENV.openaiApiKey),
      call: () =>
        callOpenAICompatible(params, {
          url: "https://api.openai.com/v1/chat/completions",
          apiKey: ENV.openaiApiKey,
          model: ENV.openaiModel,
        }),
    }),
    gemini: () => ({
      name: "gemini",
      available: Boolean(ENV.geminiApiKey),
      call: () => callGemini(params),
    }),
    openrouter: () => ({
      name: "openrouter",
      available: Boolean(ENV.openrouterApiKey),
      call: () =>
        callOpenAICompatible(params, {
          url: "https://openrouter.ai/api/v1/chat/completions",
          apiKey: ENV.openrouterApiKey,
          model: ENV.openrouterModel,
        }),
    }),
    forge: () => ({
      name: "forge",
      available: Boolean(ENV.forgeApiKey),
      call: () =>
        callOpenAICompatible(params, {
          url: resolveApiUrl(),
          apiKey: ENV.forgeApiKey,
          model: ENV.forgeModel,
        }),
    }),
  };

  const providers = ENV.llmProviderOrder
    .split(",")
    .map(name => registry[name.trim().toLowerCase()]?.())
    .filter((p): p is LlmProvider => Boolean(p && p.available));

  if (providers.length === 0) {
    throw new Error(
      "No LLM provider configured. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY, or BUILT_IN_FORGE_API_KEY."
    );
  }

  let lastError: unknown;
  for (const provider of providers) {
    try {
      return await provider.call();
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[LLM] provider '${provider.name}' failed, trying next: ${message.slice(0, 200)}`);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("All LLM providers failed");
}
