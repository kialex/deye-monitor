import { updateGenerator, type GeneratorSnapshot } from "./generator";
import { VOLTAGE_MAX_AGE_MS } from "./constants";
import type { DeyeClient, Device, Station } from "./deye";
import type { GridDatabase } from "./grid-monitor";
import { batteryDetails, DEFAULT_VOLTAGE_LIMITS, formatGridAlert, formatPhaseVoltages, gridProblem, parseStationTime, readGridTransition, type VoltageLimits } from "./status";

const OFFLINE_ALERT_MS = 30 * 60_000;
const FAULT_LOOKBACK_MS = 24 * 60 * 60_000;

interface Snapshot {
  generator?: GeneratorSnapshot;
  gridState?: "present" | "absent";
  gridChangedAt?: number;
  gridMeasuredAt?: number;
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

function updateConnectivity(snapshot: Snapshot, measuredAt: number, now: number, messages: string[]) {
  snapshot.checkedAt ??= now;
  if (measuredAt > 0 && measuredAt <= now) {
    snapshot.latestSample = Math.max(snapshot.latestSample ?? 0, measuredAt);
  }
  const last = snapshot.latestSample ?? snapshot.checkedAt;
  const offline = now - last >= OFFLINE_ALERT_MS;
  if (offline && !snapshot.offline) {
    const minutes = Math.floor((now - last) / 60_000);
    messages.push(`📡 Нет свежих данных от инвертора\n\nПоследнее обновление — ${snapshot.latestSample ? minutes + " минут назад" : "неизвестно"}\nПитание дома и заряд сейчас неизвестны.`);
  } else if (!offline && snapshot.offline) {
    messages.push("✅ Связь с инвертором восстановлена");
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
    messages.push(`🪫 Достигнут нижний порог заряда\n\nЗаряд — ${percent} %\nНижний порог — ${shutdown} %`);
    return;
  }
  const icon = charge < 50 ? "🪫" : "🔋";
  messages.push(`${icon} Осталось ${percent} % заряда\n\n${batteryDetails(station, runtime).split("\n").slice(1).join("\n")}`);
}

function updatePhases(
  snapshot: Snapshot, sample: ReturnType<typeof readGridTransition>, limits: VoltageLimits, messages: string[],
) {
  if (!sample.fresh || sample.measuredAt <= (snapshot.phaseSample ?? 0)) return;
  const previousSample = snapshot.phaseSample;
  snapshot.phaseSample = sample.measuredAt;
  const volts = sample.volts;
  if (volts.every(value => value === 0) || volts.some(value => value === undefined)) {
    delete snapshot.phaseCandidate;
    if (volts.every(value => value === 0)) delete snapshot.phaseConfirmed;
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
    if (snapshot.phaseConfirmed) messages.push("✅ Напряжение на фазах восстановилось\n\n" + formatPhaseVoltages(volts));
  } else {
    const reason = gridProblem(volts, limits);
    messages.push("⚠️ " + reason.charAt(0).toUpperCase() + reason.slice(1) + "\n\n" + formatPhaseVoltages(volts)
      + `\nДопустимый диапазон — ${Math.round(limits.low_volts)}–${Math.round(limits.high_volts)} В`);
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
        messages.push("🚨 Ошибка инвертора\n\n" + label + (fault.description ? "\n" + fault.description.slice(0, 300) : ""));
      }
      if (previous === false && ended) messages.push("✅ Ошибка инвертора устранена\n\n" + label);
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

  snapshot.generator ??= {};
  const generator = updateGenerator(snapshot.generator, device, station, now);
  if (generator.message) messages.push(generator.message);
  const voltageLimits = limits ?? DEFAULT_VOLTAGE_LIMITS;
  if (!snapshot.gridState) {
    const previous = await db.prepare("SELECT state, changed_at, measured_at FROM grid_state WHERE device_sn = ?1")
      .bind(serial).first<{ state: "present" | "absent"; changed_at: number; measured_at: number }>();
    snapshot.gridState = previous?.state;
    snapshot.gridChangedAt = previous?.changed_at;
    snapshot.gridMeasuredAt = previous?.measured_at;
  }
  if (sample.measuredAt <= (snapshot.gridMeasuredAt ?? 0)) sample.state = undefined;
  const previousPhase = snapshot.phaseConfirmed;
  const transition = sample.state !== undefined && snapshot.gridState !== undefined && sample.state !== snapshot.gridState;
  const phaseMessages: string[] = [];
  const batteryMessages: string[] = [];
  const connectivityMessages: string[] = [];
  updateConnectivity(snapshot, sample.measuredAt, now, connectivityMessages);
  if (generator.running === true) delete snapshot.batteryBand;
  else updateBattery(snapshot, sample, station, shutdown, runtime, batteryMessages);
  updatePhases(snapshot, sample, voltageLimits, phaseMessages);
  if (transition) {
    if (!(sample.state === "absent" && generator.running === true)) messages.push(formatGridAlert(sample.state!, sample.measuredAt, station, runtime, sample.volts,
      voltageLimits, snapshot.gridChangedAt, Boolean(previousPhase && previousPhase !== "normal,normal,normal" && sample.volts.every(v => v !== undefined && v >= voltageLimits.low_volts && v <= voltageLimits.high_volts))));
    // The transition already describes the phase problem; don't repeat it on the next sample.
    if (sample.volts.every(v => v !== undefined)) {
      snapshot.phaseConfirmed = sample.volts.map(v => v === 0 ? "missing" : v! < voltageLimits.low_volts
        ? "low" : v! > voltageLimits.high_volts ? "high" : "normal").join(",");
    }
    if (batteryMessages.some(text => text.startsWith("🪫 Достигнут"))) messages.push(...batteryMessages);
  } else {
    messages.push(...batteryMessages, ...phaseMessages);
  }
  if (sample.state) {
    if (sample.state !== snapshot.gridState) snapshot.gridChangedAt = sample.measuredAt;
    snapshot.gridState = sample.state;
    snapshot.gridMeasuredAt = sample.measuredAt;
  }
  for (const text of connectivityMessages) {
    if (text.startsWith("✅") && transition) continue;
    messages.push(text.startsWith("✅") ? text + "\n\nПитание — "
      + (sample.state === "absent" && generator.running === true ? "от генератора"
        : sample.state === "absent" ? "от аккумуляторов\n" + batteryDetails(station, runtime)
        : sample.state === "present" ? "от городской сети\nЗаряд — " + (station?.batterySOC ?? "нет данных") + " %"
        : "неизвестно") : text);
  }
  if (now - (snapshot.faultCheckedAt ?? 0) >= 5 * 60_000) {
    const faults: string[] = [];
    await updateFaults(client, snapshot, now, faults);
    messages.push(...faults.map(text => sample.state === "absent" && generator.running !== true ? text + "\n\n" + batteryDetails(station, runtime) : text));
  }

  const message = messages.join("\n\n").slice(0, 3900);
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
