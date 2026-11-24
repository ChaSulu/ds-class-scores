const allowedRooms = ["e55d513fba951cf0289097adc3f941c2c760cfd4cfc8dc7b9bc31faf3a4e44a3","e16a3a3516f0934feb7df2c9d335346a7f965f9ed18d4ac7b40c87c538ce571f"];

const headers = {
  'Access-Control-Allow-Origin': 'https://chasulu.github.io',
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json; charset=utf-8'
};
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers });
const hash = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
  new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');
const caps = [10, 15, 40, 6, 29];
const bestScores = includeLegacy => `WITH entries AS (
  SELECT COALESCE(a.student, a.participant) AS participant, COALESCE(s.name, a.nickname) AS nickname,
    s.suffix, a.scores, a.total, a.pending, a.ended, a.paper, a.participant AS device
  FROM attempts a LEFT JOIN students s ON s.room = a.room AND s.student = a.student
  WHERE a.room = ? ${includeLegacy ? '' : 'AND s.student IS NOT NULL'}
), ordered AS (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY participant
    ORDER BY (pending = 0) DESC, total DESC, ended, paper, device) AS priority FROM entries)
  SELECT participant, nickname, suffix, scores, total, pending, ended
  FROM ordered WHERE priority = 1 ORDER BY (pending = 0) DESC, total DESC, ended, participant`;

async function publishStudent(db, room, input, device, total) {
  const number = typeof input.studentNumber==='string' ? input.studentNumber.normalize('NFKC').trim().toUpperCase() : '';
  const name = typeof input.name==='string' ? input.name.normalize('NFKC').trim().replace(/\s+/gu,' ') : '';
  if (!/^[A-Z0-9][A-Z0-9_-]{0,31}$/.test(number) || !name || name.length>40)
    return json({error:'identity'},400);
  const student = await hash('student-v1:'+input.room+':'+number);
  const nameKey = name.toLowerCase().replace(/\s/gu,'');
  const suffix = number.slice(Math.max(1, number.length-4));
  const {paper,revision,scores,pending,ended} = input;
  // Keep paper ownership on the originating device, including when a legacy paper is claimed.
  const statements = [
    db.prepare(`INSERT INTO students(room,student,name,name_key,suffix)
      SELECT ?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM attempts WHERE room=? AND participant=? AND paper=? AND student<>?)
      ON CONFLICT(room,student) DO NOTHING`).bind(room,student,name,nameKey,suffix,room,device,paper,student),
    db.prepare(`INSERT INTO attempts(room,participant,paper,revision,nickname,scores,total,pending,ended,student)
      SELECT ?,?,?,?,?,?,?,?,?,? FROM students WHERE room=? AND student=? AND name_key=?
      ON CONFLICT(room,participant,paper) DO UPDATE SET
        revision=excluded.revision, scores=excluded.scores, total=excluded.total, pending=excluded.pending, student=excluded.student
      WHERE (attempts.student IS NULL OR attempts.student=excluded.student) AND attempts.revision<excluded.revision`)
      .bind(room,device,paper,revision,name,JSON.stringify(scores),total,pending,ended,student,room,student,nameKey),
    db.prepare(`UPDATE attempts SET student=? WHERE room=? AND participant=? AND paper=? AND student IS NULL
      AND EXISTS(SELECT 1 FROM students WHERE room=? AND student=? AND name_key=?)`).bind(student,room,device,paper,room,student,nameKey),
    db.prepare(`SELECT a.student, s.name_key FROM attempts a LEFT JOIN students s ON s.room=a.room AND s.student=a.student
      WHERE a.room=? AND a.participant=? AND a.paper=?`).bind(room,device,paper)
  ];
  const result = await db.batch(statements);
  const bound = result[3].results[0];
  if (bound?.student && bound.student!==student) return json({error:'paper_bound'},409);
  if (!bound || bound.student!==student || bound.name_key!==nameKey) return json({error:'name_mismatch'},409);
  return json({participant:student});
}

export default {
  async fetch(request, env) {
    if (request.method !== 'POST' || !new URL(request.url).pathname.endsWith('/api/ranking')) return json({error:'route'}, 404);
    const raw = await request.text();
    if (raw.length > 1800) return json({error:'size'}, 413);
    let input;
    try { input = JSON.parse(raw); } catch { return json({error:'json'}, 400); }
    if (typeof input?.room !== 'string') return json({error:'room'}, 403);
    const room = await hash(input.room);
    if (!allowedRooms.includes(room)) return json({error:'room'}, 403);
    if (input.action === 'list' || input.action === 'standings') {
      const { results } = await env.DB.prepare(bestScores(input.action==='list')).bind(room).all();
      return json({rows: results.map(row => ({...row, scores:JSON.parse(row.scores)}))});
    }
    if (input.action !== 'submit' && input.action !== 'publish') return json({error:'action'}, 400);
    const {key, paper, revision, nickname, scores, pending, ended} = input;
    if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key) ||
        typeof paper !== 'string' || !/^[a-z0-9-]{5,65}$/.test(paper) ||
        !Number.isSafeInteger(revision) || revision < 1 ||
        (input.action==='submit' && (typeof nickname !== 'string' || !nickname.trim() || nickname.length > 24)) ||
        !Array.isArray(scores) || scores.length !== caps.length ||
        !scores.every((n,i) => Number.isFinite(n) && n >= 0 && n <= caps[i]) ||
        !Number.isInteger(pending) || pending < 0 || pending > 8 ||
        !Number.isSafeInteger(ended) || ended < 1 || ended > Date.now() + 86400000)
      return json({error:'score'}, 400);
    const participant = await hash(key);
    const total = Math.round(scores.reduce((a,b) => a+b, 0) * 100) / 100;
    if (input.action==='publish') return publishStudent(env.DB, room, input, participant, total);
    await env.DB.prepare(`INSERT INTO attempts (room,participant,paper,revision,nickname,scores,total,pending,ended)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(room,participant,paper) DO UPDATE SET
      revision=excluded.revision,nickname=excluded.nickname,scores=excluded.scores,total=excluded.total,pending=excluded.pending
      WHERE excluded.revision > attempts.revision`).bind(room,participant,paper,revision,
        nickname.trim(),JSON.stringify(scores),total,pending,ended).run();
    return json({participant});
  }
};
