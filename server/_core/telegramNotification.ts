import { ENV } from "./env";
import https from "node:https";

function hasTelegramConfig(chatId: string) {
  return Boolean(ENV.telegramBotToken && chatId);
}

function escapeTelegramMarkdown(text: string) {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!])/g, "\\$1");
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

type TelegramHttpResponse = {
  ok: boolean;
  status: number;
  statusText: string;
  text: () => Promise<string>;
};

/** Single POST to any Bot API method. Same transport settings for every call. */
async function callTelegram(
  method: string,
  payload: Record<string, unknown>,
  attempt: number
): Promise<TelegramHttpResponse | null> {
  const url = new URL(`https://api.telegram.org/bot${ENV.telegramBotToken}/${method}`);
  const body = JSON.stringify(payload);

  try {
    return await new Promise<TelegramHttpResponse>((resolve, reject) => {
      const request = https.request({
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        method: "POST",
        family: 4,
        timeout: 20000,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      }, response => {
        const chunks: Buffer[] = [];
        response.on("data", chunk => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on("end", () => {
          const responseText = Buffer.concat(chunks).toString("utf8");
          resolve({
            ok: (response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300,
            status: response.statusCode ?? 0,
            statusText: response.statusMessage ?? "",
            text: async () => responseText,
          });
        });
      });

      request.on("timeout", () => {
        request.destroy(new Error("Telegram request timed out"));
      });
      request.on("error", reject);
      request.write(body);
      request.end();
    });
  } catch (error) {
    console.warn(`[Telegram] Error calling ${method} (attempt ${attempt}):`, error);
    return null;
  }
}

async function sendWithRetry(
  method: string,
  payload: Record<string, unknown>
): Promise<boolean> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await callTelegram(method, payload, attempt);

    if (!response) {
      if (attempt < 3) {
        await sleep(1500 * attempt);
        continue;
      }
      return false;
    }

    if (response.ok) {
      return true;
    }

    const detail = await response.text().catch(() => "");
    console.warn(
      `[Telegram] Failed ${method} (${response.status} ${response.statusText})${
        detail ? `: ${detail}` : ""
      }`
    );

    if (attempt < 3 && (response.status === 429 || response.status >= 500)) {
      await sleep(1500 * attempt);
      continue;
    }

    return false;
  }

  return false;
}

export async function sendTelegramMessage(
  title: string,
  content: string,
  chatId: string = ENV.telegramChatId
): Promise<boolean> {
  if (!hasTelegramConfig(chatId)) {
    return false;
  }

  const message = `${escapeTelegramMarkdown(title)}\n\n${escapeTelegramMarkdown(content)}`;
  return sendWithRetry("sendMessage", {
    chat_id: chatId,
    text: message.slice(0, 4000),
    parse_mode: "MarkdownV2",
    disable_web_page_preview: true,
  });
}

export type TelegramInlineButton = {
  text: string;
  /** ≤64 bytes — Telegram rejects anything longer. */
  callbackData: string;
};

/**
 * Same as sendTelegramMessage but with tappable buttons underneath.
 *
 * Used for the one-tap decision journal: the commander logs a decision by
 * tapping, never by typing. Taps are collected on the next scheduled run via
 * fetchTelegramCallbackTaps — no webhook or always-on server involved.
 */
export async function sendTelegramMessageWithButtons(
  title: string,
  content: string,
  buttons: TelegramInlineButton[][],
  chatId: string = ENV.telegramChatId
): Promise<boolean> {
  if (!hasTelegramConfig(chatId)) {
    return false;
  }

  const message = `${escapeTelegramMarkdown(title)}\n\n${escapeTelegramMarkdown(content)}`;
  const inlineKeyboard = buttons
    .map(row =>
      row
        .filter(button => Buffer.byteLength(button.callbackData) <= 64)
        .map(button => ({ text: button.text, callback_data: button.callbackData }))
    )
    .filter(row => row.length > 0);

  return sendWithRetry("sendMessage", {
    chat_id: chatId,
    text: message.slice(0, 4000),
    parse_mode: "MarkdownV2",
    disable_web_page_preview: true,
    ...(inlineKeyboard.length ? { reply_markup: { inline_keyboard: inlineKeyboard } } : {}),
  });
}

export type TelegramTap = {
  updateId: number;
  callbackQueryId?: string;
  /** callback_data for a button tap, or raw text for a typed reply. */
  data: string;
  kind: "tap" | "text";
  chatId?: string;
  receivedAt: string;
};

type RawUpdate = {
  update_id?: number;
  callback_query?: {
    id?: string;
    data?: string;
    message?: { chat?: { id?: number | string } };
  };
  message?: {
    text?: string;
    chat?: { id?: number | string };
  };
};

/**
 * Drain pending updates.
 *
 * `offset` must be lastUpdateId + 1; Telegram then drops everything before it,
 * which is what stops a tap being counted twice. The offset is persisted in the
 * tracked decision journal because CI runners are ephemeral — keeping it in
 * .data would silently replay a day of taps on every run.
 */
export async function fetchTelegramTaps(
  offset?: number
): Promise<{ taps: TelegramTap[]; lastUpdateId: number | null }> {
  if (!ENV.telegramBotToken) {
    return { taps: [], lastUpdateId: null };
  }

  const response = await callTelegram(
    "getUpdates",
    {
      ...(typeof offset === "number" ? { offset } : {}),
      timeout: 0,
      limit: 100,
      allowed_updates: ["callback_query", "message"],
    },
    1
  );
  if (!response?.ok) {
    if (response) {
      const detail = await response.text().catch(() => "");
      console.warn(`[Telegram] getUpdates failed (${response.status})${detail ? `: ${detail}` : ""}`);
    }
    return { taps: [], lastUpdateId: null };
  }

  let parsed: { ok?: boolean; result?: RawUpdate[] };
  try {
    parsed = JSON.parse(await response.text());
  } catch (error) {
    console.warn("[Telegram] getUpdates returned unparsable body:", error);
    return { taps: [], lastUpdateId: null };
  }

  const receivedAt = new Date().toISOString();
  const taps: TelegramTap[] = [];
  let lastUpdateId: number | null = null;

  for (const update of parsed.result ?? []) {
    if (typeof update.update_id !== "number") continue;
    lastUpdateId = Math.max(lastUpdateId ?? update.update_id, update.update_id);

    const callback = update.callback_query;
    if (callback?.data) {
      taps.push({
        updateId: update.update_id,
        callbackQueryId: callback.id,
        data: callback.data,
        kind: "tap",
        chatId: callback.message?.chat?.id != null ? String(callback.message.chat.id) : undefined,
        receivedAt,
      });
      continue;
    }

    const text = update.message?.text?.trim();
    if (text) {
      taps.push({
        updateId: update.update_id,
        data: text,
        kind: "text",
        chatId: update.message?.chat?.id != null ? String(update.message.chat.id) : undefined,
        receivedAt,
      });
    }
  }

  return { taps, lastUpdateId };
}

/**
 * Clears the button's loading spinner. Taps are usually processed a day later,
 * by which point Telegram has expired the query — that failure is expected and
 * deliberately not retried.
 */
export async function answerTelegramCallback(
  callbackQueryId: string,
  text?: string
): Promise<void> {
  if (!ENV.telegramBotToken) return;
  await callTelegram(
    "answerCallbackQuery",
    { callback_query_id: callbackQueryId, ...(text ? { text } : {}) },
    1
  ).catch(() => null);
}
