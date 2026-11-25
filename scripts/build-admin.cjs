const fs = require('node:fs');
const path = require('node:path');
const backend = path.join(__dirname,'..','backend');
const digest = process.env.RANK_ADMIN_HASH || '';
if (!/^[a-f0-9]{64}$/.test(digest)) throw Error('Configure RANK_ADMIN_HASH before publishing the administration page.');
const html = fs.readFileSync(path.join(backend,'admin.html'),'utf8');
const entry = path.join(backend,'index.js');
const source = fs.readFileSync(entry,'utf8');
fs.writeFileSync(entry,source.replace("'__RANK_ADMIN_HASH__'",()=>JSON.stringify(digest))
  .replace("'__RANK_ADMIN_PAGE__'",()=>JSON.stringify(html)));
