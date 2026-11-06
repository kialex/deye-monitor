CREATE TABLE grid_state (
  device_sn TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('present', 'absent')),
  measured_at INTEGER NOT NULL,
  changed_at INTEGER NOT NULL
);

CREATE TABLE grid_alerts (
  id INTEGER PRIMARY KEY,
  device_sn TEXT NOT NULL,
  measured_at INTEGER NOT NULL,
  message TEXT NOT NULL,
  lease_until INTEGER,
  sent_at INTEGER,
  UNIQUE (device_sn, measured_at)
);

CREATE INDEX grid_alerts_pending ON grid_alerts (device_sn, id) WHERE sent_at IS NULL;
