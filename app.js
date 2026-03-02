'use strict';

// ============================================================
// 定数
// ============================================================
const STORAGE_KEY_CFG  = 'jm-config';
const STORAGE_KEY_DATA = 'jm-data';
const DRIVE_FILE_NAME  = 'job-manager-data.json';
const DRIVE_SCOPE      = 'https://www.googleapis.com/auth/drive.appdata';
const DEFAULT_CLIENT_ID = '546194821391-ueimk8j1r3q510efkg526pgqot7dtn9t.apps.googleusercontent.com';

// ============================================================
// 状態
// ============================================================
let state = {
  jobs:         [],
  user:         null,
  driveFileId:  null,
  activeTab:    'received',
  editingId:    null,
  accessToken:  null,
  saveTimer:    null,
  saving:       false,
};

let tokenClient = null;
let clientId    = '';
let gisReady    = false;   // GIS スクリプトのロード完了フラグ

// ============================================================
// GIS コールバック（onload から呼ばれる）
// ============================================================
window._gisReady = false;
window._tryInit  = function () {
  gisReady = true;
  const cfg = loadConfig();
  if (cfg && cfg.clientId) {
    clientId = cfg.clientId;
    initTokenClient(cfg.clientId);
    // 前回ログイン済みなら自動でサイレントログインを試みる
    if (cfg.wasLoggedIn) login();
  }
  maybeEnableLoginBtn();
};
// スクリプト到着前に DOMContentLoaded が終わっていた場合も対応
if (window._gisReady) window._tryInit();

function initTokenClient(cid) {
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: cid,
    scope: DRIVE_SCOPE,
    callback: handleTokenResponse,
  });
}

function maybeEnableLoginBtn() {
  const btn = document.getElementById('btn-login');
  if (!btn) return;
  btn.disabled = !gisReady;
  document.getElementById('btn-login-text').textContent = gisReady
    ? 'Googleでログイン' : '読み込み中...';
}

// ============================================================
// 認証
// ============================================================
function login() {
  if (!tokenClient) {
    showToast('クライアントIDが設定されていません');
    return;
  }
  // 前回ログイン済み or トークン保持中はサイレント、初回のみ consent
  const cfg = loadConfig();
  const prompt = (state.accessToken || cfg.wasLoggedIn) ? '' : 'consent';
  tokenClient.requestAccessToken({ prompt });
}

async function handleTokenResponse(resp) {
  if (resp.error) {
    // サイレントログイン失敗（interaction_required 等）はトースト不要でログイン画面へ
    const silent = ['interaction_required', 'access_denied', 'immediate_failed'];
    if (!silent.includes(resp.error)) {
      showToast('ログイン失敗: ' + resp.error);
    }
    showScreen('screen-login');
    return;
  }
  state.accessToken = resp.access_token;

  // ログイン状態を保存（次回自動ログインに使用）
  const cfg = loadConfig();
  saveConfig({ ...cfg, wasLoggedIn: true });

  // expires_in 秒前にサイレントリフレッシュを予約
  const expSec = parseInt(resp.expires_in || '3600', 10);
  setTimeout(() => tokenClient.requestAccessToken({ prompt: '' }), (expSec - 60) * 1000);

  try {
    await loadUserInfo();
    await loadFromDrive();
    showScreen('screen-app');
    renderAll();
    showToast('ログインしました');
  } catch (err) {
    console.error(err);
    showToast('データの読み込みに失敗しました');
  }
}

async function loadUserInfo() {
  const resp = await driveApi('GET', 'about?fields=user');
  if (!resp.ok) return;
  const data = await resp.json();
  state.user = data.user;
  const avatar = document.getElementById('user-avatar');
  const nameEl = document.getElementById('user-name');
  const emailEl = document.getElementById('user-email');
  if (state.user.photoLink) avatar.src = state.user.photoLink;
  if (nameEl)  nameEl.textContent  = state.user.displayName  || '';
  if (emailEl) emailEl.textContent = state.user.emailAddress || '';
}

function logout() {
  google.accounts.oauth2.revoke(state.accessToken, () => {});
  // 自動ログインフラグをクリア
  const cfg = loadConfig();
  saveConfig({ ...cfg, wasLoggedIn: false });
  Object.assign(state, {
    jobs: [], user: null, driveFileId: null, accessToken: null, editingId: null,
  });
  showScreen('screen-login');
  showToast('ログアウトしました');
}

// ============================================================
// Google Drive API（fetch ベース）
// ============================================================
async function driveApi(method, path, body = null, contentType = null) {
  const url = `https://www.googleapis.com/drive/v3/${path}`;
  const headers = { Authorization: `Bearer ${state.accessToken}` };
  if (contentType) headers['Content-Type'] = contentType;
  const opts = { method, headers };
  if (body !== null) opts.body = body;
  const resp = await fetch(url, opts);
  if (resp.status === 401) {
    // トークン期限切れ → サイレントリフレッシュして1回リトライ
    await new Promise(resolve => {
      const orig = tokenClient.callback;
      tokenClient.callback = r => {
        if (!r.error) state.accessToken = r.access_token;
        tokenClient.callback = orig;
        resolve();
      };
      tokenClient.requestAccessToken({ prompt: '' });
    });
    return fetch(url, { method, headers: { ...headers, Authorization: `Bearer ${state.accessToken}` }, ...( body !== null ? { body } : {}) });
  }
  return resp;
}

async function loadFromDrive() {
  // appDataFolder 内のファイルを検索
  const resp = await driveApi('GET',
    `files?spaces=appDataFolder&q=name='${DRIVE_FILE_NAME}'&fields=files(id)&orderBy=createdTime desc`);
  if (!resp.ok) { loadFromLocal(); return; }
  const result = await resp.json();

  if (result.files && result.files.length > 0) {
    state.driveFileId = result.files[0].id;
    const mediaResp = await driveApi('GET', `files/${state.driveFileId}?alt=media`);
    if (mediaResp.ok) {
      const data = await mediaResp.json();
      state.jobs = Array.isArray(data.jobs) ? data.jobs : [];
      saveToLocal();
      return;
    }
  }
  // ファイルが存在しない場合はローカルから復元してDriveに新規作成
  loadFromLocal();
  await saveToDrive(true);
}

async function saveToDrive(force = false) {
  if (state.saving && !force) return;
  if (!state.accessToken) return;
  state.saving = true;
  setSyncDot('saving');

  const payload = JSON.stringify({ jobs: state.jobs, savedAt: new Date().toISOString() });

  try {
    if (state.driveFileId) {
      // 既存ファイルのメディアのみ更新
      const r = await fetch(
        `https://www.googleapis.com/upload/drive/v3/files/${state.driveFileId}?uploadType=media`,
        {
          method: 'PATCH',
          headers: {
            Authorization:   `Bearer ${state.accessToken}`,
            'Content-Type':  'application/json',
          },
          body: payload,
        }
      );
      if (!r.ok) throw new Error('Update failed: ' + r.status);
    } else {
      // マルチパートで新規作成
      const boundary = 'jm_boundary_' + Date.now();
      const meta = JSON.stringify({ name: DRIVE_FILE_NAME, parents: ['appDataFolder'] });
      const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${payload}\r\n--${boundary}--`;
      const r = await fetch(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
        {
          method: 'POST',
          headers: {
            Authorization:   `Bearer ${state.accessToken}`,
            'Content-Type':  `multipart/related; boundary="${boundary}"`,
          },
          body,
        }
      );
      if (!r.ok) throw new Error('Create failed: ' + r.status);
      const data = await r.json();
      state.driveFileId = data.id;
    }
    saveToLocal();
    setSyncDot('saved');
  } catch (err) {
    console.error('Drive save error:', err);
    setSyncDot('error');
    showToast('Driveへの保存に失敗（オフライン？）');
  } finally {
    state.saving = false;
  }
}

function scheduleSave() {
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => saveToDrive(), 1500);
}

// ============================================================
// ローカルストレージ
// ============================================================
function saveToLocal() {
  try {
    localStorage.setItem(STORAGE_KEY_DATA, JSON.stringify({ jobs: state.jobs }));
  } catch (_) {}
}
function loadFromLocal() {
  try {
    const s = localStorage.getItem(STORAGE_KEY_DATA);
    if (s) state.jobs = JSON.parse(s).jobs || [];
  } catch (_) {}
}

// ============================================================
// 設定（OAuth クライアントID）
// ============================================================
function loadConfig() {
  try {
    const cfg = JSON.parse(localStorage.getItem(STORAGE_KEY_CFG) || 'null');
    if (cfg && cfg.clientId) return cfg;
    return { clientId: DEFAULT_CLIENT_ID };
  } catch (_) { return { clientId: DEFAULT_CLIENT_ID }; }
}
function saveConfig(cfg) {
  localStorage.setItem(STORAGE_KEY_CFG, JSON.stringify(cfg));
}

// ============================================================
// 画面切り替え
// ============================================================
function showScreen(id) {
  ['screen-setup', 'screen-login', 'screen-app'].forEach(s => {
    document.getElementById(s).classList.toggle('hidden', s !== id);
  });
}

// ============================================================
// 同期インジケーター
// ============================================================
function setSyncDot(status) {
  const el = document.getElementById('sync-dot');
  el.className = 'sync-dot ' + status;
  el.title = { saving: '同期中...', saved: '同期済み', error: '保存失敗' }[status] || '';
}

// ============================================================
// CRUD
// ============================================================
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function addJob(job) {
  job.id = uid();
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
    const total = filtered.reduce((s, j) => s + (parseFloat(j.amount) || 0), 0);
    document.getElementById(`total-${type}`).textContent  = fmtAmount(total);
    document.getElementById(`count-${type}`).textContent  = filtered.length + '件';
  });
}

function renderList(type) {
  const listEl  = document.getElementById(`list-${type}`);
  const emptyEl = document.getElementById(`empty-${type}`);
  const jobs = state.jobs
    .filter(j => j.type === type)
    .sort((a, b) => (b.orderDate || b.createdAt || '').localeCompare(a.orderDate || a.createdAt || ''));

  // カードのみ削除（空状態は残す）
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
  card.className = `job-card type-${job.type}`;
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
  const form = document.getElementById('job-form');
  // 必須チェック
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
document.addEventListener('DOMContentLoaded', () => {

  // ── セットアップ画面 ──
  const cfg = loadConfig();
  if (!cfg || !cfg.clientId) {
    showScreen('screen-setup');
  } else {
    clientId = cfg.clientId;
    showScreen('screen-login');
    // GIS が先に来ていた場合は既に initTokenClient 済み
  }

  document.getElementById('btn-help-toggle').addEventListener('click', () => {
    document.getElementById('setup-help').classList.toggle('hidden');
  });

  document.getElementById('btn-save-config').addEventListener('click', () => {
    const cid = document.getElementById('input-client-id').value.trim();
    if (!cid.includes('.apps.googleusercontent.com')) {
      showToast('正しいクライアントIDを入力してください');
      return;
    }
    saveConfig({ clientId: cid });
    clientId = cid;
    if (gisReady) initTokenClient(cid);
    showScreen('screen-login');
    maybeEnableLoginBtn();
    showToast('設定を保存しました');
  });

  // ── ログイン画面 ──
  document.getElementById('btn-login').addEventListener('click', login);
  document.getElementById('btn-change-config').addEventListener('click', () => {
    const cfg = loadConfig();
    if (cfg) document.getElementById('input-client-id').value = cfg.clientId || '';
    showScreen('screen-setup');
  });

  // ── アプリ画面：アバターメニュー ──
  document.getElementById('avatar-wrap').addEventListener('click', e => {
    e.stopPropagation();
    document.getElementById('user-menu').classList.toggle('hidden');
  });
  document.addEventListener('click', () => {
    document.getElementById('user-menu')?.classList.add('hidden');
  });

  document.getElementById('btn-sync').addEventListener('click', () => {
    document.getElementById('user-menu').classList.add('hidden');
    saveToDrive(true).then(() => showToast('同期しました'));
  });
  document.getElementById('btn-logout').addEventListener('click', logout);

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
    if (state.editingId) showModal('modal-job'); // 編集モーダルに戻る
  });

  document.getElementById('btn-confirm-ok').addEventListener('click', () => {
    if (state.editingId) {
      deleteJob(state.editingId);
      state.editingId = null;
    }
    hideModal('modal-confirm');
    showToast('削除しました');
  });

  // ── サービスワーカー登録 ──
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(err => {
      console.warn('SW registration failed:', err);
    });
  }

  // GIS がすでにロード済みの場合（キャッシュ）
  if (window._gisReady && !gisReady) window._tryInit();
});
