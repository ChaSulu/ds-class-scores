CREATE TABLE students (
  room TEXT NOT NULL,
  student TEXT NOT NULL,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  suffix TEXT NOT NULL,
  PRIMARY KEY (room, student)
);
ALTER TABLE attempts ADD COLUMN student TEXT;
CREATE INDEX idx_attempts_student ON attempts(room, student);
