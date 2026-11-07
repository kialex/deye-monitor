import { voltageAdvice, DEFAULT_VOLTAGE_LIMITS, formatVoltagePhases, phaseLevels, voltageHeading, type VoltageLimits } from "./phase-voltage";
export { DEFAULT_VOLTAGE_LIMITS, type VoltageLimits } from "./phase-voltage";
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
  const relay = device?.dataList?.find(point => normalizeTelemetryKey(point.key) === "gridrelaystatus")
    ?.value;
  if (fresh && relay === "Break") {
    state = "absent";
  } else if (relay !== undefined && relay !== "Pull-in") {
    // Unknown relay states must not be interpreted as a confirmed grid reconnection.
    state = undefined;
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


export function batteryDetails(station?: Station, runtime?: string): string {
  return [
    `Заряд — ${format(station?.batterySOC, "%")}`,
    `Примерное время работы — ${runtime?.replace(/^около /, "") ?? "пока неизвестно"}`,
    `Потребление — ${format(station?.consumptionPower === undefined ? undefined : station.consumptionPower / 1000, "кВт")}`,
  ].join("\n");
}

export function gridProblem(volts: (number | undefined)[], limits: VoltageLimits): string {
  if (volts.every(v => v === 0)) return "пропало напряжение в городской сети";
  const problems = volts.flatMap((v, i) => v === undefined ? [] : v === 0
    ? [`нет напряжения на L${i + 1}`] : v < limits.low_volts
    ? [`низкое напряжение на L${i + 1}`] : v > Math.min(limits.high_volts, DEFAULT_VOLTAGE_LIMITS.high_volts)
    ? [`высокое напряжение на L${i + 1}`] : []);
  return problems.join("; ");
}

export function formatGridAlert(
  state: "present" | "absent", measuredAt: number, station?: Station, batteryRuntime?: string,
  volts: (number | undefined)[] = [], limits: VoltageLimits = DEFAULT_VOLTAGE_LIMITS,
  changedAt?: number, phasesRestored = false, previousPhases?: string,
): string {
  if (state === "present") {
    const minutes = changedAt === undefined ? undefined : Math.max(0, Math.floor((measuredAt - changedAt) / 60_000));
    const duration = minutes === undefined ? undefined : minutes < 1 ? "менее минуты"
      : `${Math.floor(minutes / 60) ? Math.floor(minutes / 60) + " ч " : ""}${minutes % 60} мин`;
    return ["🟢 Вернулись на городскую сеть", phasesRestored ? "Напряжение на всех фазах в норме." : "",
      "", duration ? `На аккумуляторах — ${duration}` : "", `Заряд — ${format(station?.batterySOC, "%")}`]
      .filter((line, i) => line || i === 2).join("\n");
  }
  const levels = phaseLevels(volts, limits);
  const allMissing = volts.length > 0 && volts.every(v => v === 0);
  const problem = volts.length ? gridProblem(volts, limits) : "";
  const reason = allMissing ? "пропало напряжение в городской сети"
    : problem ? voltageHeading(levels, limits).replace(/^\S+ /u, "").replace(/^./u, c => c.toLowerCase()) : "";
  return ["🔋 Перешли на аккумуляторы", reason ? `Причина — ${reason}.`
    : "Инвертор отключился от городской сети. Причина не определена.",
    reason && !allMissing ? formatVoltagePhases(volts, limits, previousPhases) : "", "", batteryDetails(station, batteryRuntime),
    ...(voltageAdvice(levels) ? ["", voltageAdvice(levels)] : [])]
    .filter((line, i) => line || i === 3 || i === 5).join("\n");
}

export function formatStatus(station?: Station, device?: Device): string {
  const { volts, measuredAt, fresh, state } = readGridSample(device);
  const grid = fresh
    ? (state ? { present: "есть напряжение", absent: "напряжения нет" }[state] : "недостаточно данных")
    : "нет свежих данных";

  return [
    "⚡ Состояние Deye",
    `🔋 Заряд батареи — ${format(station?.batterySOC, "%")}`,
    `🔌 Подключение к сети — ${grid === "напряжения нет" ? "инвертор отключён от сети" : grid}`,
    formatPhaseVoltages(volts),
    `☀️ Генерация — ${format(station?.generationPower, "Вт")}`,
    `🏠 Потребление — ${format(station?.consumptionPower, "Вт")}`,
    `🕒 Данные станции — ${formatTime(parseStationTime(station?.lastUpdateTime))}`,
    `🕒 Замер напряжения — ${formatTime(measuredAt)}`,
  ].join("\n");
}
