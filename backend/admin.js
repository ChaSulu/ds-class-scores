'use strict';

const el = id => document.getElementById(id);
const board = new URLSearchParams(location.search).get('board') === 'qa' ? 'qa' : 'class';
const endpoint = location.pathname.replace(/\/$/, '') + '/api';
const deviceStateKey = 'ds.admin.device.v1.' + endpoint;
const collator = new Intl.Collator('zh-CN', {numeric: true});
const formatScore = new Intl.NumberFormat('zh-CN', {maximumFractionDigits: 2});
const formatAverage = new Intl.NumberFormat('zh-CN', {maximumFractionDigits: 1});
const attemptClock = new Intl.DateTimeFormat('zh-CN', {month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false});
const attemptStates = {working: '答题中', pending: '已交卷待自评', graded: '已评分', none: '暂无记录'};
const questionTypes = ['判断题', '单选题', '填空题', '编程题', '主观题'];
const outcomeLabels = {correct:'正确', partScore:'部分得分', incorrect:'错误', pending:'待自评', blank:'未答'};
const pages = {
  overview: ['管理概览', '查看班级交卷进度和成绩分布。'],
  roster: ['学号名单', '核对真实姓名，勾选学号可批量管理。'],
  ranking: ['成绩排名', '查看全班作答进度，按最近答卷状态筛选。'],
  loginCopy: ['登录页文案', '保存后，同学下次打开学生登录页时会看到新文字。'],
  announcements: ['公告管理', '发布的公告会显示在学生登录页和考场内。']
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
  announcement_changed: '这条公告已被其他管理员修改。请刷新公告列表后重新编辑。',
  admin_unavailable: '管理服务暂时不可用，请稍后重试。'
};
let session = null;
let loginVersion = 0;
let currentEdit = null;
let rosterPage = 1;
let rankPage = 1;
let members = [];
let ranked = [];
let expandedStudent = null;
let rankTimer;
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
async function api(body, token, credentials = 'same-origin') {
  const response = await fetch(endpoint, {
    method: 'POST', credentials, cache: 'no-store', referrerPolicy: 'no-referrer',
    headers: token ? {'Content-Type':'application/json', Authorization:'Bearer ' + token} : {'Content-Type':'application/json'},
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
  if (!Object.hasOwn(pages, view) || (view === 'loginCopy' && board !== 'class')) view = 'overview';
  clearInterval(rankTimer);
  if (view === 'ranking') rankTimer = setInterval(pollRanking, 15000);
  else if (session?.reading?.rankingOnly) {
    session.reading = false;
    setRefreshBusy(false);
  }
  for (const id of Object.keys(pages)) el(id).hidden = id !== view;
  const ownControls = view === 'loginCopy' || view === 'announcements';
  document.querySelector('.page-actions').hidden = ownControls;
  el('message').hidden = ownControls;
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
  if (view === 'loginCopy' && !session.hasLoginCopy) void syncLoginCopy();
  if (view === 'announcements') void loadAnnouncements();
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
el('loginCopyNav').hidden = board !== 'class';

function copyStatus(message, error = false) {
  setText('copyStatus', message);
  el('copyStatus').classList.toggle('error', error);
}
async function syncLoginCopy(value) {
  const owner = session;
  if (!owner || owner.copyBusy || board !== 'class') return;
  owner.copyBusy = true;
  el('loginCopyFields').disabled = true;
  el('copySave').disabled = true;
  el('copyRetry').hidden = true;
  copyStatus(value ? '正在保存…' : '正在读取文案…');
  try {
    const data = await api(value ? {action:'loginCopySave', value} : {action:'loginCopyGet'}, owner.token);
    if (session !== owner) return;
    for (const field of el('loginCopyFields').elements) field.value = data.value[field.name];
    owner.hasLoginCopy = true;
    copyStatus(value ? '已保存，学生登录页已更新。' : '');
  } catch (error) {
    if (session !== owner) return;
    if (error.code === 'unauthorized') { logout(error.message); return; }
    copyStatus(error.code ? error.message : value ? '保存失败，请检查网络后重试。' : '未能读取文案，请重试。', true);
    el('copyRetry').hidden = !!owner.hasLoginCopy;
  } finally {
    if (session === owner) {
      owner.copyBusy = false;
      el('loginCopyFields').disabled = !owner.hasLoginCopy;
      el('copySave').disabled = !owner.hasLoginCopy;
    }
  }
}
el('copyRetry').addEventListener('click', () => syncLoginCopy());
el('loginCopyForm').addEventListener('input', () => copyStatus(''));
el('loginCopyForm').addEventListener('submit', event => {
  event.preventDefault();
  if (!session?.hasLoginCopy) return;
  const value = {};
  for (const field of el('loginCopyFields').elements) {
    value[field.name] = field.value.trim();
    if (!value[field.name]) {
      copyStatus('请填写' + field.labels[0].firstChild.textContent.trim() + '。', true);
      field.focus();
      return;
    }
  }
  void syncLoginCopy(value);
});

function announcementMessage(text, error = false) {
  setText('announcementMessage', text);
  el('announcementMessage').classList.toggle('error', error);
}
function announcementBusy(busy) {
  el('announcementRefresh').disabled = busy;
  el('announcementNew').disabled = busy || !session?.announcements;
  el('announcementList').inert = busy;
  for (const id of ['announcementFields','announcementDraft','announcementPublish','announcementCancel']) el(id).disabled = busy;
}
function renderAnnouncements() {
  const list = el('announcementList');
  list.replaceChildren();
  if (!session.announcements.length) {
    list.append(element('p','empty','暂无公告'));
    return;
  }
  for (const item of session.announcements) {
    const published = item.status === 'published';
    const card = element('article','announcement-item','');
    const meta = element('div','announcement-meta','');
    meta.append(element('span',published ? 'state' : 'state off',published ? '已发布' : '草稿'),
      element('span','','更新于 ' + attemptClock.format(item.updatedAt)));
    const actions = element('div','announcement-actions','');
    const edit = element('button','secondary','编辑');
    edit.type = 'button';
    edit.addEventListener('click', () => openAnnouncement(item));
    const toggle = element('button','secondary',published ? '撤下' : '发布');
    toggle.type = 'button';
    toggle.addEventListener('click', () => saveAnnouncement(item,published ? 'draft' : 'published'));
    actions.append(edit,toggle);
    card.append(meta,element('h3','',item.title),element('p','announcement-excerpt',item.body),actions);
    list.append(card);
  }
}
async function loadAnnouncements() {
  const owner = session;
  if (!owner || owner.announcementBusy) return;
  owner.announcementBusy = true;
  announcementBusy(true);
  announcementMessage('正在读取公告…');
  try {
    const data = await api({action:'announcementList'},owner.token);
    if (session !== owner) return;
    owner.announcements = data.items;
    renderAnnouncements();
    announcementMessage('');
  } catch (error) {
    if (session !== owner) return;
    if (error.code === 'unauthorized') logout(error.message);
    else announcementMessage(error.code ? error.message : '读取失败，请点击刷新重试。',true);
  } finally {
    if (session === owner) {
      owner.announcementBusy = false;
      announcementBusy(false);
    }
  }
}
function openAnnouncement(item) {
  const editing = Boolean(item);
  const published = item?.status === 'published';
  session.editingAnnouncement = item || {id:crypto.randomUUID()};
  setText('announcementHeading',editing ? '编辑公告' : '新增公告');
  el('announcementTitle').value = item?.title || '';
  el('announcementBody').value = item?.body || '';
  el('announcementDraft').hidden = published;
  setText('announcementPublish',published ? '保存修改' : '发布公告');
  setText('announcementError','');
  el('announcementEditor').showModal();
  el('announcementTitle').focus();
}
async function saveAnnouncement(item, status) {
  const owner = session;
  if (!owner || owner.announcementBusy) return;
  owner.announcementBusy = true;
  announcementBusy(true);
  setText('announcementError','');
  const {id,title,body,updatedAt} = item;
  try {
    const data = await api({action:'announcementSave',id,title,body,status,expectedUpdatedAt:updatedAt},owner.token);
    if (session !== owner) return;
    owner.announcements = [data.item,...owner.announcements.filter(old => old.id !== id)];
    renderAnnouncements();
    el('announcementEditor').close();
    const message = status === 'draft' ? (item.status === 'published' ? '公告已撤下，保存在草稿中。' : '草稿已保存。')
      : (item.status === 'published' ? '已更新发布的公告。' : '公告已发布。');
    announcementMessage(message);
  } catch (error) {
    if (session !== owner) return;
    if (error.code === 'unauthorized') { logout(error.message); return; }
    const message = error.code ? error.message : '保存失败，请检查网络后重试。';
    if (el('announcementEditor').open) setText('announcementError',message);
    else announcementMessage(message,true);
  } finally {
    if (session === owner) {
      owner.announcementBusy = false;
      announcementBusy(false);
    }
  }
}
el('announcementRefresh').addEventListener('click',loadAnnouncements);
el('announcementNew').addEventListener('click',() => openAnnouncement());
el('announcementCancel').addEventListener('click',() => el('announcementEditor').close());
el('announcementEditor').addEventListener('cancel',event => { if (session?.announcementBusy) event.preventDefault(); });
el('announcementForm').addEventListener('submit', event => {
  event.preventDefault();
  const item = session.editingAnnouncement;
  const title = el('announcementTitle').value.trim(), body = el('announcementBody').value.trim();
  if (!title || !body) {
    setText('announcementError',title ? '请填写公告正文。' : '请填写公告标题。');
    el(title ? 'announcementBody' : 'announcementTitle').focus();
    return;
  }
  const status = item.status === 'published' ? 'published' : event.submitter?.value || 'draft';
  void saveAnnouncement({...item,title,body},status);
});

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
function appendAttemptDetails(body, latest) {
  const row = document.createElement('tr');
  row.className = 'attempt-detail';
  const content = row.insertCell();
  content.colSpan = 7;
  content.id = 'rankAttemptDetails';
  const heading = element('div', 'attempt-heading', '');
  heading.append(element('strong', '', '最近答卷详情'));
  if (latest.total != null) {
    const label = latest.status === 'pending' ? '暂计 ' : '本次得分 ';
    heading.append(element('span', '', label + formatScore.format(latest.total) + ' 分'));
  }
  content.append(heading);
  if (latest.groups || latest.scores) {
    const breakdown = element('dl', 'type-breakdown', '');
    questionTypes.forEach((label, index) => {
      const group = latest.groups?.[index];
      const score = latest.scores?.[index];
      const block = element('div', '', '');
      block.append(element('dt', '', label));
      if (group) {
        block.append(element('dd', '', '已答 ' + group.answered + ' / ' + group.total + ' 题'));
        if (group.partial) block.append(element('dd', 'part-count', '部分作答 ' + group.partial + ' 题'));
      }
      if (score != null) block.append(element('dd', 'type-score', '得分 ' + formatScore.format(score)));
      breakdown.append(block);
    });
    content.append(breakdown);
  }
  if (latest.outcomes) {
    const outcomes = element('div', 'outcome-list', '');
    for (const [key, label] of Object.entries(outcomeLabels)) {
      outcomes.append(element('span', '', label + ' ' + latest.outcomes[key] + ' 题'));
    }
    content.append(outcomes);
  } else if (!latest.groups) {
    content.append(element('p', 'attempt-note', '这份答卷未记录作答题数和逐题判定。'));
  }
  body.append(row);
}

function appendProgressCells(row, item) {
  const latest = item.latest;
  const state = latest?.status || 'none';
  const status = cell(row, 'status', '', '最近答卷状态');
  const badgeStyle = {none:'off', working:'working', pending:'pending', graded:''}[state];
  status.append(element('span', 'state ' + badgeStyle, attemptStates[state]));
  if (latest?.pending && state === 'pending') status.append(element('small', 'attempt-meta', latest.pending + ' 题待自评'));
  const time = latest?.updated ?? latest?.ended;
  if (time != null) {
    const timestamp = element('time', 'attempt-meta', (latest.updated == null ? '交卷 ' : '更新 ') + attemptClock.format(time));
    timestamp.dateTime = new Date(time).toISOString();
    timestamp.title = new Date(time).toLocaleString('zh-CN');
    status.append(timestamp);
  }
  const progress = cell(row, 'answer-progress', '', '答题进度');
  if (!latest) {
    progress.textContent = '—';
    return;
  }
  if (latest.groups) {
    let answered = 0, partial = 0, total = 0;
    for (const group of latest.groups) {
      answered += group.answered;
      partial += group.partial;
      total += group.total;
    }
    progress.append(element('span', 'answer-count', '已答 ' + answered + ' / ' + total + ' 题'));
    if (total) {
      const bar = document.createElement('progress');
      bar.max = total;
      bar.value = answered;
      bar.setAttribute('aria-label', '完整作答题数');
      progress.append(bar);
    }
    if (partial) progress.append(element('small', 'part-count', '另有 ' + partial + ' 题部分作答'));
  } else progress.append(element('span', 'attempt-meta', '题数未记录'));
  const open = expandedStudent === item.id;
  const toggle = element('button', 'attempt-toggle', open ? '收起详情' : '查看详情');
  toggle.type = 'button';
  toggle.dataset.student = item.id;
  toggle.setAttribute('aria-expanded', String(open));
  toggle.setAttribute('aria-label', toggle.textContent + ' ' + (item.number || item.name || ''));
  if (open) toggle.setAttribute('aria-controls', 'rankAttemptDetails');
  toggle.addEventListener('click', () => {
    expandedStudent = open ? null : item.id;
    renderRanking();
  });
  progress.append(toggle);
}

function renderRanking() {
  const filter = el('rankFilter').value;
  const needle = el('rankSearch').value.trim().toLowerCase();
  const graded = ranked.filter(entry => entry.rank !== null);
  const unranked = members.filter(item => item.active && (item.total == null || item.pending))
    .sort((a, b) => (b.latest?.updated ?? b.latest?.ended ?? 0) - (a.latest?.updated ?? a.latest?.ended ?? 0));
  const visible = graded.concat(unranked.map(item => ({item, rank:null}))).filter(({item}) =>
    (filter === 'all' || (item.latest?.status || 'none') === filter) && matches(item, needle));
  const pageSize = 15;
  const pages = Math.max(1, Math.ceil(visible.length / pageSize));
  rankPage = Math.min(rankPage, pages);
  const first = (rankPage - 1) * pageSize;
  const body = document.createDocumentFragment();
  const focused = document.activeElement?.dataset.student;
  const page = visible.slice(first, first + pageSize);
  if (!page.some(({item}) => item.id === expandedStudent)) expandedStudent = null;
  for (const {item, rank} of page) {
    const row = document.createElement('tr');
    row.className = 'rank-entry';
    cell(row, 'position', rank ?? '—', '排名');
    cell(row, 'number', item.number ?? '待补全', '学号');
    cell(row, 'real-name', item.realName || '—', '真实姓名');
    cell(row, 'name', item.name || '—', '显示名');
    cell(row, 'score', rank === null ? '—' : formatScore.format(item.total), '最高分');
    appendProgressCells(row, item);
    body.append(row);
    if (item.latest && expandedStudent === item.id) appendAttemptDetails(body, item.latest);
  }
  el('rankRows').replaceChildren(body);
  if (focused) [...el('rankRows').querySelectorAll('.attempt-toggle')].find(button => button.dataset.student === focused)?.focus({preventScroll:true});
  setText('rankResultCount', '共 ' + visible.length + ' 人');
  setText('rankPageInfo', '第 ' + rankPage + ' / ' + pages + ' 页');
  el('rankPrev').disabled = rankPage === 1;
  el('rankNext').disabled = rankPage === pages;
  el('rankEmpty').hidden = visible.length > 0;
  setText('rankEmpty', members.some(item => item.active) ? '没有符合条件的学号' : '暂无启用学号');
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
  setText('partPending', members.filter(item => item.active && item.latest?.status === 'pending').length);
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
function logout(message = '', keepView = false) {
  if (message === clientMessages.unauthorized && session && !session.token) {
    if (deviceState() === 'remembered') setDeviceState(null);
    message = '设备登录已失效，请重新输入管理口令。';
  }
  loginVersion++;
  session = null;
  members = [];
  selected.clear();
  showSelection([], []);
  ranked = [];
  expandedStudent = null;
  clearInterval(rankTimer);
  rosterPage = 1;
  rankPage = 1;
  if (el('editor').open) el('editor').close();
  resetEditor();
  setSaving(false);
  setRefreshBusy(false);
  el('loginCopyForm').reset();
  el('announcementEditor').close();
  el('announcementForm').reset();
  el('announcementList').replaceChildren();
  announcementMessage('');
  setText('announcementError','');
  announcementBusy(false);
  el('loginCopyFields').disabled = true;
  el('copySave').disabled = true;
  el('copyRetry').hidden = true;
  copyStatus('');
  for (const id of ['members', 'rankRows', 'leaders', 'distribution']) el(id).replaceChildren();
  for (const id of ['metricActive', 'metricSubmitted', 'metricAverage', 'metricHigh', 'partSubmitted', 'partMissing',
    'partPending', 'participationPercent', 'updatedAt', 'counts', 'resultCount', 'rankResultCount', 'pageInfo',
    'rankPageInfo', 'empty', 'rankEmpty']) setText(id, '');
  el('participationRing').style.removeProperty('--progress');
  for (const id of ['password', 'search', 'rankSearch']) el(id).value = '';
  el('rememberDevice').checked = false;
  setLoginBusy(false);
  for (const id of ['filter', 'rankFilter']) el(id).value = 'all';
  el('pageSize').value = '15';
  setPasswordVisible(false);
  notify('');
  el('workspace').hidden = true;
  el('loginPanel').hidden = false;
  mobileMenu(false);
  if (!keepView) history.replaceState(null, '', location.pathname + location.search);
  setText('loginError', message);
  el('password').focus();
}
function mappingNotice(data) {
  return data.unmapped ? '有 ' + data.unmapped + ' 个学号待补全，补全后即可编辑。' : '';
}
function deviceState() {
  try { return localStorage.getItem(deviceStateKey); }
  catch { return null; }
}
function setDeviceState(value) {
  if (value) localStorage.setItem(deviceStateKey, value);
  else localStorage.removeItem(deviceStateKey);
}
function deviceLock(action) {
  return navigator.locks ? navigator.locks.request(deviceStateKey, action) : action();
}
async function revokePending() {
  if (!['enrolling','logout'].includes(deviceState())) return;
  await api({action:'deviceLogout'});
  setDeviceState(null);
}
async function finishLogout() {
  try {
    await deviceLock(revokePending);
    if (!session && !deviceState()) setText('loginError','');
  } catch {
    if (!session) setText('loginError','本机后台已锁定。联网后会自动完成退出。');
  }
}
function setLoginBusy(busy) {
  el('signIn').disabled = busy;
  el('signIn').setAttribute('aria-busy', String(busy));
}
function enterWorkspace(data, token) {
  session = {token, reading:false, writing:false};
  adopt(data);
  el('password').value = '';
  setPasswordVisible(false);
  notify(mappingNotice(data));
  el('loginPanel').hidden = true;
  el('workspace').hidden = false;
  const requested = location.hash.slice(1);
  const view = Object.hasOwn(pages,requested) && (requested !== 'loginCopy' || board === 'class') ? requested : 'overview';
  history.replaceState(null, '', '#' + view);
  showView(view);
  el('pageTitle').focus();
}
async function restoreDevice() {
  if (session || el('signIn').disabled) return;
  const state = deviceState();
  if (state === 'logout' || state === 'enrolling') { await finishLogout(); return; }
  if (state !== 'remembered') return;
  const version = ++loginVersion;
  try {
    const data = await api({action:'list'});
    if (version === loginVersion && deviceState() === 'remembered') enterWorkspace(data,null);
  } catch (error) {
    if (version !== loginVersion) return;
    if (error.code === 'unauthorized') {
      setDeviceState(null);
      setText('loginError','设备登录已失效，请重新输入管理口令。');
    } else setText('loginError','暂时无法恢复登录，请检查网络后重试。');
  }
}
el('loginForm').addEventListener('submit', async event => {
  event.preventDefault();
  const token = el('password').value.trim();
  if (!token || el('signIn').disabled) return;
  const version = ++loginVersion;
  const remember = el('rememberDevice').checked;
  setLoginBusy(true);
  setText('loginError', '');
  try {
    const data = await deviceLock(async () => {
      await revokePending();
      if (version !== loginVersion) return;
      if (!remember) {
        const data = await api({action:'list'}, token);
        if (version === loginVersion && deviceState() === 'remembered') {
          setDeviceState('logout');
          await revokePending();
        }
        return data;
      }
      // Record the intent before issuing a cookie so an interrupted login can be revoked.
      setDeviceState('enrolling');
      let issued = false;
      try {
        await api({action:'deviceLogin'}, token);
        issued = true;
        const data = await api({action:'list'});
        if (version === loginVersion && deviceState() === 'enrolling') {
          setDeviceState('remembered');
          return data;
        }
        await revokePending();
      } catch (error) {
        try { await revokePending(); } catch { /* Revoke on reconnection or next visit. */ }
        if (issued && error.code === 'unauthorized') {
          throw Object.assign(new Error('浏览器未能保存设备登录。请允许 Cookie，或取消勾选后登录。'), {code:'cookie_unavailable'});
        }
        throw error;
      }
    });
    if (data && version === loginVersion) enterWorkspace(data, remember ? null : token);
  } catch (error) {
    if (version === loginVersion) setText('loginError', error.code ? error.message : '登录未完成。请检查网络，或取消记住设备后重试。');
  } finally {
    if (version === loginVersion) setLoginBusy(false);
  }
});
async function refresh(success = '', rankingOnly = false) {
  const owner = session;
  if (!owner || owner.reading) return;
  const request = {rankingOnly};
  owner.reading = request;
  setRefreshBusy(true);
  try {
    const data = await api({action: 'list'}, owner.token);
    if (owner !== session || owner.reading !== request) return;
    adopt(data);
    notify([success, mappingNotice(data)].filter(Boolean).join(' '));
  } catch (error) {
    if (owner !== session || owner.reading !== request) return;
    if (error.code === 'unauthorized') logout(error.message);
    else notify(success + ' 数据刷新失败，请重新刷新。', true);
  } finally {
    if (owner === session && owner.reading === request) {
      owner.reading = false;
      setRefreshBusy(false);
    }
  }
}
function pollRanking() {
  if (session && !session.writing && !document.hidden && !el('ranking').hidden && !el('editor').open) {
    void refresh('', true);
  }
}
document.addEventListener('visibilitychange', pollRanking);
el('logout').addEventListener('click', async () => {
  const remembered = session && !session.token;
  logout();
  if (remembered) {
    setDeviceState('logout');
    await finishLogout();
  } else {
    // A PIN-only tab has no device session of its own to revoke.
    await api({action:'deviceLogout'}, null, 'omit').catch(() => {});
  }
});
el('refresh').addEventListener('click', () => { if (session && !session.writing) refresh(); });
window.addEventListener('pagehide', () => logout('',true));
window.addEventListener('pageshow', () => { void restoreDevice(); });
window.addEventListener('online', () => { void restoreDevice(); });
window.addEventListener('storage', event => {
  if ((event.key === deviceStateKey || event.key === null) && deviceState() !== 'remembered' &&
      (session && !session.token || el('signIn').disabled)) logout();
});
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
