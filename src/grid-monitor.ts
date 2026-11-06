import { listDevices, loadConfig } from "./owner";
import { estimateBatteryRuntime, getBatterySettings } from "./battery";
import { DeyeClient } from "./deye";
import { readDeyeConfig, type DeyeConfig, type Env } from "./env";
import { formatGridAlert, readGridTransition } from "./status";
import { TelegramClient } from "./telegram";

interface Statement {
  bind(...values: (string | number)[]): Statement;
  all<T>(): Promise<{ results: T[] }>;
  first<T>(): Promise<T | null>;
}

export interface GridDatabase {
  prepare(sql: string): Statement;
  batch(statements: Statement[]): Promise<{ results: unknown[] }[]>;
}

const DELIVERY_LEASE_MS = 30_000;

async function deliverAlerts(db: GridDatabase, env: Env, deviceSn: string): Promise<void> {
  const legacyChat = deviceSn === env.DEYE_DEVICE_SN ? env.TELEGRAM_CHAT_ID : "";
  const now = Date.now();
  await db.batch([
    db.prepare(`
      INSERT OR IGNORE INTO alert_deliveries (alert_id, chat_id)
      SELECT a.id, s.chat_id FROM grid_alerts a
      JOIN chat_subscriptions s ON s.device_sn = a.device_sn AND s.enabled = 1
      WHERE a.device_sn = ?1 AND a.sent_at IS NULL AND a.queued_at IS NULL
      UNION
      SELECT a.id, ?2 FROM grid_alerts a
      WHERE a.device_sn = ?1 AND a.sent_at IS NULL AND a.queued_at IS NULL AND ?2 <> ''
      AND NOT EXISTS (
        SELECT 1 FROM chat_subscriptions s WHERE s.device_sn = ?1 AND s.chat_id = ?2 AND s.enabled = 0
      )
    `).bind(deviceSn, legacyChat),
    db.prepare("UPDATE grid_alerts SET queued_at = ?2 WHERE device_sn = ?1 AND queued_at IS NULL")
      .bind(deviceSn, now),
  ]);

  const { results: chats } = await db.prepare(`
    SELECT d.chat_id, MIN(d.alert_id) AS alert_id
    FROM alert_deliveries d JOIN grid_alerts a ON a.id = d.alert_id
    LEFT JOIN chat_subscriptions s ON s.device_sn = a.device_sn AND s.chat_id = d.chat_id
    WHERE a.device_sn = ?1 AND d.sent_at IS NULL
      AND COALESCE(s.enabled, d.chat_id = ?2) = 1
    GROUP BY d.chat_id
  `).bind(deviceSn, legacyChat).all<{ chat_id: string; alert_id: number }>();

  for (const chat of chats) {
    try {
      const lease = Date.now() + DELIVERY_LEASE_MS;
      const alert = await db.prepare(`
        UPDATE alert_deliveries SET lease_until = ?1
        WHERE alert_id = ?2 AND chat_id = ?3 AND sent_at IS NULL
          AND (lease_until IS NULL OR lease_until <= ?4)
        RETURNING (SELECT message FROM grid_alerts WHERE id = ?2) AS message
      `).bind(lease, chat.alert_id, chat.chat_id, Date.now()).first<{ message: string }>();
      if (!alert) continue;
      await new TelegramClient(env.TELEGRAM_BOT_TOKEN, chat.chat_id).sendStatusMessage(alert.message, false);
      await db.prepare(`
        UPDATE alert_deliveries SET sent_at = ?1
        WHERE alert_id = ?2 AND chat_id = ?3 AND lease_until = ?4 RETURNING alert_id
      `).bind(Date.now(), chat.alert_id, chat.chat_id, lease).first();
    } catch {
      console.warn("Grid alert delivery failed");
    }
  }
}

async function monitorDevice(db: GridDatabase, env: Env, config: DeyeConfig, name?: string): Promise<void> {
  try {
    const client = new DeyeClient(config);
    const settings = await getBatterySettings(db, client, config.deviceSn);
    const { station, device } = await client.getTelemetry();
    const { state, measuredAt } = readGridTransition(device);
    if (state) {
      const runtime = state === "absent" ? estimateBatteryRuntime(settings, device, station, measuredAt) : undefined;
      const alert = formatGridAlert(state, measuredAt, station, runtime);
      const message = name ? name + "\n" + alert : alert;

      // D1 runs a batch atomically. Only a newer sample can enqueue an alert or update the state.
      await db.batch([
        db.prepare(`
          INSERT INTO grid_alerts (device_sn, measured_at, message)
          SELECT device_sn, ?2, ?4 FROM grid_state
          WHERE device_sn = ?1 AND measured_at < ?2 AND state <> ?3
        `).bind(config.deviceSn, measuredAt, state, message),
        db.prepare(`
          INSERT INTO grid_state (device_sn, measured_at, state, changed_at)
          VALUES (?1, ?2, ?3, ?2)
          ON CONFLICT(device_sn) DO UPDATE SET
            measured_at = excluded.measured_at,
            state = excluded.state,
            changed_at = CASE WHEN grid_state.state <> excluded.state
                              THEN excluded.measured_at ELSE grid_state.changed_at END
          WHERE grid_state.measured_at < excluded.measured_at
        `).bind(config.deviceSn, measuredAt, state),
      ]);
    }
  } finally {
    // Pending alerts can be delivered even while Deye Cloud is unavailable.
    await deliverAlerts(db, env, config.deviceSn);
  }
}

export async function monitorGrid(env: Env): Promise<void> {
  const db = env.GRID_DB;
  if (!db) return;

  const devices = await listDevices(db);
  if (env.DEYE_DEVICE_SN && !devices.some(row => row.device_sn === env.DEYE_DEVICE_SN)) {
    try {
      await monitorDevice(db, env, readDeyeConfig(env), "Текущая станция");
    } catch {
      console.warn("Legacy Deye monitoring failed");
    }
  }
  for (const device of devices) {
    try {
      await monitorDevice(db, env, await loadConfig(env, device), device.name);
    } catch {
      console.warn("Deye device monitoring failed");
    }
  }
}
