import { recordMembership, recordPrivateRequest, requestButtons, resolveRequest, type ChatMembership } from "./chat-requests";
import { adminReply, changeSubscription } from "./telegram-admin";
import { legacyDevice, listDevices, loadConfig } from "./owner";
import { STATUS_BUTTON, TELEGRAM_API } from "./constants";
import { DeyeClient } from "./deye";
import { readDeyeConfig, type Env } from "./env";
import { post } from "./http";
import { formatStatus } from "./status";

export class TelegramClient {
  constructor(private readonly token: string, private readonly chatId: string) {}

  async configureOwnerMenu(): Promise<void> {
    const api = `${TELEGRAM_API}/bot${this.token}`;
    const commands = await post<{ ok: boolean }>(api + "/setMyCommands", {
      scope: { type: "chat", chat_id: this.chatId },
      commands: [{ command: "admin", description: "Открыть управление Deye" }],
    });
    const button = await post<{ ok: boolean }>(api + "/setChatMenuButton", {
      chat_id: this.chatId,
      menu_button: { type: "commands" },
    });
    if (!commands.ok || !button.ok) throw new Error("Telegram rejected owner menu configuration");
  }

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
  [{ text: STATUS_BUTTON, callback_data: "menu:status" }],
  [{ text: "👤 Мои подписки", callback_data: "menu:subscriptions" }],
  [{ text: "⚙️ Администрирование", callback_data: "menu:manage" }],
] };

const backToMenu = [{ text: "‹ Главное меню", callback_data: "menu:admin" }];

const backToManagement = [{ text: "‹ Администрирование", callback_data: "menu:manage" }];

const ownerSections = {
  manage: {
    title: "⚙️ Администрирование",
    inline_keyboard: [
  [{ text: "📋 Инверторы", callback_data: "menu:devices" }, { text: "🔔 Оповещения", callback_data: "menu:alerts" }],
      backToMenu,
    ],
  },
  devices: {
    title: "📋 Инверторы",
    inline_keyboard: [
      [{ text: "Список станций", callback_data: "menu:stations" }],
      [{ text: "➕ Добавить инвертор", callback_data: "menu:add" }],
      backToManagement,
    ],
  },
  alerts: {
    title: "🔔 Оповещения",
    inline_keyboard: [
      [{ text: "Заявки", callback_data: "menu:requests" }],
      [{ text: "Все подписки", callback_data: "menu:recipients" }],
      backToManagement,
    ],
  },
};

interface TelegramUpdate {
  update_id: number;
  my_chat_member?: ChatMembership;
  callback_query?: { id: string; from: { id: number }; message?: { chat: { id: number; type: string } }; data?: string };
  message?: { chat: { id: number; type: string }; from?: { id: number; is_bot?: boolean; first_name?: string; last_name?: string }; text?: string };
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
        if (pending) await notifyOwnerOfRequest(env, ownerId, pending, update.update_id);
      } else if (update.callback_query) {
        const callback = update.callback_query;
        if (String(callback.from.id) === ownerId && String(callback.message?.chat.id) === ownerId &&
            callback.message?.chat.type === "private") {
          const [action, target, serial] = (callback.data ?? "").split(":");
          let answer: string | undefined;
          if ((action === "detach" || action === "restore") && target && serial) {
            const enable = action === "restore";
            const name = await changeSubscription(env, target, serial, enable);
            answer = "Подписка уже в нужном состоянии или недоступна.";
            if (name) {
              answer = enable ? "Подписка восстановлена." : "Подписка отключена.";
              try {
                await new TelegramClient(env.TELEGRAM_BOT_TOKEN, target)
                  .sendStatusMessage(enable ? `🔔 Оповещения по инвертору «${name}» снова включены.`
                    : `🔕 Оповещения по инвертору «${name}» отключены.`, false);
              } catch {
                answer += " Получателю не удалось отправить уведомление.";
              }
            }
          } else if (action !== "menu") {
            answer = await processChatRequest(env, action, target ?? "", serial);
          }
          await post(`${TELEGRAM_API}/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
            callback_query_id: callback.id, ...(answer ? { text: answer, show_alert: true } : {}),
          });
          if (action === "menu" && target &&
              ["admin", "status", "manage", "devices", "alerts", "add", "requests", "stations", "recipients", "subscriptions", "bind", "unbind"].includes(target)) {
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

  return handleMessage(update?.message, request, env, update.update_id);
}

async function processChatRequest(env: Env, action: string, chatId: string, serial?: string): Promise<string> {
  const result = await resolveRequest(env, action, chatId, serial);
  if (typeof result === "string") return result;
  try {
    await new TelegramClient(env.TELEGRAM_BOT_TOKEN, chatId).sendStatusMessage(result.notification, false);
    return result.confirmation;
  } catch {
    return result.confirmation + " Подтверждение не удалось отправить.";
  }
}

async function notifyOwnerOfRequest(
  env: Env, ownerId: string, pending: { chat_id: string; title: string }, updateId: number,
) {
  const client = new TelegramClient(env.TELEGRAM_BOT_TOKEN, ownerId);
  await client.sendStatusMessage(
    "🔔 Запрос на оповещения\n" + pending.title + "\nВыбери инвертор.",
    { inline_keyboard: await requestButtons(env, pending.chat_id) },
  );
  await env.GRID_DB?.prepare("UPDATE chat_requests SET notified_at = ?1 WHERE chat_id = ?2 AND update_id = ?3 RETURNING chat_id")
    .bind(Date.now(), pending.chat_id, updateId).first();
}

async function handleMessage(message: TelegramUpdate["message"], request: Request, env: Env, updateId?: number): Promise<Response> {
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
    if (ownerId && !owner && privateChat && !message.from?.is_bot &&
        command === "/start" && updateId !== undefined) {
      const name = [message.from?.first_name, message.from?.last_name].filter(Boolean).join(" ");
      const pending = await recordPrivateRequest(env, chatId, "Личный чат · " + (name || chatId), updateId);
      if (pending) {
        await notifyOwnerOfRequest(env, ownerId, pending, pending.update_id);
        await client.sendStatusMessage("Заявка на оповещения отправлена владельцу.", false);
      }
      return new Response(null, { status: 204 });
    }

    if (owner && privateChat && ["/start", "/admin"].includes(command)) {
      if (updateId !== undefined) try {
        await client.configureOwnerMenu();
      } catch {
        console.warn("Telegram owner menu configuration failed");
      }
      if (updateId !== undefined) await client.sendStatusMessage("Управление Deye", { remove_keyboard: true });
      await client.sendStatusMessage("Выбери действие.", ownerMenu);
      return new Response(null, { status: 204 });
    }

    if (owner && privateChat && (command === "/manage" || command === "/devices" || command === "/alerts")) {
      const section = command === "/devices" ? ownerSections.devices : command === "/alerts" ? ownerSections.alerts : ownerSections.manage;
      await client.sendStatusMessage(section.title, { inline_keyboard: section.inline_keyboard });
      return new Response(null, { status: 204 });
    }

    if (owner && privateChat && command === "/requests" && env.GRID_DB) {
      const { results } = await env.GRID_DB.prepare(
        "SELECT chat_id, title FROM chat_requests WHERE state = 'pending' ORDER BY update_id DESC LIMIT 20",
      ).all<{ chat_id: string; title: string }>();
      if (!results.length) await client.sendStatusMessage("Открытых заявок нет.", { inline_keyboard: [[{ text: "‹ Оповещения", callback_data: "menu:alerts" }]] });
      for (const pending of results) {
        await client.sendStatusMessage("🔔 " + pending.title + " · " + pending.chat_id, {
          inline_keyboard: [...await requestButtons(env, pending.chat_id), [{ text: "‹ Оповещения", callback_data: "menu:alerts" }]],
        });
      }
      return new Response(null, { status: 204 });
    }

    if (owner && privateChat && command === "/approve") {
      await client.sendStatusMessage(await processChatRequest(env, "approve", args[0] ?? "", args[1]), false);
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
      await client.sendStatusMessage("Мои подписки", { inline_keyboard: [...buttons, backToMenu] });
      return new Response(null, { status: 204 });
    }

    const adminButtons: typeof ownerMenu.inline_keyboard = [];
    const adminText = owner && (privateChat || ["/admin", "/bind", "/unbind"].includes(command))
      ? await adminReply(command, args, chatId, ownerId, env, new URL(request.url).origin, adminButtons)
      : undefined;
    if (adminText) {
      await client.sendStatusMessage(adminText, owner && privateChat ? { inline_keyboard: [...adminButtons, [command === "/recipients" || command === "/bind" || command === "/unbind"
        ? { text: "‹ Оповещения", callback_data: "menu:alerts" }
        : { text: "‹ Инверторы", callback_data: "menu:devices" }]] } : false);
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
      inline_keyboard: [...buttons, backToMenu],
    });
  } catch {
    console.warn("Telegram update processing failed");
    return new Response(null, { status: 502 });
  }
  return new Response(null, { status: 204 });
}
