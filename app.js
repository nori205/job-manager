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

  const invoiceNumHtml = job.invoiceNumber
    ? `<span class="date-chip"><span class="date-chip-label">No.</span> ${esc(job.invoiceNumber)}</span>`
    : '';

  card.innerHTML = `
    <div class="card-top">
      <span class="card-content">${esc(job.content)}</span>
      <span class="status-badge ${cls}">${label}</span>
    </div>
    <div class="card-mid">
      <span class="card-amount">${fmtAmount(job.amount)}<span class="card-tax-label">${job.taxType === 'included' ? '税込' : '税抜'}</span></span>
      ${job.client ? `<span class="card-client">${esc(job.client)}</span>` : ''}
    </div>
    ${(datesHtml || invoiceNumHtml) ? `<div class="card-dates">${invoiceNumHtml}${datesHtml}</div>` : ''}
  `;
  card.addEventListener('click', () => openEdit(job.id));
  return card;
}

// ============================================================
// モーダル
// ============================================================
const FIELDS = ['order-date','content','amount','client','invoice-number','start-date','delivery-date','completion-date','invoice-date','transfer-date','notes'];

function formGet(name)    { return document.getElementById(`field-${name}`); }
function formVal(name)    { return formGet(name).value; }
function formSet(name, v) { formGet(name).value = v || ''; }

function getTaxType() {
  return document.getElementById('field-tax-included').checked ? 'included' : 'excluded';
}
function setTaxType(v) {
  const id = (v === 'included') ? 'field-tax-included' : 'field-tax-excluded';
  document.getElementById(id).checked = true;
}

function openAdd(type) {
  state.editingId = null;
  document.getElementById('modal-title').textContent = type === 'received' ? '受注を追加' : '発注を追加';
  formSet('id',   '');
  formSet('type', type);
  FIELDS.forEach(f => formSet(f, ''));
  setTaxType('excluded');
  document.getElementById('btn-delete').classList.add('hidden');
  document.getElementById('btn-invoice').classList.add('hidden');
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
  formSet('invoice-number',  job.invoiceNumber);
  setTaxType(job.taxType);
  formSet('start-date',      job.startDate);
  formSet('delivery-date',   job.deliveryDate);
  formSet('completion-date', job.completionDate);
  formSet('invoice-date',    job.invoiceDate);
  formSet('transfer-date',   job.transferDate);
  formSet('notes',           job.notes);
  document.getElementById('btn-delete').classList.remove('hidden');
  document.getElementById('btn-invoice').classList.remove('hidden');
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
    invoiceNumber:  formVal('invoice-number').trim(),
    taxType:        getTaxType(),
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

function fmtDateJP(s) {
  if (!s) return '';
  const [y, m, d] = s.split('-');
  return `${y}年${m}月${d}日`;
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
  const headers = ['種別','仕事内容','取引先','金額','請求書番号','受注/発注日','作業開始日','受渡日','完了日','請求書発行日','振込日','メモ'];
  const rows = state.jobs.map(j => [
    j.type === 'received' ? '受注' : '発注',
    j.content,
    j.client         || '',
    j.amount,
    j.invoiceNumber  || '',
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
  downloadBlob(new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' }), `仕事管理_${dateStr()}.csv`);
  showToast('CSVを保存しました');
}

// ============================================================
// JSONインポート（バックアップ復元）
// ============================================================
function importJSON() {
  const input = document.getElementById('input-import-json');
  input.value = '';
  input.click();
}

async function handleImportFile(file) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!data.jobs || !Array.isArray(data.jobs)) {
      showToast('有効なJSONファイルではありません');
      return;
    }
    const count = data.jobs.length;
    if (!confirm(`${count}件のデータを復元しますか？\n現在のデータはすべて上書きされます。`)) return;
    state.jobs = data.jobs;
    await saveToIDB();
    renderAll();
    showToast(`${count}件のデータを復元しました`);
  } catch (e) {
    showToast('ファイルの読み込みに失敗しました');
  }
}

// ============================================================
// 自社情報設定
// ============================================================
function loadSettings() {
  try { return JSON.parse(localStorage.getItem('jm-settings') || '{}'); } catch { return {}; }
}

function saveSettings(s) {
  localStorage.setItem('jm-settings', JSON.stringify(s));
}

function openSettings() {
  const s = loadSettings();
  document.getElementById('settings-name').value    = s.myName    || '';
  document.getElementById('settings-address').value = s.myAddress || '';
  document.getElementById('settings-phone').value   = s.myPhone   || '';
  document.getElementById('settings-bank').value    = s.bankInfo  || '';
  showModal('modal-settings');
}

// ============================================================
// 請求書作成
// ============================================================
function readJobFromForm() {
  return {
    type:           formVal('type'),
    orderDate:      formVal('order-date'),
    content:        formVal('content').trim(),
    amount:         parseFloat(formVal('amount')) || 0,
    client:         formVal('client').trim(),
    invoiceNumber:  formVal('invoice-number').trim(),
    startDate:      formVal('start-date'),
    deliveryDate:   formVal('delivery-date'),
    completionDate: formVal('completion-date'),
    invoiceDate:    formVal('invoice-date'),
    transferDate:   formVal('transfer-date'),
    notes:          formVal('notes').trim(),
  };
}

function openInvoice() {
  const job      = readJobFromForm();
  const settings = loadSettings();

  if (!job.content) {
    showToast('仕事内容を入力してください');
    return;
  }

  const html = buildInvoiceHTML(job, settings);
  const win  = window.open('', '_blank', 'width=860,height=1100');
  if (!win) {
    showToast('ポップアップがブロックされました。ブラウザの設定を確認してください。');
    return;
  }
  win.document.write(html);
  win.document.close();
}

function buildInvoiceHTML(job, s) {
  const isIncluded = job.taxType === 'included';
  const tax        = isIncluded
    ? Math.floor(job.amount * 10 / 110)   // 内税（税込金額から逆算）
    : Math.floor(job.amount * 0.1);        // 外税（税抜金額に加算）
  const subtotal   = isIncluded ? job.amount - tax : job.amount;
  const total      = isIncluded ? job.amount : job.amount + tax;
  const issueDate  = job.invoiceDate
    ? fmtDateJP(job.invoiceDate)
    : fmtDateJP(new Date().toISOString().slice(0, 10));
  const dueDate    = job.deliveryDate ? fmtDateJP(job.deliveryDate) : '';

  const senderLines = [
    s.myName    ? esc(s.myName)    : '（会社名 / 氏名未設定）',
    s.myAddress ? esc(s.myAddress) : '',
    s.myPhone   ? `TEL: ${esc(s.myPhone)}` : '',
  ].filter(Boolean).join('<br>');

  const bankHtml = s.bankInfo
    ? esc(s.bankInfo).replace(/\n/g, '<br>')
    : '（振込先未設定）';

  const notesHtml = job.notes
    ? `<div class="inv-notes"><div class="inv-notes-label">備考</div><div>${esc(job.notes).replace(/\n/g, '<br>')}</div></div>`
    : '';

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <title>請求書${job.invoiceNumber ? ' ' + esc(job.invoiceNumber) : ''}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Hiragino Sans', 'Hiragino Kaku Gothic ProN', 'Noto Sans JP', 'Yu Gothic', sans-serif;
      background: #ECEFF1;
      color: #212121;
      font-size: 14px;
      line-height: 1.6;
    }
    .actions {
      background: #1565C0;
      padding: 10px 20px;
      display: flex;
      gap: 10px;
      align-items: center;
      position: sticky;
      top: 0;
      z-index: 10;
    }
    .actions span { color: rgba(255,255,255,0.8); font-size: 13px; margin-right: auto; }
    .actions button {
      padding: 8px 20px;
      border: none;
      border-radius: 6px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
    }
    .btn-print { background: #fff; color: #1565C0; }
    .btn-close { background: rgba(255,255,255,0.2); color: #fff; }
    .page {
      background: #fff;
      width: 210mm;
      min-height: 297mm;
      margin: 24px auto;
      padding: 20mm 18mm;
      box-shadow: 0 4px 24px rgba(0,0,0,0.18);
    }
    .inv-title {
      font-size: 28px;
      font-weight: 700;
      text-align: center;
      letter-spacing: 0.12em;
      margin-bottom: 20px;
      padding-bottom: 12px;
      border-bottom: 2.5px solid #212121;
    }
    .inv-meta {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 28px;
      gap: 20px;
    }
    .inv-to {
      flex: 1;
    }
    .inv-to-name {
      font-size: 18px;
      font-weight: 700;
      border-bottom: 1.5px solid #212121;
      padding-bottom: 4px;
      margin-bottom: 6px;
    }
    .inv-to-label {
      font-size: 12px;
      color: #616161;
    }
    .inv-from {
      text-align: right;
      font-size: 13px;
      line-height: 1.8;
      color: #424242;
      flex-shrink: 0;
    }
    .inv-info-box {
      background: #F5F5F5;
      border: 1px solid #E0E0E0;
      border-radius: 6px;
      padding: 10px 16px;
      margin-bottom: 24px;
      display: flex;
      flex-wrap: wrap;
      gap: 6px 28px;
      font-size: 13px;
    }
    .inv-info-row { display: flex; gap: 8px; }
    .inv-info-label { color: #757575; }
    .inv-total-box {
      background: #E3F2FD;
      border: 1.5px solid #1565C0;
      border-radius: 8px;
      padding: 14px 20px;
      margin-bottom: 24px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .inv-total-label { font-size: 15px; color: #1565C0; font-weight: 600; }
    .inv-total-amount { font-size: 26px; font-weight: 700; color: #1565C0; letter-spacing: -0.01em; }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 12px;
      font-size: 13px;
    }
    th {
      background: #1565C0;
      color: #fff;
      padding: 9px 12px;
      text-align: left;
      font-weight: 600;
    }
    th:last-child, td:last-child { text-align: right; }
    td {
      padding: 10px 12px;
      border-bottom: 1px solid #E0E0E0;
    }
    tr:last-child td { border-bottom: none; }
    tr:nth-child(even) td { background: #FAFAFA; }
    .inv-subtotals {
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 4px;
      margin-bottom: 24px;
      font-size: 13px;
    }
    .inv-subtotal-row { display: flex; gap: 40px; justify-content: flex-end; }
    .inv-subtotal-row.total {
      font-size: 15px;
      font-weight: 700;
      border-top: 1.5px solid #212121;
      padding-top: 6px;
      margin-top: 2px;
    }
    .inv-subtotal-label { color: #616161; }
    .inv-subtotal-val { min-width: 110px; text-align: right; }
    .inv-due {
      margin-bottom: 24px;
      font-size: 13px;
    }
    .inv-due-label { color: #757575; margin-bottom: 2px; }
    .inv-due-val { font-size: 15px; font-weight: 600; }
    .inv-bank {
      background: #F9FBE7;
      border: 1px solid #C5E1A5;
      border-radius: 6px;
      padding: 12px 16px;
      margin-bottom: 16px;
    }
    .inv-bank-label {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.08em;
      color: #558B2F;
      margin-bottom: 6px;
    }
    .inv-bank-val { font-size: 13px; line-height: 1.8; }
    .inv-notes {
      background: #FFF8E1;
      border: 1px solid #FFE082;
      border-radius: 6px;
      padding: 12px 16px;
      font-size: 13px;
      line-height: 1.8;
    }
    .inv-notes-label {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.08em;
      color: #F57F17;
      margin-bottom: 4px;
    }
    @media print {
      body { background: none; }
      .actions { display: none; }
      .page { margin: 0; box-shadow: none; width: 100%; padding: 15mm 12mm; }
    }
  </style>
</head>
<body>
  <div class="actions">
    <span>請求書プレビュー</span>
    <button class="btn-print" onclick="window.print()">印刷する</button>
    <button class="btn-close" onclick="window.close()">閉じる</button>
  </div>
  <div class="page">
    <div class="inv-title">請　求　書</div>

    <div class="inv-meta">
      <div class="inv-to">
        <div class="inv-to-label">請求先</div>
        <div class="inv-to-name">${job.client ? esc(job.client) + '　御中' : '　　　　　　　　御中'}</div>
      </div>
      <div class="inv-from">${senderLines}</div>
    </div>

    <div class="inv-info-box">
      ${job.invoiceNumber ? `<div class="inv-info-row"><span class="inv-info-label">請求書番号</span><span>${esc(job.invoiceNumber)}</span></div>` : ''}
      <div class="inv-info-row"><span class="inv-info-label">発行日</span><span>${issueDate}</span></div>
      ${dueDate ? `<div class="inv-info-row"><span class="inv-info-label">お支払期限</span><span>${dueDate}</span></div>` : ''}
    </div>

    <div class="inv-total-box">
      <span class="inv-total-label">ご請求金額（税込）</span>
      <span class="inv-total-amount">¥${total.toLocaleString('ja-JP')}</span>
    </div>

    <table>
      <thead>
        <tr>
          <th style="width:60%">品目 / 仕事内容</th>
          <th style="width:20%">単価</th>
          <th style="width:20%">金額</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>${esc(job.content)}</td>
          <td style="text-align:right">¥${subtotal.toLocaleString('ja-JP')}</td>
          <td>¥${subtotal.toLocaleString('ja-JP')}</td>
        </tr>
      </tbody>
    </table>

    <div class="inv-subtotals">
      <div class="inv-subtotal-row">
        <span class="inv-subtotal-label">小計</span>
        <span class="inv-subtotal-val">¥${subtotal.toLocaleString('ja-JP')}</span>
      </div>
      <div class="inv-subtotal-row">
        <span class="inv-subtotal-label">消費税（10%）</span>
        <span class="inv-subtotal-val">¥${tax.toLocaleString('ja-JP')}</span>
      </div>
      <div class="inv-subtotal-row total">
        <span class="inv-subtotal-label">合計</span>
        <span class="inv-subtotal-val">¥${total.toLocaleString('ja-JP')}</span>
      </div>
    </div>

    ${dueDate ? `<div class="inv-due"><div class="inv-due-label">お支払期限</div><div class="inv-due-val">${dueDate}</div></div>` : ''}

    <div class="inv-bank">
      <div class="inv-bank-label">振込先</div>
      <div class="inv-bank-val">${bankHtml}</div>
    </div>

    ${notesHtml}
  </div>
</body>
</html>`;
}

// ============================================================
// トースト
// ============================================================
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

  // ── 請求書を作成 ──
  document.getElementById('btn-invoice').addEventListener('click', () => {
    openInvoice();
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

  // ── JSONインポート ──
  document.getElementById('btn-import-json').addEventListener('click', () => {
    document.getElementById('export-menu').classList.add('hidden');
    importJSON();
  });
  document.getElementById('input-import-json').addEventListener('change', e => {
    const file = e.target.files[0];
    if (file) handleImportFile(file);
  });

  // ── 自社情報設定 ──
  document.getElementById('btn-settings').addEventListener('click', () => {
    document.getElementById('export-menu').classList.add('hidden');
    openSettings();
  });
  document.getElementById('btn-settings-close').addEventListener('click', () => hideModal('modal-settings'));
  document.getElementById('settings-backdrop').addEventListener('click', () => hideModal('modal-settings'));
  document.getElementById('btn-settings-cancel').addEventListener('click', () => hideModal('modal-settings'));
  document.getElementById('btn-settings-save').addEventListener('click', () => {
    saveSettings({
      myName:    document.getElementById('settings-name').value.trim(),
      myAddress: document.getElementById('settings-address').value.trim(),
      myPhone:   document.getElementById('settings-phone').value.trim(),
      bankInfo:  document.getElementById('settings-bank').value.trim(),
    });
    hideModal('modal-settings');
    showToast('設定を保存しました');
  });

  // ── サービスワーカー登録 ──
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(err => {
      console.warn('SW registration failed:', err);
    });
  }
});
