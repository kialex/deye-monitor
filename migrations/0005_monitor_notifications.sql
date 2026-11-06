CREATE TABLE monitor_notifications (
  device_sn TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 0,
  snapshot TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE grid_voltage_limits (
  device_sn TEXT PRIMARY KEY,
  low_volts REAL NOT NULL CHECK (low_volts > 0),
  high_volts REAL NOT NULL CHECK (high_volts > low_volts)
);
