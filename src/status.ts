import { GRID_PHASE_KEYS, DISPLAY_TIME_ZONE, GRID_PRESENT_MIN_VOLTS, VOLTAGE_MAX_AGE_MS } from "./constants";
import type { Device, Station } from "./deye";

export function parseStationTime(value: Station["lastUpdateTime"]): number {
  if (typeof value === "number") return value * 1000;
  return value ? Date.parse(value) : NaN;
}

function normalizeTelemetryKey(key: string): string {
  return key.replace(/\s+/g, "").toLowerCase();
}

export function readGridSample(device?: Device) {
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
  const fresh = age >= 0 && age <= VOLTAGE_MAX_AGE_MS;
  let state: "present" | "absent" | undefined;
  if (fresh && volts.some(value => value !== undefined && value >= GRID_PRESENT_MIN_VOLTS)) {
    state = "present";
  } else if (fresh && volts.every(value => value === 0)) {
    state = "absent";
  }
  return { volts, measuredAt, fresh, state };
}

function format(value: number | undefined, unit: string): string {
  return typeof value === "number" && Number.isFinite(value)
    ? `${value.toLocaleString("ru-RU", { maximumFractionDigits: 1 })} ${unit}`
    : "нет данных";
}

export function formatTime(value: number): string {
  return Number.isFinite(value)
    ? new Date(value).toLocaleString("ru-RU", { timeZone: DISPLAY_TIME_ZONE })
    : "нет данных";
}

export function formatPhaseVoltages(volts: (number | undefined)[]): string {
  return volts.map((value, index) => `L${index + 1} — ${format(value, "В")}`).join(" · ");
}

export function readGridTransition(device?: Device) {
  const sample = readGridSample(device);
  const allPhasesPresent = sample.volts.every(
    value => value !== undefined && value >= GRID_PRESENT_MIN_VOLTS,
  );
  return {
    ...sample,
    state: sample.state === "present" && !allPhasesPresent ? undefined : sample.state,
  };
}

export function formatGridAlert(
  state: "present" | "absent",
  measuredAt: number,
  station?: Station,
  batteryRuntime?: string,
): string {
  const time = new Date(measuredAt).toLocaleTimeString("ru-RU", {
    timeZone: DISPLAY_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
  });

  if (state === "present") {
    return `🟢 Вернулись на городскую сеть · ${time}\nНапряжение есть на всех трёх фазах.`;
  }

  const details = [];
  if (typeof station?.batterySOC === "number" && Number.isFinite(station.batterySOC)) {
    details.push(`Заряд ${format(station.batterySOC, "%")}`);
  }
  if (typeof station?.consumptionPower === "number" && Number.isFinite(station.consumptionPower)) {
    details.push(`Нагрузка ${format(station.consumptionPower / 1000, "кВт")}`);
  }

  return [
    `🔋 Перешли на аккумуляторы · ${time}`,
    ...(details.length ? [details.join(" · ")] : []),
    ...(batteryRuntime ? [`⏳ При текущем разряде — ${batteryRuntime}`] : []),
  ].join("\n");
}

export function formatStatus(station?: Station, device?: Device): string {
  const { volts, measuredAt, fresh, state } = readGridSample(device);
  const grid = fresh
    ? (state ? { present: "есть напряжение", absent: "напряжения нет" }[state] : "недостаточно данных")
    : "нет свежих данных";

  return [
    "⚡ Состояние Deye",
    `🔋 Заряд батареи — ${format(station?.batterySOC, "%")}`,
    `🔌 Сеть — ${grid}`,
    formatPhaseVoltages(volts),
    `☀️ Генерация — ${format(station?.generationPower, "Вт")}`,
    `🏠 Потребление — ${format(station?.consumptionPower, "Вт")}`,
    `🕒 Данные станции — ${formatTime(parseStationTime(station?.lastUpdateTime))}`,
    `🕒 Замер напряжения — ${formatTime(measuredAt)}`,
  ].join("\n");
}
