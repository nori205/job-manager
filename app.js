'use strict';

// ============================================================
// 定数
// ============================================================
const DB_NAME    = 'job-manager-db';
const DB_VERSION = 1;
const STORE_NAME = 'jobs';

// ============================================================
// 状態
// ============================================================
let state = {
  jobs:      [],
  activeTab: 'received',
  editingId: null,
  saveTimer: null,
};

// ============================================================
// IndexedDB
// ============================================================
let _db = null;

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    req.onsuccess = e => { _db = e.target.result; resolve(_db); };
    req.onerror   = e => reject(e.target.error);
  });
}

async function saveToIDB() {
  setSyncDot('saving');
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx    = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.clear();
      state.jobs.forEach(job => store.put(job));
      tx.oncomplete = resolve;
      tx.onerror    = e => reject(e.target.error);
    });
    setSyncDot('saved');
  } catch (err) {
    console.error('IDB save error:', err);
    setSyncDot('error');
    showToast('保存に失敗しました');
  }
}

async function loadFromIDB() {
  try {
    const db = await openDB();
    const jobs = await new Promise((resolve, reject) => {
      const tx    = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req   = store.getAll();
      req.onsuccess = e => resolve(e.target.result || []);
      req.onerror   = e => reject(e.target.error);
    });

    // IndexedDB が空なら localStorage の旧データを移行
    if (jobs.length === 0) {
      try {
        const legacy = JSON.parse(localStorage.getItem('jm-data') || 'null');
        if (legacy && Array.isArray(legacy.jobs) && legacy.jobs.length > 0) {
          return legacy.jobs;
        }
      } catch (_) {}
    }

    return jobs;
  } catch (err) {
    console.error('IDB load error:', err);
    return [];
  }
}

function scheduleSave() {
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => saveToIDB(), 800);
}

// ============================================================
// 同期インジケーター
// ============================================================
function setSyncDot(status) {
  const el = document.getElementById('sync-dot');
  el.className = 'sync-dot ' + status;
  el.title = { saving: '保存中...', saved: '保存済み', error: '保存失敗' }[status] || '';
}

// ============================================================
// CRUD
// ============================================================
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function addJob(job) {
  job.id        = uid();
  job.createdAt = new Date().toISOString();
  state.jobs.push(job);
  scheduleSave();
  renderAll();
}

function updateJob(id, patch) {
  const i = state.jobs.findIndex(j => j.id === id);
  if (i < 0) return;
  state.jobs[i] = { ...state.jobs[i], ...patch, updatedAt: new Date().toISOString() };
  scheduleSave();
  renderAll();
}

function deleteJob(id) {
  state.jobs = state.jobs.filter(j => j.id !== id);
  scheduleSave();
  renderAll();
}

// ============================================================
// レンダリング
// ============================================================
function renderAll() {
  renderSummary();
  renderList('received');
  renderList('ordered');
}

function renderSummary() {
  ['received', 'ordered'].forEach(type => {
    const filtered = state.jobs.filter(j => j.type === type);
    const total    = filtered.reduce((s, j) => s + (parseFloat(j.amount) || 0), 0);
    document.getElementById(`total-${type}`).textContent = fmtAmount(total);
    document.getElementById(`count-${type}`).textContent = filtered.length + '件';
  });
}

function renderList(type) {
  const listEl  = document.getElementById(`list-${type}`);
  const emptyEl = document.getElementById(`empty-${type}`);
  const jobs    = state.jobs
    .filter(j => j.type === type)
    .sort((a, b) => (b.orderDate || b.createdAt || '').localeCompare(a.orderDate || a.createdAt || ''));

  listEl.querySelectorAll('.job-card').forEach(el => el.remove());

  if (jobs.length === 0) {
    emptyEl.style.display = '';
    return;
  }
  emptyEl.style.display = 'none';
  jobs.forEach(job => listEl.appendChild(makeCard(job)));
}

function makeCard(job) {
  const { label, cls } = jobStatus(job);
  const card = document.createElement('div');
  card.className  = `job-card type-${job.type}`;
  card.dataset.id = job.id;

  const datesHtml = [
    job.orderDate      && `<span class="date-chip"><span class="date-chip-label">${job.type === 'received' ? '受注' : '発注'}</span> ${fmtDate(job.orderDate)}</span>`,
    job.deliveryDate   && `<span class="date-chip"><span class="date-chip-label">受渡</span> ${fmtDate(job.deliveryDate)}</span>`,
    job.completionDate && `<span class="date-chip"><span class="date-chip-label">完了</span> ${fmtDate(job.completionDate)}</span>`,
    job.invoiceDate    && `<span class="date-chip"><span class="date-chip-label">請求</span> ${fmtDate(job.invoiceDate)}</span>`,
    job.transferDate   && `<span class="date-chip"><span class="date-chip-label">入金</span> ${fmtDate(job.transferDate)}</span>`,
  ].filter(Boolean).slice(0, 3).join('');

  card.innerHTML = `
    <div class="card-top">
      <span class="card-content">${esc(job.content)}</span>
      <span class="status-badge ${cls}">${label}</span>
    </div>
    <div class="card-mid">
      <span class="card-amount">${fmtAmount(job.amount)}</span>
      ${job.client ? `<span class="card-client">${esc(job.client)}</span>` : ''}
    </div>
    ${datesHtml ? `<div class="card-dates">${datesHtml}</div>` : ''}
  `;
  card.addEventListener('click', () => openEdit(job.id));
  return card;
}

// ============================================================
// モーダル
// ============================================================
const FIELDS = ['order-date','content','amount','client','start-date','delivery-date','completion-date','invoice-date','transfer-date','notes'];

function formGet(name)    { return document.getElementById(`field-${name}`); }
function formVal(name)    { return formGet(name).value; }
function formSet(name, v) { formGet(name).value = v || ''; }

function openAdd(type) {
  state.editingId = null;
  document.getElementById('modal-title').textContent = type === 'received' ? '受注を追加' : '発注を追加';
  formSet('id',   '');
  formSet('type', type);
  FIELDS.forEach(f => formSet(f, ''));
  document.getElementById('btn-delete').classList.add('hidden');
  showModal('modal-job');
}

function openEdit(id) {
  const job = state.jobs.find(j => j.id === id);
  if (!job) return;
  state.editingId = id;
  document.getElementById('modal-title').textContent = job.type === 'received' ? '受注を編集' : '発注を編集';
  formSet('id',              job.id);
  formSet('type',            job.type);
  formSet('order-date',      job.orderDate);
  formSet('content',         job.content);
  formSet('amount',          job.amount);
  formSet('client',          job.client);
  formSet('start-date',      job.startDate);
  formSet('delivery-date',   job.deliveryDate);
  formSet('completion-date', job.completionDate);
  formSet('invoice-date',    job.invoiceDate);
  formSet('transfer-date',   job.transferDate);
  formSet('notes',           job.notes);
  document.getElementById('btn-delete').classList.remove('hidden');
  showModal('modal-job');
}

function saveJob() {
  const orderDate = formVal('order-date');
  const content   = formVal('content').trim();
  const amount    = formVal('amount');
  if (!orderDate || !content || amount === '') {
    showToast('必須項目を入力してください');
    return;
  }

  const job = {
    type:           formVal('type'),
    orderDate,
    content,
    amount:         parseFloat(amount) || 0,
    client:         formVal('client').trim(),
    startDate:      formVal('start-date'),
    deliveryDate:   formVal('delivery-date'),
    completionDate: formVal('completion-date'),
    invoiceDate:    formVal('invoice-date'),
    transferDate:   formVal('transfer-date'),
    notes:          formVal('notes').trim(),
  };

  if (state.editingId) {
    updateJob(state.editingId, job);
    showToast('更新しました');
  } else {
    addJob(job);
    showToast('追加しました');
  }
  hideModal('modal-job');
}

function showModal(id) {
  document.getElementById(id).classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}
function hideModal(id) {
  document.getElementById(id).classList.add('hidden');
  document.body.style.overflow = '';
}

// ============================================================
// ユーティリティ
// ============================================================
function fmtAmount(v) {
  const n = parseFloat(v) || 0;
  return '¥' + n.toLocaleString('ja-JP');
}

function fmtDate(s) {
  if (!s) return '';
  const [y, m, d] = s.split('-');
  return `${y}/${m}/${d}`;
}

function jobStatus(job) {
  if (job.transferDate)   return { label: '入金済', cls: 'status-paid' };
  if (job.invoiceDate)    return { label: '請求済', cls: 'status-invoiced' };
  if (job.completionDate) return { label: '完了',   cls: 'status-done' };
  if (job.startDate)      return { label: '進行中', cls: 'status-active' };
  return                         { label: '未着手', cls: 'status-pending' };
}

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ============================================================
// エクスポート
// ============================================================
function dateStr() {
  return new Date().toISOString().slice(0, 10).replace(/-/g, '');
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function exportJSON() {
  if (state.jobs.length === 0) { showToast('データがありません'); return; }
  const data = JSON.stringify({ jobs: state.jobs, exportedAt: new Date().toISOString() }, null, 2);
  downloadBlob(new Blob([data], { type: 'application/json' }), `仕事管理_${dateStr()}.json`);
  showToast('JSONを保存しました');
}

function exportCSV() {
  if (state.jobs.length === 0) { showToast('データがありません'); return; }
  const headers = ['種別','仕事内容','取引先','金額','受注/発注日','作業開始日','受渡日','完了日','請求書発行日','振込日','メモ'];
  const rows = state.jobs.map(j => [
    j.type === 'received' ? '受注' : '発注',
    j.content,
    j.client         || '',
    j.amount,
    j.orderDate      || '',
    j.startDate      || '',
    j.deliveryDate   || '',
    j.completionDate || '',
    j.invoiceDate    || '',
    j.transferDate   || '',
    j.notes          || '',
  ]);
  const csv = [headers, ...rows]
    .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    .join('\r\n');
  // BOM付きでExcelが文字化けしないようにする
  downloadBlob(new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' }), `仕事管理_${dateStr()}.csv`);
  showToast('CSVを保存しました');
}

let toastTimer = null;
function showToast(msg, ms = 3000) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
}

// ============================================================
// イベントバインド
// ============================================================
document.addEventListener('DOMContentLoaded', async () => {

  // IndexedDB からデータを読み込んでアプリを起動
  state.jobs = await loadFromIDB();
  renderAll();

  // ── タブ切り替え ──
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      state.activeTab = tab;
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      document.getElementById(`tab-${tab}`).classList.add('active');
    });
  });

  // ── FAB（追加）──
  document.getElementById('btn-add').addEventListener('click', () => {
    openAdd(state.activeTab);
  });

  // ── モーダル操作 ──
  document.getElementById('btn-modal-close').addEventListener('click', () => hideModal('modal-job'));
  document.getElementById('btn-cancel').addEventListener('click', () => hideModal('modal-job'));
  document.getElementById('btn-save').addEventListener('click', saveJob);
  document.getElementById('modal-backdrop').addEventListener('click', () => hideModal('modal-job'));

  // Enterキーで保存（textarea以外）
  document.getElementById('job-form').addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') {
      e.preventDefault();
      saveJob();
    }
  });

  // ── 削除 ──
  document.getElementById('btn-delete').addEventListener('click', () => {
    hideModal('modal-job');
    showModal('modal-confirm');
  });

  document.getElementById('btn-confirm-cancel').addEventListener('click', () => {
    hideModal('modal-confirm');
    if (state.editingId) showModal('modal-job');
  });

  document.getElementById('btn-confirm-ok').addEventListener('click', () => {
    if (state.editingId) {
      deleteJob(state.editingId);
      state.editingId = null;
    }
    hideModal('modal-confirm');
    showToast('削除しました');
  });

  // ── エクスポートメニュー ──
  document.getElementById('btn-menu').addEventListener('click', e => {
    e.stopPropagation();
    document.getElementById('export-menu').classList.toggle('hidden');
  });
  document.addEventListener('click', () => {
    document.getElementById('export-menu')?.classList.add('hidden');
  });
  document.getElementById('btn-export-json').addEventListener('click', () => {
    document.getElementById('export-menu').classList.add('hidden');
    exportJSON();
  });
  document.getElementById('btn-export-csv').addEventListener('click', () => {
    document.getElementById('export-menu').classList.add('hidden');
    exportCSV();
  });

  // ── サービスワーカー登録 ──
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(err => {
      console.warn('SW registration failed:', err);
    });
  }
});
