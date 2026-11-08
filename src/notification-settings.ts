import type { GridDatabase } from "./grid-monitor";

export const NOTIFICATION_GROUPS = {
  grid: "🔌 Городская сеть",
  battery: "🔋 Заряд батареи",
  voltage: "⚡ Напряжение фаз",
  generator: "⚡ Генератор",
  faults: "🚨 Ошибки инвертора",
  connection: "📡 Связь с Deye",
} as const;
export type NotificationGroup = keyof typeof NOTIFICATION_GROUPS;

export const NOTIFICATIONS = {
  grid_off: { group: "grid", label: "Переход на аккумуляторы" },
  grid_on: { group: "grid", label: "Возвращение городской сети" },
  battery80: { group: "battery", label: "Заряд 80 %" },
  battery50: { group: "battery", label: "Заряд 50 %" },
  battery30: { group: "battery", label: "Заряд 30 %" },
  battery20: { group: "battery", label: "Заряд 20 %" },
  shutdown: { group: "battery", label: "Нижний порог батареи" },
  low: { group: "voltage", label: "Низкое · 185–195,5 В" },
  very_low: { group: "voltage", label: "Очень низкое · 170–185 В" },
  critical_low: { group: "voltage", label: "Критически низкое · <170 В" },
  high: { group: "voltage", label: "Высокое · >253, <260 В" },
  very_high: { group: "voltage", label: "Очень высокое · 260–270 В" },
  critical_high: { group: "voltage", label: "Критически высокое · ≥270 В" },
  phase_missing: { group: "voltage", label: "Отсутствие фазы" },
  phase_improved: { group: "voltage", label: "Улучшение уровня напряжения" },
  phase_restored: { group: "voltage", label: "Полное восстановление напряжения" },
  gen_on: { group: "generator", label: "Генератор включился" },
  gen_off: { group: "generator", label: "Генератор выключился" },
  fault_on: { group: "faults", label: "Появление ошибки" },
  fault_off: { group: "faults", label: "Устранение ошибки" },
  offline: { group: "connection", label: "Нет данных 30 минут" },
  online: { group: "connection", label: "Связь восстановлена" },
} as const;
export type NotificationKind = keyof typeof NOTIFICATIONS;
export type NotificationSettings = Partial<Record<NotificationKind, boolean>>;
export const notificationKinds = Object.keys(NOTIFICATIONS) as NotificationKind[];
export const notificationGroups = Object.keys(NOTIFICATION_GROUPS) as NotificationGroup[];

export function notificationEnabled(settings: NotificationSettings, kind: NotificationKind): boolean {
  return settings[kind] !== false;
}

export async function loadNotificationSettings(db: GridDatabase, serial: string): Promise<NotificationSettings> {
  const { results } = await db.prepare("SELECT kind, enabled FROM notification_settings WHERE device_sn = ?1")
    .bind(serial).all<{ kind: NotificationKind; enabled: number }>();
  return Object.fromEntries(results.filter(row => Object.hasOwn(NOTIFICATIONS, row.kind)).map(row => [row.kind, row.enabled === 1]));
}

export async function saveNotificationSettings(db: GridDatabase, serial: string, kinds: NotificationKind[], enabled: boolean) {
  await db.batch(kinds.map(kind => db.prepare(`
    INSERT INTO notification_settings (device_sn, kind, enabled) VALUES (?1, ?2, ?3)
    ON CONFLICT(device_sn, kind) DO UPDATE SET enabled = excluded.enabled
  `).bind(serial, kind, enabled ? 1 : 0)));
}
