import { DISPLAY_TIME_ZONE } from "./constants";
import { DeyeClient, type StationHistoryItem } from "./deye";
import type { DeyeConfig } from "./env";
import { formatTime } from "./status";

export type StatisticsPeriod = "today" | "yesterday" | "week";
const SAMPLE_GAP_MS = 15 * 60_000;

function dateInZone(time: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: DISPLAY_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(time);
  return ["year", "month", "day"].map(type => parts.find(part => part.type === type)!.value).join("-");
}

function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(date + "T12:00:00Z") + days * 86_400_000).toISOString().slice(0, 10);
}

// Resolve local midnight using the offset on that date, including DST changes.
export function localMidnight(date: string): number {
  const target = Date.parse(date + "T00:00:00Z");
  let result = target;
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: DISPLAY_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  for (let i = 0; i < 3; i++) {
    const parts = formatter.formatToParts(result);
    const get = (type: string) => Number(parts.find(part => part.type === type)!.value);
    const local = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
    result += target - local;
  }
  return result;
}

export function statisticsRange(period: StatisticsPeriod, now = Date.now()) {
  const today = dateInZone(now);
  const startDate = shiftDate(today, period === "yesterday" ? -1 : period === "week" ? -6 : 0);
  const endDate = period === "yesterday" ? today : shiftDate(today, 1);
  return { startDate, endDate, start: localMidnight(startDate), end: Math.min(now, localMidnight(endDate)) };
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function timestamp(value: StationHistoryItem["timeStamp"]): number {
  if (typeof value === "number") return value * 1000;
  if (typeof value === "string" && /^\d+(\.\d+)?$/.test(value)) return Number(value) * 1000;
  return value ? Date.parse(value) : NaN;
}

function numeric(value: number): string {
  return value.toLocaleString("ru-RU", { maximumFractionDigits: 1 });
}

export function formatStatistics(
  period: StatisticsPeriod, range: ReturnType<typeof statisticsRange>,
  data: Awaited<ReturnType<DeyeClient["getStatistics"]>>,
): string {
  const days = new Map<string, StationHistoryItem>();
  for (const row of data.days) {
    if (!row.year || !row.month || !row.day) continue;
    const date = `${row.year}-${String(row.month).padStart(2, "0")}-${String(row.day).padStart(2, "0")}`;
    if (date >= range.startDate && date < range.endDate) days.set(date, row);
  }
  const expectedDays = Math.round((Date.parse(range.endDate) - Date.parse(range.startDate)) / 86_400_000);
  const sum = (key: keyof StationHistoryItem): number | undefined => {
    const values = [...days.values()].map(row => row[key]);
    return values.length === expectedDays && values.every(finite) ? values.reduce<number>((total, value) => total + value!, 0) : undefined;
  };
  const energy = (value: number | undefined) => value === undefined ? "нет полных данных" : numeric(value) + " кВт·ч";
  const samples = data.samples.map(row => ({ ...row, time: timestamp(row.timeStamp) }))
    .filter(row => row.time >= range.start && (period === "yesterday" ? row.time < range.end : row.time <= range.end)).sort((a, b) => a.time - b.time);
  const last = samples.at(-1)?.time;
  const coveredEnd = period === "yesterday" ? range.end : last;
  const consumption = sum("consumptionValue");
  const average = consumption !== undefined && coveredEnd !== undefined && coveredEnd > range.start
    ? consumption / ((coveredEnd - range.start) / 3_600_000) : undefined;
  const loads = samples.map(row => row.consumptionPower).filter(finite);
  const charges = samples.map(row => row.batterySOC).filter(value => finite(value) && value <= 100) as number[];
  const gaps = !samples.length || data.samplesTruncated || samples[0].time - range.start > SAMPLE_GAP_MS
    || range.end - (last ?? 0) > SAMPLE_GAP_MS
    || samples.some((row, i) => i > 0 && row.time - samples[i - 1].time > SAMPLE_GAP_MS);
  const label = { today: "Сегодня", yesterday: "Вчера", week: "Последние 7 дней" }[period];
  return [
    `📊 ${label} · ${range.startDate}${expectedDays > 1 ? " — " + shiftDate(range.endDate, -1) : ""}`,
    `Часовой пояс — Киев`,
    last ? `Последний замер — ${formatTime(last)}` : "История замеров недоступна",
    "", "🏠 Потребление",
    `Всего — ${energy(consumption)}`,
    `Средняя нагрузка — ${average === undefined ? "нет данных" : "≈ " + numeric(average) + " кВт"}`,
    `Максимум по замерам — ${loads.length ? numeric(Math.max(...loads) / 1000) + " кВт" : "нет данных"}`,
    "", "🔌 Городская сеть", `Получено — ${energy(sum("purchaseValue"))}`,
    "", "🔋 Аккумуляторы", `Заряжено — ${energy(sum("chargeValue"))}`,
    `Отдано — ${energy(sum("dischargeValue"))}`,
    `Минимальный заряд по замерам — ${charges.length ? numeric(Math.min(...charges)) + " %" : "нет данных"}`,
    "", "☀️ Солнечные панели", `Выработка — ${energy(sum("generationValue"))}`,
    ...(gaps || days.size !== expectedDays ? ["", "⚠️ Есть пропуски данных. Итоги могут быть неполными; максимум и минимум — по доступным замерам."] : []),
    "", "Статистика генератора и отключений за период пока недоступна.",
  ].join("\n");
}

export async function getStatisticsReport(config: DeyeConfig, period: StatisticsPeriod): Promise<string> {
  const range = statisticsRange(period);
  const data = await new DeyeClient(config).getStatistics(
    range.startDate, range.endDate, Math.floor(range.start / 1000), Math.floor(range.end / 1000),
  );
  return formatStatistics(period, range, data);
}
