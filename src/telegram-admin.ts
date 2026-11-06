import type { Env } from "./env";
import { legacyDevice, listDevices, makeSetupLink } from "./owner";

export async function adminReply(
  command: string, args: string[], chatId: string, ownerId: string, env: Env, origin: string,
  buttons: { text: string; callback_data: string }[][] = [],
): Promise<string | undefined> {
  const db = env.GRID_DB;
  if (!db) return "База данных недоступна.";
  if (command === "/admin") return "Открой личный чат с ботом и нажми Start.";

  if (command === "/add") {
    if (chatId !== ownerId) return "Открой «Добавить инвертор» в личном чате с ботом.";
    return "Открой одноразовую ссылку для подключения Deye (10 минут).\n" + await makeSetupLink(env, origin);
  }

  if (command === "/stations" || command === "/recipients") {
    if (chatId !== ownerId) return "Открой этот раздел в личном чате с ботом.";
    const devices = await listDevices(db);
    const legacy = legacyDevice(env);
    const entries = legacy && !devices.some(row => row.device_sn === legacy.device_sn) ? [legacy, ...devices] : devices;
    if (command === "/stations") {
      return entries.map(device => device.name + " · " + device.device_sn)
        .join("\n").slice(0, 3900) || "Нажми «Добавить инвертор», чтобы подключить первый инвертор.";
    }

    const { results: subscriptions } = await db.prepare(`
      SELECT s.device_sn, s.chat_id, s.enabled, r.title, r.state
      FROM chat_subscriptions s LEFT JOIN chat_requests r ON r.chat_id = s.chat_id
      ORDER BY COALESCE(r.title, s.chat_id)
    `).all<{ device_sn: string; chat_id: string; enabled: number; title: string | null; state: string | null }>();
    return entries.map(device => {
      const rows = subscriptions.filter(row => row.device_sn === device.device_sn);
      const chats = rows.map(row => ({
        enabled: row.enabled === 1, available: row.state !== "removed",
        id: row.chat_id, name: row.chat_id === ownerId ? "Вы (личный чат)" : row.title || "Чат " + row.chat_id,
      }));
      if (device.device_sn === env.DEYE_DEVICE_SN && env.TELEGRAM_CHAT_ID &&
          !rows.some(row => row.chat_id === env.TELEGRAM_CHAT_ID)) {
        chats.push({ enabled: true, available: true, id: env.TELEGRAM_CHAT_ID, name: env.TELEGRAM_CHAT_ID === ownerId ? "Вы (личный чат)" : "Чат " + env.TELEGRAM_CHAT_ID });
      }
      for (const chat of chats) {
        const data = `${chat.enabled ? "detach" : "restore"}:${chat.id}:${device.device_sn}`;
        if (chat.available && new TextEncoder().encode(data).length <= 64 && buttons.length < 30) {
          buttons.push([{ text: `${chat.enabled ? "Отключить" : "Восстановить"} · ${chat.name} · ${device.name}`.slice(0, 64), callback_data: data }]);
        }
      }
      return [device.name + " · " + device.device_sn, ...chats.map(chat => "• " + chat.name + (chat.enabled ? "" : " · отключена")),
        ...(chats.length ? [] : ["Подписок нет"])].join("\n");
    }).join("\n\n").slice(0, 3900) || "Нажми «Добавить инвертор», чтобы подключить первый инвертор.";
  }

  if (!["/bind", "/unbind"].includes(command)) return undefined;
  const [serial] = args;
  if (!serial || !/^[\w-]{1,100}$/.test(serial)) return "Выбери инвертор в разделе подписок.";
  const device = await db.prepare("SELECT device_sn FROM monitored_devices WHERE device_sn = ?1").bind(serial).first();
  if (!device && serial !== env.DEYE_DEVICE_SN) return "Инвертор не зарегистрирован. Открой список станций.";

  const enabled = command === "/bind" ? 1 : 0;
  await db.prepare(`
    INSERT INTO chat_subscriptions (device_sn, chat_id, enabled) VALUES (?1, ?2, ?3)
    ON CONFLICT(device_sn, chat_id) DO UPDATE SET enabled = excluded.enabled
    RETURNING device_sn
  `).bind(serial, chatId, enabled).first();
  return enabled ? "Оповещения для этого инвертора включены в чате." : "Оповещения для этого инвертора отключены в чате.";
}

export async function changeSubscription(env: Env, chatId: string, serial: string, enable: boolean) {
  const db = env.GRID_DB;
  if (!db || !/^-?[1-9]\d{0,15}$/.test(chatId) || !/^[\w-]{1,100}$/.test(serial)) return null;

  const device = await db.prepare("SELECT name FROM monitored_devices WHERE device_sn = ?1")
    .bind(serial).first<{ name: string }>();
  if (!device && serial !== env.DEYE_DEVICE_SN) return null;

  if (enable) {
    const restored = await db.prepare(`
      UPDATE chat_subscriptions SET enabled = 1
      WHERE device_sn = ?1 AND chat_id = ?2 AND enabled = 0
        AND NOT EXISTS (SELECT 1 FROM chat_requests WHERE chat_id = ?2 AND state = 'removed')
      RETURNING chat_id
    `).bind(serial, chatId).first();
    return restored ? device?.name ?? "Текущая станция" : null;
  }

  const legacy = serial === env.DEYE_DEVICE_SN && chatId === env.TELEGRAM_CHAT_ID ? 1 : 0;
  const changed = await db.prepare(`
    INSERT INTO chat_subscriptions (device_sn, chat_id, enabled)
    SELECT ?1, ?2, 0
    WHERE ?3 = 1 OR EXISTS (
      SELECT 1 FROM chat_subscriptions WHERE device_sn = ?1 AND chat_id = ?2 AND enabled = 1
    )
    ON CONFLICT(device_sn, chat_id) DO UPDATE SET enabled = 0
    WHERE chat_subscriptions.enabled = 1
    RETURNING chat_id
  `).bind(serial, chatId, legacy).first();
  return changed ? device?.name ?? "Текущая станция" : null;
}
