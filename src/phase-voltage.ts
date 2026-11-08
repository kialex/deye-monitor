import type { NotificationKind } from "./notification-settings";
export interface VoltageLimits { low_volts: number; high_volts: number }
export const DEFAULT_VOLTAGE_LIMITS: VoltageLimits = { low_volts: 195.5, high_volts: 253 };

const HIGH_VOLTS = 253;
const VERY_HIGH_VOLTS = 260;
const CRITICAL_HIGH_VOLTS = 270;
const VERY_LOW_VOLTS = 185;
const CRITICAL_VOLTS = 170;
export const CRITICAL_VOLTAGE_ADVICE = "Отключите чувствительную технику, питающуюся напрямую от городской сети.";

export const HIGH_VOLTAGE_ADVICE = "Отключите всю технику, питающуюся напрямую от городской сети.";

type PhaseLevel = "normal" | "low" | "very-low" | "critical" | "missing" | "high" | "very-high" | "critical-high" | "unknown";
const SEVERITY: Record<PhaseLevel, number> = {
  normal: 0, low: 1, "very-low": 2, critical: 3, missing: 4, high: 1, "very-high": 2, "critical-high": 3, unknown: -1,
};

export function phaseLevels(volts: (number | undefined)[], limits: VoltageLimits): PhaseLevel[] {
  return volts.map(value => {
    if (value === undefined || !Number.isFinite(value)) return "unknown";
    if (value === 0) return "missing";
    if (value >= CRITICAL_HIGH_VOLTS) return "critical-high";
    if (value >= VERY_HIGH_VOLTS) return "very-high";
    if (value > Math.min(limits.high_volts, HIGH_VOLTS)) return "high";
    if (value >= limits.low_volts) return "normal";
    if (value < CRITICAL_VOLTS) return "critical";
    if (value < VERY_LOW_VOLTS) return "very-low";
    return "low";
  });
}

function number(value: number): string {
  return value.toLocaleString("ru-RU", { maximumFractionDigits: 1 });
}

export function formatVoltagePhases(
  volts: (number | undefined)[], limits: VoltageLimits, previousSignature?: string,
): string {
  const previous = previousSignature?.split(",") as PhaseLevel[] | undefined;
  const levels = phaseLevels(volts, limits);
  return volts.map((value, i) => {
    const before = previous?.[i];
    const changed = before !== undefined && before !== "unknown" && levels[i] !== "unknown" && before !== levels[i];
    const improving = before !== undefined && SEVERITY[levels[i]] < SEVERITY[before];
    const direction = isHigh(levels[i]) ? (improving ? "↓" : "↑")
      : before !== undefined && isHigh(before) ? "↓" : improving ? "↑" : "↓";
    const arrow = changed ? ` ${improving ? "🟢" : "🔴"}${direction}` : "";
    return `L${i + 1} — ${value === undefined ? "нет данных" : number(value) + " В"}${arrow}`;
  }).join(" · ");
}

export function voltageHeading(levels: PhaseLevel[], limits: VoltageLimits): string {
  if (levels.includes("missing")) return "⚠️ Нет напряжения на фазах";
  if (levels.includes("critical-high")) return `🔴 Критически высокое напряжение · от ${CRITICAL_HIGH_VOLTS} В`;
  if (levels.includes("critical")) return `🔴 Критически низкое напряжение · ниже ${CRITICAL_VOLTS} В`;
  if (levels.includes("very-high")) return `🟠 Очень высокое напряжение · ${VERY_HIGH_VOLTS}–${CRITICAL_HIGH_VOLTS} В`;
  if (levels.includes("very-low")) return `🟠 Очень низкое напряжение · ${CRITICAL_VOLTS}–${VERY_LOW_VOLTS} В`;
  if (levels.includes("high")) return `⚠️ Высокое напряжение · ${number(Math.min(limits.high_volts, HIGH_VOLTS))}–${VERY_HIGH_VOLTS} В`;
  if (levels.includes("low")) return `⚠️ Низкое напряжение · ${VERY_LOW_VOLTS}–${number(limits.low_volts)} В`;
  return "✅ Напряжение на всех фазах восстановилось";
}


function isHigh(level: PhaseLevel): boolean {
  return level === "high" || level === "very-high" || level === "critical-high";
}

export function voltageAdvice(levels: PhaseLevel[]): string {
  return levels.some(isHigh) ? HIGH_VOLTAGE_ADVICE : levels.includes("critical") ? CRITICAL_VOLTAGE_ADVICE : "";
}

export function formatPhaseAlert(
  volts: (number | undefined)[], limits: VoltageLimits, previousSignature?: string,
): string {
  const levels = phaseLevels(volts, limits);
  const previous = previousSignature?.split(",") as PhaseLevel[] | undefined;
  let heading = voltageHeading(levels, limits);
  // Mixed changes are described by the current worst level, never as a general improvement.
  const improved = previous && levels.some((level, i) => SEVERITY[level] < SEVERITY[previous[i]])
    && levels.every((level, i) => SEVERITY[level] <= SEVERITY[previous[i]]);
  if (improved && levels.some(level => level !== "normal")) {
    heading = heading.replace(/(Низкое|Очень низкое|Критически низкое) напряжение/, "Напряжение повышается")
      .replace(/(Высокое|Очень высокое|Критически высокое) напряжение/, "Напряжение снижается");
  }
  return [heading, "", formatVoltagePhases(volts, limits, previousSignature),
    ...(voltageAdvice(levels) ? ["", voltageAdvice(levels)] : [])].join("\n");
}

// Classify changed phases rather than the worst phase that was already abnormal.
export function phaseNotificationKinds(
  volts: (number | undefined)[], limits: VoltageLimits, previousSignature?: string,
): NotificationKind[] {
  const levels = phaseLevels(volts, limits);
  const previous = previousSignature?.split(",") as PhaseLevel[] | undefined;
  if (levels.every(level => level === "normal")) return previous ? ["phase_restored"] : [];
  const kinds: NotificationKind[] = [];
  const destinations: Partial<Record<PhaseLevel, NotificationKind>> = {
    low: "low", "very-low": "very_low", critical: "critical_low", high: "high",
    "very-high": "very_high", "critical-high": "critical_high", missing: "phase_missing",
  };
  for (let i = 0; i < levels.length; i++) {
    const level = levels[i];
    const before = previous?.[i];
    if (level === before || level === "unknown") continue;
    if (before && SEVERITY[level] < SEVERITY[before]) kinds.push("phase_improved");
    else if (destinations[level]) kinds.push(destinations[level]!);
  }
  return [...new Set(kinds)];
}
