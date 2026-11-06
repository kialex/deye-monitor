import { STATUS_BUTTON, TELEGRAM_API } from "./constants";
import { DeyeClient } from "./deye";
import { readDeyeConfig, type Env } from "./env";
import { post } from "./http";
import { formatStatus } from "./status";

class TelegramClient {
  constructor(private readonly token: string, private readonly chatId: string) {}

  async sendStatusMessage(text: string): Promise<void> {
    const result = await post<{ ok: boolean }>(
      `${TELEGRAM_API}/bot${this.token}/sendMessage`,
      {
        chat_id: this.chatId,
        text,
        reply_markup: {
          keyboard: [[{ text: STATUS_BUTTON }]],
          resize_keyboard: true,
          is_persistent: true,
        },
      },
    );
    if (!result.ok) throw new Error("Telegram rejected the message");
  }
}

interface TelegramUpdate {
  message?: { chat: { id: number }; text?: string };
}

export async function handleTelegramWebhook(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (!env.TELEGRAM_WEBHOOK_SECRET || secret !== env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response(null, { status: 403 });
  }

  let update: TelegramUpdate;
  try {
    update = await request.json() as TelegramUpdate;
  } catch {
    return new Response(null, { status: 400 });
  }

  const message = update?.message;
  if (!message?.chat || String(message.chat.id) !== env.TELEGRAM_CHAT_ID ||
      typeof message.text !== "string") {
    return new Response(null, { status: 204 });
  }

  const command = message.text.split(/[@\s]/, 1)[0];
  let text = `Нажми «${STATUS_BUTTON}», чтобы получить показания Deye.`;
  if (command === "/status" || message.text === STATUS_BUTTON) {
    try {
      const config = readDeyeConfig(env);
      const { station, device } = await new DeyeClient(config).getTelemetry();
      text = formatStatus(station, device);
    } catch {
      console.warn("Deye Cloud status request failed");
      text = "Не удалось получить данные Deye Cloud. Попробуй ещё раз позже.";
    }
  } else if (command !== "/start") {
    return new Response(null, { status: 204 });
  }

  try {
    await new TelegramClient(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID).sendStatusMessage(text);
  } catch {
    console.warn("Telegram message delivery failed");
    return new Response(null, { status: 502 });
  }
  return new Response(null, { status: 204 });
}
