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
const bestScores = `WITH ordered AS (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY participant
    ORDER BY (pending = 0) DESC, total DESC, ended, paper) AS priority
  FROM attempts WHERE room = ?)
  SELECT participant, nickname, scores, total, pending, ended
  FROM ordered WHERE priority = 1 ORDER BY (pending = 0) DESC, total DESC, ended, participant`;

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
    if (input.action === 'list') {
      const { results } = await env.DB.prepare(bestScores).bind(room).all();
      return json({rows: results.map(row => ({...row, scores:JSON.parse(row.scores)}))});
    }
    if (input.action !== 'submit') return json({error:'action'}, 400);
    const {key, paper, revision, nickname, scores, pending, ended} = input;
    if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key) ||
        typeof paper !== 'string' || !/^[a-z0-9-]{5,65}$/.test(paper) ||
        !Number.isSafeInteger(revision) || revision < 1 ||
        typeof nickname !== 'string' || !nickname.trim() || nickname.length > 24 ||
        !Array.isArray(scores) || scores.length !== caps.length ||
        !scores.every((n,i) => Number.isFinite(n) && n >= 0 && n <= caps[i]) ||
        !Number.isInteger(pending) || pending < 0 || pending > 8 ||
        !Number.isSafeInteger(ended) || ended < 1 || ended > Date.now() + 86400000)
      return json({error:'score'}, 400);
    const participant = await hash(key);
    const total = Math.round(scores.reduce((a,b) => a+b, 0) * 100) / 100;
    await env.DB.prepare(`INSERT INTO attempts (room,participant,paper,revision,nickname,scores,total,pending,ended)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(room,participant,paper) DO UPDATE SET
      revision=excluded.revision,nickname=excluded.nickname,scores=excluded.scores,total=excluded.total,pending=excluded.pending
      WHERE excluded.revision > attempts.revision`).bind(room,participant,paper,revision,
        nickname.trim(),JSON.stringify(scores),total,pending,ended).run();
    return json({participant});
  }
};
