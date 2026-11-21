import type { Env } from "./env";
import type { GridDatabase } from "./grid-monitor";
import { HttpError } from "./http";
import { formatTime } from "./status";
import { TelegramClient } from "./telegram";

const DELIVERY_INTERVAL_MS = 60_000;
const DELIVERY_LEASE_MS = 90_000;
const MAX_BACKOFF_MS = 15 * 60_000;
const DELAYED_MESSAGE_MS = 5 * 60_000;

interface AlertPreview {
  message: string;
  created_at: number;
  name?: string;
  device_sn: string;
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/, "") + "…";
}

export function formatDeliverySummary(alerts: AlertPreview[], count: number, now: number): string {
  if (count === 1 && alerts.length === 1 && now - alerts[0].created_at < DELAYED_MESSAGE_MS) return alerts[0].message;
  const multipleDevices = new Set(alerts.map(alert => alert.device_sn)).size > 1;
  const heading = count > 1 ? `📬 Накопились уведомления — ${count}` : "📬 Уведомление с задержкой";
  const events = [...alerts].reverse().map(alert => [
    `🕒 ${formatTime(alert.created_at)}${multipleDevices ? " · " + truncate(alert.name ?? alert.device_sn, 100) : ""}`,
    truncate(alert.message, alerts.length > 1 ? 1000 : 3000),
  ].join("\n"));
  return [heading, "Это события за прошедшее время.",
    ...(count > alerts.length ? [`Показаны последние ${alerts.length} из ${count}.`] : []), "", ...events].join("\n\n");
}

export function deliveryRetryDelay(attempts: number, retryAfterSeconds?: number): number {
  const backoff = Math.min(MAX_BACKOFF_MS, DELIVERY_INTERVAL_MS * 2 ** Math.min(attempts, 10));
  return Math.max(backoff, (retryAfterSeconds ?? 0) * 1000);
}

export async function enqueueDeviceAlerts(db: GridDatabase, env: Env, deviceSn: string): Promise<void> {
  const legacyChat = deviceSn === env.DEYE_DEVICE_SN ? env.TELEGRAM_CHAT_ID ?? "" : "";
  await db.batch([
    db.prepare(`
      INSERT OR IGNORE INTO alert_deliveries (alert_id, chat_id)
      SELECT a.id, s.chat_id FROM grid_alerts a
      JOIN chat_subscriptions s ON s.device_sn = a.device_sn AND s.enabled = 1
      WHERE a.device_sn = ?1 AND a.sent_at IS NULL AND a.queued_at IS NULL
      UNION
      SELECT a.id, ?2 FROM grid_alerts a
      WHERE a.device_sn = ?1 AND a.sent_at IS NULL AND a.queued_at IS NULL AND ?2 <> ''
      AND NOT EXISTS (SELECT 1 FROM chat_subscriptions s WHERE s.device_sn = ?1 AND s.chat_id = ?2 AND s.enabled = 0)
    `).bind(deviceSn, legacyChat),
    db.prepare("UPDATE grid_alerts SET queued_at = ?2 WHERE device_sn = ?1 AND queued_at IS NULL")
      .bind(deviceSn, Date.now()),
  ]);
}

// Shared by every inverter and overlapping cron invocation: one sender per Telegram chat.
export async function deliverPendingAlerts(db: GridDatabase, env: Env): Promise<void> {
  const legacySn = env.DEYE_DEVICE_SN ?? "";
  const legacyChat = env.TELEGRAM_CHAT_ID ?? "";
  await db.prepare(`
    DELETE FROM alert_deliveries
    WHERE NOT EXISTS (
      SELECT 1 FROM grid_alerts a LEFT JOIN chat_subscriptions s
        ON s.device_sn = a.device_sn AND s.chat_id = alert_deliveries.chat_id
      WHERE a.id = alert_deliveries.alert_id
        AND COALESCE(s.enabled, a.device_sn = ?1 AND alert_deliveries.chat_id = ?2) = 1
    ) RETURNING alert_id
  `).bind(legacySn, legacyChat).all();
  const { results: chats } = await db.prepare("SELECT DISTINCT chat_id FROM alert_deliveries WHERE sent_at IS NULL").all<{ chat_id: string }>();
  for (const { chat_id: chatId } of chats) {
    const now = Date.now();
    await db.prepare("INSERT OR IGNORE INTO telegram_delivery_state (chat_id) VALUES (?1) RETURNING chat_id").bind(chatId).first();
    const leaseUntil = now + DELIVERY_LEASE_MS;
    const claim = await db.prepare(`
      UPDATE telegram_delivery_state SET lease_until = ?2, next_attempt_at = ?3
      WHERE chat_id = ?1 AND lease_until <= ?4 AND next_attempt_at <= ?4
      RETURNING attempts
    `).bind(chatId, leaseUntil, now + DELIVERY_INTERVAL_MS, now).first<{ attempts: number }>();
    if (!claim) continue;
    try {
      const pending = await db.prepare(`
        SELECT COUNT(*) AS count, MAX(alert_id) AS cutoff FROM alert_deliveries
        WHERE chat_id = ?1 AND sent_at IS NULL AND COALESCE(lease_until, 0) <= ?2
      `).bind(chatId, now).first<{ count: number; cutoff: number }>();
      if (!pending?.count) {
        await db.prepare("UPDATE telegram_delivery_state SET lease_until = 0 WHERE chat_id = ?1 AND lease_until = ?2 RETURNING chat_id")
          .bind(chatId, leaseUntil).first();
        continue;
      }
      const { results: alerts } = await db.prepare(`
        SELECT a.message, CASE WHEN a.created_at > 0 THEN a.created_at ELSE COALESCE(a.queued_at, ?3) END AS created_at,
          a.device_sn, m.name
        FROM alert_deliveries d JOIN grid_alerts a ON a.id = d.alert_id
        LEFT JOIN monitored_devices m ON m.device_sn = a.device_sn
        WHERE d.chat_id = ?1 AND d.sent_at IS NULL AND d.alert_id <= ?2 AND COALESCE(d.lease_until, 0) <= ?3
        ORDER BY a.created_at DESC, a.id DESC LIMIT 3
      `).bind(chatId, pending.cutoff, now).all<AlertPreview>();
      if (!alerts.length) throw new Error("Pending alerts unavailable");
      await new TelegramClient(env.TELEGRAM_BOT_TOKEN, chatId).sendStatusMessage(
        formatDeliverySummary(alerts, pending.count, now), false, true,
      );
      await db.batch([
        db.prepare(`
          UPDATE alert_deliveries SET sent_at = ?3
          WHERE chat_id = ?1 AND alert_id <= ?2 AND sent_at IS NULL AND COALESCE(lease_until, 0) <= ?4
            AND EXISTS (SELECT 1 FROM telegram_delivery_state WHERE chat_id = ?1 AND lease_until = ?5)
        `).bind(chatId, pending.cutoff, Date.now(), now, leaseUntil),
        db.prepare(`
          UPDATE telegram_delivery_state SET lease_until = 0, attempts = 0, last_status = 200, next_attempt_at = ?3
          WHERE chat_id = ?1 AND lease_until = ?2
        `).bind(chatId, leaseUntil, Date.now() + DELIVERY_INTERVAL_MS),
      ]);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 0;
      const retryAfter = error instanceof HttpError ? error.retryAfterSeconds : undefined;
      await db.prepare(`
        UPDATE telegram_delivery_state SET lease_until = 0, attempts = attempts + 1, last_status = ?3, next_attempt_at = ?4
        WHERE chat_id = ?1 AND lease_until = ?2 RETURNING chat_id
      `).bind(chatId, leaseUntil, status, Date.now() + deliveryRetryDelay(claim.attempts, retryAfter)).first();
      console.warn("Telegram alert delivery postponed", { status, attempt: claim.attempts + 1 });
    }
  }
  // Both deletes are atomic: retain pending messages until delivery or inclusion in an acknowledged summary.
  await db.batch([
    db.prepare(`
      DELETE FROM alert_deliveries WHERE alert_id IN (
        SELECT a.id FROM grid_alerts a WHERE a.queued_at IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM alert_deliveries d WHERE d.alert_id = a.id AND d.sent_at IS NULL)
      )
    `),
    db.prepare("DELETE FROM grid_alerts WHERE queued_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM alert_deliveries WHERE alert_id = grid_alerts.id)"),
  ]);
}
