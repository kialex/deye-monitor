import { estimateBatteryRuntime, getBatterySettings } from "./battery";
import { DeyeClient } from "./deye";
import { readDeyeConfig, type Env } from "./env";
import { formatGridAlert, readGridTransition } from "./status";
import { TelegramClient } from "./telegram";

interface Statement {
  bind(...values: (string | number)[]): Statement;
  first<T>(): Promise<T | null>;
}

export interface GridDatabase {
  prepare(sql: string): Statement;
  batch(statements: Statement[]): Promise<unknown>;
}

const DELIVERY_LEASE_MS = 30_000;

async function deliverAlert(db: GridDatabase, env: Env): Promise<void> {
  const now = Date.now();
  const leaseUntil = now + DELIVERY_LEASE_MS;
  const alert = await db.prepare(`
    UPDATE grid_alerts SET lease_until = ?1
    WHERE id = (
      SELECT id FROM grid_alerts WHERE device_sn = ?2 AND sent_at IS NULL ORDER BY id LIMIT 1
    ) AND (lease_until IS NULL OR lease_until <= ?3)
    RETURNING id, message
  `).bind(leaseUntil, env.DEYE_DEVICE_SN, now).first<{ id: number; message: string }>();
  if (!alert) return;

  await new TelegramClient(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID).sendStatusMessage(alert.message);
  await db.prepare(`
    UPDATE grid_alerts SET sent_at = ?1 WHERE id = ?2 AND lease_until = ?3 RETURNING id
  `).bind(Date.now(), alert.id, leaseUntil).first<{ id: number }>();
}

export async function monitorGrid(env: Env): Promise<void> {
  const db = env.GRID_DB;
  if (!db) return;

  try {
    const config = readDeyeConfig(env);
    const client = new DeyeClient(config);
    const settings = await getBatterySettings(db, client, config.deviceSn);
    const { station, device } = await client.getTelemetry();
    const { state, measuredAt } = readGridTransition(device);
    if (state) {
      const runtime = state === "absent" ? estimateBatteryRuntime(settings, device, station, measuredAt) : undefined;
      const message = formatGridAlert(state, measuredAt, station, runtime);

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
    await deliverAlert(db, env);
  }
}
