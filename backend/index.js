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
const bestScores = `WITH entries AS (
  SELECT a.student AS participant, a.nickname,
    s.suffix, a.scores, a.total, a.pending, a.ended, a.paper, a.participant AS device
  FROM roster r JOIN attempts a ON a.room = r.room AND a.student = r.student
  JOIN students s ON s.room = r.room AND s.student = r.student
  WHERE r.room = ?
), ordered AS (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY participant
    ORDER BY (pending = 0) DESC, total DESC, ended, paper, device) AS priority FROM entries)
  SELECT participant, nickname, suffix, scores, total, pending, ended
  FROM ordered WHERE priority = 1 ORDER BY (pending = 0) DESC, total DESC, ended, participant`;

const membership = `EXISTS(SELECT 1 FROM roster WHERE room=?) AS ready,
  EXISTS(SELECT 1 FROM roster WHERE room=? AND student=?) AS listed`;

function rosterError({ready, listed}) {
  if (!ready) return json({error:'roster_unavailable'},503);
  if (!listed) return json({error:'student_not_listed'},403);
  return null;
}

async function studentIdentity(input) {
  const number = typeof input.studentNumber==='string' ? input.studentNumber.normalize('NFKC').trim().toUpperCase() : '';
  if (!/^[A-Z0-9][A-Z0-9_-]{0,31}$/.test(number)) return null;
  const student = await hash('student-v1:'+input.room+':'+number);
  return {student,suffix:number.slice(Math.max(1, number.length-4))};
}

async function publishStudent(db, room, input, device, total) {
  const identity = await studentIdentity(input);
  const name = (typeof input.name==='string' ? input.name.normalize('NFKC').trim().replace(/\s+/gu,' ') : '') || '同学';
  if (!identity || name.length>40) return json({error:'identity'},400);
  const {student,suffix} = identity;
  const {paper,revision,scores,pending,ended} = input;
  const statements = [
    db.prepare(`INSERT INTO students(room,student,name,name_key,suffix)
      SELECT room,student,'','',? FROM roster WHERE room=? AND student=?
      ON CONFLICT(room,student) DO NOTHING`).bind(suffix,room,student),
    // The originating device can claim an anonymous paper or correct a formerly unlisted number.
    db.prepare(`UPDATE attempts SET student=?,nickname=? WHERE room=? AND participant=? AND paper=?
      AND NOT EXISTS (SELECT 1 FROM roster r WHERE r.room=attempts.room AND r.student=attempts.student)
      AND EXISTS (SELECT 1 FROM roster WHERE room=? AND student=?)`).bind(student,name,room,device,paper,room,student),
    db.prepare(`INSERT INTO attempts(room,participant,paper,revision,nickname,scores,total,pending,ended,student)
      SELECT ?,?,?,?,?,?,?,?,?,? FROM roster WHERE room=? AND student=?
      ON CONFLICT(room,participant,paper) DO UPDATE SET
        revision=excluded.revision,nickname=excluded.nickname,scores=excluded.scores,total=excluded.total,pending=excluded.pending
      WHERE attempts.student=excluded.student AND attempts.revision<excluded.revision`)
      .bind(room,device,paper,revision,name,JSON.stringify(scores),total,pending,ended,student,room,student),
    db.prepare(`SELECT ${membership},
      (SELECT student FROM attempts WHERE room=? AND participant=? AND paper=?) AS bound`)
      .bind(room,room,student,room,device,paper)
  ];
  const result = await db.batch(statements);
  const record = result[3].results[0];
  const error = rosterError(record);
  if (error) return error;
  if (record.bound!==student) return json({error:'paper_bound'},409);
  return json({participant:student,rosterVerified:true});
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
    if (input.action === 'checkStudent') {
      const identity = await studentIdentity(input);
      if (!identity) return json({error:'identity'},400);
      const record = await env.DB.prepare('SELECT '+membership).bind(room,room,identity.student).first();
      return rosterError(record) || json({rosterVerified:true});
    }
    if (input.action === 'list' || input.action === 'standings') {
      const { results } = await env.DB.prepare(bestScores).bind(room).all();
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
      WHERE attempts.student IS NULL AND excluded.revision > attempts.revision`).bind(room,participant,paper,revision,
        nickname.trim(),JSON.stringify(scores),total,pending,ended).run();
    return json({participant});
  }
};
