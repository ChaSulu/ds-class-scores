ALTER TABLE attempts ADD COLUMN progress TEXT;

CREATE TABLE paper_drafts (
  room TEXT NOT NULL,
  participant TEXT NOT NULL,
  paper TEXT NOT NULL,
  student TEXT NOT NULL,
  revision INTEGER NOT NULL,
  progress TEXT NOT NULL,
  PRIMARY KEY (room, participant, paper)
);
CREATE INDEX paper_drafts_student ON paper_drafts(room,student);

CREATE VIEW latest_papers AS
WITH papers AS (
  SELECT room,student,participant,paper,progress,ended,scores,total,pending
  FROM attempts WHERE student IS NOT NULL
  UNION ALL
  SELECT room,student,participant,paper,progress,NULL,NULL,NULL,NULL FROM paper_drafts
), ordered AS (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY room,student
    ORDER BY COALESCE(json_extract(progress,'$.started'),ended) DESC,
      COALESCE(json_extract(progress,'$.updated'),ended) DESC,paper,participant) AS position
  FROM papers
)
SELECT room,student,progress,ended,scores,total,pending FROM ordered WHERE position=1;
