import { VOLTAGE_MAX_AGE_MS } from "./constants";
import type { DeyeClient, Device, Station } from "./deye";
import type { GridDatabase } from "./grid-monitor";
import { formatTime, parseStationTime, readGridTransition } from "./status";

const DEFAULT_VOLTAGE_LIMITS = { low_volts: 195.5, high_volts: 264.5 }; // 230 V ± 15%
const FAULT_LOOKBACK_MS = 24 * 60 * 60_000;

interface Snapshot {
  checkedAt?: number;
  latestSample?: number;
  offline?: boolean;
  batteryBand?: number;
  phaseSample?: number;
  phaseCandidate?: string;
  phaseConfirmed?: string;
  faultCheckedAt?: number;
  faults?: Record<string, boolean>;
}

interface VoltageLimits {
  low_volts: number;
  high_volts: number;
}

function updateConnectivity(snapshot: Snapshot, measuredAt: number, now: number, messages: string[]) {
  snapshot.checkedAt ??= now;
  if (measuredAt > 0 && measuredAt <= now) {
    snapshot.latestSample = Math.max(snapshot.latestSample ?? 0, measuredAt);
  }
  const last = snapshot.latestSample ?? snapshot.checkedAt;
  const offline = now - last >= VOLTAGE_MAX_AGE_MS;
  if (offline && !snapshot.offline) {
    const lastReading = snapshot.latestSample ? " Последний замер — " + formatTime(last) + "." : "";
    messages.push("📡 Данные инвертора не обновляются 15 минут. Текущее состояние сети неизвестно." + lastReading);
  } else if (!offline && snapshot.offline) {
    messages.push("✅ Данные инвертора снова обновляются.");
  }
  snapshot.offline = offline;
}

function updateBattery(
  snapshot: Snapshot, sample: ReturnType<typeof readGridTransition>, station: Station | undefined,
  shutdown: number | undefined, runtime: string | undefined, messages: string[],
) {
  if (sample.state === "present") {
    delete snapshot.batteryBand;
    return;
  }

  const charge = station?.batterySOC;
  const stationTime = parseStationTime(station?.lastUpdateTime);
  if (sample.state !== "absent" || charge === undefined || !Number.isFinite(charge) || charge < 0 || charge > 100 ||
      !Number.isFinite(stationTime) || Math.abs(stationTime - sample.measuredAt) > 120_000) return;
  const atShutdown = shutdown !== undefined && charge <= shutdown;
  const band = atShutdown ? 0 : [20, 30, 50, 80].find(threshold => charge <= threshold) ?? 101;
  const previous = snapshot.batteryBand;
  snapshot.batteryBand = Math.min(previous ?? 101, band);
  if ((previous === undefined && !atShutdown) || (previous !== undefined && band >= previous)) return;

  const percent = charge.toLocaleString("ru-RU", { maximumFractionDigits: 1 });
  if (atShutdown) {
    messages.push(`🪫 Аккумуляторы достигли нижнего порога — ${shutdown}%. Текущий заряд — ${percent}%.`);
    return;
  }
  const icon = charge < 50 ? "🪫" : "🔋";
  messages.push(`${icon} Заряд аккумуляторов — ${percent}%.\n${runtime
    ? "⏳ При текущем разряде осталось " + runtime + "."
    : "⏳ Время работы пока неизвестно."}`);
}

function updatePhases(
  snapshot: Snapshot, sample: ReturnType<typeof readGridTransition>, limits: VoltageLimits, messages: string[],
) {
  if (!sample.fresh || sample.measuredAt <= (snapshot.phaseSample ?? 0)) return;
  const previousSample = snapshot.phaseSample;
  snapshot.phaseSample = sample.measuredAt;
  const volts = sample.volts;
  if (sample.state === "absent" || volts.some(value => value === undefined)) {
    delete snapshot.phaseCandidate;
    if (sample.state === "absent") delete snapshot.phaseConfirmed;
    return;
  }
  const phases = volts.map(value => {
    if (value === 0) return "missing";
    if (value !== undefined && value < limits.low_volts) return "low";
    if (value !== undefined && value > limits.high_volts) return "high";
    return "normal";
  });
  const signature = phases.join(",");
  if (snapshot.phaseCandidate !== signature ||
      sample.measuredAt - (previousSample ?? 0) > VOLTAGE_MAX_AGE_MS) {
    snapshot.phaseCandidate = signature;
    return;
  }
  const normal = phases.every(phase => phase === "normal");
  if (snapshot.phaseConfirmed === signature) return;
  if (normal) {
    if (snapshot.phaseConfirmed) messages.push("✅ Напряжение на всех фазах восстановилось.");
  } else {
    const deviations = phases.flatMap((phase, index) => phase === "normal" ? [] : [
      `L${index + 1} — ${volts[index]} В (${{ missing: "нет напряжения", low: "ниже предела", high: "выше предела" }[phase]})`,
    ]);
    messages.push("⚡ Отклонение напряжения на фазах\n" + deviations.join("\n"));
  }
  snapshot.phaseConfirmed = signature;
}

async function updateFaults(client: DeyeClient, snapshot: Snapshot, now: number, messages: string[]) {
  try {
    const start = Math.min(now - FAULT_LOOKBACK_MS, snapshot.faultCheckedAt ?? now);
    const faults = await client.getFaults(Math.floor(start / 1000), Math.floor(now / 1000));
    const seen = new Map(Object.entries(snapshot.faults ?? {}));
    for (const fault of faults) {
      if (!fault.alertId || !Number.isFinite(fault.alertStartTime)) continue;
      const ended = (fault.alertEndTime ?? 0) > 0;
      const previous = seen.get(fault.alertId);
      const label = [fault.alertName, Number.isFinite(fault.alertCode) ? `код ${fault.alertCode}` : ""]
        .filter(Boolean).join(" · ") || "без описания";
      if (previous === undefined && (!ended || fault.alertStartTime * 1000 >= (snapshot.faultCheckedAt ?? now))) {
        messages.push("⚠️ Ошибка инвертора — " + label + (fault.description ? "\n" + fault.description.slice(0, 300) : ""));
      }
      if (previous === false && ended) messages.push("✅ Ошибка инвертора устранена — " + label);
      seen.set(fault.alertId, ended);
    }
    snapshot.faults = Object.fromEntries(seen);
    snapshot.faultCheckedAt = now;
  } catch {
    console.warn("Deye fault history unavailable");
  }
}

export async function updateMonitorNotifications(
  db: GridDatabase, client: DeyeClient, serial: string, name: string | undefined,
  device: Device | undefined, station: Station | undefined, shutdown?: number, runtime?: string,
) {
  await db.prepare("INSERT OR IGNORE INTO monitor_notifications (device_sn) VALUES (?1) RETURNING device_sn")
    .bind(serial).first();
  const row = await db.prepare("SELECT revision, snapshot FROM monitor_notifications WHERE device_sn = ?1")
    .bind(serial).first<{ revision: number; snapshot: string }>();
  if (!row) return;

  const snapshot = JSON.parse(row.snapshot) as Snapshot;
  const messages: string[] = [];
  const now = Date.now();
  const sample = readGridTransition(device);
  const limits = await db.prepare("SELECT low_volts, high_volts FROM grid_voltage_limits WHERE device_sn = ?1")
    .bind(serial).first<VoltageLimits>();

  updateConnectivity(snapshot, sample.measuredAt, now, messages);
  updateBattery(snapshot, sample, station, shutdown, runtime, messages);
  updatePhases(snapshot, sample, limits ?? DEFAULT_VOLTAGE_LIMITS, messages);
  if (now - (snapshot.faultCheckedAt ?? 0) >= 5 * 60_000) {
    await updateFaults(client, snapshot, now, messages);
  }

  const message = messages.length ? [name, ...messages].filter(Boolean).join("\n\n").slice(0, 3900) : "";
  // Negative sequence keys separate monitor events from the positive grid sample timestamps.
  await db.batch([
    db.prepare(`
      INSERT INTO grid_alerts (device_sn, measured_at, message)
      SELECT device_sn, -revision - 1, ?3 FROM monitor_notifications
      WHERE device_sn = ?1 AND revision = ?2 AND ?3 <> ''
    `).bind(serial, row.revision, message),
    db.prepare(`
      UPDATE monitor_notifications SET revision = revision + 1, snapshot = ?3
      WHERE device_sn = ?1 AND revision = ?2
    `).bind(serial, row.revision, JSON.stringify(snapshot)),
  ]);
}
