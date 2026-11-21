ALTER TABLE grid_alerts ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
UPDATE grid_alerts SET created_at = COALESCE(queued_at,
  CASE WHEN measured_at > 0 THEN measured_at ELSE unixepoch() * 1000 END);
CREATE TABLE telegram_delivery_state (
  chat_id TEXT PRIMARY KEY,
  lease_until INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_status INTEGER
);
