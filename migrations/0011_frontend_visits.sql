CREATE TABLE frontend_visits (
  room TEXT NOT NULL,
  visit TEXT NOT NULL,
  student TEXT,
  source TEXT NOT NULL,
  page TEXT NOT NULL,
  opened_at INTEGER NOT NULL,
  entered_at INTEGER,
  seen_at INTEGER NOT NULL,
  visible INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY(room,visit)
) WITHOUT ROWID;
CREATE INDEX frontend_visits_opened ON frontend_visits(room,opened_at DESC);
CREATE INDEX frontend_visits_seen ON frontend_visits(room,visible,seen_at DESC);
CREATE INDEX frontend_visits_entered ON frontend_visits(room,entered_at,student);
