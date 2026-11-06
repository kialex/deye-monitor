import type { Env } from "./env";
import { legacyDevice, listDevices, makeSetupLink } from "./owner";

export async function adminReply(
  command: string, args: string[], chatId: string, ownerId: string, env: Env, origin: string,
): Promise<string | undefined> {
  const db = env.GRID_DB;
  if (!db) return "База данных недоступна.";
  if (command === "/admin") return [
    "⚙️ Управление Deye",
    "/add — подключить аккаунт или обновить реквизиты инвертора (в личке)",
    "/stations — список инверторов и подписок (в личке)",
    "/bind <серийный номер> — включить оповещения в текущем чате",
    "/unbind <серийный номер> — отключить оповещения в текущем чате",
    "/allow <серийный номер> <ID пользователя> — доступ к /status в личке",
    "/revoke <серийный номер> <ID пользователя> — отозвать доступ",
  ].join("\n");

  if (command === "/add") {
    if (chatId !== ownerId) return "Отправь /add в личном чате с ботом.";
    return "Открой одноразовую ссылку для подключения Deye (10 минут).\n" + await makeSetupLink(env, origin);
  }

  if (command === "/stations") {
    if (chatId !== ownerId) return "Отправь /stations в личном чате с ботом.";
    const devices = await listDevices(db);
    const legacy = legacyDevice(env);
    const entries = legacy && !devices.some(row => row.device_sn === legacy.device_sn) ? [legacy, ...devices] : devices;
    const { results: subscriptions } = await db.prepare(
      "SELECT device_sn, chat_id FROM chat_subscriptions WHERE enabled = 1 ORDER BY chat_id",
    ).all<{ device_sn: string; chat_id: string }>();
    return entries.map(device => {
      const chats = subscriptions.filter(row => row.device_sn === device.device_sn).map(row => row.chat_id);
      const personal = chats.includes(ownerId) ? " · личная подписка включена" : "";
      return `${device.name} · ${device.device_sn}${personal}\nЧаты: ${chats.join(", ") || "—"}`;
    }).join("\n\n").slice(0, 3900) || "Подключи первый инвертор через /add.";
  }

  if (!["/bind", "/unbind", "/allow", "/revoke"].includes(command)) return undefined;
  const [serial, userId] = args;
  if (!serial || !/^[\w-]{1,100}$/.test(serial)) return `${command} <серийный номер из /stations>`;
  const device = await db.prepare("SELECT device_sn FROM monitored_devices WHERE device_sn = ?1").bind(serial).first();
  if (!device && serial !== env.DEYE_DEVICE_SN) return "Инвертор не зарегистрирован. Проверь /stations.";

  if (command === "/bind" || command === "/unbind") {
    const enabled = command === "/bind" ? 1 : 0;
    await db.prepare(`
      INSERT INTO chat_subscriptions (device_sn, chat_id, enabled) VALUES (?1, ?2, ?3)
      ON CONFLICT(device_sn, chat_id) DO UPDATE SET enabled = excluded.enabled
      RETURNING device_sn
    `).bind(serial, chatId, enabled).first();
    return enabled ? "Оповещения для этого инвертора включены в чате." : "Оповещения для этого инвертора отключены в чате.";
  }

  if (chatId !== ownerId) return "Эта команда доступна в личном чате с ботом.";
  if (!/^\d{1,16}$/.test(userId ?? "")) return `${command} <серийный номер> <Telegram User ID>`;
  const sql = command === "/allow"
    ? "INSERT OR IGNORE INTO device_access (device_sn, user_id) VALUES (?1, ?2) RETURNING user_id"
    : "DELETE FROM device_access WHERE device_sn = ?1 AND user_id = ?2 RETURNING user_id";
  await db.prepare(sql).bind(serial, userId).first();
  return command === "/allow" ? "Доступ к показаниям выдан." : "Доступ к показаниям отозван.";
}
