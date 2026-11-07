import { GRID_PRESENT_MIN_VOLTS, VOLTAGE_MAX_AGE_MS } from "./constants";
import type { Device, Station } from "./deye";
import { parseStationTime } from "./status";

const GENERATOR_OFF_MAX_VOLTS = 20;
const GENERATOR_ACTIVE_MIN_WATTS = 100;

export interface GeneratorSnapshot {
  running?: boolean;
  measuredAt?: number;
  startedAt?: number;
}

function point(device: Device | undefined, key: string, unit: string): number | undefined {
  const raw = device?.dataList?.find(item => item.key === key && item.unit === unit)?.value;
  if (raw === undefined || String(raw).trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function readGeneratorSample(device: Device | undefined, now = Date.now()) {
  const measuredAt = (device?.collectionTime ?? NaN) * 1000;
  const volts = [1, 2, 3].map(phase => point(device, `GenVoltageL${phase}`, "V"));
  const phases = [1, 2, 3].map(phase => point(device, `GenPowerL${phase}`, "W"));
  const power = point(device, "GeneratorActivePower", "W") ?? point(device, "TotalGeneratorPower", "W")
    ?? (phases.every(value => value !== undefined) ? phases.reduce<number>((sum, value) => sum + value!, 0) : undefined);
  let running: boolean | undefined;
  if (now >= measuredAt && now - measuredAt <= VOLTAGE_MAX_AGE_MS) {
    if (volts.some(value => value !== undefined && value >= GRID_PRESENT_MIN_VOLTS)
        || (power !== undefined && power > GENERATOR_ACTIVE_MIN_WATTS)) running = true;
    else if (volts.every(value => value !== undefined && value <= GENERATOR_OFF_MAX_VOLTS)) running = false;
  }
  return { measuredAt, running, power };
}

function formatDuration(milliseconds: number): string {
  const minutes = Math.max(0, Math.floor(milliseconds / 60_000));
  if (minutes === 0) return "менее минуты";
  const hours = Math.floor(minutes / 60);
  return [hours ? `${hours} ч` : "", minutes % 60 ? `${minutes % 60} мин` : ""].filter(Boolean).join(" ");
}

export function updateGenerator(
  snapshot: GeneratorSnapshot, device: Device | undefined, station: Station | undefined, now = Date.now(),
): { running: boolean | undefined; message?: string } {
  const sample = readGeneratorSample(device, now);
  if (sample.running === undefined) return { running: undefined };
  if (sample.measuredAt <= (snapshot.measuredAt ?? 0)) return { running: snapshot.running };
  const previous = snapshot.running;
  snapshot.measuredAt = sample.measuredAt;
  snapshot.running = sample.running;
  // The first reading establishes a baseline; it cannot establish when an already-running generator started.
  if (previous === undefined || previous === sample.running) return { running: sample.running };

  const charge = station?.batterySOC;
  const stationTime = parseStationTime(station?.lastUpdateTime);
  const chargeText = charge !== undefined && Number.isFinite(charge) && charge >= 0 && charge <= 100
    && Math.abs(stationTime - sample.measuredAt) <= 120_000
    ? charge.toLocaleString("ru-RU", { maximumFractionDigits: 1 }) + " %" : "нет свежих данных";
  if (sample.running) {
    snapshot.startedAt = sample.measuredAt;
    const powerText = sample.power === undefined ? "нет данных"
      : (sample.power / 1000).toLocaleString("ru-RU", { maximumFractionDigits: 1 }) + " кВт";
    return { running: true, message: `⚡ Генератор включился\n\nМощность — ${powerText}\nЗаряд батареи — ${chargeText}` };
  }
  const duration = snapshot.startedAt === undefined ? "время запуска неизвестно"
    : formatDuration(sample.measuredAt - snapshot.startedAt);
  delete snapshot.startedAt;
  return { running: false, message: `⏹ Генератор выключился\n\nПроработал — ${duration}\nЗаряд батареи — ${chargeText}` };
}
