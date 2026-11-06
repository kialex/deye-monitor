import { recordMembership, requestButtons, resolveRequest, type ChatMembership } from "./chat-requests";
import { adminReply } from "./telegram-admin";
import { legacyDevice, listDevices, loadConfig } from "./owner";
import { STATUS_BUTTON, TELEGRAM_API } from "./constants";
import { DeyeClient } from "./deye";
import { readDeyeConfig, type Env } from "./env";
import { post } from "./http";
import { formatStatus } from "./status";

export class TelegramClient {
  constructor(private readonly token: string, private readonly chatId: string) {}

  async sendStatusMessage(text: string, keyboard: boolean | { remove_keyboard: true } | { inline_keyboard: { text: string; callback_data: string }[][] } = true): Promise<void> {
    const result = await post<{ ok: boolean }>(
      `${TELEGRAM_API}/bot${this.token}/sendMessage`,
      {
        chat_id: this.chatId,
        text,
        link_preview_options: { is_disabled: true },
        ...(typeof keyboard === "object" ? { reply_markup: keyboard } : keyboard ? { reply_markup: {
          keyboard: [[{ text: STATUS_BUTTON }]],
          resize_keyboard: true,
          is_persistent: true,
        } } : {}),
      },
    );
    if (!result.ok) throw new Error("Telegram rejected the message");
  }
}

const ownerMenu = { inline_keyboard: [
  [{ text: STATUS_BUTTON, callback_data: "menu:status" }, { text: "➕ Добавить инвертор", callback_data: "menu:add" }],
  [{ text: "🔔 Заявки", callback_data: "menu:requests" }, { text: "📋 Станции", callback_data: "menu:stations" }],
  [{ text: "👤 Мои подписки", callback_data: "menu:subscriptions" }],
] };

interface TelegramUpdate {
  update_id: number;
  my_chat_member?: ChatMembership;
  callback_query?: { id: string; from: { id: number }; message?: { chat: { id: number; type: string } }; data?: string };
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

  const ownerId = env.ADMIN_TELEGRAM_USER_ID;
  if (ownerId && (update.my_chat_member || update.callback_query)) {
    const client = new TelegramClient(env.TELEGRAM_BOT_TOKEN, ownerId);
    try {
      if (update.my_chat_member) {
        const pending = await recordMembership(env, update.my_chat_member, update.update_id);
        if (pending) {
          const buttons = await requestButtons(env, pending.chat_id);
          await client.sendStatusMessage(
            "🔔 Новый чат хочет получать оповещения\n" + pending.title +
            "\nВыбери инвертор. Если его ещё нет, используй /add, затем /requests.",
            { inline_keyboard: buttons },
          );
          await env.GRID_DB?.prepare("UPDATE chat_requests SET notified_at = ?1 WHERE chat_id = ?2 AND update_id = ?3 RETURNING chat_id")
            .bind(Date.now(), pending.chat_id, update.update_id).first();
        }
      } else if (update.callback_query) {
        const callback = update.callback_query;
        if (String(callback.from.id) === ownerId && String(callback.message?.chat.id) === ownerId &&
            callback.message?.chat.type === "private") {
          const [action, target, serial] = (callback.data ?? "").split(":");
          const answer = action === "menu" ? undefined : await resolveRequest(env, action, target ?? "", serial);
          await post(`${TELEGRAM_API}/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
            callback_query_id: callback.id, ...(answer ? { text: answer, show_alert: true } : {}),
          });
          if (action === "menu" && target &&
              ["admin", "status", "add", "requests", "stations", "subscriptions", "bind", "unbind"].includes(target)) {
            return handleMessage({
              chat: callback.message.chat,
              from: callback.from,
              text: "/" + target + (serial ? " " + serial : ""),
            }, request, env);
          }
        }
      }
      return new Response(null, { status: 204 });
    } catch {
      console.warn("Telegram chat request processing failed");
      return new Response(null, { status: 502 });
    }
  }

  return handleMessage(update?.message, request, env);
}

async function handleMessage(message: TelegramUpdate["message"], request: Request, env: Env): Promise<Response> {
  const ownerId = env.ADMIN_TELEGRAM_USER_ID;
  if (!message?.chat || typeof message.text !== "string") return new Response(null, { status: 204 });

  const chatId = String(message.chat.id);
  const userId = String(message.from?.id ?? "");
  const owner = !!ownerId && userId === ownerId && !message.from?.is_bot;
  const privateChat = message.chat.type === "private" && chatId === userId;
  const [rawCommand, ...args] = message.text.trim().split(/\s+/);
  const command = rawCommand.split("@")[0];
  const client = new TelegramClient(env.TELEGRAM_BOT_TOKEN, chatId);

  try {
    if (owner && privateChat && ["/start", "/admin"].includes(command)) {
      await client.sendStatusMessage("Управление Deye", { remove_keyboard: true });
      await client.sendStatusMessage("Выбери действие.", ownerMenu);
      return new Response(null, { status: 204 });
    }

    if (owner && privateChat && command === "/requests" && env.GRID_DB) {
      const { results } = await env.GRID_DB.prepare(
        "SELECT chat_id, title FROM chat_requests WHERE state = 'pending' ORDER BY update_id DESC LIMIT 20",
      ).all<{ chat_id: string; title: string }>();
      if (!results.length) await client.sendStatusMessage("Открытых заявок нет.", false);
      for (const pending of results) {
        await client.sendStatusMessage("🔔 " + pending.title + " · " + pending.chat_id, {
          inline_keyboard: await requestButtons(env, pending.chat_id),
        });
      }
      return new Response(null, { status: 204 });
    }

    if (owner && privateChat && command === "/approve") {
      await client.sendStatusMessage(await resolveRequest(env, "approve", args[0] ?? "", args[1]), false);
      return new Response(null, { status: 204 });
    }

    if (owner && privateChat && command === "/subscriptions" && env.GRID_DB) {
      const devices = await listDevices(env.GRID_DB);
      const legacy = legacyDevice(env);
      const choices = legacy && !devices.some(row => row.device_sn === legacy.device_sn) ? [legacy, ...devices] : devices;
      const { results } = await env.GRID_DB.prepare(
        "SELECT device_sn, enabled FROM chat_subscriptions WHERE chat_id = ?1",
      ).bind(chatId).all<{ device_sn: string; enabled: number }>();
      const buttons = choices.slice(0, 30).flatMap(row => {
        const saved = results.find(item => item.device_sn === row.device_sn);
        const enabled = saved ? saved.enabled === 1
          : row.device_sn === env.DEYE_DEVICE_SN && chatId === env.TELEGRAM_CHAT_ID;
        const data = "menu:" + (enabled ? "unbind:" : "bind:") + row.device_sn;
        return new TextEncoder().encode(data).length <= 64
          ? [[{ text: ((enabled ? "🔕 Отключить · " : "🔔 Включить · ") + row.name).slice(0, 64), callback_data: data }]] : [];
      });
      await client.sendStatusMessage("Личные подписки", { inline_keyboard: [...buttons, ...ownerMenu.inline_keyboard] });
      return new Response(null, { status: 204 });
    }

    const adminText = owner && (privateChat || ["/admin", "/bind", "/unbind"].includes(command))
      ? await adminReply(command, args, chatId, ownerId, env, new URL(request.url).origin)
      : undefined;
    if (adminText) {
      await client.sendStatusMessage(adminText, owner && privateChat ? ownerMenu : false);
      return new Response(null, { status: 204 });
    }

    if (command === "/id" && privateChat) {
      await client.sendStatusMessage("Твой Telegram User ID: " + userId, false);
      return new Response(null, { status: 204 });
    }

    const requested = command === "/status" || message.text === STATUS_BUTTON;
    if (!requested && command !== "/start") return new Response(null, { status: 204 });
    if (!owner || !privateChat) {
      if (requested) {
        await client.sendStatusMessage("Состояние доступно владельцу бота.", { remove_keyboard: true });
      }
      return new Response(null, { status: 204 });
    }

    const devices = env.GRID_DB ? await listDevices(env.GRID_DB) : [];
    const legacy = legacyDevice(env);
    const choices = legacy && !devices.some(row => row.device_sn === legacy.device_sn)
      ? [legacy, ...devices] : devices;
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
    const buttons = selected ? [] : choices.slice(0, 30).flatMap(row => {
      const data = "menu:status:" + row.device_sn;
      return new TextEncoder().encode(data).length <= 64
        ? [[{ text: row.name.slice(0, 64), callback_data: data }]] : [];
    });
    await client.sendStatusMessage(selected ? text.slice(0, 3900) : "Выбери станцию.", {
      inline_keyboard: [...buttons, ...ownerMenu.inline_keyboard],
    });
  } catch {
    console.warn("Telegram update processing failed");
    return new Response(null, { status: 502 });
  }
  return new Response(null, { status: 204 });
}
