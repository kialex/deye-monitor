import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { enqueueDeviceAlerts, deliverPendingAlerts, deliveryRetryDelay } from '../src/alert-delivery';
import { formatGridAlert, readGridTransition } from '../src/status';
import { updateMonitorNotifications } from '../src/monitor-notifications';
import type { DeyeClient } from '../src/deye';
import { DEFAULT_VOLTAGE_LIMITS } from '../src/phase-voltage';
import type { GridDatabase } from '../src/grid-monitor';
import type { Env } from '../src/env';

function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  for (const file of readdirSync('migrations').filter(file => file.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync('migrations/' + file, 'utf8'));
  }
  function prepare(sql: string) {
    let values: (number | string)[] = [];
    return {
      bind(...bindings: (number | string)[]) { values = bindings; return this; },
      async first() { return sqlite.prepare(sql).get(...values) ?? null; },
      async all() { return { results: sqlite.prepare(sql).all(...values) }; },
    };
  }
  const db = {
    prepare,
    async batch(statements: ReturnType<typeof prepare>[]) {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.all());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  } as GridDatabase;
  return { db, sqlite };
}

const env = { TELEGRAM_BOT_TOKEN: 'test', DEYE_DEVICE_SN: '', TELEGRAM_CHAT_ID: '' } as Env;
const originalFetch = globalThis.fetch;
const originalNow = Date.now;
let now = 1_795_000_000_000;
function reset() { now = 1_795_000_000_000; Date.now = () => now; }
function subscribe(sqlite: DatabaseSync, serial = 'sn', chat = '123') {
  sqlite.prepare('INSERT INTO chat_subscriptions VALUES (?, ?, 1)').run(serial, chat);
}
function event(sqlite: DatabaseSync, serial = 'sn', message = '🔋 Перешли на аккумуляторы', age = 0) {
  return sqlite.prepare('INSERT INTO grid_alerts (device_sn, measured_at, message, created_at) VALUES (?, ?, ?, ?)')
    .run(serial, now + Number(sqlite.prepare('SELECT COUNT(*) AS n FROM grid_alerts').get()!.n), message, now - age);
}
function pending(sqlite: DatabaseSync) { return Number(sqlite.prepare('SELECT COUNT(*) AS n FROM alert_deliveries WHERE sent_at IS NULL').get()!.n); }
function mockTelegram(send: (body: any) => Response | Promise<Response>) {
  globalThis.fetch = (async (_url, options) => send(JSON.parse(String(options?.body)))) as typeof fetch;
}

test.afterEach(() => { globalThis.fetch = originalFetch; Date.now = originalNow; });

test('high voltage and open relay are detected independently; transient evidence is labelled', () => {
  reset();
  const sample = readGridTransition({ collectionTime: now / 1000, dataList: [
    { key: 'GridRelayStatus', unit: '', value: 'Break' },
    ...[270, 230, 230].map((value, i) => ({ key: 'GridVoltageL' + (i + 1), unit: 'V', value })),
  ] });
  assert.equal(sample.state, 'absent');
  assert.match(formatGridAlert('absent', now, undefined, undefined, sample.volts), /высокое напряжение/);
  const previous = { measuredAt: now - 60_000, volts: [275, 230, 230] };
  const message = formatGridAlert('absent', now, undefined, undefined, [230, 230, 230], DEFAULT_VOLTAGE_LIMITS,
    undefined, false, { previous, frequency: 50 });
  assert.match(message, /Перед отключением/);
  assert.match(message, /275 В/);
  assert.match(message, /Последний замер: L1 — 230 В/);
  assert.match(message, /Частота сети — 50 Гц/);
  const stale = formatGridAlert('absent', now, undefined, undefined, [230, 230, 230], DEFAULT_VOLTAGE_LIMITS,
    undefined, false, { previous: { ...previous, measuredAt: now - 180_000 } });
  assert.doesNotMatch(stale, /Перед отключением/);
  assert.match(stale, /Точную причину Deye не сообщил/);
});

test('ten delayed events become one summary, and completed messages are removed', async () => {
  reset(); const { db, sqlite } = database(); subscribe(sqlite);
  for (let i = 0; i < 10; i++) event(sqlite, 'sn', `Событие ${i}`, 600_000 - i * 1000);
  await enqueueDeviceAlerts(db, env, 'sn');
  const sent: string[] = [];
  mockTelegram(body => { sent.push(body.text); return Response.json({ ok: true }); });
  await deliverPendingAlerts(db, env);
  assert.equal(sent.length, 1); assert.match(sent[0], /Накопились уведомления — 10/);
  assert.match(sent[0], /последние 3 из 10/); assert.match(sent[0], /Событие 9/);
  assert.doesNotMatch(sent[0], /Событие 0/); assert.equal(pending(sqlite), 0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM grid_alerts').get()!.n, 0);
});

test('one chat across multiple inverters and overlapping cron runs has one sender', async () => {
  reset(); const { db, sqlite } = database(); subscribe(sqlite); subscribe(sqlite, 'other');
  event(sqlite); event(sqlite, 'other');
  await enqueueDeviceAlerts(db, env, 'sn'); await enqueueDeviceAlerts(db, env, 'other');
  let sent = 0; let release!: () => void; let started!: () => void;
  const gate = new Promise<void>(resolve => release = resolve);
  const sending = new Promise<void>(resolve => started = resolve);
  mockTelegram(async () => { sent++; started(); await gate; return Response.json({ ok: true }); });
  const first = deliverPendingAlerts(db, env); await sending;
  await deliverPendingAlerts(db, env); assert.equal(sent, 1);
  event(sqlite, 'sn', 'Новое событие во время отправки'); await enqueueDeviceAlerts(db, env, 'sn');
  release(); await first; assert.equal(pending(sqlite), 1);
  await deliverPendingAlerts(db, env); assert.equal(sent, 1);
  now += 60_001; await deliverPendingAlerts(db, env); assert.equal(sent, 2); assert.equal(pending(sqlite), 0);
});

test('failed delivery stays pending; Telegram retry_after is respected without replay bursts', async () => {
  reset(); const { db, sqlite } = database(); subscribe(sqlite); event(sqlite); await enqueueDeviceAlerts(db, env, 'sn');
  let attempts = 0;
  mockTelegram(() => { attempts++; return Response.json({ ok: false, parameters: { retry_after: 180 } }, { status: 429 }); });
  await deliverPendingAlerts(db, env); assert.equal(pending(sqlite), 1);
  assert.equal(sqlite.prepare('SELECT last_status FROM telegram_delivery_state').get()!.last_status, 429);
  now += 120_000; await deliverPendingAlerts(db, env); assert.equal(attempts, 1);
  event(sqlite, 'sn', 'Событие после ошибки'); await enqueueDeviceAlerts(db, env, 'sn');
  now += 60_001; const messages: string[] = [];
  mockTelegram(body => { messages.push(body.text); return Response.json({ ok: true }); });
  await deliverPendingAlerts(db, env); assert.equal(messages.length, 1); assert.match(messages[0], /уведомления — 2/);
  assert.equal(pending(sqlite), 0);
  assert.equal(deliveryRetryDelay(0), 60_000); assert.equal(deliveryRetryDelay(1), 120_000);
  assert.equal(deliveryRetryDelay(20), 900_000);
});

test('one successful recipient does not erase another recipient pending delivery', async () => {
  reset(); const { db, sqlite } = database(); subscribe(sqlite); subscribe(sqlite, 'sn', '456');
  event(sqlite); await enqueueDeviceAlerts(db, env, 'sn');
  mockTelegram(body => body.chat_id === '123' ? Response.json({ ok: true }) : Promise.reject(new TypeError('Network failed')));
  await deliverPendingAlerts(db, env); assert.equal(pending(sqlite), 1);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM grid_alerts').get()!.n, 1);
  now += 60_001; let sent = 0;
  mockTelegram(body => { assert.equal(body.chat_id, '456'); sent++; return Response.json({ ok: true }); });
  await deliverPendingAlerts(db, env); assert.equal(sent, 1); assert.equal(pending(sqlite), 0);
});

test('disabled subscriptions do not receive accumulated events', async () => {
  reset(); const { db, sqlite } = database(); subscribe(sqlite); event(sqlite); await enqueueDeviceAlerts(db, env, 'sn');
  sqlite.exec('UPDATE chat_subscriptions SET enabled = 0');
  mockTelegram(() => { throw new Error('Should not send'); });
  await deliverPendingAlerts(db, env); assert.equal(pending(sqlite), 0);
});


test('monitor persists evidence and event time; repeated samples do not enqueue another outage', async () => {
  reset(); const { db, sqlite } = database();
  sqlite.prepare('INSERT INTO grid_state VALUES (?, ?, ?, ?)').run('sn', 'present', now - 60_000, now - 600_000);
  sqlite.prepare('INSERT INTO monitor_notifications (device_sn, snapshot) VALUES (?, ?)').run('sn', JSON.stringify({
    gridState: 'present', gridMeasuredAt: now - 60_000,
    lastGridObservation: { measuredAt: now - 60_000, volts: [275, 230, 230], frequency: 50 },
  }));
  const device = { collectionTime: now / 1000, dataList: [
    { key: 'GridRelayStatus', value: 'Break', unit: '' },
    ...[230, 230, 230].map((value, i) => ({ key: 'GridVoltageL' + (i + 1), value, unit: 'V' })),
  ] };
  const client = { getFaults: async () => [] } as unknown as DeyeClient;
  await updateMonitorNotifications(db, client, 'sn', 'name', device, undefined);
  const alert = sqlite.prepare('SELECT message, created_at FROM grid_alerts').get()!;
  assert.match(String(alert.message), /Перед отключением/); assert.match(String(alert.message), /275 В/);
  assert.equal(alert.created_at, now);
  await updateMonitorNotifications(db, client, 'sn', 'name', device, undefined);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM grid_alerts').get()!.n, 1);
  const snapshot = JSON.parse(String(sqlite.prepare('SELECT snapshot FROM monitor_notifications').get()!.snapshot));
  assert.deepEqual(snapshot.lastGridObservation.volts, [230, 230, 230]);
});

test('an expired lease can recover, but a live sender lease cannot be stolen', async () => {
  reset(); const { db, sqlite } = database(); subscribe(sqlite); event(sqlite); await enqueueDeviceAlerts(db, env, 'sn');
  sqlite.prepare('INSERT INTO telegram_delivery_state (chat_id, lease_until) VALUES (?, ?)').run('123', now + 90_000);
  let sent = 0; mockTelegram(() => { sent++; return Response.json({ ok: true }); });
  await deliverPendingAlerts(db, env); assert.equal(sent, 0);
  now += 90_001; await deliverPendingAlerts(db, env); assert.equal(sent, 1);
});
