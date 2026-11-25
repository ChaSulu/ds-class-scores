const fs = require('node:fs');
const path = require('node:path');
const backend = path.join(__dirname, '..', 'backend');

function renderAdminPage() {
  const read = name => fs.readFileSync(path.join(backend, name), 'utf8');
  const script = read('admin.js').replace(/<\/script/gi, '<\\/script');
  return read('admin.html')
    .replace('<link rel="stylesheet" href="./admin.css">', () => '<style>\n' + read('admin.css') + '\n</style>')
    .replace('<script src="./admin.js"></script>', () => '<script>\n' + script + '\n</script>');
}

if (require.main === module) {
  const digest = process.env.RANK_ADMIN_HASH || '';
  if (!/^[a-f0-9]{64}$/.test(digest)) throw Error('Configure RANK_ADMIN_HASH before publishing the administration page.');
  const entry = path.join(backend, 'index.js');
  const source = fs.readFileSync(entry, 'utf8');
  fs.writeFileSync(entry, source
    .replace("'__RANK_ADMIN_HASH__'", () => JSON.stringify(digest))
    .replace("'__RANK_ADMIN_PAGE__'", () => JSON.stringify(renderAdminPage())));
}

module.exports = {renderAdminPage};
