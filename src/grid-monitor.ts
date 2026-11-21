import { updateMonitorNotifications } from "./monitor-notifications";
import { listDevices, loadConfig } from "./owner";
import { estimateBatteryRuntime, getBatterySettings } from "./battery";
import { DeyeClient } from "./deye";
import { readDeyeConfig, type DeyeConfig, type Env } from "./env";
import { readGridTransition } from "./status";
import { enqueueDeviceAlerts, deliverPendingAlerts } from "./alert-delivery";

interface Statement {
  bind(...values: (string | number)[]): Statement;
  all<T>(): Promise<{ results: T[] }>;
  first<T>(): Promise<T | null>;
}

export interface GridDatabase {
  prepare(sql: string): Statement;
  batch(statements: Statement[]): Promise<{ results: unknown[] }[]>;
}

async function monitorDevice(db: GridDatabase, env: Env, config: DeyeConfig, name?: string): Promise<void> {
  try {
    const client = new DeyeClient(config);
    const settings = await getBatterySettings(db, client, config.deviceSn);
    const { station, device } = await client.getTelemetry().catch(() => ({ station: undefined, device: undefined }));
    const { state, measuredAt } = readGridTransition(device);
    const runtime = state === "absent" ? estimateBatteryRuntime(settings, device, station, measuredAt) : undefined;
    await updateMonitorNotifications(db, client, config.deviceSn, name, device, station, settings?.shutdown_soc, runtime);
    if (state) {
      // Keep the latest confirmed state for status consumers; notifications deduplicate in their own snapshot.
      await db.batch([
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
    await enqueueDeviceAlerts(db, env, config.deviceSn);
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
  await deliverPendingAlerts(db, env);
}
