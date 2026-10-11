// トレカ・コレクション 本体（画面描画・データ操作・バックアップ）
import { db } from './db.js';
import * as G from './google.js';
import * as P from './parser.js';
import * as AI from './gemini.js';
import { lineChart } from './chart.js';

// ================= 共通ユーティリティ =================

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const num = (v) => { const n = Number(String(v ?? '').replace(/[¥￥,円\s]/g, '')); return Number.isFinite(n) ? n : 0; };
const yen = (n) => (n === null || n === undefined || n === '' || Number.isNaN(Number(n)))
  ? '-' : `${Number(n) < 0 ? '-' : ''}¥${Math.abs(Math.round(Number(n))).toLocaleString('ja-JP')}`;
const signedYen = (n) => (n > 0 ? '+' : '') + yen(n);
const today = () => new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD
const nowIso = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const splitList = (s) => String(s || '').split(/[,、\n]/).map((t) => t.trim()).filter(Boolean);

// 「2025/1/2」「2025-01-02 10:00」などを YYYY-MM-DD に正規化
function normDate(s) {
  const m = String(s || '').match(/(\d{4})[/\-.年](\d{1,2})[/\-.月](\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : '';
}

function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.classList.add('hide'), type === 'error' ? 6000 : 3000);
  setTimeout(() => el.remove(), type === 'error' ? 6600 : 3600);
}

// 非同期処理のエラーをトーストに出す
function guard(fn) {
  return async (...args) => {
    try { return await fn(...args); } catch (e) { console.error(e); toast(e.message || String(e), 'error'); }
  };
}

function download(filename, content, type) {
  const blob = new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function readFileText(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsText(file);
  });
}

// 画像を長辺 max px の JPEG に縮小して dataURL で返す（バックアップの容量対策）
async function resizeImage(file, max = 800) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const s = Math.min(1, max / Math.max(img.width, img.height));
    const cv = document.createElement('canvas');
    cv.width = Math.round(img.width * s);
    cv.height = Math.round(img.height * s);
    cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
    return cv.toDataURL('image/jpeg', 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ================= 設定・状態 =================

const SETTINGS_KEY = 'tcg-collection-settings';
const DEFAULT_SETTINGS = {
  clientId: '',
  geminiKey: '',
  geminiModel: 'gemini-2.5-flash',
  gameName: 'ポケモンカード',
  autoAi: false,
  keywordFilter: true,
  keywords: P.DEFAULT_KEYWORDS.join(', '),
  excludeKeywords: P.DEFAULT_EXCLUDE.join(', '),
  sources: P.DEFAULT_SOURCES,
  scanMax: 200,
  lastScanDate: '',
  autoDrive: true,
  lastDriveBackup: '',
  lastLocalBackup: '',
};

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    return { ...structuredClone(DEFAULT_SETTINGS), ...s };
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings)); } catch { /* 保存不可の環境 */ }
}

const GRADES = ['未鑑定', 'PSA10', 'PSA9', 'PSA8', 'BGS10', 'BGS9.5', 'ARS10', 'CGC10'];
const CONDITIONS = ['美品', '完美品', '目立つ傷なし', '傷あり', 'スリーブ保管', 'ローダー保管'];

const state = {
  settings: loadSettings(),
  cards: [], // 削除済みは { id, deleted:true, updatedAt } の墓標として残す（マージ用）
  sets: [],
  processed: new Set(), // 取込済み・無視したメールID
  view: 'dashboard',
  filters: { q: '', set: '', rarity: '', grade: '', tag: '', sort: 'added-desc', layout: 'grid' },
  wishQ: '',
  candidates: [],
  showAllCandidates: false,
  scanning: false,
  editing: null,
  editingSet: null,
  dirty: false,
  localHandle: null,
  syncing: false,
};

// ================= カードの計算 =================

const live = (status) => state.cards.filter((c) => !c.deleted && (!status || c.status === status));
const qty = (c) => Math.max(1, Math.floor(num(c.quantity)) || 1);
const title = (c) => c.name || c.rawTitle || '(名称未設定)';

function latestPrice(c, at = null) {
  const ps = (c.prices || []).filter((p) => p.date && (!at || p.date <= at)).sort((a, b) => a.date.localeCompare(b.date));
  return ps.length ? num(ps[ps.length - 1].price) : null;
}
// 相場の記録がなければ購入価格を評価額とみなす
const unitValue = (c, at = null) => latestPrice(c, at) ?? num(c.purchasePrice);
const cardValue = (c) => unitValue(c) * qty(c);
const cardCost = (c) => num(c.purchasePrice) * qty(c);
const sum = (arr, f) => arr.reduce((a, x) => a + f(x), 0);

const setKey = (c) => String(c.setCode || c.setName || '').trim().toLowerCase();

function newCard(preset = {}) {
  return {
    id: crypto.randomUUID(),
    status: 'owned',
    name: '', rawTitle: '', rarity: '', setCode: '', setName: '', number: '',
    quantity: 1, condition: '', grade: '未鑑定',
    purchaseDate: today(), purchasePrice: '', shop: '', targetPrice: '',
    mailLink: '', gmailId: '', imageUrl: '', imageData: '',
    prices: [], forecast10y: '', tags: [], memo: '',
    createdAt: nowIso(), updatedAt: nowIso(),
    ...preset,
  };
}

// ================= 永続化 =================

async function saveCard(card) {
  card.updatedAt = nowIso();
  await db.put('cards', card);
  const i = state.cards.findIndex((c) => c.id === card.id);
  if (i >= 0) state.cards[i] = card; else state.cards.push(card);
  markDirty();
}

async function saveCards(cards) {
  const t = nowIso();
  cards.forEach((c) => { c.updatedAt = t; });
  await db.putMany('cards', cards);
  const map = new Map(state.cards.map((c) => [c.id, c]));
  cards.forEach((c) => map.set(c.id, c));
  state.cards = [...map.values()];
  markDirty();
}

async function deleteCard(id) {
  const tomb = { id, deleted: true, updatedAt: nowIso() };
  await db.put('cards', tomb);
  state.cards = state.cards.map((c) => (c.id === id ? tomb : c));
  markDirty();
}

async function saveProcessed() {
  await db.put('meta', { key: 'processedMails', ids: [...state.processed] });
}

// ================= バックアップ（Google Drive / ローカル） =================

function buildBackup() {
  // API キーはバックアップに含めない
  const { geminiKey, ...settings } = state.settings;
  return {
    app: 'tcg-collection',
    version: 1,
    exportedAt: nowIso(),
    cards: state.cards,
    sets: state.sets,
    processedMails: [...state.processed],
    settings,
  };
}

// 更新日時が新しい方を採用してマージ（削除の墓標も同じ扱い）
function mergeById(local, remote) {
  const map = new Map(local.map((x) => [x.id, x]));
  for (const r of remote || []) {
    const l = map.get(r.id);
    if (!l || String(r.updatedAt || '') > String(l.updatedAt || '')) map.set(r.id, r);
  }
  return [...map.values()];
}

async function applyBackup(data, mode) {
  if (!data || data.app !== 'tcg-collection' || !Array.isArray(data.cards)) {
    throw new Error('このアプリのバックアップファイルではありません');
  }
  let cards; let sets;
  if (mode === 'replace') {
    cards = data.cards;
    sets = data.sets || [];
    state.processed = new Set(data.processedMails || []);
    if (data.settings) {
      // API キー・バックアップ日時はこの端末の値を維持する
      const { clientId, geminiKey, lastDriveBackup, lastLocalBackup } = state.settings;
      state.settings = {
        ...structuredClone(DEFAULT_SETTINGS), ...data.settings,
        geminiKey, lastDriveBackup, lastLocalBackup, clientId: clientId || data.settings.clientId || '',
      };
      saveSettings();
    }
  } else {
    cards = mergeById(state.cards, data.cards);
    sets = mergeById(state.sets, data.sets || []);
    (data.processedMails || []).forEach((id) => state.processed.add(id));
  }
  await db.clear('cards');
  await db.putMany('cards', cards);
  await db.clear('sets');
  await db.putMany('sets', sets);
  await saveProcessed();
  state.cards = cards;
  state.sets = sets;
  render();
}

let autoTimer = null;
function markDirty() {
  state.dirty = true;
  updateSyncButton();
  clearTimeout(autoTimer);
  // 変更から数秒後に、許可済みの保存先へ自動保存（ポップアップは出さない）
  autoTimer = setTimeout(() => autoBackup(), 4000);
}

async function autoBackup() {
  if (!state.dirty || state.syncing) return;
  const drive = state.settings.autoDrive && state.settings.clientId && G.hasToken(G.SCOPES.drive);
  const local = state.localHandle && (await state.localHandle.queryPermission?.({ mode: 'readwrite' })) === 'granted';
  if (!drive && !local) return;
  try {
    await syncNow({ interactive: false });
  } catch (e) {
    console.warn('自動バックアップ失敗', e);
  }
}

// 同期ボタン: Drive とローカルファイル（設定済みなら）へ保存
async function syncNow({ interactive = true } = {}) {
  if (state.syncing) return;
  state.syncing = true;
  updateSyncButton();
  const done = [];
  try {
    if (state.settings.clientId && (interactive || G.hasToken(G.SCOPES.drive))) {
      const token = await G.getToken(G.SCOPES.drive, state.settings.clientId);
      await G.driveSave(token, buildBackup());
      state.settings.lastDriveBackup = nowIso();
      done.push('Googleドライブ');
    }
    if (state.localHandle && (await writeLocalFile(interactive))) done.push('ローカルファイル');
    if (done.length) {
      state.dirty = false;
      saveSettings();
      if (interactive) toast(`${done.join('・')}にバックアップしました`, 'ok');
    } else if (interactive) {
      toast('バックアップ先が未設定です。設定画面でGoogle連携かローカルファイルを設定してください', 'error');
      state.view = 'settings';
      render();
    }
  } finally {
    state.syncing = false;
    updateSyncButton();
    if (state.view === 'settings' || state.view === 'dashboard') render();
  }
}

async function restoreFromDrive(mode) {
  const token = await G.getToken(G.SCOPES.drive, state.settings.clientId);
  const res = await G.driveLoad(token);
  if (!res) { toast('Googleドライブにバックアップが見つかりません', 'error'); return; }
  const when = new Date(res.modifiedTime).toLocaleString('ja-JP');
  if (mode === 'replace' && !confirm(`ドライブのバックアップ（${when}）で端末のデータを上書きします。よろしいですか？`)) return;
  await applyBackup(res.data, mode);
  if (mode === 'merge') markDirty(); else { state.dirty = false; updateSyncButton(); }
  toast(`ドライブのバックアップ（${when}）を${mode === 'merge' ? 'マージ' : '復元'}しました`, 'ok');
}

// File System Access API（PC版 Chrome / Edge）で指定したファイルに自動保存
const canPickFile = 'showSaveFilePicker' in window;

async function chooseLocalFile() {
  const handle = await window.showSaveFilePicker({
    suggestedName: G.BACKUP_FILE_NAME,
    types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }],
  });
  state.localHandle = handle;
  await db.put('meta', { key: 'localHandle', handle });
  await writeLocalFile(true);
  toast(`${handle.name} に保存しました。以後、変更時に自動保存されます`, 'ok');
  render();
}

async function writeLocalFile(interactive) {
  const h = state.localHandle;
  if (!h) return false;
  let perm = await h.queryPermission({ mode: 'readwrite' });
  if (perm !== 'granted' && interactive) perm = await h.requestPermission({ mode: 'readwrite' });
  if (perm !== 'granted') return false;
  const w = await h.createWritable();
  await w.write(JSON.stringify(buildBackup()));
  await w.close();
  state.settings.lastLocalBackup = nowIso();
  saveSettings();
  return true;
}

function exportJson() {
  download(`tcg-collection-${today().replace(/-/g, '')}.json`, JSON.stringify(buildBackup(), null, 1), 'application/json');
  state.settings.lastLocalBackup = nowIso();
  saveSettings();
  render();
}

// ================= CSV =================

const CSV_COLUMNS = [
  ['ID', (c) => c.id], ['区分', (c) => (c.status === 'wish' ? 'ほしいもの' : '所持')],
  ['カード名', (c) => c.name], ['商品名', (c) => c.rawTitle], ['レアリティ', (c) => c.rarity],
  ['セットコード', (c) => c.setCode], ['セット名', (c) => c.setName], ['番号', (c) => c.number],
  ['枚数', (c) => qty(c)], ['状態メモ', (c) => c.condition], ['鑑定', (c) => c.grade],
  ['購入日', (c) => c.purchaseDate], ['金額', (c) => c.purchasePrice], ['購入先', (c) => c.shop],
  ['現在価格', (c) => latestPrice(c) ?? ''], ['評価額', (c) => cardValue(c)], ['損益', (c) => cardValue(c) - cardCost(c)],
  ['目標価格', (c) => c.targetPrice], ['10年後予測', (c) => c.forecast10y], ['タグ', (c) => (c.tags || []).join(' ')],
  ['メモ', (c) => c.memo], ['メールリンク', (c) => c.mailLink],
];

function exportCsv() {
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [CSV_COLUMNS.map(([h]) => q(h)).join(',')];
  live().forEach((c) => rows.push(CSV_COLUMNS.map(([, f]) => q(f(c))).join(',')));
  // Excel で文字化けしないよう BOM 付き
  download(`tcg-collection-${today().replace(/-/g, '')}.csv`, '﻿' + rows.join('\r\n'), 'text/csv');
}

function parseCsv(text) {
  const rows = [];
  let row = []; let field = ''; let quoted = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch !== '\r') field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

// スプレッドシート「ポケモンカード購入履歴」の CSV と、このアプリの CSV の両方を読み込む
async function importCsv(file) {
  const rows = parseCsv(await readFileText(file));
  if (rows.length < 2) throw new Error('CSVにデータがありません');
  const head = rows[0].map((h) => h.trim());
  const col = (name) => head.indexOf(name);
  const get = (r, name) => (col(name) >= 0 ? (r[col(name)] ?? '').trim() : '');
  const existingIds = new Set(state.cards.map((c) => c.id));
  const existingLinks = new Set(live().map((c) => c.mailLink).filter(Boolean));
  const cards = [];
  let skipped = 0;
  for (const r of rows.slice(1)) {
    const id = get(r, 'ID');
    const link = get(r, 'メールリンク');
    if ((id && existingIds.has(id)) || (link && existingLinks.has(link))) { skipped++; continue; }
    const formal = P.parseFormalName(get(r, '予測名称'));
    const rawTitle = get(r, '商品名');
    const card = newCard({
      ...(id ? { id } : {}),
      status: get(r, '区分') === 'ほしいもの' ? 'wish' : 'owned',
      rawTitle,
      name: get(r, 'カード名') || formal.name || rawTitle,
      rarity: get(r, 'レアリティ') || formal.rarity,
      setCode: get(r, 'セットコード') || formal.setCode,
      setName: get(r, 'セット名') || formal.setName,
      number: get(r, '番号') || formal.number,
      quantity: num(get(r, '枚数')) || 1,
      condition: get(r, '状態メモ'),
      grade: get(r, '鑑定') || '未鑑定',
      purchaseDate: normDate(get(r, '購入日')),
      purchasePrice: num(get(r, '金額')) || '',
      shop: get(r, '購入先'),
      targetPrice: num(get(r, '目標価格')) || '',
      forecast10y: get(r, '10年後予測'),
      tags: splitList(get(r, 'タグ').replace(/\s+/g, ',')),
      memo: get(r, 'メモ'),
      mailLink: link,
    });
    const cur = num(get(r, '現在価格'));
    if (cur) card.prices.push({ date: today(), price: cur, note: 'CSV取込' });
    if (link) existingLinks.add(link);
    cards.push(card);
  }
  if (cards.length) await saveCards(cards);
  toast(`${cards.length}件を取り込みました${skipped ? `（重複 ${skipped}件はスキップ）` : ''}`, 'ok');
  render();
}

// ================= Gmail 取り込み =================

const CAND_STATUS = {
  candidate: ['候補', 'ok'],
  excluded: ['除外キーワード', 'muted'],
  nomatch: ['キーワード不一致', 'muted'],
  noname: ['商品名を抽出できず', 'warn'],
  aiskip: ['AI判定: 対象外', 'muted'],
  imported: ['取込済み', 'muted'],
};

function threadIdOf(link) {
  const m = String(link || '').match(/#[^/]+\/([A-Za-z0-9]+)/);
  return m ? m[1] : '';
}

function classify(msg, src) {
  const s = state.settings;
  const rawTitle = P.extractItemName(msg.body);
  const price = P.extractPrice(msg.body);
  const mercariId = P.extractMercariId(msg.body);
  const exclude = splitList(s.excludeKeywords);
  const include = splitList(s.keywords);
  // 旧スプレッドシートから CSV 取込したものはメールリンクのスレッドIDで重複判定する
  const knownThreads = new Set(live().map((c) => threadIdOf(c.mailLink)).filter(Boolean));
  let status = 'candidate';
  if (state.processed.has(msg.id) || live().some((c) => c.gmailId === msg.id) || knownThreads.has(msg.threadId)) status = 'imported';
  else if (P.hasKeyword(msg.body, exclude) || (rawTitle && P.hasKeyword(rawTitle, exclude))) status = 'excluded';
  else if (s.keywordFilter && !P.hasKeyword(`${msg.subject} ${msg.body} ${rawTitle || ''}`, include)) status = 'nomatch';
  else if (!rawTitle) status = 'noname';
  return {
    gmailId: msg.id,
    date: msg.date.toLocaleDateString('sv-SE'),
    shop: src.label,
    subject: msg.subject,
    rawTitle: rawTitle || msg.subject,
    price,
    imageUrl: P.mercariImageUrl(mercariId),
    mailLink: msg.link,
    status,
    ai: null,
    aiBusy: false,
    checked: status === 'candidate',
  };
}

async function scanGmail() {
  if (state.scanning) return;
  const s = state.settings;
  const token = await G.getToken(G.SCOPES.gmail, s.clientId);
  const after = $('#scan-after')?.value || '';
  s.lastScanDate = after;
  saveSettings();
  state.scanning = true;
  state.candidates = [];
  const progress = (t) => { const el = $('#scan-progress'); if (el) el.textContent = t; };
  try {
    const list = [];
    const seen = new Set();
    for (const src of s.sources.filter((x) => x.enabled && x.query)) {
      progress(`${src.label} を検索中…`);
      const q = src.query + (after ? ` after:${after.replace(/-/g, '/')}` : '');
      for (const m of await G.gmailSearch(token, q, num(s.scanMax) || 200)) {
        if (!seen.has(m.id)) { seen.add(m.id); list.push({ id: m.id, src }); }
      }
    }
    // 5件ずつ並列で本文を取得
    for (let i = 0; i < list.length; i += 5) {
      progress(`メールを解析中… ${Math.min(i + 5, list.length)} / ${list.length}`);
      const batch = await Promise.all(list.slice(i, i + 5).map(async ({ id, src }) => classify(await G.gmailGet(token, id), src)));
      state.candidates.push(...batch);
    }
    state.candidates.sort((a, b) => b.date.localeCompare(a.date));
    const n = state.candidates.filter((c) => c.status === 'candidate').length;
    progress(`${list.length}件のメールを解析し、新しい候補が ${n}件 見つかりました。`);
    renderScanResults();
    if (s.autoAi && s.geminiKey && n) await aiCandidates(state.candidates.filter((c) => c.checked));
  } finally {
    state.scanning = false;
    renderScanResults();
  }
}

async function aiCandidate(cand) {
  const s = state.settings;
  cand.aiBusy = true;
  renderScanResults();
  try {
    let img = null;
    if (cand.imageUrl) {
      try { img = await AI.urlToBase64(cand.imageUrl); } catch { /* CORS で取得できない場合はテキストのみで判定 */ }
    }
    cand.ai = await AI.identifyCard({
      apiKey: s.geminiKey, model: s.geminiModel, gameName: s.gameName,
      itemName: cand.rawTitle, price: cand.price, date: cand.date,
      imageBase64: img?.base64, mimeType: img?.mimeType,
    });
    if (!cand.ai.isTargetCard) { cand.status = 'aiskip'; cand.checked = false; }
  } finally {
    cand.aiBusy = false;
    renderScanResults();
  }
}

async function aiCandidates(list) {
  if (!state.settings.geminiKey) throw new Error('設定画面で Gemini API キーを入力してください');
  for (const c of list) {
    try { await aiCandidate(c); } catch (e) { toast(`${c.rawTitle}: ${e.message}`, 'error'); }
    await sleep(800); // レート制限対策
  }
}

async function addCandidates() {
  const picked = state.candidates.filter((c) => c.checked && c.status !== 'imported');
  if (!picked.length) { toast('追加するメールを選択してください', 'error'); return; }
  const cards = picked.map((c) => newCard({
    rawTitle: c.rawTitle,
    name: c.ai?.name || c.rawTitle,
    rarity: c.ai?.rarity || '',
    setCode: c.ai?.setCode || '',
    setName: c.ai?.setName || '',
    number: c.ai?.number || '',
    purchaseDate: c.date,
    purchasePrice: c.price || '',
    shop: c.shop,
    mailLink: c.mailLink,
    gmailId: c.gmailId,
    imageUrl: c.imageUrl,
  }));
  await saveCards(cards);
  picked.forEach((c) => { state.processed.add(c.gmailId); c.status = 'imported'; c.checked = false; });
  await saveProcessed();
  toast(`${cards.length}件をコレクションに追加しました`, 'ok');
  renderScanResults();
}

async function ignoreCandidates() {
  const picked = state.candidates.filter((c) => c.checked);
  picked.forEach((c) => { state.processed.add(c.gmailId); c.status = 'imported'; c.checked = false; });
  await saveProcessed();
  markDirty();
  toast(`${picked.length}件を無視しました（次回から表示されません）`);
  renderScanResults();
}

// ================= 画面描画 =================

const NAV = [
  ['dashboard', 'ホーム', '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>'],
  ['collection', 'コレクション', '<rect x="3" y="4" width="7" height="9" rx="1"/><rect x="14" y="4" width="7" height="9" rx="1"/><rect x="3" y="15" width="18" height="5" rx="1"/>'],
  ['sets', 'セット', '<path d="M4 6h16M4 12h16M4 18h10"/>'],
  ['wish', 'ほしいもの', '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>'],
  ['import', '取り込み', '<path d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v3h16v-3"/>'],
  ['settings', '設定', '<circle cx="12" cy="12" r="3"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3M4.9 4.9l2.1 2.1m10 10l2.1 2.1M4.9 19.1l2.1-2.1m10-10l2.1-2.1"/>'],
];

function renderNav() {
  $('#nav').innerHTML = NAV.map(([key, label, icon]) => `
    <button class="nav-btn${state.view === key ? ' on' : ''}" data-action="nav" data-view="${key}" aria-current="${state.view === key ? 'page' : 'false'}">
      <svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg><span>${label}</span>
    </button>`).join('');
}

function updateSyncButton() {
  const b = $('#sync-btn');
  if (!b) return;
  // 一度もバックアップしていない場合も「未バックアップ」扱いにする
  const never = live().length > 0 && !state.settings.lastDriveBackup && !state.settings.lastLocalBackup;
  const pending = state.dirty || never;
  b.classList.toggle('dirty', pending);
  b.disabled = state.syncing;
  b.querySelector('span').textContent = state.syncing ? '保存中…' : pending ? '未バックアップ' : 'バックアップ済';
}

function render() {
  renderNav();
  const main = $('#main');
  const views = { dashboard: viewDashboard, collection: viewCollection, sets: viewSets, wish: viewWish, import: viewImport, settings: viewSettings };
  main.innerHTML = (views[state.view] || viewDashboard)();
  if (state.view === 'dashboard') {
    const el = $('#asset-chart');
    if (el) lineChart(el, assetSeries());
  }
  if (state.view === 'collection') renderResults();
  if (state.view === 'import') renderScanResults();
  updateSyncButton();
}

function tileHtml(c) {
  const img = c.imageData || c.imageUrl;
  const v = cardValue(c);
  const pl = v - cardCost(c);
  const showPl = c.status === 'owned' && num(c.purchasePrice) > 0;
  return `
  <button class="tile" data-action="open-card" data-id="${c.id}">
    <div class="tile-img">
      ${img ? `<img src="${esc(img)}" loading="lazy" referrerpolicy="no-referrer" alt="">` : ''}
      <span class="ph">${esc(title(c).slice(0, 18))}</span>
      ${c.grade && c.grade !== '未鑑定' ? `<span class="badge grade">${esc(c.grade)}</span>` : ''}
      ${qty(c) > 1 ? `<span class="badge qty">×${qty(c)}</span>` : ''}
    </div>
    <div class="tile-body">
      <div class="tile-name">${esc(title(c))}</div>
      <div class="tile-meta">${esc([c.rarity, c.setCode, c.number].filter(Boolean).join(' · ') || ' ')}</div>
      <div class="tile-price"><span>${yen(c.status === 'wish' ? (latestPrice(c) ?? c.targetPrice) : v)}</span>
        ${showPl ? `<span class="${pl >= 0 ? 'up' : 'down'}">${signedYen(pl)}</span>` : ''}</div>
    </div>
  </button>`;
}

function emptyState(msg, actions = '') {
  return `<div class="empty"><p>${msg}</p><div class="row center">${actions}</div></div>`;
}

// ---------- ホーム（資産ダッシュボード） ----------

function assetSeries() {
  const owned = live('owned');
  const dates = new Set([today()]);
  owned.forEach((c) => {
    if (c.purchaseDate) dates.add(c.purchaseDate);
    (c.prices || []).forEach((p) => p.date && dates.add(p.date));
  });
  const value = []; const cost = [];
  for (const d of [...dates].sort()) {
    let v = 0; let k = 0;
    for (const c of owned) {
      if ((c.purchaseDate || '0000') > d) continue;
      v += unitValue(c, d) * qty(c);
      k += cardCost(c);
    }
    const x = new Date(d).getTime();
    value.push({ x, y: v });
    cost.push({ x, y: k });
  }
  return [
    { name: '評価額', color: 'var(--accent)', points: value },
    { name: '取得総額', color: 'var(--line2)', points: cost },
  ];
}

function backupNotice() {
  const s = state.settings;
  const last = [s.lastDriveBackup, s.lastLocalBackup].filter(Boolean).sort().pop();
  const days = last ? Math.floor((Date.now() - new Date(last).getTime()) / 86_400_000) : null;
  if (!live().length || (days !== null && days < 7 && !state.dirty)) return '';
  const msg = last ? `最後のバックアップから${days}日経っています。` : 'まだバックアップがありません。';
  return `<div class="notice">${msg}データはこの端末のブラウザ内にだけ保存されています。
    <button class="btn small" data-action="sync-now">今すぐバックアップ</button></div>`;
}

function viewDashboard() {
  const owned = live('owned');
  if (!owned.length && !live('wish').length) {
    return `<section class="hero">
      <h1>コレクションを始めましょう</h1>
      <p class="muted">手動でカードを登録するか、Gmail の購入メール（メルカリ・Yahoo!・ラクマ・magi・スニダン）から取り込めます。</p>
      <div class="row center">
        <button class="btn primary" data-action="new-card">＋ カードを追加</button>
        <button class="btn" data-action="nav" data-view="import">Gmail / CSV から取り込む</button>
        <button class="btn" data-action="nav" data-view="settings">バックアップから復元</button>
      </div></section>`;
  }
  const cost = sum(owned, cardCost);
  const value = sum(owned, cardValue);
  const pl = value - cost;
  const pct = cost ? (pl / cost) * 100 : 0;
  const top = [...owned].sort((a, b) => cardValue(b) - cardValue(a)).slice(0, 5);
  const gainers = owned.filter((c) => num(c.purchasePrice) > 0 && latestPrice(c) !== null)
    .map((c) => ({ c, r: (unitValue(c) - num(c.purchasePrice)) / num(c.purchasePrice) }))
    .sort((a, b) => b.r - a.r).slice(0, 5);
  const recent = [...owned].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 6);
  const rankRow = (c, right) => `<li><button class="rank-row" data-action="open-card" data-id="${c.id}">
      <span class="rank-name">${esc(title(c))}<small>${esc([c.rarity, c.grade !== '未鑑定' ? c.grade : ''].filter(Boolean).join(' · '))}</small></span>
      <span class="rank-val">${right}</span></button></li>`;
  return `
    ${backupNotice()}
    <section class="stats">
      <div class="stat big"><span class="label">評価額</span><span class="val">${yen(value)}</span>
        <span class="${pl >= 0 ? 'up' : 'down'}">${signedYen(pl)}（${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%）</span></div>
      <div class="stat"><span class="label">取得総額</span><span class="val">${yen(cost)}</span></div>
      <div class="stat"><span class="label">所持枚数</span><span class="val">${sum(owned, qty)}枚</span><span class="muted small">${owned.length}種類</span></div>
      <div class="stat"><span class="label">ほしいもの</span><span class="val">${live('wish').length}件</span></div>
    </section>
    <section class="panel"><h2>資産推移</h2><div id="asset-chart"></div>
      <p class="muted small">評価額は各カードの最新の相場記録（なければ購入価格）× 枚数で計算しています。</p></section>
    <div class="two-col">
      <section class="panel"><h2>評価額トップ5</h2><ol class="rank">${top.map((c) => rankRow(c, yen(cardValue(c)))).join('')}</ol></section>
      <section class="panel"><h2>値上がり率トップ5</h2>${gainers.length
        ? `<ol class="rank">${gainers.map(({ c, r }) => rankRow(c, `<span class="${r >= 0 ? 'up' : 'down'}">${r >= 0 ? '+' : ''}${(r * 100).toFixed(0)}%</span>`)).join('')}</ol>`
        : '<p class="muted small">カード詳細で相場を記録すると表示されます。</p>'}</section>
    </div>
    <section class="panel"><div class="panel-head"><h2>最近追加したカード</h2>
      <button class="link" data-action="nav" data-view="collection">すべて見る</button></div>
      <div class="grid">${recent.map(tileHtml).join('')}</div></section>`;
}

// ---------- コレクション ----------

function filteredCards() {
  const f = state.filters;
  let list = live('owned');
  if (f.q) {
    const q = f.q.toLowerCase();
    list = list.filter((c) => [c.name, c.rawTitle, c.setName, c.setCode, c.number, c.rarity, c.memo, c.grade, (c.tags || []).join(' ')]
      .join(' ').toLowerCase().includes(q));
  }
  if (f.set) list = list.filter((c) => setKey(c) === f.set);
  if (f.rarity) list = list.filter((c) => c.rarity === f.rarity);
  if (f.grade) list = list.filter((c) => (f.grade === 'graded' ? c.grade && c.grade !== '未鑑定' : (c.grade || '未鑑定') === f.grade));
  if (f.tag) list = list.filter((c) => (c.tags || []).includes(f.tag));
  const by = {
    'added-desc': (a, b) => String(b.createdAt).localeCompare(String(a.createdAt)),
    'purchase-desc': (a, b) => String(b.purchaseDate).localeCompare(String(a.purchaseDate)),
    'value-desc': (a, b) => cardValue(b) - cardValue(a),
    'value-asc': (a, b) => cardValue(a) - cardValue(b),
    'profit-desc': (a, b) => (cardValue(b) - cardCost(b)) - (cardValue(a) - cardCost(a)),
    name: (a, b) => title(a).localeCompare(title(b), 'ja'),
    number: (a, b) => setKey(a).localeCompare(setKey(b)) || (P.parseCardNumber(a.number)?.n ?? 9e9) - (P.parseCardNumber(b.number)?.n ?? 9e9),
  };
  return list.sort(by[f.sort] || by['added-desc']);
}

function setOptions() {
  const map = new Map();
  live().forEach((c) => { const k = setKey(c); if (k && !map.has(k)) map.set(k, [c.setCode, c.setName].filter(Boolean).join(' ')); });
  return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1], 'ja'));
}

const opt = (value, label, cur) => `<option value="${esc(value)}"${value === cur ? ' selected' : ''}>${esc(label)}</option>`;

function viewCollection() {
  const f = state.filters;
  const owned = live('owned');
  const rarities = [...new Set(owned.map((c) => c.rarity).filter(Boolean))].sort();
  const tags = [...new Set(owned.flatMap((c) => c.tags || []))].sort();
  const grades = [...new Set(owned.map((c) => c.grade || '未鑑定'))].sort();
  return `
    <div class="toolbar">
      <input type="search" class="grow" placeholder="カード名・セット・タグで検索" value="${esc(f.q)}" data-filter="q" aria-label="検索">
      <select data-filter="set" aria-label="セット">${opt('', 'すべてのセット', f.set)}${setOptions().map(([k, l]) => opt(k, l, f.set)).join('')}</select>
      <select data-filter="rarity" aria-label="レアリティ">${opt('', 'レアリティ', f.rarity)}${rarities.map((r) => opt(r, r, f.rarity)).join('')}</select>
      <select data-filter="grade" aria-label="鑑定">${opt('', '鑑定', f.grade)}${opt('graded', '鑑定済みすべて', f.grade)}${grades.map((g) => opt(g, g, f.grade)).join('')}</select>
      ${tags.length ? `<select data-filter="tag" aria-label="タグ">${opt('', 'タグ', f.tag)}${tags.map((t) => opt(t, `#${t}`, f.tag)).join('')}</select>` : ''}
      <select data-filter="sort" aria-label="並び替え">
        ${[['added-desc', '登録が新しい順'], ['purchase-desc', '購入日が新しい順'], ['value-desc', '評価額が高い順'], ['value-asc', '評価額が低い順'],
          ['profit-desc', '損益が大きい順'], ['name', '名前順'], ['number', 'セット・番号順']].map(([v, l]) => opt(v, l, f.sort)).join('')}
      </select>
      <div class="seg" role="group" aria-label="表示切替">
        <button class="${f.layout === 'grid' ? 'on' : ''}" data-action="layout" data-layout="grid">グリッド</button>
        <button class="${f.layout === 'list' ? 'on' : ''}" data-action="layout" data-layout="list">リスト</button>
      </div>
      <button class="btn primary" data-action="new-card">＋ 追加</button>
    </div>
    <div id="results"></div>`;
}

function renderResults() {
  const el = $('#results');
  if (!el) return;
  const list = filteredCards();
  const value = sum(list, cardValue);
  const pl = value - sum(list, cardCost);
  const summary = `<p class="muted small">${list.length}種類 / ${sum(list, qty)}枚 ・ 評価額 ${yen(value)}（<span class="${pl >= 0 ? 'up' : 'down'}">${signedYen(pl)}</span>）</p>`;
  if (!list.length) {
    el.innerHTML = live('owned').length
      ? emptyState('条件に一致するカードがありません。', '<button class="btn" data-action="clear-filters">絞り込みを解除</button>')
      : emptyState('まだカードがありません。', '<button class="btn primary" data-action="new-card">＋ カードを追加</button><button class="btn" data-action="nav" data-view="import">取り込む</button>');
    return;
  }
  if (state.filters.layout === 'list') {
    el.innerHTML = summary + `<div class="table-wrap"><table class="table">
      <thead><tr><th></th><th>カード</th><th>セット / 番号</th><th>鑑定</th><th class="r">枚数</th><th class="r">取得</th><th class="r">評価額</th><th class="r">損益</th></tr></thead>
      <tbody>${list.map((c) => {
        const img = c.imageData || c.imageUrl;
        const pl2 = cardValue(c) - cardCost(c);
        return `<tr data-action="open-card" data-id="${c.id}" tabindex="0">
          <td><span class="thumb">${img ? `<img src="${esc(img)}" loading="lazy" referrerpolicy="no-referrer" alt="">` : ''}</span></td>
          <td><strong>${esc(title(c))}</strong><br><span class="muted small">${esc(c.rarity)}</span></td>
          <td class="small">${esc([c.setCode, c.setName].filter(Boolean).join(' '))}<br>${esc(c.number)}</td>
          <td>${esc(c.grade !== '未鑑定' ? c.grade : '')}</td>
          <td class="r">${qty(c)}</td><td class="r">${yen(cardCost(c))}</td><td class="r">${yen(cardValue(c))}</td>
          <td class="r ${pl2 >= 0 ? 'up' : 'down'}">${signedYen(pl2)}</td></tr>`;
      }).join('')}</tbody></table></div>`;
  } else {
    el.innerHTML = summary + `<div class="grid">${list.map(tileHtml).join('')}</div>`;
  }
}

// ---------- セット（コンプ率） ----------

function setStats() {
  const groups = new Map();
  for (const c of live('owned')) {
    const k = setKey(c);
    if (!k) continue;
    if (!groups.has(k)) groups.set(k, { key: k, code: c.setCode, name: c.setName, cards: [] });
    const g = groups.get(k);
    g.code ||= c.setCode;
    g.name ||= c.setName;
    g.cards.push(c);
  }
  // マスタに登録されたセット（カード未所持でも表示）
  for (const m of state.sets.filter((x) => !x.deleted)) {
    const k = String(m.code || m.name).trim().toLowerCase();
    const g = groups.get(k) || { key: k, code: m.code, name: m.name, cards: [] };
    g.master = m;
    g.code = m.code || g.code;
    g.name = m.name || g.name;
    groups.set(k, g);
  }
  return [...groups.values()].map((g) => {
    const nums = g.cards.map((c) => P.parseCardNumber(c.number)).filter(Boolean);
    // 総数: マスタ > カード番号の分母で最も多いもの
    const denoms = nums.map((n) => n.total).filter(Boolean);
    const mode = denoms.sort((a, b) => denoms.filter((v) => v === b).length - denoms.filter((v) => v === a).length)[0];
    const total = num(g.master?.total) || mode || 0;
    const distinct = new Set(nums.map((n) => n.n));
    const base = total ? [...distinct].filter((n) => n <= total).length : distinct.size;
    const secret = total ? [...distinct].filter((n) => n > total).length : 0;
    return { ...g, total, base, secret, value: sum(g.cards, cardValue), qty: sum(g.cards, qty) };
  }).sort((a, b) => String(b.master?.releaseDate || '').localeCompare(String(a.master?.releaseDate || '')) || b.value - a.value);
}

function viewSets() {
  const stats = setStats();
  return `
    <div class="panel-head"><h1>セット別コンプリート</h1><button class="btn primary" data-action="new-set">＋ セットを登録</button></div>
    <p class="muted small">カードの「セットコード / セット名」と「番号（例: 198/190）」から自動集計します。分母を超える番号（SR・SAR など）はシークレットとして別カウントします。</p>
    ${stats.length ? `<div class="set-list">${stats.map((g) => {
      const pct = g.total ? Math.min(100, (g.base / g.total) * 100) : 0;
      return `<div class="set-row">
        <button class="set-main" data-action="filter-set" data-key="${esc(g.key)}">
          <span class="set-title"><span class="code">${esc(g.code || '')}</span> ${esc(g.name || '')}</span>
          <span class="bar"><i style="width:${pct}%"></i></span>
          <span class="set-nums">${g.total ? `${g.base} / ${g.total}（${pct.toFixed(0)}%）` : `${g.base}種`}${g.secret ? ` ＋シークレット ${g.secret}` : ''}
            ・ ${g.qty}枚 ・ ${yen(g.value)}</span>
        </button>
        <button class="btn small ghost" data-action="edit-set" data-key="${esc(g.key)}">編集</button>
      </div>`;
    }).join('')}</div>` : emptyState('セット情報のあるカードがまだありません。カードにセットコードと番号を入れるか、AIでカード判定するとここに表示されます。')}`;
}

// ---------- ほしいもの ----------

function viewWish() {
  const q = state.wishQ.toLowerCase();
  const list = live('wish').filter((c) => !q || `${c.name} ${c.rawTitle} ${c.setName} ${c.rarity}`.toLowerCase().includes(q))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return `
    <div class="toolbar">
      <input type="search" class="grow" placeholder="ほしいものを検索" value="${esc(state.wishQ)}" data-filter="wishQ" aria-label="検索">
      <button class="btn primary" data-action="new-card" data-status="wish">＋ ほしいものを追加</button>
    </div>
    ${list.length ? `<div class="wish-list">${list.map((c) => {
      const cur = latestPrice(c);
      const target = num(c.targetPrice);
      const hit = cur !== null && target > 0 && cur <= target;
      const img = c.imageData || c.imageUrl;
      return `<div class="wish-row${hit ? ' hit' : ''}">
        <button class="wish-main" data-action="open-card" data-id="${c.id}">
          <span class="thumb">${img ? `<img src="${esc(img)}" loading="lazy" referrerpolicy="no-referrer" alt="">` : ''}</span>
          <span class="wish-info"><strong>${esc(title(c))}</strong>
            <span class="muted small">${esc([c.rarity, c.setCode, c.number, c.grade !== '未鑑定' ? c.grade : ''].filter(Boolean).join(' · '))}</span></span>
          <span class="wish-prices"><span class="small muted">目標</span> ${yen(target || null)}<br>
            <span class="small muted">相場</span> ${cur !== null ? yen(cur) : '-'} ${hit ? '<span class="badge ok">目標以下</span>' : ''}</span>
        </button>
        <button class="btn small" data-action="got-wish" data-id="${c.id}">入手した</button>
      </div>`;
    }).join('')}</div>` : emptyState('ほしいカードを登録して、目標価格と相場を見比べられます。')}`;
}

// ---------- 取り込み ----------

function viewImport() {
  const s = state.settings;
  const ready = !!s.clientId;
  return `
    <section class="panel">
      <h2>Gmail の購入メールから取り込む</h2>
      <p class="muted small">${s.sources.filter((x) => x.enabled).map((x) => esc(x.label)).join(' / ')} の購入完了メールを解析し、商品名・金額・購入日を取り出します。
        キーワードで${esc(s.gameName)}以外を除外し、Gemini でカード名・レアリティ・型番を推定できます。</p>
      ${ready ? '' : '<div class="notice">先に <button class="link" data-action="nav" data-view="settings">設定</button> で Google OAuth クライアントID を登録してください。</div>'}
      <div class="row">
        <label class="fld inline"><span>この日以降</span><input type="date" id="scan-after" value="${esc(s.lastScanDate)}"></label>
        <button class="btn primary" data-action="scan-gmail" ${ready ? '' : 'disabled'}>${state.scanning ? 'スキャン中…' : 'Gmail をスキャン'}</button>
      </div>
      <p id="scan-progress" class="muted small" aria-live="polite"></p>
      <div id="scan-results"></div>
    </section>
    <section class="panel">
      <h2>CSV から取り込む</h2>
      <p class="muted small">スプレッドシート「ポケモンカード購入履歴」（購入日・商品名・金額・状態メモ・鑑定・予測名称・10年後予測・メールリンク）を CSV でダウンロードしたもの、またはこのアプリで書き出した CSV を読み込めます。メールリンクが同じ行は重複としてスキップします。</p>
      <label class="btn">CSV ファイルを選択<input type="file" accept=".csv,text/csv" data-change="import-csv" hidden></label>
    </section>`;
}

function renderScanResults() {
  const el = $('#scan-results');
  if (!el) return;
  const btn = $('[data-action="scan-gmail"]');
  if (btn) btn.textContent = state.scanning ? 'スキャン中…' : 'Gmail をスキャン';
  const all = state.candidates;
  if (!all.length) { el.innerHTML = ''; return; }
  const shown = state.showAllCandidates ? all : all.filter((c) => !['imported', 'excluded', 'nomatch', 'aiskip'].includes(c.status));
  const hidden = all.length - shown.length;
  const checked = all.filter((c) => c.checked).length;
  el.innerHTML = `
    <div class="toolbar">
      <label class="check"><input type="checkbox" data-change="check-all" ${shown.length && shown.every((c) => c.checked) ? 'checked' : ''}> すべて選択</label>
      <label class="check"><input type="checkbox" data-change="show-all" ${state.showAllCandidates ? 'checked' : ''}> 除外・取込済みも表示${hidden ? `（${hidden}件）` : ''}</label>
      <span class="spacer"></span>
      <button class="btn" data-action="ai-selected" ${checked ? '' : 'disabled'}>✨ 選択をAI判定</button>
      <button class="btn ghost" data-action="ignore-selected" ${checked ? '' : 'disabled'}>無視する</button>
      <button class="btn primary" data-action="add-selected" ${checked ? '' : 'disabled'}>選択した${checked}件を追加</button>
    </div>
    ${shown.length ? `<div class="cand-list">${shown.map((c) => {
      const i = all.indexOf(c);
      const [label, tone] = CAND_STATUS[c.status];
      const ai = c.ai ? `<div class="ai-line">✨ ${esc([c.ai.name, c.ai.rarity, [c.ai.setCode, c.ai.setName].filter(Boolean).join(' '), c.ai.number].filter(Boolean).join(' / '))}</div>` : '';
      return `<div class="cand${c.checked ? ' on' : ''}">
        <input type="checkbox" data-change="toggle-cand" data-idx="${i}" ${c.checked ? 'checked' : ''} ${c.status === 'imported' ? 'disabled' : ''} aria-label="選択">
        <span class="thumb">${c.imageUrl ? `<img src="${esc(c.imageUrl)}" loading="lazy" referrerpolicy="no-referrer" alt="">` : ''}</span>
        <div class="cand-info">
          <div class="cand-title">${esc(c.rawTitle)}</div>
          <div class="muted small">${esc(c.date)} ・ ${esc(c.shop)} ・ ${yen(c.price)} ・ <a href="${esc(c.mailLink)}" target="_blank" rel="noopener">メールを開く</a></div>
          ${ai}
        </div>
        <span class="badge ${tone}">${label}</span>
        <button class="btn small ghost" data-action="ai-one" data-idx="${i}" ${c.aiBusy ? 'disabled' : ''}>${c.aiBusy ? '判定中…' : 'AI'}</button>
      </div>`;
    }).join('')}</div>` : '<p class="muted small">新しい候補はありません。</p>'}`;
}

// ---------- 設定 ----------

function fmtTime(iso) {
  return iso ? new Date(iso).toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' }) : '未実施';
}

function viewSettings() {
  const s = state.settings;
  return `
    <h1>設定</h1>
    <section class="panel">
      <h2>バックアップ</h2>
      <p class="muted small">データはこの端末のブラウザ内（IndexedDB）に保存されます。機種変更やブラウザのデータ削除に備えて、Google ドライブかローカルファイルにバックアップしてください。</p>
      <h3>Google ドライブ</h3>
      <p class="small">マイドライブに <code>${G.BACKUP_FILE_NAME}</code> として保存します（最終: ${fmtTime(s.lastDriveBackup)}）。</p>
      <div class="row">
        <button class="btn primary" data-action="drive-save" ${s.clientId ? '' : 'disabled'}>ドライブに保存</button>
        <button class="btn" data-action="drive-restore" data-mode="merge" ${s.clientId ? '' : 'disabled'}>ドライブから取り込み（マージ）</button>
        <button class="btn ghost" data-action="drive-restore" data-mode="replace" ${s.clientId ? '' : 'disabled'}>ドライブで上書き復元</button>
      </div>
      <label class="check"><input type="checkbox" data-setting="autoDrive" ${s.autoDrive ? 'checked' : ''}> 変更後に自動でドライブへ保存（ログイン中のみ）</label>
      <h3>ローカル</h3>
      <p class="small">最終: ${fmtTime(s.lastLocalBackup)}</p>
      <div class="row">
        ${canPickFile ? `<button class="btn" data-action="pick-local-file">${state.localHandle ? `自動保存先: ${esc(state.localHandle.name)}（変更）` : '自動保存するファイルを指定'}</button>` : ''}
        <button class="btn" data-action="export-json">JSON を書き出す</button>
        <label class="btn">JSON を取り込む（マージ）<input type="file" accept=".json,application/json" data-change="import-json" data-mode="merge" hidden></label>
        <label class="btn ghost">JSON で上書き復元<input type="file" accept=".json,application/json" data-change="import-json" data-mode="replace" hidden></label>
        <button class="btn ghost" data-action="export-csv">CSV を書き出す</button>
      </div>
      ${canPickFile ? '<p class="muted small">「自動保存するファイル」を指定すると、変更のたびにそのファイルへ上書き保存します（PC版 Chrome / Edge）。OneDrive や Google ドライブの同期フォルダ内のファイルを指定すると二重の備えになります。</p>' : ''}
    </section>

    <section class="panel">
      <h2>Google 連携</h2>
      <label class="fld"><span>OAuth クライアントID</span>
        <input data-setting="clientId" value="${esc(s.clientId)}" placeholder="xxxxxxxx.apps.googleusercontent.com" autocomplete="off"></label>
      <p class="muted small">Google Cloud Console で「ウェブ アプリケーション」の OAuth クライアントを作成し、承認済みの JavaScript 生成元に <code>${esc(location.origin)}</code> を追加してください。Gmail API と Google Drive API の有効化も必要です（詳細は README）。</p>
    </section>

    <section class="panel">
      <h2>AI（Gemini）</h2>
      <div class="grid2">
        <label class="fld"><span>Gemini API キー</span><input type="password" data-setting="geminiKey" value="${esc(s.geminiKey)}" autocomplete="off"></label>
        <label class="fld"><span>モデル</span><input data-setting="geminiModel" value="${esc(s.geminiModel)}"></label>
        <label class="fld"><span>対象のカードゲーム</span><input data-setting="gameName" value="${esc(s.gameName)}"></label>
      </div>
      <label class="check"><input type="checkbox" data-setting="autoAi" ${s.autoAi ? 'checked' : ''}> スキャン後に候補を自動でAI判定する</label>
      <p class="muted small">API キーはこの端末のブラウザにだけ保存され、バックアップファイルには含まれません。</p>
    </section>

    <section class="panel">
      <h2>取り込みフィルタ</h2>
      <label class="check"><input type="checkbox" data-setting="keywordFilter" ${s.keywordFilter ? 'checked' : ''}> キーワードを含むメールだけを候補にする</label>
      <label class="fld"><span>対象キーワード（カンマ区切り）</span><textarea rows="2" data-setting="keywords">${esc(s.keywords)}</textarea></label>
      <label class="fld"><span>除外キーワード（カンマ区切り）</span><textarea rows="2" data-setting="excludeKeywords">${esc(s.excludeKeywords)}</textarea></label>
      <label class="fld inline"><span>1検索あたりの最大件数</span><input type="number" min="10" max="1000" data-setting="scanMax" value="${esc(s.scanMax)}"></label>
      <h3>検索するメール</h3>
      ${s.sources.map((src, i) => `<div class="src-row">
        <label class="check"><input type="checkbox" data-source="${i}" data-field="enabled" ${src.enabled ? 'checked' : ''}> ${esc(src.label)}</label>
        <input class="grow" data-source="${i}" data-field="query" value="${esc(src.query)}" aria-label="${esc(src.label)}の検索クエリ"></div>`).join('')}
      <button class="btn small ghost" data-action="reset-filters">初期値に戻す</button>
    </section>

    <section class="panel danger-zone">
      <h2>データ</h2>
      <p class="muted small">カード ${live().length}件 ・ 取込済みメール ${state.processed.size}件</p>
      <button class="btn danger" data-action="wipe">この端末のデータをすべて削除</button>
    </section>`;
}

// ================= カード編集ダイアログ =================

const cardDlg = () => $('#card-dialog');
const cardForm = () => $('#card-form');

function fld(label, name, value, type = 'text', extra = '') {
  return `<label class="fld"><span>${label}</span><input type="${type}" name="${name}" value="${esc(value)}" ${extra}></label>`;
}

function openCard(id, preset = {}) {
  const base = id ? state.cards.find((c) => c.id === id) : newCard(preset);
  if (!base) return;
  state.editing = structuredClone(base);
  renderCardForm();
  cardDlg().showModal();
}

function renderCardForm() {
  const c = state.editing;
  const isNew = !state.cards.some((x) => x.id === c.id && !x.deleted);
  const img = c.imageData || c.imageUrl;
  const prices = [...(c.prices || [])].map((p, i) => ({ ...p, i })).sort((a, b) => b.date.localeCompare(a.date));
  const cur = latestPrice(c);
  const pl = cur !== null && num(c.purchasePrice) ? (cur - num(c.purchasePrice)) * qty(c) : null;
  cardForm().innerHTML = `
    <header class="dlg-head">
      <h2>${isNew ? (c.status === 'wish' ? 'ほしいものを追加' : 'カードを追加') : esc(title(c))}</h2>
      <button type="button" class="icon-btn" data-action="close-card" aria-label="閉じる">×</button>
    </header>
    <div class="dlg-body">
      <div class="card-edit">
        <div class="edit-img">
          <div class="img-box">${img ? `<img src="${esc(img)}" referrerpolicy="no-referrer" alt="">` : ''}<span class="ph">画像なし</span></div>
          <label class="btn small">画像を選択<input type="file" accept="image/*" data-change="pick-image" hidden></label>
          ${img ? '<button type="button" class="btn small ghost" data-action="clear-image">画像を外す</button>' : ''}
          <button type="button" class="btn small" data-action="ai-identify">✨ AIでカード判定</button>
          ${c.mailLink ? `<a class="small" href="${esc(c.mailLink)}" target="_blank" rel="noopener">購入メールを開く</a>` : ''}
        </div>
        <div class="grid2">
          <label class="fld"><span>区分</span><select name="status">${opt('owned', '所持', c.status)}${opt('wish', 'ほしいもの', c.status)}</select></label>
          ${fld('カード名', 'name', c.name, 'text', 'required')}
          ${fld('レアリティ', 'rarity', c.rarity, 'text', 'list="dl-rarity"')}
          ${fld('番号', 'number', c.number, 'text', 'placeholder="198/190"')}
          ${fld('セットコード', 'setCode', c.setCode, 'text', 'placeholder="S4a"')}
          ${fld('セット名', 'setName', c.setName, 'text', 'placeholder="シャイニースターV"')}
          ${fld('鑑定', 'grade', c.grade, 'text', 'list="dl-grade"')}
          ${fld('状態メモ', 'condition', c.condition, 'text', 'list="dl-cond"')}
          ${fld('枚数', 'quantity', c.quantity, 'number', 'min="1" step="1"')}
          ${c.status === 'wish' ? fld('目標価格（円）', 'targetPrice', c.targetPrice, 'number', 'min="0"') : fld('購入価格（円・1枚）', 'purchasePrice', c.purchasePrice, 'number', 'min="0"')}
          ${c.status === 'wish' ? '' : fld('購入日', 'purchaseDate', c.purchaseDate, 'date')}
          ${c.status === 'wish' ? '' : fld('購入先', 'shop', c.shop, 'text', 'list="dl-shop"')}
          ${fld('タグ（カンマ区切り）', 'tags', (c.tags || []).join(', '))}
          ${fld('画像URL', 'imageUrl', c.imageUrl, 'url')}
        </div>
      </div>
      ${c.rawTitle ? `<p class="muted small">元の商品名: ${esc(c.rawTitle)}</p>` : ''}
      <label class="fld"><span>メモ</span><textarea name="memo" rows="2">${esc(c.memo)}</textarea></label>

      <section class="sub">
        <div class="panel-head"><h3>相場の記録</h3>
          <span class="small">${cur !== null ? `最新 ${yen(cur)}` : '未記録'}${pl !== null ? ` ・ 損益 <span class="${pl >= 0 ? 'up' : 'down'}">${signedYen(pl)}</span>` : ''}</span></div>
        <div id="card-chart"></div>
        <div class="price-add">
          <input type="date" id="np-date" value="${today()}" aria-label="日付">
          <input type="number" id="np-price" min="0" placeholder="価格（円）" aria-label="価格">
          <input id="np-note" class="grow" placeholder="メモ（例: スニダン最安値）" aria-label="メモ">
          <button type="button" class="btn small" data-action="add-price">記録</button>
        </div>
        ${prices.length ? `<ul class="price-list">${prices.map((p) => `<li><span>${esc(p.date)}</span><strong>${yen(p.price)}</strong>
          <span class="muted small grow">${esc(p.note || '')}</span>
          <button type="button" class="icon-btn" data-action="del-price" data-idx="${p.i}" aria-label="削除">×</button></li>`).join('')}</ul>` : ''}
      </section>

      <section class="sub">
        <div class="panel-head"><h3>10年後予測</h3><button type="button" class="btn small ghost" data-action="ai-forecast">✨ AIで予想</button></div>
        <input name="forecast10y" value="${esc(c.forecast10y)}" placeholder="例: ¥50,000前後" aria-label="10年後予測">
      </section>
    </div>
    <footer class="dlg-foot">
      ${isNew ? '' : '<button type="button" class="btn danger ghost" data-action="delete-card">削除</button>'}
      <span class="spacer"></span>
      <button type="button" class="btn ghost" data-action="close-card">キャンセル</button>
      <button type="submit" class="btn primary">保存</button>
    </footer>`;
  const chartEl = $('#card-chart');
  const pts = (c.prices || []).filter((p) => p.date).map((p) => ({ x: new Date(p.date).getTime(), y: num(p.price) }));
  if (pts.length) {
    const series = [{ name: '相場', color: 'var(--accent)', points: pts }];
    if (num(c.purchasePrice) && c.purchaseDate) series.push({ name: '購入価格', color: 'var(--line2)', points: [{ x: new Date(c.purchaseDate).getTime(), y: num(c.purchasePrice) }] });
    lineChart(chartEl, series, { height: 160 });
  } else {
    chartEl.innerHTML = '';
  }
}

// フォームの入力値を編集中データに反映（再描画前に呼ぶ）
function syncForm() {
  const fd = new FormData(cardForm());
  const c = state.editing;
  for (const [k, v] of fd.entries()) {
    if (k === 'tags') c.tags = splitList(v);
    else if (k === 'quantity') c.quantity = Math.max(1, Math.floor(num(v)) || 1);
    else if (k === 'purchasePrice' || k === 'targetPrice') c[k] = v === '' ? '' : num(v);
    else c[k] = typeof v === 'string' ? v.trim() : v;
  }
}

function applyAiResult(c, r) {
  c.name = r.name || c.name;
  c.rarity = r.rarity || c.rarity;
  c.setCode = r.setCode || c.setCode;
  c.setName = r.setName || c.setName;
  c.number = r.number || c.number;
}

async function aiIdentifyEditing(btn) {
  syncForm();
  const s = state.settings;
  const c = state.editing;
  btn.disabled = true;
  btn.textContent = '判定中…';
  try {
    let img = c.imageData ? AI.splitDataUrl(c.imageData) : null;
    if (!img && c.imageUrl) {
      try { img = await AI.urlToBase64(c.imageUrl); } catch { /* CORS で取得できない画像はテキストのみ */ }
    }
    const r = await AI.identifyCard({
      apiKey: s.geminiKey, model: s.geminiModel, gameName: s.gameName,
      itemName: c.rawTitle || c.name, price: c.purchasePrice, date: c.purchaseDate,
      imageBase64: img?.base64, mimeType: img?.mimeType,
    });
    if (!r.isTargetCard) toast(`AIは${s.gameName}ではないと判定しました`, 'error');
    applyAiResult(c, r);
    renderCardForm();
    toast(img ? '画像と商品名から判定しました' : '商品名から判定しました（画像なし）', 'ok');
  } finally {
    btn.disabled = false;
    btn.textContent = '✨ AIでカード判定';
  }
}

// ================= セット編集ダイアログ =================

function openSet(key) {
  const g = key ? setStats().find((x) => x.key === key) : null;
  state.editingSet = g?.master ? structuredClone(g.master)
    : { id: crypto.randomUUID(), code: g?.code || '', name: g?.name || '', total: g?.total || '', releaseDate: '' };
  const m = state.editingSet;
  const exists = state.sets.some((x) => x.id === m.id && !x.deleted);
  $('#set-form').innerHTML = `
    <header class="dlg-head"><h2>${exists ? 'セットを編集' : 'セットを登録'}</h2>
      <button type="button" class="icon-btn" data-action="close-set" aria-label="閉じる">×</button></header>
    <div class="dlg-body grid2">
      ${fld('セットコード', 'code', m.code, 'text', 'placeholder="SV2a"')}
      ${fld('セット名', 'name', m.name, 'text', 'placeholder="ポケモンカード151"')}
      ${fld('収録数（分母）', 'total', m.total, 'number', 'min="1"')}
      ${fld('発売日', 'releaseDate', m.releaseDate, 'date')}
    </div>
    <footer class="dlg-foot">
      ${exists ? '<button type="button" class="btn danger ghost" data-action="delete-set">削除</button>' : ''}
      <span class="spacer"></span>
      <button type="button" class="btn ghost" data-action="close-set">キャンセル</button>
      <button type="submit" class="btn primary">保存</button>
    </footer>`;
  $('#set-dialog').showModal();
}

async function saveSet() {
  const fd = new FormData($('#set-form'));
  const m = { ...state.editingSet, code: String(fd.get('code')).trim(), name: String(fd.get('name')).trim(), total: num(fd.get('total')) || '', releaseDate: fd.get('releaseDate') || '', updatedAt: nowIso() };
  if (!m.code && !m.name) { toast('セットコードかセット名を入力してください', 'error'); return; }
  await db.put('sets', m);
  state.sets = [...state.sets.filter((x) => x.id !== m.id), m];
  markDirty();
  $('#set-dialog').close();
  render();
}

// ================= イベント =================

const actions = {
  nav: (el) => { state.view = el.dataset.view; render(); window.scrollTo(0, 0); },
  'sync-now': () => syncNow(),
  'new-card': (el) => openCard(null, el.dataset.status ? { status: el.dataset.status, purchaseDate: '' } : {}),
  'open-card': (el) => openCard(el.dataset.id),
  'close-card': () => cardDlg().close(),
  'clear-image': () => { syncForm(); state.editing.imageData = ''; state.editing.imageUrl = ''; renderCardForm(); },
  'ai-identify': (el) => aiIdentifyEditing(el),
  'ai-forecast': async (el) => {
    syncForm();
    const s = state.settings;
    el.disabled = true; el.textContent = '予想中…';
    try {
      state.editing.forecast10y = await AI.forecast10y({ apiKey: s.geminiKey, model: s.geminiModel, gameName: s.gameName, card: state.editing, currentPrice: latestPrice(state.editing) });
      renderCardForm();
    } finally { el.disabled = false; el.textContent = '✨ AIで予想'; }
  },
  'add-price': () => {
    const date = $('#np-date').value;
    const price = $('#np-price').value;
    if (!date || price === '') { toast('日付と価格を入力してください', 'error'); return; }
    syncForm();
    state.editing.prices = [...(state.editing.prices || []), { date, price: num(price), note: $('#np-note').value.trim() }];
    renderCardForm();
  },
  'del-price': (el) => { syncForm(); state.editing.prices.splice(Number(el.dataset.idx), 1); renderCardForm(); },
  'delete-card': async () => {
    if (!confirm(`「${title(state.editing)}」を削除しますか？`)) return;
    await deleteCard(state.editing.id);
    cardDlg().close();
    render();
  },
  'got-wish': async (el) => {
    const c = structuredClone(state.cards.find((x) => x.id === el.dataset.id));
    c.status = 'owned';
    c.purchaseDate = today();
    c.purchasePrice = latestPrice(c) ?? (c.targetPrice || '');
    state.editing = c;
    renderCardForm();
    cardDlg().showModal();
    toast('購入価格と購入日を確認して保存してください');
  },
  layout: (el) => { state.filters.layout = el.dataset.layout; render(); },
  'clear-filters': () => { Object.assign(state.filters, { q: '', set: '', rarity: '', grade: '', tag: '' }); render(); },
  'filter-set': (el) => { Object.assign(state.filters, { q: '', set: el.dataset.key, rarity: '', grade: '', tag: '', sort: 'number' }); state.view = 'collection'; render(); },
  'new-set': () => openSet(null),
  'edit-set': (el) => openSet(el.dataset.key),
  'close-set': () => $('#set-dialog').close(),
  'delete-set': async () => {
    const tomb = { id: state.editingSet.id, deleted: true, updatedAt: nowIso() };
    await db.put('sets', tomb);
    state.sets = state.sets.map((x) => (x.id === tomb.id ? tomb : x));
    markDirty();
    $('#set-dialog').close();
    render();
  },
  'scan-gmail': () => scanGmail(),
  'ai-one': (el) => aiCandidate(state.candidates[Number(el.dataset.idx)]),
  'ai-selected': () => aiCandidates(state.candidates.filter((c) => c.checked)),
  'add-selected': () => addCandidates(),
  'ignore-selected': () => ignoreCandidates(),
  'drive-save': () => syncNow(),
  'drive-restore': (el) => restoreFromDrive(el.dataset.mode),
  'pick-local-file': () => chooseLocalFile(),
  'export-json': () => exportJson(),
  'export-csv': () => exportCsv(),
  'reset-filters': () => {
    Object.assign(state.settings, { keywordFilter: true, keywords: DEFAULT_SETTINGS.keywords, excludeKeywords: DEFAULT_SETTINGS.excludeKeywords, sources: structuredClone(P.DEFAULT_SOURCES) });
    saveSettings();
    render();
  },
  wipe: async () => {
    if (!confirm('この端末のカード・セット・取込履歴をすべて削除します。バックアップは削除されません。よろしいですか？')) return;
    if (prompt('確認のため「削除」と入力してください') !== '削除') return;
    await Promise.all([db.clear('cards'), db.clear('sets'), db.clear('meta')]);
    Object.assign(state, { cards: [], sets: [], processed: new Set(), candidates: [], localHandle: null, dirty: false });
    render();
    toast('すべて削除しました');
  },
};

const changeActions = {
  'pick-image': async (el) => {
    const file = el.files?.[0];
    if (!file) return;
    syncForm();
    state.editing.imageData = await resizeImage(file);
    renderCardForm();
  },
  'import-csv': async (el) => { const f = el.files?.[0]; el.value = ''; if (f) await importCsv(f); },
  'import-json': async (el) => {
    const f = el.files?.[0];
    el.value = '';
    if (!f) return;
    const mode = el.dataset.mode;
    if (mode === 'replace' && !confirm('ファイルの内容で端末のデータを上書きします。よろしいですか？')) return;
    await applyBackup(JSON.parse(await readFileText(f)), mode);
    if (mode === 'merge') markDirty();
    toast(mode === 'merge' ? 'バックアップをマージしました' : 'バックアップから復元しました', 'ok');
  },
  'toggle-cand': (el) => { state.candidates[Number(el.dataset.idx)].checked = el.checked; renderScanResults(); },
  'check-all': (el) => {
    const shown = state.showAllCandidates ? state.candidates : state.candidates.filter((c) => !['imported', 'excluded', 'nomatch', 'aiskip'].includes(c.status));
    shown.forEach((c) => { if (c.status !== 'imported') c.checked = el.checked; });
    renderScanResults();
  },
  'show-all': (el) => { state.showAllCandidates = el.checked; renderScanResults(); },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.action];
  if (fn) { e.preventDefault(); guard(fn)(el, e); }
});

document.addEventListener('keydown', (e) => {
  // テーブル行のキーボード操作
  if (e.key === 'Enter' && e.target.matches('tr[data-action]')) e.target.click();
  // 相場入力欄の Enter はフォーム送信ではなく「記録」
  if (e.key === 'Enter' && e.target.closest('.price-add')) { e.preventDefault(); guard(actions['add-price'])(); }
});

document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.dataset.change && changeActions[el.dataset.change]) { guard(changeActions[el.dataset.change])(el); return; }
  if (el.dataset.setting) {
    const k = el.dataset.setting;
    state.settings[k] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? num(el.value) : el.value.trim();
    saveSettings();
    if (k === 'clientId' && state.settings.clientId) G.loadGis().catch(() => {});
    if (['clientId', 'autoDrive'].includes(k)) render();
    return;
  }
  if (el.dataset.source !== undefined) {
    const src = state.settings.sources[Number(el.dataset.source)];
    src[el.dataset.field] = el.type === 'checkbox' ? el.checked : el.value.trim();
    saveSettings();
    return;
  }
  if (el.dataset.filter && el.dataset.filter !== 'q' && el.dataset.filter !== 'wishQ') {
    state.filters[el.dataset.filter] = el.value;
    renderResults();
  }
});

document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.dataset.filter === 'q') { state.filters.q = el.value; renderResults(); }
  if (el.dataset.filter === 'wishQ') {
    state.wishQ = el.value;
    const pos = el.selectionStart;
    render();
    const input = $('[data-filter="wishQ"]');
    input.focus();
    input.setSelectionRange(pos, pos);
  }
});

// 読み込めなかった画像（直リンク不可など）はプレースホルダー表示にする
document.addEventListener('error', (e) => { if (e.target.tagName === 'IMG') e.target.classList.add('broken'); }, true);

// ================= 起動 =================

async function init() {
  $('#card-form').addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    syncForm();
    const c = state.editing;
    if (!c.name) { toast('カード名を入力してください', 'error'); return; }
    await saveCard(c);
    cardDlg().close();
    render();
    toast('保存しました', 'ok');
  }));
  $('#set-form').addEventListener('submit', guard(async (e) => { e.preventDefault(); await saveSet(); }));

  // 入力候補
  $('#datalists').innerHTML = `
    <datalist id="dl-grade">${GRADES.map((g) => `<option value="${g}">`).join('')}</datalist>
    <datalist id="dl-cond">${CONDITIONS.map((g) => `<option value="${g}">`).join('')}</datalist>
    <datalist id="dl-rarity">${['C', 'U', 'R', 'RR', 'RRR', 'SR', 'SAR', 'AR', 'UR', 'HR', 'CHR', 'CSR', 'ACE', 'PROMO'].map((g) => `<option value="${g}">`).join('')}</datalist>
    <datalist id="dl-shop">${['メルカリ', 'Yahoo!', '楽天ラクマ', 'magi', 'スニダン', 'カードショップ', 'パック開封'].map((g) => `<option value="${g}">`).join('')}</datalist>`;

  // 旧バージョンの設定に新しい検索元が無い場合に補完
  const keys = new Set(state.settings.sources.map((s) => s.key));
  P.DEFAULT_SOURCES.forEach((s) => { if (!keys.has(s.key)) state.settings.sources.push({ ...s }); });

  const [cards, sets, processed, handle] = await Promise.all([
    db.getAll('cards'), db.getAll('sets'), db.get('meta', 'processedMails'), db.get('meta', 'localHandle'),
  ]);
  state.cards = cards || [];
  state.sets = sets || [];
  state.processed = new Set(processed?.ids || []);
  state.localHandle = handle?.handle || null;
  render();

  if (state.settings.clientId) G.loadGis().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('SW登録失敗', e));
  }
  // 永続ストレージを要求（ブラウザによる自動削除を防ぐ）
  navigator.storage?.persist?.().catch(() => {});
}

init().catch((e) => { console.error(e); toast(`起動に失敗しました: ${e.message}`, 'error'); });
