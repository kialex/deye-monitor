import type { DeyeClient, Device, Station } from "./deye";
import type { GridDatabase } from "./grid-monitor";
import { parseStationTime } from "./status";

const SETTINGS_TTL_MS = 24 * 60 * 60_000;
const MAX_SAMPLE_SKEW_MS = 2 * 60_000;

interface BatterySettings {
  capacity_ah: number;
  shutdown_soc: number;
  refreshed_at: number;
}

export async function getBatterySettings(
  db: GridDatabase, client: DeyeClient, deviceSn: string,
): Promise<BatterySettings | null> {
  const cached = await db.prepare(`
    SELECT capacity_ah, shutdown_soc, refreshed_at FROM battery_settings WHERE device_sn = ?1
  `).bind(deviceSn).first<BatterySettings>();
  if (cached && Date.now() - cached.refreshed_at < SETTINGS_TTL_MS) return cached;

  try {
    const { battCapacity, battLowCapacity, battShutDownCapacity } = await client.getBatterySettings();
    if (!Number.isFinite(battCapacity) || battCapacity <= 0 ||
        !Number.isFinite(battLowCapacity) || battLowCapacity < 0 || battLowCapacity > 100 ||
        !Number.isFinite(battShutDownCapacity) || battShutDownCapacity < 0 || battShutDownCapacity >= 100) {
      return cached;
    }

    return await db.prepare(`
      INSERT INTO battery_settings (device_sn, capacity_ah, low_soc, shutdown_soc, refreshed_at)
      VALUES (?1, ?2, ?3, ?4, ?5)
      ON CONFLICT(device_sn) DO UPDATE SET
        capacity_ah = excluded.capacity_ah, low_soc = excluded.low_soc,
        shutdown_soc = excluded.shutdown_soc, refreshed_at = excluded.refreshed_at
      RETURNING capacity_ah, shutdown_soc, refreshed_at
    `).bind(deviceSn, battCapacity, battLowCapacity, battShutDownCapacity, Date.now()).first<BatterySettings>();
  } catch {
    console.warn("Deye battery settings refresh failed");
    return cached;
  }
}

export function estimateBatteryRuntime(
  settings: BatterySettings | null,
  device: Device | undefined,
  station: Station | undefined,
  measuredAt: number,
): string | undefined {
  const stationTime = parseStationTime(station?.lastUpdateTime);
  if (!settings || !station || !Number.isFinite(stationTime) ||
      Math.abs(stationTime - measuredAt) > MAX_SAMPLE_SKEW_MS) return undefined;

  const voltage = Number(device?.dataList?.find(point => point.key === "BatteryVoltage" && point.unit === "V")?.value);
  const { batterySOC, dischargePower } = station;
  if (!Number.isFinite(voltage) || voltage <= 0 ||
      typeof batterySOC !== "number" || !Number.isFinite(batterySOC) ||
      batterySOC <= settings.shutdown_soc || batterySOC > 100 ||
      typeof dischargePower !== "number" || !Number.isFinite(dischargePower) || dischargePower <= 0) return undefined;

  const availableWh = settings.capacity_ah * voltage * (batterySOC - settings.shutdown_soc) / 100;
  const minutes = Math.round(availableWh / dischargePower * 60 / 5) * 5;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (hours === 0) return minutes === 0 ? "менее 5 мин" : `около ${minutes} мин`;
  return remainder ? `около ${hours} ч ${remainder} мин` : `около ${hours} ч`;
}
