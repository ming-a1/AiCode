(function(){
'use strict';
// 内嵌 SQL 引擎（构建时注入 base64 编码的 sql-wasm.wasm）
var WASM_B64 = window.WASM_B64 || '';
var APP_META = (typeof window !== 'undefined' && window.APP_META) ? window.APP_META : { version: '1.0.0', build: '' };
function metaText(){ return 'v' + APP_META.version + (APP_META.build ? ' · 构建于 ' + APP_META.build : ''); }
function initVersion(){
  try {
    var q = function(s){ return document.querySelector(s); };
    q('#appVersion').textContent = 'v' + APP_META.version;
    q('#appVersion').title = metaText();
    q('#dzVersion').textContent = metaText();
    q('#appVersion').addEventListener('click', function(){ toastMsg('DB Reader ' + metaText()); });
  } catch(e) {}
}
initVersion();
// ================= 工具函数 =================
var $ = function(s){ return document.querySelector(s); };
var $$ = function(s){ return Array.prototype.slice.call(document.querySelectorAll(s)); };
var BACKSLASH = String.fromCharCode(92);
var escId = function(s){ return '"' + String(s).replace(/"/g, '""') + '"'; };
function b64ToBytes(b64){
  var bin = atob(b64), n = bin.length, u8 = new Uint8Array(n);
  for (var i = 0; i < n; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}
function blobToBase64(u8){
  var s = '', CH = 0x8000;
  for (var i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  return btoa(s);
}
function toHex(u8){
  var s = '';
  for (var i = 0; i < u8.length; i++) s += (u8[i] < 16 ? '0' : '') + u8[i].toString(16);
  return s;
}
function fmtBytes(n){
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(2) + ' MB';
}
function fmtInt(n){ return Number(n).toLocaleString('en-US'); }
function nowStr(){
  var d = new Date(), p = function(x){ return String(x).padStart(2, '0'); };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}
var safeName = function(s){ return String(s).replace(/[^\w\u4e00-\u9fa5.-]+/g, '_'); };

// ================= 状态 =================
var SQL = null, db = null, dbBytes = null, dbName = '';
var tables = [];            // {name,type,sql,count}
var curTable = null;        // 当前选中的表/视图
var page = 1, pageSize = 50, sortCol = null, sortDir = 'ASC', filterText = '';
var pageData = null;        // {cols,rows,total}
var selRow = null;          // {table,type,index,cols,values}
var selField = null;        // {col,value}
var modalScope = 'table', modalFmt = 'txt', modalField = null, modalOpen = false;
var nameEdited = false;
var optStripHtml = false, optRegex = '', optRepl = '';
var colSel = null;            // 导出字段选择：null=全部，{col:false}=排除
var rowFrom = 0, rowTo = 0;   // 导出行范围（1 起；0 - 0 = 全部行）
var paraMode = false;         // 每行独立成段：段间空 4 行（仅 txt）
var titleFoldOpen = false;    // 自定义标题折叠面板展开状态
var exportTitles = [];        // 按导出行序的自定义标题（空串 = 不加）
var dirty = false;            // 是否有未保存的库修改
var pageRids = [];            // 当前页各行的 rowid（用于编辑/删除定位）
var editMode = false;         // 当前表是否可编辑（表且有 rowid）

var ALLOWED = {
  db:    ['db', 'sql', 'json', 'txt'],
  table: ['txt', 'json', 'csv', 'sql', 'md'],
  row:   ['txt', 'json', 'csv', 'sql', 'md'],
  field: ['txt', 'json', 'csv', 'md']
};
var MIME = { txt:'text/plain', json:'application/json', csv:'text/csv', sql:'application/sql', md:'text/markdown', db:'application/octet-stream' };
var FMT_NOTE = { txt:'纯文本（默认）', json:'结构化数据', csv:'表格数据（含 BOM，Excel 可直接打开）', sql:'SQL 建表与插入语句', md:'Markdown 表格', db:'二进制数据库文件' };

// ================= 启动：加载内嵌引擎 =================
function setDrop(text){ $('#dzText').textContent = text; }
var engineReady = false;
(function boot(){
  try {
    setDrop('正在加载 SQL 引擎…');
    initSqlJs({ wasmBinary: b64ToBytes(WASM_B64) }).then(function(engine){
      SQL = engine;
      engineReady = true;
      setDrop('拖入数据库文件，或点击选择');
    }).catch(function(e){
      setDrop('SQL 引擎加载失败：' + (e && e.message ? e.message : e));
    });
  } catch(e) {
    setDrop('SQL 引擎加载失败：' + (e && e.message ? e.message : e));
  }
})();

// ================= Toast =================
var toastTimer = null;
function toastMsg(msg){
  var t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function(){ t.classList.remove('show'); }, 2600);
}

// ================= 移动端适配 =================
var mqMobile = (typeof window.matchMedia === 'function') ? window.matchMedia('(max-width: 768px)') : null;
function isMobile(){ return !!(mqMobile && mqMobile.matches); }
var sideOpen = false;
function openSidebar(){
  if (!isMobile() || sideOpen) return;
  sideOpen = true;
  $('#sidebar').classList.add('mobile-open');
  $('#overlayBack').classList.remove('hidden');
}
function closeSidebar(){
  if (!sideOpen) return;
  sideOpen = false;
  $('#sidebar').classList.remove('mobile-open');
  $('#overlayBack').classList.add('hidden');
}
$('#btnSwitchTable').onclick = openSidebar;
$('#btnSideClose').onclick = closeSidebar;
$('#overlayBack').onclick = closeSidebar;
if (mqMobile) {
  var onMqChange = function(){ closeSidebar(); };
  if (mqMobile.addEventListener) mqMobile.addEventListener('change', onMqChange);
  else if (mqMobile.addListener) mqMobile.addListener(onMqChange);
}

// ================= 最近打开（本机缓存） =================
var RECENT_MAX = 5;
var RECENT_BLOB_LIMIT = 50 * 1048576;
var recentBackend = null;
function idbOpenDb(){
  return new Promise(function(res, rej){
    try {
      if (typeof indexedDB === 'undefined' || !indexedDB) { rej(new Error('no-indexeddb')); return; }
      var req = indexedDB.open('db-reader-store', 1);
      req.onupgradeneeded = function(){
        var d = req.result;
        if (!d.objectStoreNames.contains('files')) d.createObjectStore('files', { keyPath: 'name' });
      };
      req.onsuccess = function(){ res(req.result); };
      req.onerror = function(){ rej(req.error || new Error('idb-open-failed')); };
      req.onblocked = function(){ rej(new Error('idb-blocked')); };
    } catch(e) { rej(e); }
  });
}
function idbAll(){
  return idbOpenDb().then(function(d){
    return new Promise(function(res, rej){
      try {
        var tx = d.transaction('files', 'readonly');
        var rq = tx.objectStore('files').getAll();
        rq.onsuccess = function(){ res(rq.result || []); };
        rq.onerror = function(){ rej(rq.error); };
      } catch(e) { rej(e); }
    });
  });
}
function idbPut(entry){
  return idbOpenDb().then(function(d){
    return new Promise(function(res, rej){
      try {
        var tx = d.transaction('files', 'readwrite');
        tx.objectStore('files').put(entry);
        tx.oncomplete = function(){ res(true); };
        tx.onerror = function(){ rej(tx.error); };
        tx.onabort = function(){ rej(tx.error); };
      } catch(e) { rej(e); }
    });
  });
}
function idbDelete(name){
  return idbOpenDb().then(function(d){
    return new Promise(function(res, rej){
      try {
        var tx = d.transaction('files', 'readwrite');
        tx.objectStore('files').delete(name);
        tx.oncomplete = function(){ res(true); };
        tx.onerror = function(){ rej(tx.error); };
      } catch(e) { rej(e); }
    });
  });
}
function idbClear(){
  return idbOpenDb().then(function(d){
    return new Promise(function(res, rej){
      try {
        var tx = d.transaction('files', 'readwrite');
        tx.objectStore('files').clear();
        tx.oncomplete = function(){ res(true); };
        tx.onerror = function(){ rej(tx.error); };
      } catch(e) { rej(e); }
    });
  });
}
function recentLsRead(){
  try {
    if (typeof localStorage === 'undefined') return [];
    return JSON.parse(localStorage.getItem('db-reader-recent') || '[]');
  } catch(e) { return []; }
}
function recentInit(){
  return idbOpenDb().then(function(d){
    try { d.close(); } catch(e) {}
    recentBackend = 'idb';
    return 'idb';
  }).catch(function(){
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('db-reader-probe', '1');
        localStorage.removeItem('db-reader-probe');
        recentBackend = 'ls';
        return 'ls';
      }
    } catch(e) {}
    recentBackend = 'none';
    return 'none';
  });
}
function recentAll(){
  if (recentBackend === 'idb') return idbAll().then(function(list){
    return list.sort(function(a, b){ return b.ts - a.ts; });
  }).catch(function(){ return []; });
  if (recentBackend === 'ls') return Promise.resolve(recentLsRead());
  return Promise.resolve([]);
}
function recentPut(meta, buf){
  return Promise.resolve().then(function(){
    if (recentBackend === 'idb') {
      var entry = { name: meta.name, size: meta.size, ts: meta.ts, tables: meta.tables || 0, cached: false, blob: null };
      if (buf && meta.size <= RECENT_BLOB_LIMIT) { entry.cached = true; entry.blob = buf; }
      return idbPut(entry).catch(function(){
        entry.cached = false; entry.blob = null;
        return idbPut(entry);
      }).then(function(){
        return idbAll().then(function(list){
          list.sort(function(a, b){ return b.ts - a.ts; });
          return Promise.all(list.slice(RECENT_MAX).map(function(e){ return idbDelete(e.name).catch(function(){}); }));
        }).catch(function(){});
      }).then(function(){ return true; });
    }
    if (recentBackend === 'ls') {
      var arr = recentLsRead().filter(function(e){ return e.name !== meta.name; });
      arr.push({ name: meta.name, size: meta.size, ts: meta.ts, tables: meta.tables || 0, cached: false });
      arr.sort(function(a, b){ return b.ts - a.ts; });
      arr = arr.slice(0, RECENT_MAX);
      try { localStorage.setItem('db-reader-recent', JSON.stringify(arr)); } catch(e) {}
      return true;
    }
    return false;
  }).catch(function(){ return false; });
}
function recentRemove(name){
  if (recentBackend === 'idb') return idbDelete(name).catch(function(){ return false; });
  if (recentBackend === 'ls') {
    try { localStorage.setItem('db-reader-recent', JSON.stringify(recentLsRead().filter(function(e){ return e.name !== name; }))); } catch(e) {}
    return Promise.resolve(true);
  }
  return Promise.resolve(false);
}
function recentClear(){
  if (recentBackend === 'idb') return idbClear().catch(function(){ return false; });
  if (recentBackend === 'ls') {
    try { localStorage.setItem('db-reader-recent', '[]'); } catch(e) {}
    return Promise.resolve(true);
  }
  return Promise.resolve(false);
}
function loadRecent(name){
  return recentAll().then(function(list){
    var e = null;
    list.forEach(function(x){ if (x.name === name) e = x; });
    if (!e || !e.cached || !e.blob) { toastMsg('该文件内容未缓存，请重新拖入打开'); return; }
    showLoading(e.name, e.size || 0);
    return nextTick().then(function(){ return openFromBuffer(e.blob, e.name); });
  }).catch(function(){});
}
function fmtShortTime(ts){
  try {
    var d = new Date(ts), p = function(x){ return String(x).padStart(2, '0'); };
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  } catch(e) { return ''; }
}
function renderRecent(){
  return recentAll().then(function(list){
    var wrap = $('#recentWrap'), box = $('#recentList');
    box.innerHTML = '';
    if (!list.length) { wrap.classList.add('hidden'); return; }
    wrap.classList.remove('hidden');
    list.forEach(function(e){
      var row = document.createElement('div'); row.className = 'rrow';
      var main = document.createElement('div'); main.className = 'rmain';
      var nm = document.createElement('div'); nm.className = 'rname mono'; nm.textContent = e.name; nm.title = e.name;
      var mt = document.createElement('div'); mt.className = 'rmeta';
      mt.textContent = fmtBytes(e.size || 0) + ' · ' + fmtShortTime(e.ts) + (e.tables ? ' · ' + e.tables + ' 张表' : '') + (e.cached ? '' : ' · 未缓存内容');
      main.appendChild(nm); main.appendChild(mt);
      var bOpen = document.createElement('button'); bOpen.className = 'btn sm'; bOpen.textContent = '打开';
      if (e.cached && e.blob) bOpen.onclick = function(){ loadRecent(e.name); };
      else { bOpen.disabled = true; bOpen.title = '文件内容未缓存，请重新拖入'; }
      var bDel = document.createElement('button'); bDel.className = 'iconbtn'; bDel.textContent = '✕'; bDel.title = '从列表移除';
      bDel.onclick = function(){ recentRemove(e.name).then(renderRecent); };
      row.appendChild(main); row.appendChild(bOpen); row.appendChild(bDel);
      box.appendChild(row);
    });
  }).catch(function(){});
}
$('#btnClearRecent').onclick = function(){ recentClear().then(renderRecent); };
recentInit().then(renderRecent);

// ================= 文件打开 =================
function openFile(file){
  if (!engineReady) { toastMsg('SQL 引擎尚未就绪，请稍候'); return; }
  showLoading(file.name, file.size || 0);
  file.arrayBuffer().then(function(buf){
    return openFromBuffer(buf, file.name);
  }, function(e){
    hideLoading();
    toastMsg('无法读取数据库：' + (e && e.message ? e.message : e));
  });
}
function openFromBuffer(buf, name){
  setLoadPhase('解析数据库…');
  return nextTick().then(function(){
    var d;
    try {
      d = new SQL.Database(new Uint8Array(buf));
      setLoadPhase('校验文件结构…');
      try { d.exec('SELECT count(*) FROM sqlite_master'); }
      catch(e2) { d.close(); throw e2; }
    } catch(e) {
      hideLoading();
      toastMsg('无法读取数据库：' + (e && e.message ? e.message : e));
      return null;
    }
    if (db) { try { db.close(); } catch(_) {} }
    db = d; dbBytes = buf; dbName = name;
    selRow = null; selField = null; modalField = null; closeDrawer(); closeSidebar();
    setLoadPhase('读取表结构与行数…');
    return nextTick().then(function(){
      loadSchema();
      $('#emptyState').classList.add('hidden');
      $('#workArea').classList.remove('hidden');
      $('#btnCloseDb').classList.remove('hidden');
      dirty = false;
      $('#btnSaveDb').classList.add('hidden');
      updateDbStatus();
      hideLoading();
      recentPut({ name: name, size: buf.byteLength, ts: Date.now(), tables: tables.length }, buf).then(renderRecent);
      toastMsg('已加载 ' + name + ' · 点击行可查看详情并导出该行 / 字段');
      return true;
    });
  }).catch(function(e){
    hideLoading();
    toastMsg('无法读取数据库：' + (e && e.message ? e.message : e));
  });
}
// ================= 加载进度 =================
function nextTick(){ return new Promise(function(r){ setTimeout(r, 0); }); }
function showLoading(name, size){
  $('#loadName').textContent = name || '';
  $('#loadPhase').textContent = '正在读取文件…';
  $('#loadHint').textContent = size ? (fmtBytes(size) + (size > 8 * 1048576 ? ' · 大文件解析可能需要几秒钟' : '')) : '';
  $('#loadBack').classList.remove('hidden');
}
function setLoadPhase(t){ $('#loadPhase').textContent = t; }
function hideLoading(){ $('#loadBack').classList.add('hidden'); }

// ================= 结构与侧栏 =================
function scalar(sql, params){
  var st = db.prepare(sql);
  try {
    st.bind(params || []);
    if (st.step()) return st.get()[0];
    return null;
  } finally { st.free(); }
}
function loadSchema(){
  tables = [];
  try {
    var res = db.exec("SELECT name,type,sql FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY (type='view'), name COLLATE NOCASE");
    if (res.length) {
      res[0].values.forEach(function(row){
        tables.push({ name: row[0], type: row[1], sql: row[2], count: null });
      });
    }
  } catch(e) { toastMsg('读取结构失败：' + (e && e.message ? e.message : e)); }
  // 过滤 FTS 等虚拟表的影子表
  var virt = tables.filter(function(t){ return t.type === 'table' && /^CREATE\s+VIRTUAL\s+/i.test(t.sql || ''); }).map(function(t){ return t.name; });
  if (virt.length) {
    tables = tables.filter(function(t){
      return !virt.some(function(v){ return t.name !== v && t.name.indexOf(v + '_') === 0; });
    });
  }
  tables.forEach(function(t){
    try { t.count = Number(scalar('SELECT COUNT(*) FROM ' + escId(t.name))) || 0; }
    catch(e) { t.count = null; }
  });
  curTable = null; page = 1; sortCol = null; sortDir = 'ASC'; filterText = '';
  $('#searchInput').value = '';
  renderSidebar();
  curTable = tables.filter(function(t){ return t.type === 'table'; })[0] || tables[0] || null;
  if (curTable) renderTable(); else renderTable();
}
function renderSidebar(){
  var tl = $('#tableList'), vl = $('#viewList');
  tl.innerHTML = ''; vl.innerHTML = '';
  var hasView = false;
  tables.forEach(function(t){
    var li = document.createElement('li');
    var n = document.createElement('span'); n.className = 'tname'; n.textContent = t.name; n.title = t.name;
    var c = document.createElement('span'); c.className = 'tcount'; c.textContent = t.count == null ? '—' : fmtInt(t.count);
    li.appendChild(n); li.appendChild(c);
    li.onclick = function(){ selectTable(t); };
    if (curTable && t.name === curTable.name && t.type === curTable.type) li.classList.add('on');
    if (t.type === 'view') { hasView = true; vl.appendChild(li); } else tl.appendChild(li);
  });
  $('#viewTitle').style.display = hasView ? '' : 'none';
  vl.style.display = hasView ? '' : 'none';
}
function selectTable(t){
  curTable = t; page = 1; sortCol = null; sortDir = 'ASC'; filterText = '';
  $('#searchInput').value = '';
  selRow = null; selField = null; modalField = null; closeDrawer(); closeSidebar();
  renderSidebar(); renderTable();
}

// ================= 列信息 =================
function columnTypes(name){
  var m = {};
  try {
    var r = db.exec('PRAGMA table_info(' + escId(name) + ')');
    if (r.length) {
      var ci = r[0].columns.indexOf('name'), ti = r[0].columns.indexOf('type');
      r[0].values.forEach(function(v){ m[v[ci]] = v[ti] || ''; });
    }
  } catch(e) {}
  return m;
}
function tableColumns(name){
  try {
    var r = db.exec('PRAGMA table_info(' + escId(name) + ')');
    if (!r.length) return [];
    var ci = r[0].columns.indexOf('name');
    return r[0].values.map(function(v){ return v[ci]; });
  } catch(e) { return []; }
}
function isNumType(ty){ return /INT|REAL|FLOA|DOUB|NUM|DEC/.test((ty || '').toUpperCase()); }

// ================= 查询与渲染 =================
function buildWhere(){
  if (!filterText) return { sql: '', params: [] };
  var cols = tableColumns(curTable.name);
  if (!cols.length) return { sql: '', params: [] };
  var parts = cols.map(function(c){ return escId(c) + " LIKE ? ESCAPE '" + BACKSLASH + "'"; });
  var esc = filterText.replace(/[\\%_]/g, function(m){ return BACKSLASH + m; });
  return { sql: ' WHERE ' + parts.join(' OR '), params: ['%' + esc + '%'] };
}
function renderTable(){
  var thead = $('#dataTable thead'), tbody = $('#dataTable tbody');
  var empty = $('#tableMsg');
  thead.innerHTML = ''; tbody.innerHTML = '';
  $('#tblBadge').textContent = curTable ? (curTable.type === 'view' ? '视图' : '表') : '—';
  $('#tblName').textContent = curTable ? curTable.name : '—';
  $('#tblName').title = curTable ? curTable.name : '';
  $('#btnExportTable').disabled = !curTable;
  if (!curTable) {
    empty.textContent = '该数据库没有数据表或视图';
    empty.classList.remove('hidden');
    updatePager(0, 1);
    return;
  }
  var where = buildWhere();
  var order = sortCol ? (' ORDER BY ' + escId(sortCol) + ' ' + (sortDir === 'ASC' ? 'ASC' : 'DESC')) : '';
  var total = 0;
  try { total = Number(scalar('SELECT COUNT(*) FROM ' + escId(curTable.name) + where.sql, where.params)) || 0; } catch(e) {}
  $('#tblCountMeta').textContent = '共 ' + fmtInt(total) + ' 行' + (filterText ? '（筛选后）' : '');
  var pagesNow = Math.max(1, Math.ceil(total / pageSize));
  if (page > pagesNow) page = pagesNow;
  // 可编辑表用 rowid 定位行（视图 / WITHOUT ROWID 表退化为只读）
  var useRid = (curTable.type === 'table');
  editMode = useRid;
  var cols = [], rows = [];
  try {
    var q = 'SELECT ' + (useRid ? 'rowid AS __rid__, ' : '') + '* FROM ' + escId(curTable.name) + where.sql + order + ' LIMIT ? OFFSET ?';
    var st = db.prepare(q);
    st.bind(where.params.concat([pageSize, (page - 1) * pageSize]));
    while (st.step()) rows.push(st.get());
    cols = st.getColumnNames();
    st.free();
  } catch(e) {
    if (useRid) {
      // WITHOUT ROWID 等特殊情况：去掉 rowid 重查，本表转只读
      editMode = false; rows = [];
      try {
        var st2 = db.prepare('SELECT * FROM ' + escId(curTable.name) + where.sql + order + ' LIMIT ? OFFSET ?');
        st2.bind(where.params.concat([pageSize, (page - 1) * pageSize]));
        while (st2.step()) rows.push(st2.get());
        cols = st2.getColumnNames();
        st2.free();
      } catch(e2) { toastMsg('查询失败：' + (e2 && e2.message ? e2.message : e2)); }
    } else toastMsg('查询失败：' + (e && e.message ? e.message : e));
  }
  if (editMode) {
    pageRids = rows.map(function(r){ return r[0]; });
    cols = cols.slice(1);
    rows = rows.map(function(r){ return r.slice(1); });
  } else pageRids = [];
  pageData = { cols: cols, rows: rows, total: total };
  var canEdit = !!(curTable && curTable.type === 'table' && editMode);
  $('#btnAddRow').style.display = canEdit ? '' : 'none';
  $('#btnDelRow').style.display = canEdit ? '' : 'none';
  $('#editHint').textContent = canEdit ? ' · 双击单元格编辑' : '';

  var types = columnTypes(curTable.name);
  var trh = document.createElement('tr');
  var th0 = document.createElement('th'); th0.className = 'rownum-h'; th0.textContent = '#';
  trh.appendChild(th0);
  cols.forEach(function(c){
    var th = document.createElement('th');
    th.textContent = c + (sortCol === c ? (sortDir === 'ASC' ? ' ▲' : ' ▼') : '');
    th.title = '点击按「' + c + '」排序' + (types[c] ? '（' + types[c] + '）' : '');
    if (isNumType(types[c])) th.classList.add('num');
    th.onclick = function(){
      if (sortCol === c) sortDir = (sortDir === 'ASC' ? 'DESC' : 'ASC');
      else { sortCol = c; sortDir = 'ASC'; }
      page = 1; renderTable();
    };
    trh.appendChild(th);
  });
  thead.appendChild(trh);

  if (!rows.length) {
    empty.textContent = filterText ? '没有匹配筛选的行' : '该表暂无数据';
    empty.classList.remove('hidden');
  } else empty.classList.add('hidden');

  rows.forEach(function(r, ri){
    var tr = document.createElement('tr');
    var td0 = document.createElement('td');
    td0.className = 'rownum';
    td0.textContent = fmtInt((page - 1) * pageSize + ri + 1);
    tr.appendChild(td0);
    r.forEach(function(v, ci){
      var td = document.createElement('td');
      fillCell(td, v);
      if (isNumType(types[cols[ci]]) && v !== null && !(v instanceof Uint8Array)) td.classList.add('num');
      td.onclick = function(ev){
        ev.stopPropagation();
        selectRow(ri, tr);
        selectField(cols[ci], v, td);
      };
      if (canEdit) {
        td.ondblclick = (function(_td, _ri, _ci, _v){
          return function(ev){ ev.stopPropagation(); startCellEdit(_td, _ri, _ci, _v); };
        })(td, ri, ci, v);
      }
      tr.appendChild(td);
    });
    tr.onclick = function(){ selectRow(ri, tr); };
    tbody.appendChild(tr);
  });
  updatePager(total, Math.max(1, Math.ceil(total / pageSize)));
}
function fillCell(td, v){
  if (v === null) {
    var s = document.createElement('span'); s.className = 'vnull'; s.textContent = 'NULL';
    td.appendChild(s); td.title = 'NULL';
  } else if (v instanceof Uint8Array) {
    var s2 = document.createElement('span'); s2.className = 'vblob'; s2.textContent = 'BLOB · ' + fmtBytes(v.length);
    td.appendChild(s2); td.title = 'BLOB，' + v.length + ' 字节';
  } else {
    td.textContent = String(v); td.title = String(v);
  }
}
function updatePager(total, pages){
  $('#pageInfo').textContent = '第 ' + page + ' / ' + pages + ' 页 · 共 ' + fmtInt(total) + ' 行';
  $('#btnPrev').disabled = page <= 1;
  $('#btnNext').disabled = page >= pages;
}

// ================= 行 / 字段选择 =================
function selectRow(ri, tr){
  $$('#dataTable tbody tr').forEach(function(x){ x.classList.remove('sel'); });
  if (tr) tr.classList.add('sel');
  selRow = {
    table: curTable.name, type: curTable.type,
    index: (page - 1) * pageSize + ri + 1,
    cols: pageData.cols, values: pageData.rows[ri].slice(),
    rid: pageRids[ri]
  };
  renderDrawer();
}
function selectField(col, v, td){
  $$('td.sel').forEach(function(x){ x.classList.remove('sel'); });
  if (td) td.classList.add('sel');
  selField = { col: col, value: v };
  if (selRow) renderDrawer();
}

// ================= 行详情抽屉 =================
function renderDrawer(){
  if (!selRow) return;
  $('#drawer').classList.remove('hidden');
  $('#drawerSub').textContent = (selRow.type === 'view' ? '视图 ' : '表 ') + selRow.table + ' · 第 ' + fmtInt(selRow.index) + ' 行（当前浏览顺序）';
  $('#btnDelRowDrawer').style.display = (selRow.rid != null) ? '' : 'none';
  var list = $('#fieldList');
  list.innerHTML = '';
  selRow.cols.forEach(function(c, i){
    var v = selRow.values[i];
    var item = document.createElement('div');
    item.className = 'fitem' + (selField && selField.col === c ? ' on' : '');
    var head = document.createElement('div'); head.className = 'fhead';
    var fn = document.createElement('span'); fn.className = 'fname'; fn.textContent = c; fn.title = c;
    var btns = document.createElement('span'); btns.className = 'fbtns';
    var btnC = document.createElement('button'); btnC.className = 'mini'; btnC.textContent = '复制';
    btnC.onclick = function(){ copyFieldValue(c, v); };
    var btn = document.createElement('button'); btn.className = 'mini'; btn.textContent = '导出字段';
    btn.onclick = function(){ openExportModal({ scope: 'field', field: { col: c, value: v } }); };
    btns.appendChild(btnC); btns.appendChild(btn);
    head.appendChild(fn); head.appendChild(btns);
    var val = document.createElement('div'); val.className = 'fval';
    if (v === null) {
      var sn = document.createElement('span'); sn.className = 'vnull'; sn.textContent = 'NULL';
      val.appendChild(sn);
    } else if (v instanceof Uint8Array) {
      var sb = document.createElement('span'); sb.className = 'vblob'; sb.textContent = 'BLOB · ' + fmtBytes(v.length);
      var dim = document.createElement('span'); dim.className = 'fdim'; dim.textContent = '导出时转为 Base64';
      val.appendChild(sb); val.appendChild(dim);
    } else val.textContent = String(v);
    item.appendChild(head); item.appendChild(val);
    list.appendChild(item);
  });
}
function closeDrawer(){ $('#drawer').classList.add('hidden'); }
// ================= 数据库编辑（内存中修改，保存后落盘） =================
function markDirty(){
  if (!dirty) { dirty = true; $('#btnSaveDb').classList.remove('hidden'); }
  updateDbStatus();
}
function updateDbStatus(){
  $('#dbStatus').textContent = dbName + (dirty ? ' · 有未保存修改' : '');
}
function updateCellNow(col, rid, nv){
  db.run('UPDATE ' + escId(curTable.name) + ' SET ' + escId(col) + ' = ? WHERE rowid = ?', [nv, rid]);
  markDirty();
}
function insertRow(){
  try { db.run('INSERT INTO ' + escId(curTable.name) + ' DEFAULT VALUES'); return true; }
  catch(e) {
    try {
      var cols = tableColumns(curTable.name);
      if (!cols.length) throw e;
      db.run('INSERT INTO ' + escId(curTable.name) + ' (' + cols.map(escId).join(', ') + ') VALUES (' + cols.map(function(){ return 'NULL'; }).join(', ') + ')');
      return true;
    } catch(e2) { toastMsg('新增失败：' + (e2 && e2.message ? e2.message : e2)); return false; }
  }
}
function addRow(){
  if (!db || !curTable) { toastMsg('请先打开数据库'); return; }
  if (curTable.type !== 'table' || !editMode) { toastMsg('视图 / 该表结构不支持编辑，请在原表操作'); return; }
  if (!insertRow()) return;
  markDirty();
  selRow = null; selField = null; closeDrawer();
  filterText = ''; $('#searchInput').value = '';
  try { curTable.count = Number(scalar('SELECT COUNT(*) FROM ' + escId(curTable.name))) || 0; } catch(e) {}
  renderSidebar();
  page = Math.max(1, Math.ceil((curTable.count || 1) / pageSize));
  renderTable();
  toastMsg('已新增 1 行（跳到最后一页）· 双击单元格编辑内容');
}
function delRowByRid(rid){
  db.run('DELETE FROM ' + escId(curTable.name) + ' WHERE rowid = ?', [rid]);
  markDirty();
}
var rowConfirmOpen = false, rowConfirmRid = null;
function openRowConfirm(rid){
  if (rowConfirmOpen) return;
  rowConfirmOpen = true; rowConfirmRid = rid;
  $('#rowConfirmBack').classList.remove('hidden');
}
function closeRowConfirm(){
  if (!rowConfirmOpen) return;
  rowConfirmOpen = false;
  $('#rowConfirmBack').classList.add('hidden');
}
function confirmDelRow(){
  var rid = rowConfirmRid;
  closeRowConfirm();
  try {
    delRowByRid(rid);
    selRow = null; selField = null; closeDrawer();
    try { curTable.count = Number(scalar('SELECT COUNT(*) FROM ' + escId(curTable.name))) || 0; } catch(e) {}
    renderSidebar(); renderTable();
    toastMsg('已删除 1 行 · 未保存，记得「保存数据库」');
  } catch(e) { toastMsg('删除失败：' + (e && e.message ? e.message : e)); }
}
function saveDbNow(){
  if (!db) return;
  try {
    var bytes = db.export();
    var name = /\.(db|sqlite3?|db3|s3db|sdb)$/i.test(dbName || '') ? dbName : (dbName || 'database') + '.db';
    saveBlob(new Blob([bytes], { type: 'application/octet-stream' }), name);
    dbBytes = bytes; dirty = false;
    $('#btnSaveDb').classList.add('hidden');
    updateDbStatus();
    recentPut({ name: dbName, size: bytes.length, ts: Date.now(), tables: tables.length }, bytes).then(renderRecent);
    toastMsg('已导出保存（' + name + '）· 用它替换原文件即完成持久化');
  } catch(e) { toastMsg('保存失败：' + (e && e.message ? e.message : e)); }
}
function startCellEdit(td, ri, ci, v){
  if (!editMode || !curTable || curTable.type !== 'table') { toastMsg('视图为只读，请到原表编辑'); return; }
  if (v instanceof Uint8Array) { toastMsg('BLOB 字段暂不支持页面编辑'); return; }
  var rid = pageRids[ri];
  if (rid == null) { toastMsg('该行无法定位（无 rowid），不可编辑'); return; }
  var col = pageData.cols[ci];
  var input = document.createElement('input');
  input.className = 'edit-input';
  input.value = (v === null) ? '' : String(v);
  input.placeholder = 'NULL（清空即设为 NULL）';
  td.textContent = '';
  td.appendChild(input);
  try { input.focus(); input.select(); } catch(e) {}
  var done = false;
  var commit = function(){
    if (done) return; done = true;
    var raw = input.value, nv;
    if (raw === '') nv = null;
    else if (typeof v === 'number' && raw.trim() !== '' && !isNaN(Number(raw))) nv = Number(raw);
    else nv = raw;
    try {
      updateCellNow(col, rid, nv);
      renderTable();
      toastMsg('已更新「' + col + '」· 未保存，记得「保存数据库」');
    } catch(e) { toastMsg('更新失败：' + (e && e.message ? e.message : e)); renderTable(); }
  };
  var cancel = function(){ if (done) return; done = true; renderTable(); };
  input.addEventListener('keydown', function(e){
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    e.stopPropagation();
  });
  input.addEventListener('blur', function(){ commit(); });
  input.addEventListener('click', function(e){ e.stopPropagation(); });
  input.addEventListener('dblclick', function(e){ e.stopPropagation(); });
}
// ================= 字段复制 =================
function copyFieldValue(col, v){
  if (v === null) { toastMsg('「' + col + '」为 NULL，无内容可复制'); return; }
  var isBlob = (v instanceof Uint8Array);
  var text = isBlob ? blobToBase64(v) : String(v);
  copyText(text).then(function(ok){
    toastMsg(ok ? ('已复制「' + col + '」' + (isBlob ? '（Base64）' : '') + (text.length > 40 ? ' · 共 ' + fmtInt(text.length) + ' 字符' : '')) : '复制失败：请长按文本手动复制');
  });
}
function copyText(t){
  return new Promise(function(resolve){
    var done = function(ok){ resolve(!!ok); };
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(t).then(function(){ done(true); }, function(){ done(fallbackCopy(t)); });
        return;
      }
    } catch(e) {}
    done(fallbackCopy(t));
  });
}
function fallbackCopy(t){
  try {
    var ta = document.createElement('textarea');
    ta.value = t;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch(e2) { ok = false; }
    ta.remove();
    return ok;
  } catch(e) { return false; }
}

// ================= 导出内容生成 =================
function plainValue(v){
  if (v === null) return 'NULL';
  if (v instanceof Uint8Array) return blobToBase64(v);
  return applyTextFilter(String(v));
}
function jsonValue(v){
  if (v === null) return null;
  if (v instanceof Uint8Array) return { blob_base64: blobToBase64(v) };
  return v;
}
function sqlLiteral(v){
  if (v === null) return 'NULL';
  if (v instanceof Uint8Array) return "X'" + toHex(v) + "'";
  if (typeof v === 'number') return String(v);
  return "'" + String(v).replace(/'/g, "''") + "'";
}
function csvCell(v){
  if (v === null) return '';
  if (v instanceof Uint8Array) return blobToBase64(v);
  var s = applyTextFilter(String(v));
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function csvRow(arr){ return arr.map(csvCell).join(','); }
function mdCell(v){
  if (v === null) return 'NULL';
  if (v instanceof Uint8Array) return 'BLOB(' + fmtBytes(v.length) + ')';
  return applyTextFilter(String(v)).replace(/\|/g, '\\|').replace(/\r/g, '').replace(/\n/g, '<br>');
}
// ================= 导出过滤 =================
function stripHtmlTags(s){
  return String(s)
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|section|article|blockquote|h[1-6]|li|ul|ol|table|tr|pre)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
function applyTextFilter(s){
  var out = s;
  if (optStripHtml) out = stripHtmlTags(out);
  if (optRegex) {
    try { out = out.replace(new RegExp(optRegex, 'g'), optRepl); } catch(e) {}
  }
  return out;
}
function filterRegexError(){
  if (!optRegex) return null;
  try { new RegExp(optRegex, 'g'); return null; }
  catch(e) { return '正则表达式无效：' + (e && e.message ? e.message : e); }
}
function fetchAll(name, maxRows){
  var st = db.prepare('SELECT * FROM ' + escId(name));
  var cols = st.getColumnNames();
  var rows = [], truncated = false;
  while (true) {
    var has;
    try { has = st.step(); } catch(e) { st.free(); throw e; }
    if (!has) break;
    if (rows.length >= maxRows) { truncated = true; break; }
    rows.push(st.get());
  }
  st.free();
  return { cols: cols, rows: rows, truncated: truncated };
}
function rowRange(){
  var f = Math.floor(Number(rowFrom)); if (!isFinite(f) || f < 0) f = 0;
  var t2 = Math.floor(Number(rowTo)); if (!isFinite(t2) || t2 < 0) t2 = 0;
  if (f === 0 && t2 === 0) return { from: 1, to: 1e9, active: false };
  if (f === 0) f = 1;
  if (t2 === 0) t2 = 1e9;
  if (t2 < f) { var x = f; f = t2; t2 = x; }
  return { from: f, to: t2, active: true };
}
function fetchRange(name, rng, maxRows){
  var effLimit = rng.active ? (rng.to - rng.from + 1) : Infinity;
  var capped = (maxRows == null || maxRows === Infinity) ? Infinity : maxRows;
  var hardCap = Math.min(effLimit, capped);
  var st = db.prepare('SELECT * FROM ' + escId(name) + ' LIMIT ? OFFSET ?');
  st.bind([(hardCap === Infinity) ? -1 : hardCap, rng.active ? (rng.from - 1) : 0]);
  var cols = st.getColumnNames();
  var rows = [], truncated = false;
  while (true) {
    var has;
    try { has = st.step(); } catch(e) { st.free(); throw e; }
    if (!has) break;
    if (rows.length >= hardCap) { if (effLimit > hardCap) truncated = true; break; }
    rows.push(st.get());
  }
  st.free();
  return { cols: cols, rows: rows, truncated: truncated };
}
function insertSql(name, cols, r){
  return 'INSERT INTO ' + escId(name) + ' (' + cols.map(escId).join(', ') + ') VALUES (' + r.map(sqlLiteral).join(', ') + ');';
}
function ensureSemi(sql){
  var s = String(sql).trim();
  return s.charAt(s.length - 1) === ';' ? s : s + ';';
}
function tableExport(t, cols, rows, fmt, truncated, maxRows){
  var head = '# 表: ' + t.name + (t.type === 'view' ? '（视图）' : '') + ' · 共 ' + (t.count == null ? '?' : fmtInt(t.count)) + ' 行';
  var rng = rowRange();
  var rangeNote = rng.active ? '# 行范围: 第 ' + rng.from + ' - ' + (rng.to >= 1e9 ? '末尾' : rng.to) + ' 行（默认顺序）' : '';
  if (fmt === 'txt') {
    if (paraMode) {
      var parts = rows.map(function(r, i){
        var body = cols.map(function(c, j){ return plainValue(r[j]); }).join('\n');
        var tt = (exportTitles && exportTitles[i]) ? exportTitles[i] : '';
        return tt ? (tt + '\n' + body) : body;
      });
      var body2 = parts.join('\n\n\n\n\n');
      if (truncated) body2 += '\n\n……（仅含前 ' + rows.length + ' 行）';
      return body2;
    }
    var L = [head];
    if (rangeNote) L.push(rangeNote);
    L.push('# 列: ' + cols.join(' | '), '# 导出时间: ' + nowStr(), '');
    rows.forEach(function(r, i){
      L.push((i + 1) + ') ' + cols.map(function(c, j){ return c + '=' + plainValue(r[j]); }).join(' | '));
    });
    if (truncated) L.push('……（仅含前 ' + rows.length + ' 行）');
    return L.join('\n');
  }
  if (fmt === 'json') {
    var arr = rows.map(function(r){
      var o = {}; cols.forEach(function(c, j){ o[c] = jsonValue(r[j]); }); return o;
    });
    var o = { table: t.name, type: t.type, create_sql: t.sql, columns: cols, row_count: t.count, exported_at: nowStr(), rows: arr };
    if (rng.active) o.row_range = { from: rng.from, to: (rng.to >= 1e9 ? null : rng.to) };
    if (truncated) o.note = '（仅含前 ' + rows.length + ' 行）';
    return JSON.stringify(o, null, 2);
  }
  if (fmt === 'csv') {
    var L2 = [csvRow(cols)];
    rows.forEach(function(r){ L2.push(csvRow(r)); });
    return L2.join('\r\n');
  }
  if (fmt === 'sql') {
    var L3 = ['-- 表: ' + t.name + ' · ' + (t.count == null ? '?' : fmtInt(t.count)) + ' 行'];
    if (rng.active) L3.push('-- 行范围: 第 ' + rng.from + ' - ' + (rng.to >= 1e9 ? '末尾' : rng.to) + ' 行（默认顺序）');
    L3.push('-- 导出时间: ' + nowStr());
    if (t.sql) L3.push(ensureSemi(t.sql));
    if (t.type === 'table') rows.forEach(function(r){ L3.push(insertSql(t.name, cols, r)); });
    else L3.push('-- 视图不导出插入语句');
    if (truncated) L3.push('-- （仅含前 ' + rows.length + ' 行）');
    return L3.join('\n');
  }
  if (fmt === 'md') {
    var L4 = ['| ' + cols.map(mdCell).join(' | ') + ' |', '| ' + cols.map(function(){ return '---'; }).join(' | ') + ' |'];
    rows.forEach(function(r){ L4.push('| ' + r.map(mdCell).join(' | ') + ' |'); });
    if (truncated) L4.push('', '（仅含前 ' + rows.length + ' 行）');
    return L4.join('\n');
  }
  throw new Error('不支持的格式 ' + fmt);
}
function pickCols(cols){
  if (!colSel) return cols;
  return cols.filter(function(c){ return colSel[c]; });
}
function defaultColSel(cols){
  var m = {};
  (cols || []).forEach(function(c){ m[c] = false; });
  return m;
}
function applyColSel(cols, rows){
  var picked = pickCols(cols);
  if (!picked.length) throw new Error('未选择任何导出字段');
  var idx = picked.map(function(c){ return cols.indexOf(c); });
  var out = rows.map(function(r){ return idx.map(function(i){ return r[i]; }); });
  return { cols: picked, rows: out };
}
function buildExport(scope, fmt, maxRows){
  maxRows = (maxRows == null) ? Infinity : maxRows;
  if (scope === 'field') {
    var f = modalField;
    if (!f) throw new Error('未选择字段');
    var v = f.value;
    if (fmt === 'txt') return plainValue(v);
    if (fmt === 'json') return JSON.stringify({ table: selRow.table, column: f.col, row_index: selRow.index, exported_at: nowStr(), value: jsonValue(v) }, null, 2);
    if (fmt === 'csv') return csvCell(v);
    if (fmt === 'md') return mdCell(v);
    throw new Error('该范围不支持 ' + fmt + ' 格式');
  }
  if (scope === 'row') {
    var s = selRow;
    if (!s) throw new Error('未选择行');
    var ps = applyColSel(s.cols, [s.values]);
    var rcols = ps.cols, rvals = ps.rows[0];
    if (fmt === 'txt') {
      var L = ['# 表: ' + s.table, '# 行: 第 ' + fmtInt(s.index) + ' 行（当前浏览顺序）', '# 导出时间: ' + nowStr(), ''];
      rcols.forEach(function(c, i){ L.push(c + ': ' + plainValue(rvals[i])); });
      return L.join('\n');
    }
    if (fmt === 'json') {
      var o = {};
      rcols.forEach(function(c, i){ o[c] = jsonValue(rvals[i]); });
      return JSON.stringify({ table: s.table, row_index: s.index, exported_at: nowStr(), data: o }, null, 2);
    }
    if (fmt === 'csv') return csvRow(rcols) + '\r\n' + csvRow(rvals);
    if (fmt === 'sql') {
      var L2 = ['-- 表: ' + s.table, '-- 行: 第 ' + fmtInt(s.index) + ' 行', '-- 导出时间: ' + nowStr(), insertSql(s.table, rcols, rvals)];
      return L2.join('\n');
    }
    if (fmt === 'md') {
      var L3 = ['| 字段 | 值 |', '| --- | --- |'];
      rcols.forEach(function(c, i){ L3.push('| ' + mdCell(c) + ' | ' + mdCell(rvals[i]) + ' |'); });
      return L3.join('\n');
    }
    throw new Error('该范围不支持 ' + fmt + ' 格式');
  }
  if (scope === 'table') {
    if (!curTable) throw new Error('未选择表');
    var rngT = rowRange();
    var got = fetchRange(curTable.name, rngT, maxRows);
    var pt = applyColSel(got.cols, got.rows);
    return tableExport(curTable, pt.cols, pt.rows, fmt, got.truncated, maxRows);
  }
  if (scope === 'db') {
    if (fmt === 'db') return { bytes: dirty ? db.export() : dbBytes };
    var objs = [];
    tables.forEach(function(t){
      var g = fetchAll(t.name, maxRows);
      objs.push({ name: t.name, type: t.type, create_sql: t.sql, columns: g.cols, rows: g.rows, truncated: g.truncated });
    });
    if (fmt === 'txt') {
      var L4 = ['# 数据库: ' + dbName, '# 导出时间: ' + nowStr(), '# 对象数: ' + tables.length, ''];
      objs.forEach(function(o, i){
        L4.push('== [' + (i + 1) + '/' + objs.length + '] ' + (o.type === 'view' ? '视图' : '表') + ': ' + o.name + ' ==');
        if (o.create_sql) L4.push('SQL: ' + String(o.create_sql).replace(/\s+/g, ' ').trim());
        L4.push('列: ' + o.columns.join(' | '));
        o.rows.forEach(function(r, j){
          L4.push((j + 1) + ') ' + o.columns.map(function(c, k){ return c + '=' + plainValue(r[k]); }).join(' | '));
        });
        if (o.truncated) L4.push('……（仅含前 ' + o.rows.length + ' 行）');
        L4.push('');
      });
      return L4.join('\n');
    }
    if (fmt === 'json') {
      return JSON.stringify({
        database: dbName, exported_at: nowStr(),
        objects: objs.map(function(o){
          return {
            name: o.name, type: o.type, create_sql: o.create_sql, columns: o.columns,
            truncated: o.truncated || undefined,
            rows: o.rows.map(function(r){
              var x = {}; o.columns.forEach(function(c, k){ x[c] = jsonValue(r[k]); }); return x;
            })
          };
        })
      }, null, 2);
    }
    if (fmt === 'sql') {
      var L5 = ['-- 数据库: ' + dbName, '-- 导出时间: ' + nowStr(), 'BEGIN TRANSACTION;'];
      objs.forEach(function(o){
        if (o.create_sql) L5.push(ensureSemi(o.create_sql));
        if (o.type === 'table') o.rows.forEach(function(r){ L5.push(insertSql(o.name, o.columns, r)); });
      });
      L5.push('COMMIT;');
      return L5.join('\n');
    }
    throw new Error('该范围不支持 ' + fmt + ' 格式');
  }
  throw new Error('未知范围');
}

// ================= 导出弹窗 =================
function baseFileName(){
  var b = safeName(String(dbName || 'database').replace(/\.[^.]*$/, ''));
  return b || 'database';
}
function fileBase(scope){
  if (scope === 'db') return baseFileName();
  if (scope === 'table') {
    var b = baseFileName() + '.' + safeName(curTable.name);
    var rr = rowRange();
    if (rr.active) b += '.r' + rr.from + '-' + (rr.to >= 1e9 ? 'end' : rr.to);
    return b;
  }
  if (scope === 'row') return baseFileName() + '.' + safeName(selRow.table) + '.row' + selRow.index;
  if (scope === 'field') return baseFileName() + '.' + safeName(selRow.table) + '.row' + selRow.index + '.' + safeName(modalField.col);
  return 'export';
}
function sanitizeFileName(s){
  var t = String(s).replace(/[\\\/:*?"<>|\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim();
  t = t.replace(/[.\s]+$/, '');
  if (t.length > 120) t = t.slice(0, 120).replace(/[.\s]+$/, '');
  return t;
}
function currentBase(){
  var v = String($('#expName').value || '').trim();
  if (!v) return fileBase(modalScope);
  var t = sanitizeFileName(v);
  return (!t || /^\.+$/.test(t)) ? fileBase(modalScope) : t;
}
function finalFileName(){
  var ext = '.' + modalFmt;
  var b = currentBase();
  return (b.toLowerCase().slice(-ext.length) === ext) ? b : b + ext;
}
function scopeAvailable(s){
  if (!db) return false;
  if (s === 'db') return true;
  if (s === 'table') return !!curTable;
  if (s === 'row') return !!selRow;
  if (s === 'field') return !!(selRow && modalField);
  return false;
}
function openExportModal(opts){
  opts = opts || {};
  if (!db) { toastMsg('请先打开数据库'); return; }
  if (opts.field) modalField = opts.field;
  else if (selField) modalField = selField;
  if (opts.scope && scopeAvailable(opts.scope)) modalScope = opts.scope;
  else modalScope = selRow ? 'row' : (curTable ? 'table' : 'db');
  if (ALLOWED[modalScope].indexOf(modalFmt) < 0) modalFmt = 'txt';
  nameEdited = false;
  colSel = null;
  resetRangeUI();
  modalOpen = true;
  $('#modalBack').classList.remove('hidden');
  refreshModal();
  if (!isMobile() && matchMedia('(pointer: fine)').matches) { try { $('#expName').focus(); } catch(e) {} }
}
function closeModal(){ modalOpen = false; $('#modalBack').classList.add('hidden'); }
function refreshModal(){
  $$('#scopeSeg button').forEach(function(b){
    var s = b.getAttribute('data-scope');
    b.classList.toggle('on', s === modalScope);
    b.disabled = !scopeAvailable(s);
  });
  var list = ALLOWED[modalScope] || [];
  $$('#fmtSeg button').forEach(function(b){
    var f = b.getAttribute('data-fmt');
    var ok = list.indexOf(f) >= 0;
    b.disabled = !ok;
    b.classList.toggle('on', ok && f === modalFmt);
  });
  // 字段批量选择（当前表 / 当前行范围可用）
  var chipCols = [];
  if (modalScope === 'table' && curTable) chipCols = tableColumns(curTable.name);
  else if (modalScope === 'row' && selRow) chipCols = selRow.cols.slice();
  var chipBox = $('#colChips');
  chipBox.innerHTML = '';
  $('#colSelLabel').style.display = chipCols.length ? '' : 'none';
  chipBox.style.display = chipCols.length ? '' : 'none';
  // 默认全部不勾选（null → 初始化为全 false）
  if (!colSel) colSel = defaultColSel(chipCols);
  chipCols.forEach(function(c){
    var inc = !!colSel[c];
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'colchip' + (inc ? ' on' : ' off');
    b.textContent = c + (inc ? ' ✓' : '');
    b.title = inc ? '已勾选：导出该字段（点击取消勾选）' : '未勾选：不导出该字段（点击勾选）';
    b.onclick = function(){
      if (!colSel) colSel = defaultColSel(chipCols);
      colSel[c] = !colSel[c];
      refreshModal();
    };
    chipBox.appendChild(b);
  });
  var rangeUI = (modalScope === 'table');
  $('#rowRangeLabel').style.display = rangeUI ? '' : 'none';
  $('#rowRangeBox').style.display = rangeUI ? '' : 'none';
  var paraUI = $('#paraRow');
  paraUI.style.display = rangeUI ? '' : 'none';
  paraUI.classList.toggle('off', modalFmt !== 'txt');
  renderTitlePanel();
  if (!nameEdited) {
    $('#expName').value = fileBase(modalScope);
    // 全选文件名（桌面端弹窗打开时；触屏设备不自动 select——防止预选中导致拉起键盘/弹出光标拖拽柄干扰操作）
    if (!isMobile() && window.matchMedia && matchMedia('(pointer: fine)').matches) {
      try { $('#expName').select(); } catch(e) {}
    }
  }
  $('#expName').placeholder = fileBase(modalScope) + '.' + modalFmt;
  $('#expSuf').textContent = '.' + modalFmt;
  var hint = '所有解析与导出均在本地完成';
  if (modalScope === 'db') hint = '整个数据库：包含全部数据表与视图';
  if (modalScope === 'db' && modalFmt === 'db') hint = '原始数据库文件的完整副本（二进制）';
  if (modalScope === 'table' && filterText) hint = '注意：表导出包含全部行，不应用当前筛选';
  if (modalScope === 'row') hint = '导出当前选中的一行（数据快照）';
  if (modalScope === 'field') hint = '导出当前选中的字段' + (modalField ? '：' + modalField.col : '');
  if (modalScope === 'table') {
    var rr2 = rowRange();
    if (rr2.active) hint = '行范围：第 ' + rr2.from + ' - ' + (rr2.to >= 1e9 ? '末尾' : rr2.to) + ' 行 · ' + hint;
  }
  $('#expHint').textContent = hint;
  $('#expNote').textContent = FMT_NOTE[modalFmt] || '';
  var fb = $('#filterBox'), fh = $('#filterHint');
  if (modalFmt === 'json' || modalFmt === 'sql' || modalFmt === 'db') {
    fb.classList.add('off');
    fh.classList.remove('err');
    fh.textContent = '当前格式保留原始数据，不应用过滤';
  } else {
    fb.classList.remove('off');
    var rerr = filterRegexError();
    if (rerr) { fh.classList.add('err'); fh.textContent = rerr; }
    else {
      fh.classList.remove('err');
      var fparts = [];
      if (optStripHtml) fparts.push('HTML 剔除');
      if (optRegex) fparts.push('正则替换');
      fh.textContent = fparts.length ? ('已启用：' + fparts.join(' + ')) : '未启用过滤，导出原始文本';
    }
  }
  $('#btnCopyPreview').disabled = (modalScope === 'db' && modalFmt === 'db');
  $('#expPreview').textContent = buildPreview();
}
function copyFullPreview(){
  try {
    if (modalScope === 'db' && modalFmt === 'db') { toastMsg('二进制文件无法复制，请直接导出下载'); return; }
    var n = 0;
    if (modalScope === 'table' && curTable) n = curTable.count || 0;
    if (modalScope === 'db') n = tables.reduce(function(a, t){ return a + (t.count || 0); }, 0);
    if (n > 100000 && !confirm('数据量较大（约 ' + fmtInt(n) + ' 行），复制可能需要一些时间。继续？')) return;
    var rexErr = filterRegexError();
    if (rexErr && (modalFmt === 'txt' || modalFmt === 'csv' || modalFmt === 'md')) { toastMsg('复制中止：' + rexErr); return; }
    var s = fullExportText();
    copyText(s).then(function(ok){
      toastMsg(ok ? ('已复制完整内容 · 共 ' + fmtInt(s.length) + ' 字符') : '复制失败：请长按预览内容手动复制');
    });
  } catch(e) {
    toastMsg('复制失败：' + (e && e.message ? e.message : e));
  }
}
function fullExportText(){
  var c = buildExport(modalScope, modalFmt, Infinity);
  return (typeof c === 'string') ? c : String(c);
}
function buildPreview(){
  try {
    if (modalScope === 'db' && modalFmt === 'db') return '[二进制数据库文件 · ' + fmtBytes(dbBytes ? dbBytes.byteLength : 0) + ']';
    var c = buildExport(modalScope, modalFmt, 40);
    var s = (typeof c === 'string') ? c : String(c);
    if (s.length > 1600) return s.slice(0, 1600) + '\n……（预览已折叠，完整内容共 ' + fmtInt(s.length) + ' 字符 · 点上方「复制完整内容」可复制）';
    return s;
  } catch(e) {
    return '（无法生成预览：' + (e && e.message ? e.message : e) + '）';
  }
}
function saveBlob(blob, fn){
  var isIOSLike = (typeof navigator !== 'undefined') && (
    /iP(hone|od|ad)/i.test(navigator.userAgent || '') ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
  // iOS 的 Safari/WebView 对 blob 链接的 download 属性支持不可靠（点导出常静默失败）
  // → 苹果系的正确姿势是走系统分享面板，选「存储到文件」即等于下载
  if (isIOSLike && typeof navigator.share === 'function') {
    var file = null;
    try { file = new File([blob], fn, { type: blob.type || 'application/octet-stream' }); } catch(e) { file = null; }
    var shareable = false;
    try { shareable = !!(file && navigator.canShare && navigator.canShare({ files: [file] })); } catch(e) { shareable = false; }
    if (shareable) {
      navigator.share({ files: [file], title: fn }).then(function(){
        toastMsg('已调出系统分享：选择「存储到文件」即可保存');
      }).catch(function(err){
        if (err && err.name === 'AbortError') { toastMsg('已取消分享'); return; }
        legacySave(blob, fn);
      });
      return;
    }
  }
  legacySave(blob, fn);
  if (isIOSLike && typeof navigator.share !== 'function') {
    toastMsg('已尝试直接下载；若无效请长按导出内容选择「存储到文件」，或改用 Safari 打开本页');
  }
}
function legacySave(blob, fn){
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url; a.download = fn;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function(){ URL.revokeObjectURL(url); }, 30000);
}
function doExport(){
  try {
    var fn = finalFileName();
    if (modalFmt === 'txt' || modalFmt === 'csv' || modalFmt === 'md') {
      var rexErr = filterRegexError();
      if (rexErr) { toastMsg('导出中止：' + rexErr); return; }
    }
    if (modalScope === 'db' && modalFmt === 'db') {
      if (!dbBytes) { toastMsg('原始文件数据缺失，无法导出 .db'); return; }
      saveBlob(new Blob([dbBytes], { type: 'application/octet-stream' }), fn);
      toastMsg('已导出 ' + fn);
      closeModal();
      return;
    }
    var n = 0;
    if (modalScope === 'table' && curTable) n = curTable.count || 0;
    if (modalScope === 'db') n = tables.reduce(function(a, t){ return a + (t.count || 0); }, 0);
    if (n > 100000 && !confirm('数据量较大（约 ' + fmtInt(n) + ' 行），导出可能需要一些时间。继续？')) return;
    var c = buildExport(modalScope, modalFmt, Infinity);
    var out = (typeof c === 'string') ? c : '';
    if (modalFmt === 'csv') out = '\ufeff' + out;
    saveBlob(new Blob([out], { type: (MIME[modalFmt] || 'text/plain') + ';charset=utf-8' }), fn);
    toastMsg('已导出 ' + fn);
    closeModal();
  } catch(e) {
    toastMsg('导出失败：' + (e && e.message ? e.message : e));
  }
}

// ================= 事件绑定 =================
$('#btnOpen').onclick = function(){ $('#fileInput').click(); };
$('#fileInput').onchange = function(e){
  var f = e.target.files && e.target.files[0];
  if (f) openFile(f);
  e.target.value = '';
};
$('#dropZone').onclick = function(){ $('#fileInput').click(); };
window.addEventListener('dragover', function(e){ e.preventDefault(); $('#dropZone').classList.add('drag'); });
window.addEventListener('dragleave', function(e){ if (!e.relatedTarget) $('#dropZone').classList.remove('drag'); });
window.addEventListener('drop', function(e){
  e.preventDefault();
  $('#dropZone').classList.remove('drag');
  var fs = e.dataTransfer && e.dataTransfer.files;
  if (fs && fs.length) openFile(fs[0]);
});
function closeDbNow(){
  if (db) { try { db.close(); } catch(_) {} db = null; }
  dbBytes = null; dbName = ''; tables = []; curTable = null;
  selRow = null; selField = null; modalField = null;
  dirty = false; colSel = null; pageRids = []; editMode = false;
  rowFrom = 0; rowTo = 0; paraMode = false;
  exportTitles = []; titleFoldOpen = false;
  $('#btnSaveDb').classList.add('hidden');
  closeDrawer(); closeModal(); closeSidebar(); closeConfirm(); closeRowConfirm();
  $('#workArea').classList.add('hidden');
  $('#emptyState').classList.remove('hidden');
  $('#btnCloseDb').classList.add('hidden');
  $('#dbStatus').textContent = 'SQLite 数据库查看器 · 数据仅在本页本地处理';
  renderRecent();
}
var confirmOpen = false;
function openConfirm(){
  if (confirmOpen) return;
  confirmOpen = true;
  $('#confirmDbName').textContent = dbName || '当前数据库';
  $('#confirmWarn').style.display = dirty ? '' : 'none';
  $('#confirmBack').classList.remove('hidden');
}
function closeConfirm(){
  if (!confirmOpen) return;
  confirmOpen = false;
  $('#confirmBack').classList.add('hidden');
}
$('#btnCloseDb').onclick = function(){ openConfirm(); };
$('#btnConfirmCancel').onclick = closeConfirm;
$('#btnConfirmOk').onclick = function(){ closeDbNow(); toastMsg('已关闭数据库'); };
$('#confirmBack').addEventListener('click', function(e){ if (e.target === e.currentTarget) closeConfirm(); });
$('#btnPrev').onclick = function(){ if (page > 1) { page--; renderTable(); } };
$('#btnNext').onclick = function(){ page++; renderTable(); };
$('#pageSizeSel').onchange = function(e){ pageSize = Number(e.target.value) || 50; page = 1; renderTable(); };
var searchTimer = null;
$('#searchInput').addEventListener('input', function(e){
  clearTimeout(searchTimer);
  var v = e.target.value;
  searchTimer = setTimeout(function(){ filterText = v; page = 1; renderTable(); }, 250);
});
$('#btnExportTable').onclick = function(){ openExportModal(curTable ? { scope: 'table' } : {}); };
$('#btnExportRow').onclick = function(){ openExportModal({ scope: 'row' }); };
$('#btnDrawerClose').onclick = closeDrawer;
$('#btnAddRow').onclick = addRow;
$('#btnDelRow').onclick = function(){
  if (selRow && selRow.rid != null) openRowConfirm(selRow.rid);
  else toastMsg('请先点击选择要删除的行');
};
$('#btnDelRowDrawer').onclick = function(){
  if (selRow && selRow.rid != null) openRowConfirm(selRow.rid);
  else toastMsg('该行无法定位，不可删除');
};
$('#btnSaveDb').onclick = saveDbNow;
$('#btnRowConfirmCancel').onclick = closeRowConfirm;
$('#btnRowConfirmOk').onclick = confirmDelRow;
$('#rowConfirmBack').addEventListener('click', function(e){ if (e.target === e.currentTarget) closeRowConfirm(); });
$$('#scopeSeg button').forEach(function(b){
  b.onclick = function(){
    if (b.disabled) return;
    modalScope = b.getAttribute('data-scope');
    nameEdited = false;
    colSel = null;
    resetRangeUI();
    if (ALLOWED[modalScope].indexOf(modalFmt) < 0) modalFmt = 'txt';
    refreshModal();
  };
});
$$('#fmtSeg button').forEach(function(b){
  b.onclick = function(){
    if (b.disabled) return;
    modalFmt = b.getAttribute('data-fmt');
    refreshModal();
  };
});
$('#btnModalCancel').onclick = closeModal;
$('#btnModalClose').onclick = closeModal;
$('#btnDoExport').onclick = doExport;
$('#btnCopyPreview').onclick = copyFullPreview;
function currentChipCols(){
  if (modalScope === 'table' && curTable) return tableColumns(curTable.name);
  if (modalScope === 'row' && selRow) return selRow.cols.slice();
  return [];
}
// ================= 自定义标题（随导出行数生成） =================
function exportRowCount(){
  if (!curTable) return 0;
  var total = curTable.count || 0;
  var rr = rowRange();
  if (!rr.active) return total;
  var n = (rr.to >= 1e9) ? (total - rr.from + 1) : (rr.to - rr.from + 1);
  return Math.max(0, Math.min(n, total));
}
var TITLE_MAX = 200;
function renderTitlePanel(){
  var show = (modalScope === 'table' && modalFmt === 'txt' && !!curTable);
  var panel = $('#titlePanel');
  panel.style.display = show ? '' : 'none';
  if (!show) return;
  var n = exportRowCount();
  if (exportTitles.length > n) exportTitles.length = n;
  while (exportTitles.length < n) exportTitles.push('');
  var list = $('#titleList');
  list.innerHTML = '';
  if (n === 0) {
    var tip0 = document.createElement('div');
    tip0.className = 'foldhint';
    tip0.textContent = '当前表没有可导出的行。';
    list.appendChild(tip0);
    return;
  }
  if (n > TITLE_MAX) {
    var tip = document.createElement('div');
    tip.className = 'foldhint';
    tip.textContent = '当前导出 ' + fmtInt(n) + ' 行，行数过多（上限 ' + TITLE_MAX + '），未生成标题输入框——请用行范围缩小导出行数。';
    list.appendChild(tip);
    return;
  }
  var rr2 = rowRange();
  for (var i = 0; i < n; i++) {
    var row = document.createElement('div');
    row.className = 'trow';
    var lab = document.createElement('span');
    lab.className = 'tlab';
    lab.textContent = '第 ' + (rr2.active ? rr2.from + i : i + 1) + ' 行';
    var inp = document.createElement('input');
    inp.type = 'text';
    inp.value = exportTitles[i] || '';
    inp.placeholder = '标题（留空不加）';
    inp.spellcheck = false;
    (function(idx){
      inp.addEventListener('input', function(e){
        exportTitles[idx] = e.target.value;
        try { $('#expPreview').textContent = buildPreview(); } catch(_) {}
      });
    })(i);
    row.appendChild(lab);
    row.appendChild(inp);
    list.appendChild(row);
  }
}
$('#btnColAll').onclick = function(){
  var cols = currentChipCols(), m = {};
  cols.forEach(function(c){ m[c] = true; });
  colSel = m;
  refreshModal();
};
$('#btnColNone').onclick = function(){ colSel = defaultColSel(currentChipCols()); refreshModal(); };
function resetRangeUI(){
  rowFrom = 0; rowTo = 0; paraMode = false;
  exportTitles = [];
  titleFoldOpen = false;
  try {
    $('#rowFrom').value = '0'; $('#rowTo').value = '0'; $('#optPara').checked = false;
    $('#titlePanel').classList.remove('open');
    $('#titleArr').textContent = '▸';
    $('#titleBody').classList.add('hidden');
  } catch(e) {}
}
$('#rowFrom').addEventListener('input', function(e){ rowFrom = e.target.value; refreshModal(); });
$('#rowTo').addEventListener('input', function(e){ rowTo = e.target.value; refreshModal(); });
$('#btnRangeReset').onclick = function(){
  rowFrom = 0; rowTo = 0;
  $('#rowFrom').value = '0'; $('#rowTo').value = '0';
  refreshModal();
};
$('#optPara').addEventListener('change', function(e){ paraMode = !!e.target.checked; refreshModal(); });
$('#btnTitleFold').onclick = function(){
  titleFoldOpen = !titleFoldOpen;
  $('#titlePanel').classList.toggle('open', titleFoldOpen);
  $('#titleBody').classList.toggle('hidden', !titleFoldOpen);
};
$('#expName').addEventListener('input', function(){ nameEdited = true; });
$('#expName').addEventListener('focus', function(e){ try { e.target.select(); } catch(_) {} });
// 触屏长按文件名输入框 = 全选（弥补不自动 select 的场景，不弹键盘不抢焦点）
$('#expName').addEventListener('contextmenu', function(e){
  if (isMobile()) { e.preventDefault(); try { e.target.select(); } catch(_) {} }
});
$('#expName').addEventListener('keydown', function(e){ if (e.key === 'Enter') doExport(); });
$('#btnNameReset').onclick = function(){ nameEdited = false; refreshModal(); };
$('#optStripHtml').addEventListener('change', function(e){ optStripHtml = !!e.target.checked; refreshModal(); });
$('#optRegex').addEventListener('input', function(e){ optRegex = e.target.value; refreshModal(); });
$('#optRegexRepl').addEventListener('input', function(e){ optRepl = e.target.value; refreshModal(); });
$('#modalBack').addEventListener('click', function(e){ if (e.target === e.currentTarget) closeModal(); });
document.addEventListener('keydown', function(e){
  if (e.key === 'Escape') {
    if (modalOpen) closeModal();
    else if (confirmOpen) closeConfirm();
    else if (rowConfirmOpen) closeRowConfirm();
    else if (sideOpen) closeSidebar();
    else closeDrawer();
  }
});
})();

