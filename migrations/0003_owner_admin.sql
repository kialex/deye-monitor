CREATE TABLE monitored_devices (
  device_sn TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  credentials TEXT NOT NULL
);

CREATE TABLE admin_setup (
  token_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  credentials TEXT,
  choices TEXT
);

CREATE TABLE chat_subscriptions (
  device_sn TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  PRIMARY KEY (device_sn, chat_id)
);

CREATE TABLE device_access (
  device_sn TEXT NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY (device_sn, user_id)
);

CREATE TABLE alert_deliveries (
  alert_id INTEGER NOT NULL REFERENCES grid_alerts(id),
  chat_id TEXT NOT NULL,
  lease_until INTEGER,
  sent_at INTEGER,
  PRIMARY KEY (alert_id, chat_id)
);

ALTER TABLE grid_alerts ADD COLUMN queued_at INTEGER;
CREATE INDEX alert_deliveries_pending ON alert_deliveries(alert_id) WHERE sent_at IS NULL;
