CREATE TABLE admin_pin_failures (
  period INTEGER NOT NULL,
  client TEXT NOT NULL,
  failures INTEGER NOT NULL,
  PRIMARY KEY (period,client)
);
