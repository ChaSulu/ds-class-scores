CREATE TABLE practice_scores (
  room TEXT NOT NULL,
  paper TEXT NOT NULL,
  student TEXT NOT NULL,
  attempt TEXT NOT NULL,
  revision INTEGER NOT NULL,
  nickname TEXT NOT NULL,
  score REAL NOT NULL,
  pending INTEGER NOT NULL,
  ended INTEGER NOT NULL,
  PRIMARY KEY(room,paper,student,attempt)
) WITHOUT ROWID;
