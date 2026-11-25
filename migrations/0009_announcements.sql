CREATE TABLE announcements (
  room TEXT NOT NULL,
  id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'published')),
  updated_at INTEGER NOT NULL,
  published_at INTEGER,
  PRIMARY KEY (room, id)
);
CREATE INDEX announcements_by_publication ON announcements(room, status, published_at DESC, id DESC);
