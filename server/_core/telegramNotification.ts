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

async function postTelegramMessage(message: string, attempt: number, chatId: string): Promise<TelegramHttpResponse | null> {
  const url = new URL(`https://api.telegram.org/bot${ENV.telegramBotToken}/sendMessage`);
  const body = JSON.stringify({
    chat_id: chatId,
    text: message.slice(0, 4000),
    parse_mode: "MarkdownV2",
    disable_web_page_preview: true,
  });

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
    console.warn(`[Telegram] Error calling sendMessage (attempt ${attempt}):`, error);
    return null;
  }
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

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await postTelegramMessage(message, attempt, chatId);

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
      `[Telegram] Failed to send message (${response.status} ${response.statusText})${
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
