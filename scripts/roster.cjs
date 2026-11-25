const fs = require('node:fs');
const path = require('node:path');
const {createHash,createHmac} = require('node:crypto');
const {spawnSync} = require('node:child_process');

const rooms = {
  class:'e55d513fba951cf0289097adc3f941c2c760cfd4cfc8dc7b9bc31faf3a4e44a3',
  qa:'e16a3a3516f0934feb7df2c9d335346a7f965f9ed18d4ac7b40c87c538ce571f'
};
const sha256 = text => createHash('sha256').update(text).digest('hex');
const secretName = board => 'RANK_ROSTER_'+board.toUpperCase();

function prepare(board, idsText, key) {
  const token = createHmac('sha256',key).update('ranking:'+board+'-v1').digest('hex');
  const room = sha256(token);
  if (room!==rooms[board]) throw Error('The key does not belong to the selected class or QA board.');
  const ids = idsText.split(/\r?\n/u).map(s=>s.normalize('NFKC').trim().toUpperCase()).filter(Boolean);
  if (!ids.length || ids.some(s=>!/^[A-Z0-9][A-Z0-9_-]{0,31}$/.test(s)))
    throw Error('Expected one student number per line, without names, headers or punctuation.');
  const students = [...new Set(ids.map(s=>sha256('student-v1:'+token+':'+s)))].sort();
  const value = JSON.stringify({room,version:Date.now(),students});
  if (Buffer.byteLength(value)>48*1024) throw Error('Roster is larger than one GitHub Actions secret.');
  return {value,count:students.length};
}

function generate(board,value,directory) {
  const {room,version,students} = JSON.parse(value);
  if (room!==rooms[board] || !Number.isSafeInteger(version) || version<=0 ||
      !Array.isArray(students) || !students.length ||
      !students.every(s=>typeof s==='string' && /^[a-f0-9]{64}$/.test(s))) throw Error('Invalid roster configuration.');
  // D1 remembers applied migration filenames. A new secret version can replace a list with an earlier set.
  const filename='9000_'+board+'_'+version+'_'+sha256(value).slice(0,12)+'.sql';
  const sql="DELETE FROM roster WHERE room='"+room+"';\n"+
    "INSERT INTO roster(room,student) SELECT '"+room+"',value FROM json_each('"+JSON.stringify(students)+"');\n";
  fs.writeFileSync(path.join(directory,filename),sql);
}

function main() {
  const [command,board,listFile,keyFile] = process.argv.slice(2);
  if (command==='build') {
    for (const board of Object.keys(rooms)) {
      const value=process.env[secretName(board)];
      if (value) generate(board,value,path.join(__dirname,'..','migrations'));
    }
    return;
  }
  if (command!=='set' || !Object.hasOwn(rooms,board) || !listFile || !keyFile)
    throw Error('Usage: node scripts/roster.cjs set <class|qa> <numbers.txt> <class-share-link-key.bin>');
  const {value,count}=prepare(board,fs.readFileSync(listFile,'utf8'),fs.readFileSync(keyFile));
  const result=spawnSync('gh',['secret','set',secretName(board),'--repo','ChaSulu/ds-class-scores'],
    {input:value,encoding:'utf8',windowsHide:true});
  if (result.error) throw result.error;
  if (result.status!==0) throw Error(result.stderr.trim()||'Could not save the GitHub Actions secret.');
  console.log('Saved '+count+' distinct student number digests for '+board+'. Deploy to apply.');
}

if (require.main===module) main();
module.exports={prepare,generate};
