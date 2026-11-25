CREATE TABLE admin_devices (
  digest TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE INDEX admin_devices_expiry ON admin_devices(expires_at);
