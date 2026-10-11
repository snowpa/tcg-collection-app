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
  filters: { q: '', set: '', rarity: '', grade: '', tag: '', cond: '', sort: 'added-desc', layout: 'grid' },
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

const cardCost = (c) => num(c.purchasePrice) * qty(c);
const sum = (arr, f) => arr.reduce((a, x) => a + f(x), 0);

const setKey = (c) => String(c.setCode || c.setName || '').trim().toLowerCase();

// ================= カードの状態チェック =================

// 総合評価
const COND_RATINGS = [
  ['S', 'S（完美品）'], ['A', 'A（美品）'], ['B', 'B（小傷あり）'], ['C', 'C（傷・白かけが目立つ）'], ['D', 'D（ダメージ大）'],
];
// 欠陥の種類
const DEFECTS = [
  ['whitening', '白かけ'], ['dent', 'へこみ'], ['crease', '折れ'], ['scratch', '表面傷'],
  ['holo', 'ホロ傷'], ['stain', '汚れ・シミ'], ['print', '印刷ズレ・初期傷'], ['warp', '反り'],
];
// 程度（none は「なし」）
const SEVERITY = [['none', 'なし'], ['light', '軽微'], ['moderate', '目立つ'], ['heavy', '重度']];
const SEVERITY_LABEL = Object.fromEntries(SEVERITY);
// 白かけ位置（角4つ＋辺4つ）
const WH_POS = ['tl', 't', 'tr', 'r', 'br', 'b', 'bl', 'l'];
const WH_LABEL = { tl: '左上', t: '上辺', tr: '右上', r: '右辺', br: '右下', b: '下辺', bl: '左下', l: '左辺' };
// センタリングの PSA10 目安（表 55/45・裏 75/25）
const CENTER_LIMIT = { front: 55, back: 75 };

function emptyCond() {
  return {
    inspectedAt: '',
    overall: '',
    centering: { front: { l: '', r: '', t: '', b: '' }, back: { l: '', r: '', t: '', b: '' } },
    defects: Object.fromEntries(DEFECTS.map(([k]) => [k, 'none'])),
    whiteMarks: { front: [], back: [] },
    note: '',
    photos: [],
  };
}

// 旧データ（cond なし）にも対応して欠けている項目を補う
function condOf(c) {
  const e = emptyCond();
  const x = c.cond || {};
  return {
    ...e, ...x,
    centering: {
      front: { ...e.centering.front, ...(x.centering?.front || {}) },
      back: { ...e.centering.back, ...(x.centering?.back || {}) },
    },
    defects: { ...e.defects, ...(x.defects || {}) },
    whiteMarks: { front: [...(x.whiteMarks?.front || [])], back: [...(x.whiteMarks?.back || [])] },
    photos: [...(x.photos || [])],
  };
}

// 枠の幅 a, b から比率（a 側の %）を求める
function ratio(a, b) {
  const x = num(a); const y = num(b);
  if (!(x > 0 || y > 0) || a === '' || b === '') return null;
  return Math.round((x / (x + y)) * 100);
}

// 片面のセンタリング結果 { lr, tb, worst, ok }
function centeringOf(side, sideKey) {
  const lr = ratio(side.l, side.r);
  const tb = ratio(side.t, side.b);
  if (lr === null && tb === null) return null;
  const worst = Math.max(...[lr, tb].filter((v) => v !== null).map((v) => Math.max(v, 100 - v)));
  return { lr, tb, worst, ok: worst <= CENTER_LIMIT[sideKey] };
}

function centeringText(r) {
  if (!r) return '未計測';
  const p = (v, a, b) => (v === null ? '' : `${a}${v} : ${b}${100 - v}`);
  return [p(r.lr, '左', '右'), p(r.tb, '上', '下')].filter(Boolean).join(' ／ ');
}

const activeDefects = (cond) => DEFECTS.filter(([k]) => cond.defects[k] && cond.defects[k] !== 'none');

// 一覧用の短い状態要約
function condSummary(c) {
  const cond = condOf(c);
  const ds = activeDefects(cond).map(([k, l]) => `${l}(${SEVERITY_LABEL[cond.defects[k]]})`);
  return ds.length ? ds.join('・') : cond.inspectedAt ? '目立つ欠陥なし' : '';
}

function newCard(preset = {}) {
  return {
    id: crypto.randomUUID(),
    status: 'owned',
    name: '', rawTitle: '', rarity: '', setCode: '', setName: '', number: '',
    quantity: 1, condition: '', grade: '未鑑定',
    purchaseDate: today(), purchasePrice: '', shop: '', targetPrice: '',
    mailLink: '', gmailId: '', imageUrl: '', imageData: '',
    cond: emptyCond(), tags: [], memo: '',
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
  ['目標価格', (c) => c.targetPrice], ['タグ', (c) => (c.tags || []).join(' ')],
  ['メモ', (c) => c.memo], ['メールリンク', (c) => c.mailLink],
  // 状態チェック
  ['状態評価', (c) => condOf(c).overall], ['点検日', (c) => condOf(c).inspectedAt],
  ['センタリング(表)', (c) => { const r = centeringOf(condOf(c).centering.front, 'front'); return r ? centeringText(r) : ''; }],
  ['センタリング(裏)', (c) => { const r = centeringOf(condOf(c).centering.back, 'back'); return r ? centeringText(r) : ''; }],
  ...DEFECTS.map(([k, l]) => [l, (c) => { const v = condOf(c).defects[k]; return v && v !== 'none' ? SEVERITY_LABEL[v] : ''; }]),
  ['白かけ位置(表)', (c) => condOf(c).whiteMarks.front.map((p) => WH_LABEL[p]).join(' ')],
  ['白かけ位置(裏)', (c) => condOf(c).whiteMarks.back.map((p) => WH_LABEL[p]).join(' ')],
  ['状態詳細メモ', (c) => condOf(c).note],
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
      tags: splitList(get(r, 'タグ').replace(/\s+/g, ',')),
      memo: get(r, 'メモ'),
      mailLink: link,
    });
    // 状態チェック列（このアプリの CSV のみ。センタリングは比率しか残らないので取り込まない）
    const sevByLabel = Object.fromEntries(SEVERITY.map(([k, l]) => [l, k]));
    const posByLabel = Object.fromEntries(Object.entries(WH_LABEL).map(([k, l]) => [l, k]));
    card.cond.overall = COND_RATINGS.some(([k]) => k === get(r, '状態評価')) ? get(r, '状態評価') : '';
    card.cond.inspectedAt = normDate(get(r, '点検日'));
    card.cond.note = get(r, '状態詳細メモ');
    DEFECTS.forEach(([k, l]) => { card.cond.defects[k] = sevByLabel[get(r, l)] || 'none'; });
    card.cond.whiteMarks.front = get(r, '白かけ位置(表)').split(/\s+/).map((l) => posByLabel[l]).filter(Boolean);
    card.cond.whiteMarks.back = get(r, '白かけ位置(裏)').split(/\s+/).map((l) => posByLabel[l]).filter(Boolean);
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
    if (el) lineChart(el, costSeries());
  }
  if (state.view === 'collection') renderResults();
  if (state.view === 'import') renderScanResults();
  updateSyncButton();
}

function tileHtml(c) {
  const img = c.imageData || c.imageUrl;
  const cond = condOf(c);
  const issues = activeDefects(cond).length;
  return `
  <button class="tile" data-action="open-card" data-id="${c.id}">
    <div class="tile-img">
      ${img ? `<img src="${esc(img)}" loading="lazy" referrerpolicy="no-referrer" alt="">` : ''}
      <span class="ph">${esc(title(c).slice(0, 18))}</span>
      ${c.grade && c.grade !== '未鑑定' ? `<span class="badge grade">${esc(c.grade)}</span>` : ''}
      ${qty(c) > 1 ? `<span class="badge qty">×${qty(c)}</span>` : ''}
      ${cond.overall ? `<span class="badge rating r-${esc(cond.overall)}" title="状態評価">${esc(cond.overall)}</span>` : ''}
    </div>
    <div class="tile-body">
      <div class="tile-name">${esc(title(c))}</div>
      <div class="tile-meta">${esc([c.rarity, c.setCode, c.number].filter(Boolean).join(' · ') || ' ')}</div>
      <div class="tile-price"><span>${yen(c.status === 'wish' ? c.targetPrice || null : c.purchasePrice || null)}</span>
        ${issues ? `<span class="warn-text" title="${esc(condSummary(c))}">要注意 ${issues}</span>` : ''}</div>
    </div>
  </button>`;
}

function emptyState(msg, actions = '') {
  return `<div class="empty"><p>${msg}</p><div class="row center">${actions}</div></div>`;
}

// ---------- ホーム（資産ダッシュボード） ----------

// 購入額の累計推移
function costSeries() {
  const owned = live('owned');
  const dates = new Set([today()]);
  owned.forEach((c) => { if (c.purchaseDate) dates.add(c.purchaseDate); });
  const points = [...dates].sort().map((d) => ({
    x: new Date(d).getTime(),
    y: sum(owned.filter((c) => (c.purchaseDate || '0000') <= d), cardCost),
  }));
  return [{ name: '累計購入額', color: 'var(--accent)', points }];
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
  const checked = owned.filter((c) => condOf(c).inspectedAt || condOf(c).overall).length;
  // 状態評価の内訳
  const dist = COND_RATINGS.map(([k, l]) => [k, l, owned.filter((c) => condOf(c).overall === k).length]);
  const unrated = owned.filter((c) => !condOf(c).overall).length;
  const maxDist = Math.max(1, ...dist.map((d) => d[2]), unrated);
  // 要注意: 折れ・へこみがある、または目立つ/重度の欠陥があるカード
  const sevRank = { none: 0, light: 1, moderate: 2, heavy: 3 };
  const alerts = owned.map((c) => {
    const cond = condOf(c);
    const score = Math.max(0, ...activeDefects(cond).map(([k]) => sevRank[cond.defects[k]] + (k === 'crease' || k === 'dent' ? 1 : 0)));
    return { c, score };
  }).filter((x) => x.score >= 2).sort((a, b) => b.score - a.score).slice(0, 6);
  const recent = [...owned].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 6);
  const distRow = (key, label, n, filter) => `<li><button class="dist-row" data-action="filter-cond" data-cond="${filter}">
      <span class="dist-label">${key ? `<span class="badge rating r-${key}">${key}</span>` : ''}${esc(label)}</span>
      <span class="bar"><i style="width:${(n / maxDist) * 100}%"></i></span><span class="dist-n">${n}</span></button></li>`;
  return `
    ${backupNotice()}
    <section class="stats">
      <div class="stat big"><span class="label">購入総額</span><span class="val">${yen(cost)}</span></div>
      <div class="stat"><span class="label">所持枚数</span><span class="val">${sum(owned, qty)}枚</span><span class="muted small">${owned.length}種類</span></div>
      <div class="stat"><span class="label">状態チェック済み</span><span class="val">${checked} / ${owned.length}</span></div>
      <div class="stat"><span class="label">ほしいもの</span><span class="val">${live('wish').length}件</span></div>
    </section>
    <div class="two-col">
      <section class="panel"><h2>状態評価の内訳</h2><ul class="dist">
        ${dist.map(([k, l, n]) => distRow(k, l.replace(/^.（|）$/g, ''), n, k)).join('')}
        ${distRow('', '未評価', unrated, 'unrated')}</ul></section>
      <section class="panel"><h2>要注意のカード</h2>${alerts.length
        ? `<ul class="rank plain">${alerts.map(({ c }) => `<li><button class="rank-row" data-action="open-card" data-id="${c.id}">
            <span class="rank-name">${esc(title(c))}<small>${esc(condSummary(c))}</small></span></button></li>`).join('')}</ul>`
        : '<p class="muted small">折れ・へこみ、目立つ白かけなどがあるカードがここに表示されます。</p>'}</section>
    </div>
    <section class="panel"><h2>購入額の推移</h2><div id="asset-chart"></div></section>
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
  if (f.cond) {
    list = list.filter((c) => {
      const cond = condOf(c);
      if (f.cond === 'unrated') return !cond.overall;
      if (f.cond === 'issues') return activeDefects(cond).length > 0;
      if (f.cond === 'crease') return ['crease', 'dent'].some((k) => cond.defects[k] !== 'none');
      if (f.cond === 'center-ng') return [['front', 'front'], ['back', 'back']].some(([s, k]) => centeringOf(cond.centering[s], k)?.ok === false);
      return cond.overall === f.cond;
    });
  }
  const by = {
    'added-desc': (a, b) => String(b.createdAt).localeCompare(String(a.createdAt)),
    'purchase-desc': (a, b) => String(b.purchaseDate).localeCompare(String(a.purchaseDate)),
    'price-desc': (a, b) => num(b.purchasePrice) - num(a.purchasePrice),
    'price-asc': (a, b) => num(a.purchasePrice) - num(b.purchasePrice),
    // 状態評価順（S が先、未評価は最後）
    cond: (a, b) => ('SABCD'.indexOf(condOf(a).overall) + 1 || 9) - ('SABCD'.indexOf(condOf(b).overall) + 1 || 9),
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
      <select data-filter="cond" aria-label="状態">${opt('', '状態', f.cond)}${COND_RATINGS.map(([k, l]) => opt(k, `評価 ${l}`, f.cond)).join('')}
        ${opt('unrated', '未評価', f.cond)}${opt('issues', '欠陥ありすべて', f.cond)}${opt('crease', '折れ・へこみあり', f.cond)}${opt('center-ng', 'センタリング基準外', f.cond)}</select>
      ${tags.length ? `<select data-filter="tag" aria-label="タグ">${opt('', 'タグ', f.tag)}${tags.map((t) => opt(t, `#${t}`, f.tag)).join('')}</select>` : ''}
      <select data-filter="sort" aria-label="並び替え">
        ${[['added-desc', '登録が新しい順'], ['purchase-desc', '購入日が新しい順'], ['price-desc', '購入価格が高い順'], ['price-asc', '購入価格が低い順'],
          ['cond', '状態が良い順'], ['name', '名前順'], ['number', 'セット・番号順']].map(([v, l]) => opt(v, l, f.sort)).join('')}
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
  const summary = `<p class="muted small">${list.length}種類 / ${sum(list, qty)}枚 ・ 購入額 ${yen(sum(list, cardCost))}</p>`;
  if (!list.length) {
    el.innerHTML = live('owned').length
      ? emptyState('条件に一致するカードがありません。', '<button class="btn" data-action="clear-filters">絞り込みを解除</button>')
      : emptyState('まだカードがありません。', '<button class="btn primary" data-action="new-card">＋ カードを追加</button><button class="btn" data-action="nav" data-view="import">取り込む</button>');
    return;
  }
  if (state.filters.layout === 'list') {
    el.innerHTML = summary + `<div class="table-wrap"><table class="table">
      <thead><tr><th></th><th>カード</th><th>セット / 番号</th><th>鑑定</th><th>状態</th><th>欠陥</th><th class="r">枚数</th><th class="r">購入価格</th></tr></thead>
      <tbody>${list.map((c) => {
        const img = c.imageData || c.imageUrl;
        const cond = condOf(c);
        return `<tr data-action="open-card" data-id="${c.id}" tabindex="0">
          <td><span class="thumb">${img ? `<img src="${esc(img)}" loading="lazy" referrerpolicy="no-referrer" alt="">` : ''}</span></td>
          <td><strong>${esc(title(c))}</strong><br><span class="muted small">${esc(c.rarity)}</span></td>
          <td class="small">${esc([c.setCode, c.setName].filter(Boolean).join(' '))}<br>${esc(c.number)}</td>
          <td>${esc(c.grade !== '未鑑定' ? c.grade : '')}</td>
          <td>${cond.overall ? `<span class="badge rating r-${esc(cond.overall)}">${esc(cond.overall)}</span>` : '<span class="muted small">未評価</span>'}</td>
          <td class="small">${esc(activeDefects(cond).map(([k, l]) => `${l}(${SEVERITY_LABEL[cond.defects[k]]})`).join('、'))}</td>
          <td class="r">${qty(c)}</td><td class="r">${yen(c.purchasePrice || null)}</td></tr>`;
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
    return { ...g, total, base, secret, value: sum(g.cards, cardCost), qty: sum(g.cards, qty) };
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
      const target = num(c.targetPrice);
      const img = c.imageData || c.imageUrl;
      return `<div class="wish-row">
        <button class="wish-main" data-action="open-card" data-id="${c.id}">
          <span class="thumb">${img ? `<img src="${esc(img)}" loading="lazy" referrerpolicy="no-referrer" alt="">` : ''}</span>
          <span class="wish-info"><strong>${esc(title(c))}</strong>
            <span class="muted small">${esc([c.rarity, c.setCode, c.number, c.grade !== '未鑑定' ? c.grade : ''].filter(Boolean).join(' · '))}</span></span>
          <span class="wish-prices"><span class="small muted">目標</span> ${yen(target || null)}</span>
        </button>
        <button class="btn small" data-action="got-wish" data-id="${c.id}">入手した</button>
      </div>`;
    }).join('')}</div>` : emptyState('ほしいカードを目標価格と一緒に登録できます。')}`;
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
  state.editing.cond = condOf(state.editing);
  cardForm().innerHTML = '';
  renderCardForm();
  cardDlg().showModal();
}

function renderCardForm() {
  const c = state.editing;
  const isNew = !state.cards.some((x) => x.id === c.id && !x.deleted);
  const img = c.imageData || c.imageUrl;
  // 再描画してもスクロール位置を保つ
  const scroll = $('.dlg-body', cardForm())?.scrollTop || 0;
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

      ${c.status === 'wish' ? '' : condSectionHtml(c)}
    </div>
    <footer class="dlg-foot">
      ${isNew ? '' : '<button type="button" class="btn danger ghost" data-action="delete-card">削除</button>'}
      <span class="spacer"></span>
      <button type="button" class="btn ghost" data-action="close-card">キャンセル</button>
      <button type="submit" class="btn primary">保存</button>
    </footer>`;
  const body = $('.dlg-body', cardForm());
  if (body) body.scrollTop = scroll;
}

// 状態チェック欄
function condSectionHtml(c) {
  const cond = c.cond;
  const chip = (name, value, label, cur, cls = '') => `<label class="chip ${cls}"><input type="radio" name="${name}" value="${value}" ${value === cur ? 'checked' : ''}><span>${label}</span></label>`;
  const centInputs = (side, label) => {
    const v = cond.centering[side];
    const inp = (k, ph) => `<input class="c-${k}" type="number" inputmode="decimal" min="0" step="0.05" name="cond.centering.${side}.${k}" value="${esc(v[k])}" placeholder="${ph}" aria-label="${label} ${ph}の枠幅" data-cent="${side}">`;
    return `<div class="cent-side">
      <div class="cent-box">${inp('t', '上')}${inp('l', '左')}<div class="c-card">${label}</div>${inp('r', '右')}${inp('b', '下')}</div>
      <div class="cent-result" id="cent-${side}">${centResultHtml(side, v)}</div></div>`;
  };
  return `
      <section class="sub cond">
        <div class="panel-head"><h3>状態チェック</h3>
          <div class="row" style="margin:0">
            <label class="fld inline" style="margin:0"><span>点検日</span><input type="date" name="cond.inspectedAt" value="${esc(cond.inspectedAt)}"></label>
            <button type="button" class="btn small ghost" data-action="cond-today">今日</button>
          </div></div>

        <h4>総合評価</h4>
        <div class="chips">${chip('cond.overall', '', '未評価', cond.overall)}${COND_RATINGS.map(([k, l]) => chip('cond.overall', k, l, cond.overall, `r-${k}`)).join('')}</div>
        ${fld('ひとこと', 'condition', c.condition, 'text', 'list="dl-cond" placeholder="例: 美品・スリーブ保管"')}

        <h4>センタリング</h4>
        <p class="muted small">表・裏それぞれ、上下左右の枠（ボーダー）の幅を入力すると比率を計算します。単位は mm でも定規の目盛りでも構いません。PSA10 の目安は 表 55:45・裏 75:25 以内です。</p>
        <div class="cent-grid">${centInputs('front', '表')}${centInputs('back', '裏')}</div>

        <h4>欠陥</h4>
        <div class="defects">${DEFECTS.map(([k, l]) => `<div class="defect-row"><span class="defect-name">${l}</span>
          <div class="chips sev">${SEVERITY.map(([v, vl]) => chip(`cond.defects.${k}`, v, vl, cond.defects[k], `sev-${v}`)).join('')}</div></div>`).join('')}</div>

        <h4>白かけの位置</h4>
        <p class="muted small">角・辺をタップして白かけのある位置を記録します。</p>
        <div class="wh-grid">${['front', 'back'].map((side) => whDiagram(side, cond.whiteMarks[side])).join('')}</div>

        <label class="fld"><span>状態の詳細メモ</span><textarea name="cond.note" rows="2" placeholder="例: 裏面右上に0.5mmほどの白かけ。ホロに薄い縦線。">${esc(cond.note)}</textarea></label>

        <h4>状態の写真</h4>
        <div class="cond-photos">
          ${cond.photos.map((ph, i) => `<div class="cphoto"><button type="button" class="cphoto-img" data-action="view-photo" data-idx="${i}" aria-label="写真${i + 1}を拡大"><img src="${esc(ph)}" alt=""></button>
            <button type="button" class="icon-btn del" data-action="del-photo" data-idx="${i}" aria-label="写真${i + 1}を削除">×</button></div>`).join('')}
          ${cond.photos.length < 8 ? '<label class="cphoto add">＋ 写真を追加<input type="file" accept="image/*" multiple data-change="add-photos" hidden></label>' : ''}
        </div>
      </section>`;
}

function centResultHtml(side, v) {
  const r = centeringOf(v, side);
  if (!r) return '<span class="muted small">未計測</span>';
  return `<span class="small">${esc(centeringText(r))}</span>
    <span class="badge ${r.ok ? 'ok' : 'warn'}">${r.ok ? 'PSA10目安内' : '目安外'}</span>`;
}

// 白かけ位置の図（角・辺をタップで切り替え）
function whDiagram(side, marks) {
  const on = (p) => (marks.includes(p) ? ' on' : '');
  const g = (p, shape) => `<g class="wh-pos${on(p)}" data-action="toggle-wh" data-side="${side}" data-pos="${p}" role="button" tabindex="0" aria-pressed="${marks.includes(p)}" aria-label="${side === 'front' ? '表' : '裏'} ${WH_LABEL[p]}"><title>${WH_LABEL[p]}</title>${shape}</g>`;
  const corner = (p, x, y) => g(p, `<circle cx="${x}" cy="${y}" r="10"/>`);
  return `<figure class="wh">
    <svg viewBox="-3 -3 106 142">
      <rect x="10" y="10" width="80" height="116" rx="6" class="wh-card"/>
      <text x="50" y="72" text-anchor="middle" class="wh-label">${side === 'front' ? '表' : '裏'}</text>
      ${corner('tl', 10, 10)}${corner('tr', 90, 10)}${corner('br', 90, 126)}${corner('bl', 10, 126)}
      ${g('t', '<rect x="30" y="4" width="40" height="12" rx="4"/>')}${g('b', '<rect x="30" y="120" width="40" height="12" rx="4"/>')}
      ${g('l', '<rect x="4" y="48" width="12" height="40" rx="4"/>')}${g('r', '<rect x="84" y="48" width="12" height="40" rx="4"/>')}
    </svg>
    <figcaption class="small">${marks.length ? esc(marks.map((p) => WH_LABEL[p]).join('・')) : '<span class="muted">なし</span>'}</figcaption>
  </figure>`;
}

// フォームの入力値を編集中データに反映（再描画前に呼ぶ）
function syncForm() {
  const fd = new FormData(cardForm());
  const c = state.editing;
  for (const [k, v] of fd.entries()) {
    if (k.startsWith('cond.')) {
      // 例: cond.centering.front.l → c.cond.centering.front.l
      const path = k.split('.').slice(1);
      let o = c.cond;
      path.slice(0, -1).forEach((p) => { o = o[p]; });
      o[path[path.length - 1]] = String(v).trim();
    } else if (k === 'tags') c.tags = splitList(v);
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
  'cond-today': () => { syncForm(); state.editing.cond.inspectedAt = today(); renderCardForm(); },
  'toggle-wh': (el) => {
    syncForm();
    const marks = state.editing.cond.whiteMarks[el.dataset.side];
    const i = marks.indexOf(el.dataset.pos);
    if (i >= 0) marks.splice(i, 1); else marks.push(el.dataset.pos);
    // 白かけ位置を付けたのに程度が「なし」なら「軽微」にする
    if (marks.length && state.editing.cond.defects.whitening === 'none') state.editing.cond.defects.whitening = 'light';
    renderCardForm();
  },
  'del-photo': (el) => {
    if (!confirm('この写真を削除しますか？')) return;
    syncForm();
    state.editing.cond.photos.splice(Number(el.dataset.idx), 1);
    renderCardForm();
  },
  'view-photo': (el) => {
    $('#photo-view').src = state.editing.cond.photos[Number(el.dataset.idx)];
    $('#photo-dialog').showModal();
  },
  'close-photo': () => $('#photo-dialog').close(),
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
    c.purchasePrice = c.targetPrice || '';
    state.editing = c;
    renderCardForm();
    cardDlg().showModal();
    toast('購入価格と購入日を確認して保存してください');
  },
  layout: (el) => { state.filters.layout = el.dataset.layout; render(); },
  'clear-filters': () => { Object.assign(state.filters, { q: '', set: '', rarity: '', grade: '', tag: '', cond: '' }); render(); },
  'filter-set': (el) => { Object.assign(state.filters, { q: '', set: el.dataset.key, rarity: '', grade: '', tag: '', cond: '', sort: 'number' }); state.view = 'collection'; render(); },
  'filter-cond': (el) => { Object.assign(state.filters, { q: '', set: '', rarity: '', grade: '', tag: '', cond: el.dataset.cond }); state.view = 'collection'; render(); },
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
  'add-photos': async (el) => {
    const files = [...(el.files || [])];
    if (!files.length) return;
    syncForm();
    const room = 8 - state.editing.cond.photos.length;
    for (const f of files.slice(0, room)) state.editing.cond.photos.push(await resizeImage(f, 1200));
    if (files.length > room) toast('状態の写真は1枚のカードにつき8枚までです', 'error');
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
  // SVG の白かけ位置はキーボードでも切り替え可能に
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('g[data-action]')) { e.preventDefault(); guard(actions['toggle-wh'])(e.target); }
});

document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.dataset.change && changeActions[el.dataset.change]) { guard(changeActions[el.dataset.change])(el); return; }
  if (el.name === 'status' && el.closest('#card-form')) { syncForm(); renderCardForm(); return; }
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
  if (el.dataset.cent) {
    const side = el.dataset.cent;
    const v = Object.fromEntries(['l', 'r', 't', 'b'].map((k) => [k, $(`[name="cond.centering.${side}.${k}"]`).value]));
    $(`#cent-${side}`).innerHTML = centResultHtml(side, v);
    return;
  }
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
