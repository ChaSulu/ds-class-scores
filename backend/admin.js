'use strict';

const el = id => document.getElementById(id);
const board = new URLSearchParams(location.search).get('board') === 'qa' ? 'qa' : 'class';
const endpoint = location.pathname.replace(/\/$/, '') + '/api';
const collator = new Intl.Collator('zh-CN', {numeric: true});
const formatScore = new Intl.NumberFormat('zh-CN', {maximumFractionDigits: 2});
const formatAverage = new Intl.NumberFormat('zh-CN', {maximumFractionDigits: 1});
const pages = {
  overview: ['管理概览', '查看班级交卷进度和成绩分布。'],
  roster: ['学号名单', '核对真实姓名，勾选学号可批量管理。'],
  ranking: ['成绩排名', '按学号查成绩，或筛选待自评的答卷。']
};
const clientMessages = {
  unauthorized: '管理口令无效，请重新输入。',
  too_many_attempts: '管理口令已多次输错，请稍后再登录（最多等 10 分钟）。',
  duplicate_number: '该学号已在名单中，请核对后重试。',
  number_changed: '这条记录已被其他操作更新，请刷新名单后重试。',
  not_found: '找不到这个学号，请刷新名单。',
  roster_unready: '名单尚未准备好，请稍后刷新。',
  invalid_number: '请填写正确的学号，可用字母、数字、短横线和下划线。',
  invalid_request: '请求内容有误，请核对后重试。',
  admin_unavailable: '管理服务暂时不可用，请稍后重试。'
};
let session = null;
let currentEdit = null;
let rosterPage = 1;
let rankPage = 1;
let members = [];
let ranked = [];
const selected = new Map();

function setText(id, text) { el(id).textContent = text; }
function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}
function cell(row, className, value, label) {
  const column = row.insertCell();
  column.className = className;
  column.dataset.label = label;
  column.textContent = value;
  return column;
}
function notify(message, error = false) {
  setText('message', message);
  el('message').classList.toggle('error', error);
}
async function api(body, token) {
  const response = await fetch(endpoint, {
    method: 'POST', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
    headers: {'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token},
    body: JSON.stringify({board, ...body}), signal: AbortSignal.timeout(20000)
  });
  const result = await response.json();
  if (!response.ok || result.error) {
    const error = new Error(clientMessages[result.error] || '管理服务未能完成请求。');
    error.code = result.error;
    throw error;
  }
  return result;
}

function mobileMenu(open) {
  document.body.classList.toggle('nav-open', open);
  el('sidebar').classList.toggle('open', open);
  el('menuToggle').setAttribute('aria-expanded', String(open));
}
function showView(view) {
  if (!Object.hasOwn(pages, view)) view = 'overview';
  for (const id of Object.keys(pages)) el(id).hidden = id !== view;
  document.querySelectorAll('#sidebar [data-view]').forEach(button => {
    const active = button.dataset.view === view;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  setText('pageTitle', pages[view][0]);
  setText('crumb', pages[view][0]);
  setText('sectionHint', pages[view][1]);
  mobileMenu(false);
}
function navigate(view) {
  if (!session) return;
  if (location.hash !== '#' + view) history.pushState(null, '', '#' + view);
  showView(view);
  el('pageTitle').focus();
}
document.querySelectorAll('[data-view]').forEach(button =>
  button.addEventListener('click', () => navigate(button.dataset.view)));
window.addEventListener('hashchange', () => {
  if (session) showView(location.hash.slice(1));
});
el('menuToggle').addEventListener('click', () => mobileMenu(!document.body.classList.contains('nav-open')));
el('navBackdrop').addEventListener('click', () => mobileMenu(false));
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && document.body.classList.contains('nav-open')) {
    mobileMenu(false);
    el('menuToggle').focus();
  }
});
function setPasswordVisible(visible) {
  el('password').type = visible ? 'text' : 'password';
  el('showPassword').setAttribute('aria-pressed', String(visible));
  el('showPassword').setAttribute('aria-label', visible ? '隐藏管理口令' : '显示管理口令');
}
el('showPassword').addEventListener('click', () => setPasswordVisible(el('password').type === 'password'));
setText('classLabel', board === 'qa' ? '测试班级' : '通信2491–2494');

function matches(row, needle) {
  return [row.number, row.realName, row.name].some(value => String(value ?? '').toLowerCase().includes(needle));
}
function rosterScore(row) {
  if (row.total == null) return '—';
  return formatScore.format(row.total) + (row.pending ? '（待自评）' : '');
}
function filteredRoster() {
  const needle = el('search').value.trim().toLowerCase();
  const filter = el('filter').value;
  return members.filter(row =>
    (filter === 'all' || row.active === (filter === 'on')) && matches(row, needle));
}
function onRosterPage(rows) {
  const size = Number(el('pageSize').value);
  return rows.slice((rosterPage - 1) * size, rosterPage * size);
}
function selectMembers(rows, checked) {
  for (const row of rows) {
    if (!row.number) continue;
    if (checked) selected.set(row.id, row.number);
    else selected.delete(row.id);
  }
}
function showSelection(matches, page) {
  const eligible = page.filter(row => row.number);
  const checked = eligible.filter(row => selected.has(row.id)).length;
  el('selectPage').checked = checked > 0 && checked === eligible.length;
  el('selectPage').indeterminate = checked > 0 && checked < eligible.length;
  el('selectPage').disabled = !eligible.length;
  const selectable = matches.filter(row => row.number);
  const total = selectable.length;
  const visibleSelected = selectable.filter(row => selected.has(row.id)).length;
  const outside = selected.size - visibleSelected;
  el('selectMatches').hidden = total <= eligible.length || visibleSelected === total;
  setText('selectMatches', '选中全部 ' + total + ' 个筛选结果');
  setText('selectionCount', '已选 ' + selected.size + ' 个学号' + (outside ? '（含其他筛选结果 ' + outside + ' 个）' : ''));
  el('clearSelection').hidden = !selected.size;
  document.querySelectorAll('[data-bulk]').forEach(button => { button.disabled = !selected.size; });
}
function renderRoster() {
  const matching = filteredRoster();
  const pageSize = Number(el('pageSize').value);
  const pages = Math.max(1, Math.ceil(matching.length / pageSize));
  rosterPage = Math.min(rosterPage, pages);
  const page = onRosterPage(matching);
  const body = document.createDocumentFragment();
  for (const item of page) {
    const row = document.createElement('tr');
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.disabled = !item.number;
    check.checked = selected.has(item.id);
    row.classList.toggle('chosen', check.checked);
    check.setAttribute('aria-label', '选择 ' + (item.number ?? '待补全学号'));
    check.addEventListener('change', () => {
      selectMembers([item], check.checked);
      row.classList.toggle('chosen', check.checked);
      showSelection(matching, page);
    });
    cell(row, 'pick', '', '选择').append(check);
    cell(row, 'number', item.number ?? '待补全', '学号');
    const realCell = cell(row, 'real-name', '', '真实姓名');
    const nameButton = element('button', 'edit-name', item.realName || '填写姓名');
    nameButton.type = 'button';
    nameButton.disabled = !item.number;
    nameButton.setAttribute('aria-label', '编辑真实姓名 ' + (item.number || ''));
    nameButton.addEventListener('click', () => edit('realName', item));
    realCell.append(nameButton);
    cell(row, 'name', item.name || '—', '显示名');
    cell(row, 'score', rosterScore(item), '最高分');
    cell(row, 'status', '', '状态').append(element('span', 'state' + (item.active ? '' : ' off'), item.active ? '已启用' : '已停用'));
    const actions = element('div', 'actions', '');
    cell(row, 'operations', '', '操作').append(actions);
    if (item.number) {
      const labels = {rename: '改号', alias: '改显示名', pause: '停用', resume: '恢复', remove: '删除'};
      for (const op of ['rename', 'alias', item.active ? 'pause' : 'resume', 'remove']) {
        const button = element('button', op === 'remove' ? 'pause' : '', labels[op]);
        button.type = 'button';
        button.setAttribute('aria-label', labels[op] + ' ' + item.number);
        button.addEventListener('click', () => op === 'remove' ? editBatch(op, [item]) : edit(op, item));
        actions.append(button);
      }
    }
    body.append(row);
  }
  el('members').replaceChildren(body);
  showSelection(matching, page);
  setText('resultCount', '共 ' + matching.length + ' 个学号');
  setText('pageInfo', '第 ' + rosterPage + ' / ' + pages + ' 页');
  el('prevPage').disabled = rosterPage === 1;
  el('nextPage').disabled = rosterPage === pages;
  el('empty').hidden = matching.length > 0;
  setText('empty', members.length ? '没有匹配的学号' : '名单为空');
}
function renderRanking() {
  const filter = el('rankFilter').value;
  const needle = el('rankSearch').value.trim().toLowerCase();
  const visible = ranked.filter(({item, rank}) =>
    (filter === 'all' || (filter === 'graded' ? rank !== null : rank === null)) && matches(item, needle));
  const pageSize = 15;
  const pages = Math.max(1, Math.ceil(visible.length / pageSize));
  rankPage = Math.min(rankPage, pages);
  const first = (rankPage - 1) * pageSize;
  const body = document.createDocumentFragment();
  for (const {item, rank} of visible.slice(first, first + pageSize)) {
    const row = document.createElement('tr');
    cell(row, 'position', rank ?? '—', '排名');
    cell(row, 'number', item.number ?? '待补全', '学号');
    cell(row, 'real-name', item.realName || '—', '真实姓名');
    cell(row, 'name', item.name || '—', '显示名');
    cell(row, 'score', formatScore.format(item.total), '最高分');
    cell(row, 'status', '', '评分状态').append(element('span', rank === null ? 'state pending' : 'state', rank === null ? '待自评' : '已评分'));
    body.append(row);
  }
  el('rankRows').replaceChildren(body);
  setText('rankResultCount', '共 ' + visible.length + ' 条成绩');
  setText('rankPageInfo', '第 ' + rankPage + ' / ' + pages + ' 页');
  el('rankPrev').disabled = rankPage === 1;
  el('rankNext').disabled = rankPage === pages;
  el('rankEmpty').hidden = visible.length > 0;
  setText('rankEmpty', ranked.length ? '没有匹配的成绩' : '暂无已交卷成绩');
}
function renderOverview() {
  const active = members.filter(item => item.active).length;
  const graded = ranked.filter(entry => entry.rank !== null);
  const submitted = ranked.length;
  const percent = active ? Math.round(100 * submitted / active) : 0;
  setText('counts', members.length + ' 个学号 · ' + active + ' 个启用 · ' + (members.length - active) + ' 个停用');
  setText('metricActive', active);
  setText('metricSubmitted', submitted);
  setText('metricAverage', graded.length ? formatAverage.format(graded.reduce((sum, {item}) => sum + item.total, 0) / graded.length) : '—');
  setText('metricHigh', graded.length ? formatScore.format(graded[0].item.total) : '—');
  el('participationRing').style.setProperty('--progress', percent + '%');
  setText('participationPercent', percent + '%');
  setText('partSubmitted', submitted);
  setText('partMissing', active - submitted);
  setText('partPending', submitted - graded.length);
  const bins = [0, 0, 0, 0, 0];
  for (const {item} of graded) {
    const score = item.total;
    const index = score < 60 ? 0 : score < 70 ? 1 : score < 80 ? 2 : score < 90 ? 3 : 4;
    bins[index]++;
  }
  const labels = ['<60', '60–<70', '70–<80', '80–<90', '90–100'];
  const maxCount = Math.max(1, ...bins);
  el('distribution').replaceChildren(...bins.map((count, index) => {
    const row = element('div', 'bin-row', '');
    const track = element('div', 'bin-track', '');
    const bar = document.createElement('i');
    bar.style.width = (count * 100 / maxCount) + '%';
    track.append(bar);
    row.append(element('span', 'bin-label', labels[index]), track, element('span', 'bin-count', count));
    return row;
  }));
  const leaders = graded.slice(0, 5).map(({rank, item}) => {
    const row = document.createElement('li');
    const fallback = item.number ? '学号尾号 ' + item.number.slice(-4) : '待补全学号';
    row.append(element('span', rank === 1 ? 'leader-rank first' : 'leader-rank', rank), element('span', 'leader-name', item.name || fallback),
      element('strong', 'leader-score score', formatScore.format(item.total) + ' 分'));
    return row;
  });
  el('leaders').replaceChildren(...(leaders.length ? leaders : [element('li', 'leader-empty', '暂无已评分成绩')]));
}
function adopt(data) {
  const current = new Map(data.rows.map(row => [row.id, row.number]));
  for (const [id, number] of selected) if (current.get(id) !== number) selected.delete(id);
  members = data.rows.slice().sort((a, b) => {
    if (a.number === null || b.number === null) return Number(a.number === null) - Number(b.number === null);
    return collator.compare(a.number, b.number);
  });
  const submitted = members.filter(row => row.active && row.total !== null)
    .sort((a, b) => Number(!!a.pending) - Number(!!b.pending) || b.total - a.total || a.tieOrder - b.tieOrder);
  let previousScore = null;
  let position = 0;
  ranked = submitted.map((item, index) => {
    if (item.pending) return {item, rank: null};
    if (item.total !== previousScore) position = index + 1;
    previousScore = item.total;
    return {item, rank: position};
  });
  renderRoster();
  renderRanking();
  renderOverview();
  setText('updatedAt', '更新于 ' + new Date().toLocaleTimeString('zh-CN', {hour: '2-digit', minute: '2-digit', hour12: false}));
}

function resetEditor() {
  currentEdit = null;
  el('number').value = '';
  el('number').placeholder = '';
  el('realNameInput').value = '';
  el('editTargets').replaceChildren();
  el('editTargets').hidden = true;
  setText('impact', '');
  setText('editTitle', '');
  setText('editError', '');
}
function setSaving(busy) {
  for (const id of ['save', 'cancel', 'number', 'realNameInput']) el(id).disabled = busy;
}
function setRefreshBusy(busy) {
  el('refresh').disabled = busy;
  el('refresh').setAttribute('aria-busy', String(busy));
}
function logout(message = '') {
  session = null;
  members = [];
  selected.clear();
  showSelection([], []);
  ranked = [];
  rosterPage = 1;
  rankPage = 1;
  if (el('editor').open) el('editor').close();
  resetEditor();
  setSaving(false);
  setRefreshBusy(false);
  for (const id of ['members', 'rankRows', 'leaders', 'distribution']) el(id).replaceChildren();
  for (const id of ['metricActive', 'metricSubmitted', 'metricAverage', 'metricHigh', 'partSubmitted', 'partMissing',
    'partPending', 'participationPercent', 'updatedAt', 'counts', 'resultCount', 'rankResultCount', 'pageInfo',
    'rankPageInfo', 'empty', 'rankEmpty']) setText(id, '');
  el('participationRing').style.removeProperty('--progress');
  for (const id of ['password', 'search', 'rankSearch']) el(id).value = '';
  for (const id of ['filter', 'rankFilter']) el(id).value = 'all';
  el('pageSize').value = '15';
  setPasswordVisible(false);
  notify('');
  el('workspace').hidden = true;
  el('loginPanel').hidden = false;
  mobileMenu(false);
  history.replaceState(null, '', location.pathname + location.search);
  setText('loginError', message);
  el('password').focus();
}
function mappingNotice(data) {
  return data.unmapped ? '有 ' + data.unmapped + ' 个学号待补全，补全后即可编辑。' : '';
}
el('loginForm').addEventListener('submit', async event => {
  event.preventDefault();
  const token = el('password').value.trim();
  if (!token || el('signIn').disabled) return;
  el('signIn').disabled = true;
  el('signIn').setAttribute('aria-busy', 'true');
  setText('loginError', '');
  try {
    const data = await api({action: 'list'}, token);
    adopt(data);
    session = {token, reading: false, writing: false};
    el('password').value = '';
    setPasswordVisible(false);
    notify(mappingNotice(data));
    el('loginPanel').hidden = true;
    el('workspace').hidden = false;
    history.replaceState(null, '', '#overview');
    showView('overview');
    el('pageTitle').focus();
  } catch (error) {
    setText('loginError', error.code ? error.message : '无法连接管理服务，请检查网络后重试。');
  } finally {
    el('signIn').disabled = false;
    el('signIn').setAttribute('aria-busy', 'false');
  }
});
async function refresh(success = '') {
  const owner = session;
  if (!owner || owner.reading) return;
  owner.reading = true;
  setRefreshBusy(true);
  try {
    const data = await api({action: 'list'}, owner.token);
    if (owner !== session) return;
    adopt(data);
    notify([success, mappingNotice(data)].filter(Boolean).join(' '));
  } catch (error) {
    if (owner !== session) return;
    if (error.code === 'unauthorized') logout(error.message);
    else notify(success + ' 数据刷新失败，请重新刷新。', true);
  } finally {
    if (owner === session) {
      owner.reading = false;
      setRefreshBusy(false);
    }
  }
}
el('logout').addEventListener('click', () => logout());
el('refresh').addEventListener('click', () => { if (session && !session.writing) refresh(); });
window.addEventListener('pagehide', () => { if (session) logout(); });
for (const [id, event] of [['search', 'input'], ['filter', 'change'], ['pageSize', 'change']]) {
  el(id).addEventListener(event, () => {
    rosterPage = 1;
    renderRoster();
  });
}
el('selectPage').addEventListener('change', () => {
  selectMembers(onRosterPage(filteredRoster()), el('selectPage').checked);
  renderRoster();
});
el('selectMatches').addEventListener('click', () => { selectMembers(filteredRoster(), true); renderRoster(); });
el('clearSelection').addEventListener('click', () => { selected.clear(); renderRoster(); });
document.querySelectorAll('[data-bulk]').forEach(button => button.addEventListener('click', () => {
  editBatch(button.dataset.bulk, members.filter(row => selected.has(row.id)));
}));
for (const [id, event] of [['rankSearch', 'input'], ['rankFilter', 'change']]) {
  el(id).addEventListener(event, () => { rankPage = 1; renderRanking(); });
}
el('prevPage').addEventListener('click', () => { rosterPage--; renderRoster(); });
el('nextPage').addEventListener('click', () => { rosterPage++; renderRoster(); });
el('rankPrev').addEventListener('click', () => { rankPage--; renderRanking(); });
el('rankNext').addEventListener('click', () => { rankPage++; renderRanking(); });

function editBatch(operation, rows) {
  if (!rows.length) return;
  const label = {enable: '启用', disable: '停用', remove: '删除'}[operation];
  const impact = {
    enable: '启用后可交卷，已有成绩重新参加排名。',
    disable: '停用后无法交卷，已有成绩暂时从排名隐藏。',
    remove: '将从名单和排名中移除，并清除登记姓名及显示名设置。历史答卷会保留，重新添加同一学号可恢复成绩。'
  }[operation];
  edit('bulk', {operation, targets: rows, text: [label + ' ' + rows.length + ' 个学号', impact, '', '确认' + label]});
}
function edit(op, item = {}) {
  if (!session || session.writing || session.reading) return;
  currentEdit = {op, item};
  const id = item.number;
  const text = {
    add: ['新增学号', '添加后，该学号即可交卷并参与班级排名。', '学号', '添加'],
    rename: ['更正学号', '原学号 ' + id + ' 的历史成绩会归入新学号，原学号将停止使用。', '新学号', '保存更正'],
    alias: ['修改榜单显示名', '为 ' + id + ' 设置榜上显示名。留空会恢复最高分答卷填写的名字。', '榜单显示名（选填）', '保存显示名'],
    realName: ['编辑真实姓名', '学号 ' + id + '。真实姓名仅管理员可见，留空可清除。', '真实姓名（选填）', '保存姓名'],
    bulk: item.text,
    pause: ['停用学号', '停用 ' + id + ' 后，该学号无法交卷，成绩从班级排名隐藏。历史成绩会保留。', '', '确认停用'],
    resume: ['恢复学号', '恢复 ' + id + ' 后，该学号可以继续交卷，已有成绩重新参加排名。', '', '确认恢复']
  }[op];
  const needsInput = ['add', 'rename', 'alias', 'realName'].includes(op);
  setText('editTitle', text[0]);
  setText('impact', text[1]);
  setText('numberLabel', text[2]);
  el('numberFields').hidden = !needsInput;
  el('realNameFields').hidden = op !== 'add';
  el('realNameInput').value = '';
  el('editTargets').hidden = op !== 'bulk';
  if (op === 'bulk') {
    el('editTargets').replaceChildren(...item.targets.map(row =>
      element('li', '', row.number + (row.realName ? '　' + row.realName : ''))));
  }
  const input = el('number');
  input.required = op === 'add' || op === 'rename';
  input.maxLength = input.required ? 32 : 40;
  input.autocapitalize = input.required ? 'characters' : 'off';
  input.placeholder = op === 'alias' ? (item.submittedName || '留空使用答卷显示名') : '';
  input.value = op === 'rename' ? id : op === 'alias' ? (item.displayName || '') : op === 'realName' ? (item.realName || '') : '';
  setText('editError', '');
  setText('save', text[3]);
  const destructive = op === 'pause' || ['remove', 'disable'].includes(item.operation);
  el('save').classList.toggle('destructive', destructive);
  el('save').classList.toggle('primary', !destructive);
  el('editor').showModal();
  if (needsInput) {
    input.focus();
    input.select();
  } else el('cancel').focus();
}
el('add').addEventListener('click', () => edit('add'));
el('cancel').addEventListener('click', () => el('editor').close());
el('editor').addEventListener('cancel', event => { if (session?.writing) event.preventDefault(); });
el('editor').addEventListener('close', () => { if (!el('editor').open) resetEditor(); });
el('editForm').addEventListener('submit', async event => {
  event.preventDefault();
  const owner = session;
  if (!currentEdit || !owner || owner.writing || owner.reading) return;
  const {op, item} = currentEdit;
  const input = el('number');
  const num = input.value.normalize('NFKC').trim().toUpperCase();
  if (op === 'add' || op === 'rename') {
    if (!/^[A-Z0-9][A-Z0-9_-]{0,31}$/.test(num)) {
      setText('editError', clientMessages.invalid_number);
      input.focus();
      return;
    }
    if (op === 'rename' && num === item.number) {
      setText('editError', '请填写新的学号。');
      input.focus();
      return;
    }
  }
  let change, complete;
  if (op === 'add') {
    change = {action: 'add', number: num, realName: el('realNameInput').value.trim()};
    complete = '已添加 ' + num + '。';
  } else if (op === 'rename') {
    change = {action: 'rename', number: item.number, newNumber: num};
    complete = '已将 ' + item.number + ' 更正为 ' + num + '。';
  } else if (op === 'bulk') {
    const items = item.targets.map(({id, number}) => ({id, number}));
    change = {action: 'changeRoster', operation: item.operation, items};
    complete = '已' + {enable:'启用', disable:'停用', remove:'删除'}[item.operation] + ' ' + items.length + ' 个学号。';
  } else if (op === 'realName') {
    change = {action: 'changeRoster', operation: 'names', items: [{id:item.id, number:item.number, realName:input.value.trim()}]};
    complete = '已保存真实姓名。';
  } else if (op === 'alias') {
    const displayName = input.value.trim();
    change = {action: 'setDisplayName', number: item.number, displayName};
    complete = displayName ? '已更新榜单显示名。' : '已恢复答卷显示名。';
  } else {
    change = {action: 'setActive', number: item.number, active: op === 'resume'};
    complete = (op === 'pause' ? '已停用 ' : '已恢复 ') + item.number + '。';
  }
  owner.writing = true;
  setSaving(true);
  setText('editError', '');
  try {
    const result = await api(change, owner.token);
    if (owner !== session) return;
    if (result.ok !== true) throw new Error('未收到保存结果');
    if (op === 'bulk') for (const row of item.targets) selected.delete(row.id);
    el('editor').close();
    await refresh(complete);
  } catch (error) {
    if (owner !== session) return;
    if (error.code === 'unauthorized') logout(error.message);
    else setText('editError', error.code ? error.message : '未能确认保存结果，请关闭此窗口并刷新名单核对。');
  } finally {
    if (owner === session) {
      owner.writing = false;
      setSaving(false);
    }
  }
});
