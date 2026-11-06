import { adminReply } from "./telegram-admin";
import { legacyDevice, listDevices, loadConfig } from "./owner";
import { STATUS_BUTTON, TELEGRAM_API } from "./constants";
import { DeyeClient } from "./deye";
import { readDeyeConfig, type Env } from "./env";
import { post } from "./http";
import { formatStatus } from "./status";

export class TelegramClient {
  constructor(private readonly token: string, private readonly chatId: string) {}

  async sendStatusMessage(text: string, keyboard = true): Promise<void> {
    const result = await post<{ ok: boolean }>(
      `${TELEGRAM_API}/bot${this.token}/sendMessage`,
      {
        chat_id: this.chatId,
        text,
        link_preview_options: { is_disabled: true },
        ...(keyboard ? { reply_markup: {
          keyboard: [[{ text: STATUS_BUTTON }]],
          resize_keyboard: true,
          is_persistent: true,
        } } : {}),
      },
    );
    if (!result.ok) throw new Error("Telegram rejected the message");
  }
}

interface TelegramUpdate {
  message?: { chat: { id: number; type: string }; from?: { id: number; is_bot?: boolean }; text?: string };
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
  if (!message?.chat || typeof message.text !== "string") return new Response(null, { status: 204 });

  const chatId = String(message.chat.id);
  const userId = String(message.from?.id ?? "");
  const ownerId = env.ADMIN_TELEGRAM_USER_ID;
  const owner = !!ownerId && userId === ownerId && !message.from?.is_bot;
  const privateChat = message.chat.type === "private" && chatId === userId;
  const legacyChat = chatId === env.TELEGRAM_CHAT_ID;
  const [rawCommand, ...args] = message.text.trim().split(/\s+/);
  const command = rawCommand.split("@")[0];
  const client = new TelegramClient(env.TELEGRAM_BOT_TOKEN, chatId);

  try {
    const adminText = owner && (privateChat || ["/admin", "/bind", "/unbind"].includes(command))
      ? await adminReply(command, args, chatId, ownerId, env, new URL(request.url).origin)
      : undefined;
    if (adminText) {
      await client.sendStatusMessage(adminText, false);
      return new Response(null, { status: 204 });
    }

    if (command === "/id" && privateChat) {
      await client.sendStatusMessage("Твой Telegram User ID: " + userId, false);
      return new Response(null, { status: 204 });
    }

    const requested = command === "/status" || message.text === STATUS_BUTTON;
    if (!requested && command !== "/start") return new Response(null, { status: 204 });
    if (!privateChat && !legacyChat) return new Response(null, { status: 204 });

    const db = env.GRID_DB;
    const devices = privateChat && db ? await listDevices(db) : [];
    const grants = privateChat && db && !owner ? (await db.prepare(
      "SELECT device_sn FROM device_access WHERE user_id = ?1",
    ).bind(userId).all<{ device_sn: string }>()).results : [];
    const allowed = new Set(grants.map(row => row.device_sn));
    const available = devices.filter(row => owner || allowed.has(row.device_sn));
    const legacy = legacyDevice(env);
    const canReadLegacy = legacy && (legacyChat || owner || allowed.has(legacy.device_sn));
    const choices = canReadLegacy && !available.some(row => row.device_sn === legacy.device_sn)
      ? [legacy, ...available] : available;
    if (!choices.length) return new Response(null, { status: 204 });

    let text = "Выбери объект:\n" + choices.map(row => row.name + " · /status " + row.device_sn).join("\n");
    const selected = args.length ? choices.find(row => row.device_sn === args[0])
      : choices.length === 1 ? choices[0] : undefined;
    if (requested && selected) {
      try {
        const row = devices.find(device => device.device_sn === selected.device_sn);
        const config = row ? await loadConfig(env, row) : readDeyeConfig(env);
        const { station, device } = await new DeyeClient(config).getTelemetry();
        text = selected.name + "\n\n" + formatStatus(station, device);
      } catch {
        console.warn("Deye Cloud status request failed");
        text = "Не удалось получить данные Deye Cloud. Попробуй ещё раз позже.";
      }
    }
    await client.sendStatusMessage(text.slice(0, 3900), privateChat || legacyChat);
  } catch {
    console.warn("Telegram update processing failed");
    return new Response(null, { status: 502 });
  }
  return new Response(null, { status: 204 });
}
