import type { Env } from "./env";
import { legacyDevice, listDevices } from "./owner";
import {
  NOTIFICATIONS, NOTIFICATION_GROUPS, notificationGroups, notificationKinds, notificationEnabled,
  loadNotificationSettings, saveNotificationSettings, type NotificationGroup, type NotificationKind,
} from "./notification-settings";

interface SettingsView {
  text: string;
  keyboard: { inline_keyboard: { text: string; callback_data: string }[][] };
}

function button(text: string, callback_data: string) {
  if (new TextEncoder().encode(callback_data).length > 64) throw new Error("Settings callback exceeds Telegram limit");
  return { text, callback_data };
}

async function devicesForSettings(env: Env) {
  const devices = env.GRID_DB ? await listDevices(env.GRID_DB) : [];
  const legacy = legacyDevice(env);
  return legacy && !devices.some(device => device.device_sn === legacy.device_sn) ? [legacy, ...devices] : devices;
}

export async function openNotificationSettings(env: Env): Promise<SettingsView> {
  if (!env.GRID_DB) throw new Error("Database unavailable");
  const devices = await devicesForSettings(env);
  if (devices.length === 1) return notificationSettingsView(env, devices[0].device_sn);
  return {
    text: devices.length ? "Настройки уведомлений · выбери инвертор" : "Сначала добавь инвертор в разделе «Администрирование».",
    keyboard: { inline_keyboard: devices.slice(0, 30).map(device => [button(device.name, `ns:${device.device_sn}:all`)]) },
  };
}

export async function notificationSettingsView(env: Env, serial: string, group = "all"): Promise<SettingsView> {
  const device = (await devicesForSettings(env)).find(device => device.device_sn === serial);
  if (!env.GRID_DB || !device) throw new Error("Unknown inverter");
  if (group !== "all" && !notificationGroups.includes(group as NotificationGroup)) throw new Error("Unknown notification group");
  const settings = await loadNotificationSettings(env.GRID_DB, serial);
  const kinds = notificationKinds.filter(kind => group === "all" || NOTIFICATIONS[kind].group === group);
  const active = kinds.filter(kind => notificationEnabled(settings, kind)).length;
  const rows = group === "all"
    ? notificationGroups.map(key => {
      const entries = notificationKinds.filter(kind => NOTIFICATIONS[kind].group === key);
      const count = entries.filter(kind => notificationEnabled(settings, kind)).length;
      return [button(`${NOTIFICATION_GROUPS[key]} · ${count}/${entries.length}`, `ns:${serial}:${key}`)];
    })
    : kinds.map(kind => [button(`${notificationEnabled(settings, kind) ? "✅" : "⬜"} ${NOTIFICATIONS[kind].label}`,
      `nt:${serial}:${kind}:${notificationEnabled(settings, kind) ? 0 : 1}`)]);
  rows.push([button("Включить все", `na:${serial}:${group}:1`), button("Выключить все", `na:${serial}:${group}:0`)]);
  if (group !== "all") rows.push([button("К категориям уведомлений", `ns:${serial}:all`)]);
  return {
    text: ["Настройки уведомлений", device.name + " · " + serial,
      group === "all" ? "Все категории" : NOTIFICATION_GROUPS[group as NotificationGroup],
      `Включено: ${active} из ${kinds.length}`,
      "", "✅ включено · ⬜ выключено. Нажми, чтобы изменить.",
      "Настройка действует для всех подписчиков этого инвертора.",
      ...(group === "voltage" ? ["Причина перехода на аккумуляторы остаётся в сообщении о переходе."] : []),
    ].join("\n"),
    keyboard: { inline_keyboard: rows },
  };
}

export async function changeNotificationSetting(env: Env, data: string): Promise<SettingsView> {
  const [action, serial, key, value] = data.split(":");
  // Validate both the inverter and the setting before writing anything.
  if (!env.GRID_DB || !(await devicesForSettings(env)).some(device => device.device_sn === serial)) throw new Error("Unknown inverter");
  if (action === "ns") return notificationSettingsView(env, serial, key);
  if (!["nt", "na"].includes(action) || !["0", "1"].includes(value)) throw new Error("Invalid setting action");
  let group: string;
  let kinds: NotificationKind[];
  if (action === "nt") {
    if (!notificationKinds.includes(key as NotificationKind)) throw new Error("Unknown notification");
    kinds = [key as NotificationKind];
    group = NOTIFICATIONS[key as NotificationKind].group;
  } else {
    if (key !== "all" && !notificationGroups.includes(key as NotificationGroup)) throw new Error("Unknown group");
    group = key;
    kinds = notificationKinds.filter(kind => group === "all" || NOTIFICATIONS[kind].group === group);
  }
  await saveNotificationSettings(env.GRID_DB, serial, kinds, value === "1");
  return notificationSettingsView(env, serial, group);
}
