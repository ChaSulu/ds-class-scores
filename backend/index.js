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
const adminVerifier = '__RANK_ADMIN_HASH__';
const adminPage = '__RANK_ADMIN_PAGE__';

function normalizedNumber(value) {
  const number = typeof value==='string' ? value.normalize('NFKC').trim().toUpperCase() : '';
  return /^[A-Z0-9][A-Z0-9_-]{0,31}$/.test(number) ? number : null;
}

const privateHeaders = {'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
const adminJson = (value,status=200) => Response.json(value,{status,headers:privateHeaders});
const adminError = (error,status) => adminJson({error},status);

async function changeRoster(db, room, input) {
  const {operation,items}=input;
  if (!Array.isArray(items) || !items.length || !['enable','disable','remove','names'].includes(operation))
    return adminError('invalid_request',400);
  const targets=[];
  for (const item of items) {
    const number=normalizedNumber(item?.number);
    if (!number || typeof item.id!=='string' || !/^[a-f0-9]{64}$/.test(item.id)) return adminError('invalid_request',400);
    const name=typeof item.realName==='string' ? item.realName.trim() : null;
    if (operation==='names' && (name===null || name.length>40)) return adminError('invalid_request',400);
    targets.push([item.id,number,name||null]);
  }
  const update={
    enable:'active=1', disable:'active=0', remove:'active=0,removed=1,real_name=NULL,display_name=NULL',
    names: input.onlyMissing ? 'real_name=COALESCE(real_name,matched.name)' : 'real_name=matched.name'
  }[operation];
  const result=await db.prepare(`WITH matched AS MATERIALIZED (
    SELECT r.student,json_extract(j.value,'$[2]') AS name FROM json_each(?) j JOIN roster r
    ON r.student=json_extract(j.value,'$[0]') AND r.number=json_extract(j.value,'$[1]')
    WHERE r.room=? AND r.removed=0
  ) UPDATE roster SET ${update} FROM matched WHERE roster.room=? AND roster.student=matched.student
    AND (SELECT count(DISTINCT student) FROM matched)=?`).bind(JSON.stringify(targets),room,room,targets.length).run();
  return result.meta.changes===targets.length ? adminJson({ok:true,count:targets.length}) : adminError('number_changed',409);
}

async function hydrate(db, room, input) {
  if (typeof input.roomToken!=='string' || await hash(input.roomToken)!==room ||
      !Array.isArray(input.numbers) || !input.numbers.length || input.numbers.length>500)
    return adminError('invalid_request',400);
  const numbers = [...new Set(input.numbers.map(normalizedNumber))];
  if (numbers.includes(null)) return adminError('invalid_number',400);
  const pairs=await Promise.all(numbers.map(async number=>[await hash('student-v1:'+input.roomToken+':'+number),number]));
  const result=await db.batch([
    db.prepare('INSERT INTO admin_rooms(room,token) VALUES (?,?) ON CONFLICT(room) DO NOTHING').bind(room,input.roomToken),
    db.prepare(`WITH input AS (
      SELECT json_extract(value,'$[0]') AS digest,json_extract(value,'$[1]') AS number FROM json_each(?)
    ) UPDATE roster SET number=input.number FROM input WHERE room=? AND roster.number IS NULL
    AND COALESCE(roster.lookup,roster.student)=input.digest`).bind(JSON.stringify(pairs),room),
    db.prepare('SELECT count(*) AS total,count(number) AS mapped FROM roster WHERE room=?').bind(room)
  ]);
  const {total,mapped}=result[2].results[0];
  return adminJson({ok:true,total,mapped,unmapped:total-mapped});
}

async function manage(request, db) {
  if (request.method!=='POST') return adminError('method',405);
  if (!/^[\da-f]{64}$/.test(adminVerifier)) return adminError('admin_unavailable',503);
  const bearer=request.headers.get('Authorization')?.match(/^Bearer (\d{6}|[A-Za-z0-9_-]{40,128})$/i);
  if (!bearer) return adminError('unauthorized',401);
  const valid=await hash(bearer[1])===adminVerifier;
  if (bearer[1].length===6) {
    const period=Math.floor(Date.now()/600000);
    const client=await hash('pin:'+ (request.headers.get('CF-Connecting-IP') || 'shared'));
    const blocked=await db.prepare('SELECT 1 FROM admin_pin_failures WHERE period=? AND client=? AND failures>=6')
      .bind(period,client).first();
    if (blocked) return adminError('too_many_attempts',429);
    if (!valid) {
      await db.batch([
        db.prepare('DELETE FROM admin_pin_failures WHERE period < ?').bind(period),
        db.prepare(`INSERT INTO admin_pin_failures(period,client,failures) VALUES (?,?,1)
          ON CONFLICT(period,client) DO UPDATE SET failures=min(failures+1,6)`).bind(period,client)
      ]);
    }
  }
  if (!valid) return adminError('unauthorized',401);
  if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase()!=='application/json')
    return adminError('invalid_request',415);
  const origin=request.headers.get('Origin');
  if (origin && origin!==new URL(request.url).origin && origin!=='https://chasulu.w7s.cloud') return adminError('origin',403);
  if (request.headers.get('Sec-Fetch-Site')==='cross-site') return adminError('origin',403);
  const raw=await request.text();
  if (raw.length>128000) return adminError('size',413);
  let input;
  try {input=JSON.parse(raw);} catch {return adminError('invalid_request',400);}
  const room=input?.board==='class'?allowedRooms[0]:input?.board==='qa'?allowedRooms[1]:null;
  if (!room) return adminError('invalid_request',400);

  if (input.action==='hydrate') return hydrate(db,room,input);
  if (input.action==='changeRoster') return changeRoster(db,room,input);
  if (input.action==='list') {
    const {results}=await db.prepare(`SELECT r.student AS id,r.number,r.active,r.real_name AS realName,r.display_name AS displayName,p.nickname AS submittedName,
      COALESCE(r.display_name,p.nickname) AS name,p.total,p.pending,
      ROW_NUMBER() OVER (ORDER BY p.ended,r.student) AS tieOrder
      FROM roster r LEFT JOIN best_papers p ON p.room=r.room AND p.student=r.student
      WHERE r.room=? AND r.removed=0 ORDER BY r.number IS NULL,r.number`).bind(room).all();
    return adminJson({rows:results.map(row=>({...row,active:!!row.active})),unmapped:results.filter(r=>r.number===null).length});
  }
  const number=normalizedNumber(input.number);
  if (!number) return adminError('invalid_number',400);
  let statement;
  if (input.action==='add' || input.action==='rename') {
    const target=input.action==='add'?number:normalizedNumber(input.newNumber);
    if (!target) return adminError('invalid_number',400);
    const settings=await db.prepare('SELECT token FROM admin_rooms WHERE room=?').bind(room).first();
    if (!settings) return adminError('roster_unready',409);
    const lookup=await hash('student-v1:'+settings.token+':'+target);
    if (input.action==='add') {
      const key=await hash(crypto.randomUUID());
      const name=input.realName ?? '';
      if (typeof name!=='string' || name.trim().length>40) return adminError('invalid_request',400);
      statement=db.prepare(`INSERT OR IGNORE INTO roster(room,student,lookup,number,real_name) VALUES (?,?,?,?,?)
        ON CONFLICT(room,number) DO UPDATE SET removed=0,active=1,real_name=excluded.real_name WHERE roster.removed=1`)
        .bind(room,key,lookup,number,name.trim()||null);
    } else {
      statement=db.prepare('UPDATE OR IGNORE roster SET number=?,lookup=? WHERE room=? AND number=? AND removed=0')
        .bind(target,lookup,room,number);
    }
  } else if (input.action==='setActive' && typeof input.active==='boolean') {
    statement=db.prepare('UPDATE roster SET active=? WHERE room=? AND number=? AND removed=0').bind(+input.active,room,number);
  } else if (input.action==='setDisplayName' && typeof input.displayName==='string') {
    const displayName=input.displayName.normalize('NFKC').trim().replace(/\s+/gu,' ');
    if (displayName.length>40) return adminError('invalid_request',400);
    statement=db.prepare('UPDATE roster SET display_name=? WHERE room=? AND number=? AND removed=0').bind(displayName||null,room,number);
  } else {
    return adminError('invalid_request',400);
  }
  const result=await statement.run();
  if (result.meta.changes) return adminJson({ok:true});
  if (input.action==='add' || (input.action==='rename' && await db.prepare('SELECT 1 FROM roster WHERE room=? AND number=?').bind(room,number).first()))
    return adminError('duplicate_number',409);
  return adminError('not_found',404);
}
const bestScores = `SELECT r.student AS participant, COALESCE(r.display_name,p.nickname) AS nickname,
  COALESCE(substr(r.number,max(2,length(r.number)-3)),s.suffix) AS suffix,
  p.scores,p.total,p.pending,p.ended
  FROM roster r JOIN best_papers p ON p.room=r.room AND p.student=r.student
  JOIN students s ON s.room=r.room AND s.student=r.student
  WHERE r.room=? AND r.active=1 AND r.removed=0 ORDER BY (p.pending=0) DESC,p.total DESC,p.ended,r.student`;

// The stable student key owns papers. Only the lookup digest changes when an admin corrects a number.
const listedEntry = 'SELECT student FROM roster WHERE room=? AND active=1 AND removed=0 AND COALESCE(lookup,student)=?';
const membership = `EXISTS(SELECT 1 FROM roster WHERE room=?) AS ready,
  (${listedEntry}) AS listed`;

function rosterError({ready, listed}) {
  if (!ready) return json({error:'roster_unavailable'},503);
  if (!listed) return json({error:'student_not_listed'},403);
  return null;
}

async function studentIdentity(input) {
  const number = normalizedNumber(input.studentNumber);
  if (!number) return null;
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
      SELECT ?,student,'','',? FROM (${listedEntry}) WHERE 1
      ON CONFLICT(room,student) DO NOTHING`).bind(room,suffix,room,student),
    // The originating device can claim an anonymous paper or correct a formerly unlisted number.
    db.prepare(`UPDATE attempts SET student=(${listedEntry}),nickname=? WHERE room=? AND participant=? AND paper=?
      AND NOT EXISTS (SELECT 1 FROM roster r WHERE r.room=attempts.room AND r.student=attempts.student)
      AND EXISTS (${listedEntry})`).bind(room,student,name,room,device,paper,room,student),
    db.prepare(`INSERT INTO attempts(room,participant,paper,revision,nickname,scores,total,pending,ended,student)
      SELECT ?,?,?,?,?,?,?,?,?,student FROM (${listedEntry}) WHERE 1
      ON CONFLICT(room,participant,paper) DO UPDATE SET
        revision=excluded.revision,nickname=excluded.nickname,scores=excluded.scores,total=excluded.total,pending=excluded.pending
      WHERE attempts.student=excluded.student AND attempts.revision<excluded.revision`)
      .bind(room,device,paper,revision,name,JSON.stringify(scores),total,pending,ended,room,student),
    db.prepare(`SELECT ${membership},
      (SELECT student FROM attempts WHERE room=? AND participant=? AND paper=?) AS bound`)
      .bind(room,room,student,room,device,paper)
  ];
  const result = await db.batch(statements);
  const record = result[3].results[0];
  const error = rosterError(record);
  if (error) return error;
  if (record.bound!==record.listed) return json({error:'paper_bound'},409);
  return json({participant:record.listed,rosterVerified:true});
}

export default {
  async fetch(request, env) {
    const path=new URL(request.url).pathname.replace(/\/$/,'');
    if (path.endsWith('/admin/api')) return manage(request,env.DB);
    if (path.endsWith('/admin') && request.method==='GET') return new Response(adminPage,{headers:{
      ...privateHeaders,'Content-Type':'text/html; charset=utf-8','X-Frame-Options':'DENY',
      'Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
    }});
    if (request.method !== 'POST' || !path.endsWith('/api/ranking')) return json({error:'route'}, 404);
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
