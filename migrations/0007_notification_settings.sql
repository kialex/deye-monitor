CREATE TABLE notification_settings (
  device_sn TEXT NOT NULL,
  kind TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  PRIMARY KEY (device_sn, kind)
);
