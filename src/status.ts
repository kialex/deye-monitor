import { GRID_PHASE_KEYS, DISPLAY_TIME_ZONE, GRID_PRESENT_MIN_VOLTS, VOLTAGE_MAX_AGE_MS } from "./constants";
import type { Device, Station } from "./deye";

function parseStationTime(value: Station["lastUpdateTime"]): number {
  if (typeof value === "number") return value * 1000;
  return value ? Date.parse(value) : NaN;
}

function normalizeTelemetryKey(key: string): string {
  return key.replace(/\s+/g, "").toLowerCase();
}

export function formatStatus(station?: Station, device?: Device): string {
  const volts = GRID_PHASE_KEYS.map(key => {
    const normalizedKey = normalizeTelemetryKey(key);
    const point = device?.dataList?.find(point =>
      normalizeTelemetryKey(point.key) === normalizedKey && point.unit === "V");
    if (!point || String(point.value).trim() === "") return undefined;
    const value = Number(point.value);
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  });

  const measuredAt = device?.collectionTime ? device.collectionTime * 1000 : NaN;
  const age = Date.now() - measuredAt;
  let grid = "нет свежих данных";
  if (age >= 0 && age <= VOLTAGE_MAX_AGE_MS) {
    grid = volts.some(value => value !== undefined && value >= GRID_PRESENT_MIN_VOLTS)
      ? "есть напряжение"
      : volts.every(value => value === 0) ? "напряжения нет" : "недостаточно данных";
  }

  const format = (value: number | undefined, unit: string) =>
    typeof value === "number" && Number.isFinite(value)
      ? `${value.toLocaleString("ru-RU", { maximumFractionDigits: 1 })} ${unit}`
      : "нет данных";
  const time = (value: number) => Number.isFinite(value)
    ? new Date(value).toLocaleString("ru-RU", { timeZone: DISPLAY_TIME_ZONE })
    : "нет данных";

  return [
    "⚡ Состояние Deye",
    `🔋 Заряд батареи — ${format(station?.batterySOC, "%")}`,
    `🔌 Сеть — ${grid}`,
    volts.map((value, index) => `L${index + 1} — ${format(value, "В")}`).join(" · "),
    `☀️ Генерация — ${format(station?.generationPower, "Вт")}`,
    `🏠 Потребление — ${format(station?.consumptionPower, "Вт")}`,
    `🕒 Данные станции — ${time(parseStationTime(station?.lastUpdateTime))}`,
    `🕒 Замер напряжения — ${time(measuredAt)}`,
  ].join("\n");
}
