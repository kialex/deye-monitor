CREATE TABLE battery_settings (
  device_sn TEXT PRIMARY KEY,
  capacity_ah REAL NOT NULL CHECK (capacity_ah > 0),
  low_soc REAL NOT NULL CHECK (low_soc BETWEEN 0 AND 100),
  shutdown_soc REAL NOT NULL CHECK (shutdown_soc BETWEEN 0 AND 100),
  refreshed_at INTEGER NOT NULL
);
