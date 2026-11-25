CREATE TABLE roster (
  room TEXT NOT NULL,
  student TEXT NOT NULL,
  PRIMARY KEY (room, student)
);

-- Older claimed papers kept their original anonymous nickname in attempts.
UPDATE attempts SET nickname = (
  SELECT s.name FROM students s WHERE s.room = attempts.room AND s.student = attempts.student
) WHERE EXISTS (
  SELECT 1 FROM students s WHERE s.room = attempts.room AND s.student = attempts.student
);
