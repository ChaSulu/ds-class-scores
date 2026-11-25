ALTER TABLE roster ADD COLUMN number TEXT;
ALTER TABLE roster ADD COLUMN lookup TEXT;
ALTER TABLE roster ADD COLUMN active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1));
ALTER TABLE roster ADD COLUMN display_name TEXT;
CREATE UNIQUE INDEX roster_number ON roster(room,number);
CREATE UNIQUE INDEX roster_lookup ON roster(room,COALESCE(lookup,student));

CREATE TABLE admin_rooms (
  room TEXT PRIMARY KEY,
  token TEXT NOT NULL
);

CREATE VIEW best_papers AS
WITH ranked AS (
  SELECT room,student,nickname,scores,total,pending,ended,
    ROW_NUMBER() OVER (PARTITION BY room,student
      ORDER BY (pending=0) DESC,total DESC,ended,paper,participant) AS priority
  FROM attempts WHERE student IS NOT NULL
)
SELECT room,student,nickname,scores,total,pending,ended FROM ranked WHERE priority=1;
