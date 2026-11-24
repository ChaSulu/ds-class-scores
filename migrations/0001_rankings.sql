CREATE TABLE attempts (
  room TEXT NOT NULL,
  participant TEXT NOT NULL,
  paper TEXT NOT NULL,
  revision INTEGER NOT NULL,
  nickname TEXT NOT NULL,
  scores TEXT NOT NULL,
  total REAL NOT NULL,
  pending INTEGER NOT NULL,
  ended INTEGER NOT NULL,
  PRIMARY KEY (room, participant, paper)
);
