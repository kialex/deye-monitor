import { VOLTAGE_MAX_AGE_MS } from "./constants";
import { formatTime } from "./status";
import type { Env } from "./env";
import { legacyDevice, listDevices } from "./owner";

export interface ChatMembership {
  chat: { id: number; title?: string; type: string };
  old_chat_member: { status: string; is_member?: boolean };
  new_chat_member: { status: string; is_member?: boolean };
}

export async function recordMembership(env: Env, change: ChatMembership, updateId: number) {
  const db = env.GRID_DB;
  if (!db || !["group", "supergroup", "channel"].includes(change.chat.type)) return null;
  const active = (member: ChatMembership["new_chat_member"]) =>
    ["member", "administrator", "creator"].includes(member.status) ||
    (member.status === "restricted" && member.is_member === true);
  const joined = active(change.new_chat_member);
  if (joined === active(change.old_chat_member)) return null;

  const chatId = String(change.chat.id);
  await db.batch([
    db.prepare(`
      INSERT INTO chat_requests (chat_id, title, update_id, state)
      VALUES (?1, ?2, ?3, ?4)
      ON CONFLICT(chat_id) DO UPDATE SET title = excluded.title, update_id = excluded.update_id,
        state = excluded.state, notified_at = NULL
      WHERE excluded.update_id > chat_requests.update_id
    `).bind(chatId, change.chat.title || chatId, updateId, joined ? "pending" : "removed"),
    db.prepare(`
      UPDATE chat_subscriptions SET enabled = 0 WHERE chat_id = ?1
      AND EXISTS (SELECT 1 FROM chat_requests WHERE chat_id = ?1 AND update_id = ?2 AND state = 'removed')
    `).bind(chatId, updateId),
  ]);
  return joined ? db.prepare(`
    SELECT chat_id, title FROM chat_requests
    WHERE chat_id = ?1 AND update_id = ?2 AND state = 'pending' AND notified_at IS NULL
  `).bind(chatId, updateId).first<{ chat_id: string; title: string }>() : null;
}

export async function recordPrivateRequest(env: Env, chatId: string, title: string, updateId: number) {
  const db = env.GRID_DB;
  if (!db) return null;
  await db.prepare(`
    INSERT INTO chat_requests (chat_id, title, update_id, state)
    VALUES (?1, ?2, ?3, 'pending') ON CONFLICT(chat_id) DO NOTHING RETURNING chat_id
  `).bind(chatId, title, updateId).first();
  return db.prepare(`
    SELECT chat_id, title, update_id FROM chat_requests
    WHERE chat_id = ?1 AND state = 'pending' AND notified_at IS NULL
  `).bind(chatId).first<{ chat_id: string; title: string; update_id: number }>();
}

export async function requestButtons(env: Env, chatId: string) {
  const devices = env.GRID_DB ? await listDevices(env.GRID_DB) : [];
  const legacy = legacyDevice(env);
  const choices = legacy && !devices.some(device => device.device_sn === legacy.device_sn) ? [legacy, ...devices] : devices;
  const buttons = choices.flatMap(device => {
    const data = `approve:${chatId}:${device.device_sn}`;
    return new TextEncoder().encode(data).length <= 64
      ? [[{ text: `Подписать · ${device.name}`.slice(0, 64), callback_data: data }]] : [];
  });
  return [...buttons.slice(0, 30), [{ text: "Отклонить", callback_data: `ignore:${chatId}` }]];
}

export async function resolveRequest(env: Env, action: string, chatId: string, serial?: string): Promise<string | { confirmation: string; notification: string }> {
  const db = env.GRID_DB;
  if (!db || !/^-?[1-9]\d{0,15}$/.test(chatId)) return "Заявка недоступна.";
  if (action === "ignore") {
    const result = await db.prepare(`
      UPDATE chat_requests SET state = 'ignored' WHERE chat_id = ?1 AND state = 'pending' RETURNING chat_id
    `).bind(chatId).first();
    return result ? "Заявка отклонена." : "Заявка уже обработана.";
  }
  if (action !== "approve" || !serial || !/^[\w-]{1,100}$/.test(serial)) return "Выбери зарегистрированный инвертор.";
  const device = await db.prepare("SELECT name FROM monitored_devices WHERE device_sn = ?1").bind(serial).first<{ name: string }>();
  if (!device && serial !== env.DEYE_DEVICE_SN) return "Инвертор не зарегистрирован.";
  const [result] = await db.batch([
    db.prepare(`
      INSERT INTO chat_subscriptions (device_sn, chat_id, enabled)
      SELECT ?1, chat_id, 1 FROM chat_requests WHERE chat_id = ?2 AND state = 'pending'
      ON CONFLICT(device_sn, chat_id) DO UPDATE SET enabled = 1 RETURNING chat_id
    `).bind(serial, chatId),
    db.prepare("UPDATE chat_requests SET state = 'approved' WHERE chat_id = ?1 AND state = 'pending'").bind(chatId),
  ]);
  if (!result.results.length) return "Заявка уже обработана.";

  const reading = await db.prepare(
    "SELECT state, measured_at FROM grid_state WHERE device_sn = ?1",
  ).bind(serial).first<{ state: string; measured_at: number }>();
  const age = reading ? Date.now() - reading.measured_at : Infinity;
  const status = reading && age >= 0 && age <= VOLTAGE_MAX_AGE_MS
    ? (reading.state === "present" ? "Городская сеть доступна" : "Городская сеть отключена") +
      " · замер " + formatTime(reading.measured_at)
    : "Свежих данных о сети пока нет";

  return {
    confirmation: `Чат подписан на отключение и восстановление сети · ${serial}.`,
    notification: [
      "✅ Заявка одобрена",
      `Инвертор — ${device?.name ?? "Текущая станция"} · ${serial}`,
      status,
      "Теперь этот чат будет получать оповещения об отключении и восстановлении сети.",
    ].join("\n"),
  };
}
