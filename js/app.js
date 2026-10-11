// トレカ・コレクション 本体（画面描画・データ操作・バックアップ）
import { db } from './db.js';
import * as G from './google.js';
import * as P from './parser.js';
import * as AI from './gemini.js';
import { lineChart } from './chart.js';
import * as CR from './cardrush.js';
import * as MK from './market.js';

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

// 画像（File または dataURL）を長辺 max px の JPEG に縮小して dataURL で返す（容量対策）
async function resizeImage(src, max = 800, quality = 0.85) {
  const isFile = src instanceof Blob;
  const url = isFile ? URL.createObjectURL(src) : src;
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const s = Math.min(1, max / Math.max(img.width, img.height));
    const cv = document.createElement('canvas');
    cv.width = Math.round(img.width * s);
    cv.height = Math.round(img.height * s);
    cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
    return cv.toDataURL('image/jpeg', quality);
  } finally {
    if (isFile) URL.revokeObjectURL(url);
  }
}

// 一覧用の小さなサムネイル（数百枚並べても軽いように）
const makeThumb = (src) => resizeImage(src, 240, 0.8);

// ================= 設定・状態 =================

const SETTINGS_KEY = 'tcg-collection-settings';
const DEFAULT_SETTINGS = {
  clientId: '',
  geminiKey: '',
  geminiModel: 'gemini-2.5-flash',
  psaPos: 'mid', // PSA の相場の割合の目安のどこを使うか（low / mid / high）
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

// 一覧で一度に描画する件数（スクロールで追加読み込み）
const PAGE = 60;

// 並び順・表示形式などの UI 設定はこの端末に記憶する
const UI_KEY = 'tcg-collection-ui';
const DEFAULT_FILTERS = { q: '', set: '', rarity: '', grade: '', tag: '', cond: '', sort: 'added-desc', layout: 'grid', density: 'm', group: false };
function loadUi() {
  try { return JSON.parse(localStorage.getItem(UI_KEY) || '{}'); } catch { return {}; }
}
function saveUi() {
  const { q, ...filters } = state.filters;
  try { localStorage.setItem(UI_KEY, JSON.stringify({ filters, filtersOpen: state.filtersOpen, setSort: state.setSort })); } catch { /* 保存不可の環境 */ }
}
const savedUi = loadUi();

const state = {
  settings: loadSettings(),
  cards: [], // 削除済みは { id, deleted:true, updatedAt } の墓標として残す（マージ用）
  sets: [],
  processed: new Set(), // 取込済み・無視したメールID
  view: 'dashboard',
  filters: { ...DEFAULT_FILTERS, ...(savedUi.filters || {}), q: '' },
  filtersOpen: !!savedUi.filtersOpen,
  visible: PAGE, // 一覧で描画済みにする件数
  rendered: 0,
  resultIds: [], // 現在の絞り込み結果（詳細画面の前へ/次へに使う）
  selectMode: false,
  selected: new Set(),
  wishQ: '',
  setQ: '',
  setSort: savedUi.setSort || 'release',
  candidates: [],
  showAllCandidates: false,
  scanning: false,
  editing: null,
  editingOrig: '', // 変更検知用のスナップショット
  editPhotos: {}, // 編集中カードの状態写真 { id: dataURL }
  removedPhotos: new Set(),
  navIds: [],
  cr: null, // カードラッシュ検索ダイアログの状態
  crWalk: false, // 選択したカードを順にカードラッシュで照合中
  marketRun: null, // 相場の一括更新の進捗
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
// カードラッシュ販売価格ベースの相場（1枚あたり）。未取得・取得失敗は null
const marketUnit = (c) => (c.market && c.market.price > 0 ? c.market.price : null);
const marketValue = (c) => (marketUnit(c) ?? 0) * qty(c);
// 自動で選んだ相場のうち、確認したほうがよいもの（理由を返す。問題なければ空文字）
function marketCheck(c) {
  if (marketUnit(c) === null) return '';
  if (!c.number) return '番号がないため名前だけで商品を特定しました';
  if (num(c.purchasePrice) > 0 && c.market.price >= num(c.purchasePrice) * 10) return '購入額の10倍以上です（別版の可能性）';
  return '';
}
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
// unchecked は「未確認」（まだ見ていない）。none の「なし」（確認して問題なし）とは区別する
const SEVERITY = [['unchecked', '未確認'], ['none', 'なし'], ['light', '軽微'], ['moderate', '目立つ'], ['heavy', '重度']];
const isDefect = (v) => !!v && v !== 'none' && v !== 'unchecked';
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
    defects: Object.fromEntries(DEFECTS.map(([k]) => [k, 'unchecked'])),
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

const activeDefects = (cond) => DEFECTS.filter(([k]) => isDefect(cond.defects[k]));
const uncheckedDefects = (cond) => DEFECTS.filter(([k]) => cond.defects[k] === 'unchecked');

// 一覧用の短い状態要約
function condSummary(c) {
  const cond = condOf(c);
  const ds = activeDefects(cond).map(([k, l]) => `${l}(${SEVERITY_LABEL[cond.defects[k]]})`);
  return ds.length ? ds.join('・') : cond.inspectedAt ? '目立つ欠陥なし' : '';
}

// 手持ちの状態 → 相場に使うカードラッシュの状態ランク（normal=無印 / A- / B / C）
function wantedRankOf(c) {
  const cond = condOf(c);
  const o = cond.overall;
  if (o === 'S' || o === 'A') return 'normal';
  if (o === 'B') return 'A-';
  if (o === 'C') return 'B';
  if (o === 'D') return 'C';
  // 未評価なら欠陥の程度から判断する
  const sev = activeDefects(cond).map(([k]) => cond.defects[k]);
  const bent = ['crease', 'dent'].some((k) => ['moderate', 'heavy'].includes(cond.defects[k]));
  if (sev.includes('heavy') || bent) return 'C';
  if (sev.includes('moderate')) return 'B';
  if (sev.includes('light')) return 'A-';
  return 'normal';
}

// 相場の算出条件。これが変わったら相場を取り直す
const marketSig = (c) => [c.name, c.number, c.setCode, c.rarity, MK.normGrade(c.grade), c.sealed ? 1 : 0, wantedRankOf(c),
  /^PSA/.test(MK.normGrade(c.grade)) ? state.settings.psaPos : ''].join('|');

function newCard(preset = {}) {
  return {
    id: crypto.randomUUID(),
    status: 'owned',
    name: '', rawTitle: '', rarity: '', setCode: '', setName: '', number: '',
    quantity: 1, condition: '', grade: '未鑑定', sealed: false,
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

async function deleteCards(ids) {
  const t = nowIso();
  const target = new Set(ids);
  const photoIds = state.cards.filter((c) => target.has(c.id) && !c.deleted).flatMap((c) => c.cond?.photos || []);
  const tombs = new Map(ids.map((id) => [id, { id, deleted: true, updatedAt: t }]));
  await db.putMany('cards', [...tombs.values()]);
  if (photoIds.length) await db.putMany('photos', photoIds.map((id) => ({ id, deleted: true, updatedAt: t })));
  state.cards = state.cards.map((c) => tombs.get(c.id) || c);
  markDirty();
}

// 状態写真をまとめて読み込む
async function loadPhotos(ids) {
  const out = {};
  for (const id of ids || []) {
    const ph = await db.get('photos', id);
    if (ph && !ph.deleted) out[id] = ph.data;
  }
  return out;
}

// 「未確認」追加前のカードは欠陥が初期値の「なし」で保存されている。
// 点検日・総合評価・白かけ位置・メモが空で全項目「なし」のカードは未確認とみなして一度だけ移行する
async function migrateUnchecked() {
  if (await db.get('meta', 'migratedUnchecked')) return 0;
  const t = nowIso();
  const changed = [];
  for (const c of state.cards) {
    if (c.deleted || !c.cond) continue;
    const x = c.cond;
    const untouched = !x.inspectedAt && !x.overall && !x.note
      && !(x.whiteMarks?.front?.length || x.whiteMarks?.back?.length)
      && DEFECTS.every(([k]) => (x.defects?.[k] || 'none') === 'none');
    if (!untouched) continue;
    x.defects = Object.fromEntries(DEFECTS.map(([k]) => [k, 'unchecked']));
    c.updatedAt = t;
    changed.push(c);
  }
  if (changed.length) await db.putMany('cards', changed);
  await db.put('meta', { key: 'migratedUnchecked', at: t });
  if (changed.length) markDirty();
  return changed.length;
}

// 旧形式の移行: カード内に埋め込んだ状態写真を photos ストアへ移し、サムネイルを作る
async function migrateCards() {
  const changed = [];
  for (const c of state.cards) {
    if (c.deleted) continue;
    let touched = false;
    const photos = c.cond?.photos || [];
    if (photos.some((ph) => String(ph).startsWith('data:'))) {
      const ids = [];
      for (const ph of photos) {
        if (!String(ph).startsWith('data:')) { ids.push(ph); continue; }
        const id = crypto.randomUUID();
        await db.put('photos', { id, cardId: c.id, data: ph, updatedAt: c.updatedAt || nowIso() });
        ids.push(id);
      }
      c.cond.photos = ids;
      touched = true;
    }
    if (c.imageData && !c.thumb) {
      try { c.thumb = await makeThumb(c.imageData); touched = true; } catch { /* 壊れた画像は無視 */ }
    }
    if (touched) changed.push(c);
  }
  // 派生データの補完なので updatedAt は変えない
  if (changed.length) await db.putMany('cards', changed);
  return changed.length;
}

async function saveProcessed() {
  await db.put('meta', { key: 'processedMails', ids: [...state.processed] });
}

// ================= バックアップ（Google Drive / ローカル） =================

async function buildBackup() {
  // API キーはバックアップに含めない
  const { geminiKey, ...settings } = state.settings;
  return {
    app: 'tcg-collection',
    version: 2,
    exportedAt: nowIso(),
    cards: state.cards,
    sets: state.sets,
    photos: await db.getAll('photos'),
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
  const photos = mode === 'replace' ? (data.photos || []) : mergeById(await db.getAll('photos'), data.photos || []);
  await db.clear('cards');
  await db.putMany('cards', cards);
  await db.clear('sets');
  await db.putMany('sets', sets);
  await db.clear('photos');
  await db.putMany('photos', photos);
  await saveProcessed();
  state.cards = cards;
  state.sets = sets;
  await migrateCards(); // 旧形式（version 1）のバックアップにも対応
  render();
}

let autoTimer = null;
function markDirty() {
  state.dirty = true;
  updateSyncButton();
  clearTimeout(autoTimer);
  // 連続して編集している間は待ち、落ち着いてから許可済みの保存先へ自動保存（ポップアップは出さない）
  autoTimer = setTimeout(() => autoBackup(), 30_000);
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
      await G.driveSave(token, await buildBackup());
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
  await w.write(JSON.stringify(await buildBackup()));
  await w.close();
  state.settings.lastLocalBackup = nowIso();
  saveSettings();
  return true;
}

async function exportJson() {
  download(`tcg-collection-${today().replace(/-/g, '')}.json`, JSON.stringify(await buildBackup()), 'application/json');
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
  ['相場', (c) => marketUnit(c) ?? ''], ['相場の根拠', (c) => c.market?.error || c.market?.basis || ''], ['相場取得日', (c) => (c.market?.at || '').slice(0, 10)], ['相場の確認', (c) => marketCheck(c)],
  // 状態チェック
  ['未開封', (c) => (c.sealed ? '○' : '')], ['状態評価', (c) => condOf(c).overall], ['点検日', (c) => condOf(c).inspectedAt],
  ['センタリング(表)', (c) => { const r = centeringOf(condOf(c).centering.front, 'front'); return r ? centeringText(r) : ''; }],
  ['センタリング(裏)', (c) => { const r = centeringOf(condOf(c).centering.back, 'back'); return r ? centeringText(r) : ''; }],
  ...DEFECTS.map(([k, l]) => [l, (c) => { const v = condOf(c).defects[k]; return v && v !== 'none' ? SEVERITY_LABEL[v] : ''; }]), // 「なし」は空欄
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
    card.sealed = /^(○|◯|1|true|yes|未開封)$/i.test(get(r, '未開封')) || /未開封/.test(rawTitle);
    card.cond.overall = COND_RATINGS.some(([k]) => k === get(r, '状態評価')) ? get(r, '状態評価') : '';
    card.cond.inspectedAt = normDate(get(r, '点検日'));
    card.cond.note = get(r, '状態詳細メモ');
    // 列があって空欄なら「なし」、列自体がない（旧スプレッドシート）なら「未確認」
    DEFECTS.forEach(([k, l]) => { card.cond.defects[k] = col(l) < 0 ? 'unchecked' : sevByLabel[get(r, l)] || 'none'; });
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
    sealed: /未開封/.test(c.rawTitle),
    imageUrl: c.imageUrl,
  }));
  // カードラッシュで照合済みの候補は正式名と画像を反映
  const withCr = picked.map((c, i) => [c, cards[i]]).filter(([c]) => c.cr);
  for (const [i, [cand, card]] of withCr.entries()) {
    toast(`カードラッシュの画像を取得中… ${i + 1} / ${withCr.length}`);
    await applyCardrush(card, cand.cr);
  }
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
  if (state.view === 'collection') renderResults({ keep: true });
  if (state.view === 'sets') renderSetList();
  if (state.view === 'settings') updateCrStatus();
  if (state.view === 'import') renderScanResults();
  updateSyncButton();
}

// 保存後などに、スクロール位置と読み込み済み件数を保ったまま再描画する
function refreshView() {
  const y = window.scrollY;
  if (state.view === 'collection' && $('#results')) renderResults({ keep: true }); else render();
  window.scrollTo(0, y);
}

const thumbOf = (c) => c.thumb || c.imageData || c.imageUrl;

function tileHtml(c) {
  const img = thumbOf(c);
  const cond = condOf(c);
  const issues = activeDefects(cond).length;
  const sel = state.selected.has(c.id);
  return `
  <button class="tile${sel ? ' sel' : ''}" data-action="open-card" data-id="${c.id}"${state.selectMode ? ` aria-pressed="${sel}"` : ''}>
    <div class="tile-img">
      ${img ? `<img src="${esc(img)}" loading="lazy" decoding="async" referrerpolicy="no-referrer" alt="">` : ''}
      <span class="ph">${esc(title(c).slice(0, 18))}</span>
      ${c.grade && c.grade !== '未鑑定' ? `<span class="badge grade">${esc(c.grade)}</span>` : ''}
      ${c.sealed ? `<span class="badge sealed${c.grade && c.grade !== '未鑑定' ? ' second' : ''}">未開封</span>` : ''}
      ${qty(c) > 1 ? `<span class="badge qty">×${qty(c)}</span>` : ''}
      ${cond.overall ? `<span class="badge rating r-${esc(cond.overall)}" title="状態評価">${esc(cond.overall)}</span>` : ''}
      ${state.selectMode ? '<span class="tick" aria-hidden="true"></span>' : ''}
    </div>
    <div class="tile-body">
      <div class="tile-name">${esc(title(c))}</div>
      <div class="tile-meta">${esc([c.rarity, c.setCode, c.number].filter(Boolean).join(' · ') || '\u00a0')}</div>
      <div class="tile-price">${c.status !== 'wish' && marketUnit(c) !== null
        ? `<span title="相場（カードラッシュ販売価格）${c.market.estimated ? '・推定' : ''}"><small class="mk-label">相場</small>${yen(marketUnit(c))}${c.market.estimated ? '<small class="mk-est">推定</small>' : ''}${marketCheck(c) ? '<small class="mk-est">要確認</small>' : ''}</span>`
        : `<span>${yen(c.status === 'wish' ? c.targetPrice || null : c.purchasePrice || null)}</span>`}
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
  const priced = owned.filter((c) => marketUnit(c) !== null);
  const market = sum(priced, marketValue);
  const pricedCost = sum(priced, cardCost);
  const failed = owned.filter((c) => c.market?.error).length;
  const checks = priced.filter((c) => marketCheck(c));
  const checkValue = sum(checks, marketValue);
  const lastAt = owned.map((c) => c.market?.at || '').sort().pop();
  const topMarket = [...priced].sort((a, b) => marketValue(b) - marketValue(a)).slice(0, 5);
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
      <div class="stat big"><span class="label">相場総額（カードラッシュ販売価格）</span>
        <span class="val">${priced.length ? yen(market) : '-'}</span>
        <span class="small">${priced.length
          ? `${priced.length} / ${owned.length}種類で算出 ・ 同じカードの購入額 ${yen(pricedCost)}（<span class="${market - pricedCost >= 0 ? 'up' : 'down'}">${market - pricedCost >= 0 ? '+' : ''}${yen(market - pricedCost)}</span>）`
          : '下の「相場を更新」で取得できます'}</span>
        ${checks.length ? `<span class="small">うち<button class="link" data-action="filter-cond" data-cond="market-check">要確認 ${checks.length}件</button> ${yen(checkValue)}（確認済みの分だけなら ${yen(market - checkValue)}）</span>` : ''}
        <span class="muted small">購入総額 ${yen(cost)}</span></div>
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
    <section class="panel">
      <div class="panel-head"><h2>相場（カードラッシュ販売価格）</h2>
        <div class="row" style="margin:0">
          <button class="btn small" data-action="market-all">相場を更新</button>
          <button class="btn small ghost" data-action="market-all" data-force="1" title="24時間以内に取得済みのカードも取り直す">すべて取り直す</button>
        </div></div>
      <p class="muted small">手持ちの状態に合わせて、カードラッシュの販売価格（無印＝美品／状態A-／B／C／鑑定品）を選んで相場にします。総合評価 S・A→無印、B→状態A-、C→状態B、D→状態C（未評価は欠陥チェックから判断）。該当する状態の商品がないときは別の状態の価格から換算した「推定」です。
        ${lastAt ? `最終更新 ${esc(new Date(lastAt).toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' }))}。` : ''}
        ${failed ? `<button class="link" data-action="filter-cond" data-cond="market-error">取得できなかったカード ${failed}件</button>（カードラッシュで照合して番号・型番を入れると取得できます）` : ''}</p>
      ${topMarket.length ? `<ol class="rank">${topMarket.map((c) => `<li><button class="rank-row" data-action="open-card" data-id="${c.id}">
        <span class="rank-name">${esc(title(c))}${marketCheck(c) ? ' <span class="badge warn">要確認</span>' : ''}<small>${esc(marketCheck(c) || c.market.basis)}</small></span>
        <span class="rank-val">${yen(marketValue(c))}${qty(c) > 1 ? `<small class="muted"> (${qty(c)}枚)</small>` : ''}</span></button></li>`).join('')}</ol>` : ''}
    </section>
    <section class="panel"><h2>購入額の推移</h2><div id="asset-chart"></div></section>
    <section class="panel"><div class="panel-head"><h2>最近追加したカード</h2>
      <button class="link" data-action="nav" data-view="collection">すべて見る</button></div>
      <div class="grid">${recent.map(tileHtml).join('')}</div></section>`;
}

// ---------- コレクション ----------

const COND_FILTERS = [
  ...COND_RATINGS.map(([k, l]) => [k, `評価 ${l}`]),
  ['unrated', '未評価'], ['issues', '欠陥あり'], ['crease', '折れ・へこみあり'], ['unchecked-items', '欠陥に未確認の項目あり'], ['center-ng', 'センタリング基準外'],
  ['sealed', '未開封'], ['opened', '未開封以外'],
  ['market-none', '相場が未取得'], ['market-error', '相場を取得できなかったカード'], ['market-check', '相場が要確認'],
];
const SORTS = [
  ['added-desc', '登録が新しい順'], ['added-asc', '登録が古い順'], ['purchase-desc', '購入日が新しい順'], ['purchase-asc', '購入日が古い順'],
  ['market-desc', '相場が高い順'], ['market-asc', '相場が低い順'], ['price-desc', '購入価格が高い順'], ['price-asc', '購入価格が低い順'], ['cond', '状態が良い順'], ['name', '名前順'], ['number', 'セット・番号順'],
];
const setLabelOf = (c) => [c.setCode, c.setName].filter(Boolean).join(' ') || 'セット未設定';
const numOf = (c) => P.parseCardNumber(c.number)?.n ?? 9e9;

function filteredCards() {
  const f = state.filters;
  let list = live('owned');
  if (f.q) {
    // 空白区切りの AND 検索
    const words = f.q.toLowerCase().split(/\s+/).filter(Boolean);
    list = list.filter((c) => {
      const text = [c.name, c.rawTitle, c.setName, c.setCode, c.number, c.rarity, c.memo, c.grade, c.shop, c.condition, c.sealed ? '未開封' : '', (c.tags || []).join(' ')].join(' ').toLowerCase();
      return words.every((w) => text.includes(w));
    });
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
      if (f.cond === 'crease') return ['crease', 'dent'].some((k) => isDefect(cond.defects[k]));
      if (f.cond === 'unchecked-items') return uncheckedDefects(cond).length > 0;
      if (f.cond === 'sealed') return !!c.sealed;
      if (f.cond === 'market-none') return !c.market;
      if (f.cond === 'market-error') return !!c.market?.error;
      if (f.cond === 'market-check') return !!marketCheck(c);
      if (f.cond === 'opened') return !c.sealed;
      if (f.cond === 'center-ng') return ['front', 'back'].some((k) => centeringOf(cond.centering[k], k)?.ok === false);
      return cond.overall === f.cond;
    });
  }
  // 比較用の値は先に1回だけ計算しておく（1000件でも並び替えが重くならないように）
  const rank = new Map(list.map((c) => [c.id, 'SABCD'.indexOf(condOf(c).overall) + 1 || 9]));
  const by = {
    'added-desc': (a, b) => String(b.createdAt).localeCompare(String(a.createdAt)),
    'added-asc': (a, b) => String(a.createdAt).localeCompare(String(b.createdAt)),
    'purchase-desc': (a, b) => String(b.purchaseDate || '').localeCompare(String(a.purchaseDate || '')),
    'purchase-asc': (a, b) => String(a.purchaseDate || '9999').localeCompare(String(b.purchaseDate || '9999')),
    'price-desc': (a, b) => num(b.purchasePrice) - num(a.purchasePrice),
    'price-asc': (a, b) => num(a.purchasePrice) - num(b.purchasePrice),
    // 相場未取得は常に最後
    'market-desc': (a, b) => (marketUnit(b) ?? -1) - (marketUnit(a) ?? -1),
    'market-asc': (a, b) => (marketUnit(a) ?? 9e12) - (marketUnit(b) ?? 9e12),
    cond: (a, b) => rank.get(a.id) - rank.get(b.id),
    name: (a, b) => title(a).localeCompare(title(b), 'ja'),
    number: (a, b) => setKey(a).localeCompare(setKey(b)) || numOf(a) - numOf(b),
  };
  const main = by[f.sort] || by['added-desc'];
  // セットごと表示ではセット単位にまとめる（セット未設定は最後）
  const group = (a, b) => (!setKey(a) - !setKey(b)) || setLabelOf(a).localeCompare(setLabelOf(b), 'ja');
  return list.sort(f.group ? (a, b) => group(a, b) || main(a, b) : main);
}

function setOptions() {
  const map = new Map();
  live().forEach((c) => { const k = setKey(c); if (k && !map.has(k)) map.set(k, setLabelOf(c)); });
  return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1], 'ja'));
}

const opt = (value, label, cur) => `<option value="${esc(value)}"${value === cur ? ' selected' : ''}>${esc(label)}</option>`;

function activeFilterChips() {
  const f = state.filters;
  const chips = [];
  if (f.set) chips.push(['set', `セット: ${new Map(setOptions()).get(f.set) || f.set}`]);
  if (f.rarity) chips.push(['rarity', `レアリティ: ${f.rarity}`]);
  if (f.grade) chips.push(['grade', `鑑定: ${f.grade === 'graded' ? '鑑定済み' : f.grade}`]);
  if (f.cond) chips.push(['cond', `状態: ${new Map(COND_FILTERS).get(f.cond) || f.cond}`]);
  if (f.tag) chips.push(['tag', `#${f.tag}`]);
  return chips;
}

function viewCollection() {
  const f = state.filters;
  const owned = live('owned');
  const rarities = [...new Set(owned.map((c) => c.rarity).filter(Boolean))].sort();
  const tags = [...new Set(owned.flatMap((c) => c.tags || []))].sort();
  const grades = [...new Set(owned.map((c) => c.grade || '未鑑定'))].sort();
  const seg = (action, key, cur, items) => items.map(([v, l]) => `<button class="${cur === v ? 'on' : ''}" data-action="${action}" data-${key}="${v}" aria-pressed="${cur === v}">${l}</button>`).join('');
  return `
    <div class="col-toolbar">
      <div class="tb-row">
        <input type="search" id="col-search" class="grow" placeholder="検索（名前・セット・番号・タグ）" value="${esc(f.q)}" data-filter="q" aria-label="検索（/ キーでも移動）">
        <button class="btn${state.filtersOpen ? ' on' : ''}" data-action="toggle-filters" aria-expanded="${state.filtersOpen}" aria-controls="filter-panel">絞り込み</button>
        <select data-filter="sort" aria-label="並び替え">${SORTS.map(([v, l]) => opt(v, l, f.sort)).join('')}</select>
      </div>
      <div class="filter-panel" id="filter-panel"${state.filtersOpen ? '' : ' hidden'}>
        <select data-filter="set" aria-label="セット">${opt('', 'セット: すべて', f.set)}${setOptions().map(([k, l]) => opt(k, l, f.set)).join('')}</select>
        <select data-filter="rarity" aria-label="レアリティ">${opt('', 'レアリティ: すべて', f.rarity)}${rarities.map((r) => opt(r, r, f.rarity)).join('')}</select>
        <select data-filter="grade" aria-label="鑑定">${opt('', '鑑定: すべて', f.grade)}${opt('graded', '鑑定済みすべて', f.grade)}${grades.map((g) => opt(g, g, f.grade)).join('')}</select>
        <select data-filter="cond" aria-label="状態">${opt('', '状態: すべて', f.cond)}${COND_FILTERS.map(([k, l]) => opt(k, l, f.cond)).join('')}</select>
        <select data-filter="tag" aria-label="タグ" ${tags.length ? '' : 'disabled'}>${opt('', tags.length ? 'タグ: すべて' : 'タグなし', f.tag)}${tags.map((t) => opt(t, `#${t}`, f.tag)).join('')}</select>
      </div>
      <div class="tb-row">
        <div class="seg" role="group" aria-label="表示形式">${seg('layout', 'layout', f.layout, [['grid', 'グリッド'], ['list', 'リスト']])}</div>
        ${f.layout === 'grid' ? `<div class="seg" role="group" aria-label="カードの大きさ">${seg('density', 'density', f.density, [['l', '大'], ['m', '中'], ['s', '小']])}</div>` : ''}
        <label class="check small"><input type="checkbox" data-filter="group" ${f.group ? 'checked' : ''}> セットごと</label>
        <span class="spacer"></span>
        <button class="btn${state.selectMode ? ' on' : ''}" data-action="toggle-select">${state.selectMode ? '選択を終了' : '選択'}</button>
        <button class="btn primary" data-action="new-card">＋ 追加</button>
      </div>
      <div id="chips" class="chips-row"></div>
    </div>
    <div id="results"></div>
    <div id="bulk-bar"></div>`;
}

let moreObserver = null;

function renderResults({ keep = false } = {}) {
  const el = $('#results');
  if (!el) return;
  const list = filteredCards();
  state.resultIds = list.map((c) => c.id);
  if (!keep) state.visible = PAGE;
  state.groupCounts = new Map();
  if (state.filters.group) list.forEach((c) => state.groupCounts.set(setKey(c), (state.groupCounts.get(setKey(c)) || 0) + 1));

  // 絞り込み条件のチップ
  const chips = activeFilterChips();
  $('#chips').innerHTML = chips.map(([k, l]) => `<button class="fchip" data-action="remove-filter" data-key="${k}" aria-label="${esc(l)} を解除">${esc(l)}<span aria-hidden="true">×</span></button>`).join('')
    + (chips.length > 1 ? '<button class="link small" data-action="clear-filters">すべて解除</button>' : '');
  const fb = $('[data-action="toggle-filters"]');
  if (fb) fb.innerHTML = `絞り込み${chips.length ? `<span class="count">${chips.length}</span>` : ''}`;

  const summary = `<p class="muted small result-sum">${list.length}種類 / ${sum(list, qty)}枚 ・ 購入額 ${yen(sum(list, cardCost))}${list.some((c) => marketUnit(c) !== null) ? ` ・ 相場 ${yen(sum(list, marketValue))}` : ''}</p>`;
  moreObserver?.disconnect();
  if (!list.length) {
    el.innerHTML = live('owned').length
      ? emptyState('条件に一致するカードがありません。', '<button class="btn" data-action="clear-filters">絞り込みと検索を解除</button>')
      : emptyState('まだカードがありません。', '<button class="btn primary" data-action="new-card">＋ カードを追加</button><button class="btn" data-action="nav" data-view="import">取り込む</button>');
    renderBulkBar();
    return;
  }
  const f = state.filters;
  if (f.layout === 'list') {
    const sortTh = (label, keys, cls = '') => {
      const on = keys.includes(f.sort);
      const arrow = on ? (f.sort.endsWith('-asc') || ['name', 'number', 'cond'].includes(f.sort) ? ' ▲' : ' ▼') : '';
      return `<th class="${cls}"><button class="th-sort${on ? ' on' : ''}" data-action="sort-by" data-sorts="${keys.join(',')}">${label}${arrow}</button></th>`;
    };
    el.innerHTML = summary + `<div class="table-wrap"><table class="table">
      <thead><tr>${state.selectMode ? '<th></th>' : ''}<th></th>${sortTh('カード', ['name'])}${sortTh('セット / 番号', ['number'])}<th>鑑定</th>
        ${sortTh('状態', ['cond'])}<th>欠陥</th><th class="r">枚数</th>${sortTh('購入価格', ['price-desc', 'price-asc'], 'r')}${sortTh('相場', ['market-desc', 'market-asc'], 'r')}${sortTh('購入日', ['purchase-desc', 'purchase-asc'])}</tr></thead>
      <tbody id="rows"></tbody></table></div><div id="more" class="more" aria-live="polite"></div>`;
  } else {
    el.innerHTML = summary + `<div id="rows" class="grid d-${esc(f.density)}"></div><div id="more" class="more" aria-live="polite"></div>`;
  }
  state.rendered = 0;
  appendRows(list, state.visible);
  watchMore(list);
  renderBulkBar();
}

function rowHtml(c) {
  const img = thumbOf(c);
  const cond = condOf(c);
  const sel = state.selected.has(c.id);
  return `<tr class="${sel ? 'sel' : ''}" data-action="open-card" data-id="${c.id}" tabindex="0">
    ${state.selectMode ? `<td><span class="tick" aria-hidden="true"></span></td>` : ''}
    <td><span class="thumb">${img ? `<img src="${esc(img)}" loading="lazy" decoding="async" referrerpolicy="no-referrer" alt="">` : ''}</span></td>
    <td><strong>${esc(title(c))}</strong><br><span class="muted small">${esc(c.rarity)}</span></td>
    <td class="small">${esc([c.setCode, c.setName].filter(Boolean).join(' '))}<br>${esc(c.number)}</td>
    <td>${esc(c.grade !== '未鑑定' ? c.grade : '')}${c.sealed ? ' <span class="badge sealed-inline">未開封</span>' : ''}</td>
    <td>${cond.overall ? `<span class="badge rating r-${esc(cond.overall)}">${esc(cond.overall)}</span>` : '<span class="muted small">未評価</span>'}</td>
    <td class="small">${esc(activeDefects(cond).map(([k, l]) => `${l}(${SEVERITY_LABEL[cond.defects[k]]})`).join('、'))}</td>
    <td class="r">${qty(c)}</td><td class="r">${yen(c.purchasePrice || null)}</td>
    <td class="r">${marketUnit(c) !== null ? `${yen(marketUnit(c))}${c.market.estimated ? '<br><small class="mk-est">推定</small>' : ''}${marketCheck(c) ? '<br><small class="mk-est">要確認</small>' : ''}` : c.market?.error ? '<small class="muted">取得不可</small>' : ''}</td>
    <td class="small">${esc(c.purchaseDate || '')}</td></tr>`;
}

function groupHeadHtml(c, isList) {
  const n = state.groupCounts.get(setKey(c)) || 0;
  const label = `${esc(setLabelOf(c))} <span class="muted small">${n}種類</span>`;
  return isList
    ? `<tr class="group-row"><td colspan="${state.selectMode ? 12 : 11}">${label}</td></tr>`
    : `<h3 class="group-head">${label}</h3>`;
}

// list の [描画済み, upto) を末尾に追加する
function appendRows(list, upto) {
  const rows = $('#rows');
  if (!rows) return;
  const from = state.rendered;
  const to = Math.min(upto, list.length);
  if (to > from) {
    const isList = state.filters.layout === 'list';
    let html = '';
    for (let i = from; i < to; i++) {
      const c = list[i];
      if (state.filters.group && (i === 0 || setKey(c) !== setKey(list[i - 1]))) html += groupHeadHtml(c, isList);
      html += isList ? rowHtml(c) : tileHtml(c);
    }
    rows.insertAdjacentHTML('beforeend', html);
    state.rendered = to;
  }
  const more = $('#more');
  if (more) more.textContent = state.rendered < list.length ? `${state.rendered} / ${list.length} 件を表示中（スクロールで続きを表示）` : '';
}

// 一覧の末尾が見えたら続きを描画する
function watchMore(list) {
  const more = $('#more');
  if (!more || state.rendered >= list.length || !('IntersectionObserver' in window)) return;
  const near = () => more.getBoundingClientRect().top < window.innerHeight + 800;
  moreObserver = new IntersectionObserver((entries) => {
    if (!entries.some((e) => e.isIntersecting)) return;
    // 追加しても末尾が画面付近に残る場合は続けて追加
    do {
      state.visible = state.rendered + PAGE;
      appendRows(list, state.visible);
    } while (state.rendered < list.length && near());
    if (state.rendered >= list.length) moreObserver.disconnect();
  }, { rootMargin: '800px 0px' });
  moreObserver.observe(more);
}

// ---------- 複数選択・一括操作 ----------

function renderBulkBar() {
  const el = $('#bulk-bar');
  if (!el) return;
  if (!state.selectMode) { el.innerHTML = ''; return; }
  const n = state.selected.size;
  el.innerHTML = `<div class="bulk" role="region" aria-label="一括操作">
    <strong>${n}件選択中</strong>
    <button class="btn small ghost" data-action="select-all">表示中の${state.resultIds.length}件をすべて選択</button>
    ${n ? '<button class="btn small ghost" data-action="select-none">選択解除</button>' : ''}
    <span class="spacer"></span>
    <button class="btn small" data-action="market-selected" ${n ? '' : 'disabled'} title="選択したカードの相場をカードラッシュの販売価格から取得">💴 相場を更新</button>
    <button class="btn small" data-action="cr-walk" ${n ? '' : 'disabled'} title="選択したカードを1枚ずつカードラッシュで照合">🔎 カードラッシュで照合</button>
    <button class="btn small" data-action="bulk-edit" ${n ? '' : 'disabled'}>一括編集</button>
    <button class="btn small danger" data-action="bulk-delete" ${n ? '' : 'disabled'}>削除</button>
  </div>`;
}

function toggleSelected(el) {
  const id = el.dataset.id;
  if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id);
  const on = state.selected.has(id);
  el.classList.toggle('sel', on);
  if (el.tagName === 'BUTTON') el.setAttribute('aria-pressed', String(on));
  renderBulkBar();
}

function openBulk() {
  const n = state.selected.size;
  $('#bulk-form').innerHTML = `
    <header class="dlg-head"><h2>${n}件を一括編集</h2>
      <button type="button" class="icon-btn" data-action="close-bulk" aria-label="閉じる">×</button></header>
    <div class="dlg-body">
      <p class="muted small">入力した項目だけを書き換えます。空欄・「変更しない」の項目はそのままです。</p>
      <div class="grid2">
        <label class="fld"><span>区分</span><select name="status">${opt('', '変更しない', '')}${opt('owned', '所持', '')}${opt('wish', 'ほしいもの', '')}</select></label>
        <label class="fld"><span>状態の総合評価</span><select name="overall">${opt('', '変更しない', '')}${opt('-', '未評価に戻す', '')}${COND_RATINGS.map(([k, l]) => opt(k, l, '')).join('')}</select></label>
        ${fld('点検日', 'inspectedAt', '', 'date')}
        <label class="fld"><span>未開封</span><select name="sealed">${opt('', '変更しない', '')}${opt('yes', '未開封にする', '')}${opt('no', '未開封を外す', '')}</select></label>
        <label class="fld"><span>欠陥の項目</span><select name="defects">${opt('', '変更しない', '')}${opt('unchecked-to-none', '未確認の項目を「なし」にする', '')}${opt('all-unchecked', 'すべて「未確認」に戻す', '')}</select></label>
        ${fld('セットコード', 'setCode', '', 'text')}
        ${fld('セット名', 'setName', '', 'text')}
        ${fld('鑑定', 'grade', '', 'text', 'list="dl-grade"')}
        ${fld('購入先', 'shop', '', 'text', 'list="dl-shop"')}
        ${fld('購入日', 'purchaseDate', '', 'date')}
        ${fld('タグを追加（カンマ区切り）', 'addTags', '', 'text')}
        ${fld('タグを外す（カンマ区切り）', 'removeTags', '', 'text')}
      </div>
    </div>
    <footer class="dlg-foot"><span class="spacer"></span>
      <button type="button" class="btn ghost" data-action="close-bulk">キャンセル</button>
      <button type="submit" class="btn primary">${n}件に適用</button></footer>`;
  $('#bulk-dialog').showModal();
}

async function applyBulk() {
  const fd = new FormData($('#bulk-form'));
  const v = (k) => String(fd.get(k) ?? '').trim();
  const byId = new Map(state.cards.map((c) => [c.id, c]));
  const add = splitList(v('addTags'));
  const rm = new Set(splitList(v('removeTags')));
  const changed = [];
  for (const id of state.selected) {
    const c0 = byId.get(id);
    if (!c0 || c0.deleted) continue;
    const c = structuredClone(c0);
    c.cond = condOf(c);
    if (v('status')) c.status = v('status');
    for (const k of ['setCode', 'setName', 'grade', 'shop', 'purchaseDate']) if (v(k)) c[k] = v(k);
    if (v('overall')) c.cond.overall = v('overall') === '-' ? '' : v('overall');
    if (v('inspectedAt')) c.cond.inspectedAt = v('inspectedAt');
    if (v('sealed')) c.sealed = v('sealed') === 'yes';
    if (v('defects') === 'unchecked-to-none') DEFECTS.forEach(([k]) => { if (c.cond.defects[k] === 'unchecked') c.cond.defects[k] = 'none'; });
    if (v('defects') === 'all-unchecked') { DEFECTS.forEach(([k]) => { c.cond.defects[k] = 'unchecked'; }); c.cond.whiteMarks = { front: [], back: [] }; }
    if (add.length || rm.size) c.tags = [...new Set([...(c.tags || []), ...add])].filter((t) => !rm.has(t));
    changed.push(c);
  }
  await saveCards(changed);
  $('#bulk-dialog').close();
  toast(`${changed.length}件を更新しました`, 'ok');
  refreshView();
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
  return `
    <div class="panel-head"><h1>セット別コンプリート</h1><button class="btn primary" data-action="new-set">＋ セットを登録</button></div>
    <p class="muted small">カードの「セットコード / セット名」と「番号（例: 198/190）」から自動集計します。分母を超える番号（SR・SAR など）はシークレットとして別カウントします。</p>
    <div class="toolbar">
      <input type="search" class="grow" placeholder="セットを検索" value="${esc(state.setQ)}" data-filter="setQ" aria-label="セットを検索">
      <select data-filter="setSort" aria-label="並び替え">
        ${[['release', '発売日が新しい順'], ['progress', 'コンプ率が高い順'], ['qty', '所持枚数が多い順'], ['name', 'セットコード順']].map(([v, l]) => opt(v, l, state.setSort)).join('')}
      </select>
    </div>
    <div id="set-results"></div>`;
}

function renderSetList() {
  const el = $('#set-results');
  if (!el) return;
  const q = state.setQ.toLowerCase();
  const pctOf = (g) => (g.total ? Math.min(100, (g.base / g.total) * 100) : 0);
  const sorters = {
    release: (a, b) => String(b.master?.releaseDate || '').localeCompare(String(a.master?.releaseDate || '')) || b.qty - a.qty,
    progress: (a, b) => pctOf(b) - pctOf(a),
    qty: (a, b) => b.qty - a.qty,
    name: (a, b) => String(a.code || a.name).localeCompare(String(b.code || b.name), 'ja', { numeric: true }),
  };
  const stats = setStats().filter((g) => !q || `${g.code} ${g.name}`.toLowerCase().includes(q)).sort(sorters[state.setSort] || sorters.release);
  el.innerHTML = stats.length ? `<p class="muted small">${stats.length}セット</p><div class="set-list">${stats.map((g) => {
    const pct = pctOf(g);
    return `<div class="set-row">
      <button class="set-main" data-action="filter-set" data-key="${esc(g.key)}">
        <span class="set-title"><span class="code">${esc(g.code || '')}</span> ${esc(g.name || '')}</span>
        <span class="bar"><i style="width:${pct}%"></i></span>
        <span class="set-nums">${g.total ? `${g.base} / ${g.total}（${pct.toFixed(0)}%）` : `${g.base}種`}${g.secret ? ` ＋シークレット ${g.secret}` : ''}
          ・ ${g.qty}枚 ・ ${yen(g.value)}</span>
      </button>
      <button class="btn small ghost" data-action="edit-set" data-key="${esc(g.key)}">編集</button>
    </div>`;
  }).join('')}</div>` : emptyState(q ? '一致するセットがありません。' : 'セット情報のあるカードがまだありません。カードにセットコードと番号を入れるか、AIでカード判定するとここに表示されます。');
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
      const img = thumbOf(c);
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
      const ai = c.cr ? `<div class="ai-line">🔎 ${esc(c.cr.name)}${c.cr.model ? ` [${esc(c.cr.model)}]` : ''}</div>`
        : c.ai ? `<div class="ai-line">✨ ${esc([c.ai.name, c.ai.rarity, [c.ai.setCode, c.ai.setName].filter(Boolean).join(' '), c.ai.number].filter(Boolean).join(' / '))}</div>` : '';
      return `<div class="cand${c.checked ? ' on' : ''}">
        <input type="checkbox" data-change="toggle-cand" data-idx="${i}" ${c.checked ? 'checked' : ''} ${c.status === 'imported' ? 'disabled' : ''} aria-label="選択">
        <span class="thumb">${c.cr?.thumb || c.imageUrl ? `<img src="${esc(c.cr?.thumb || c.imageUrl)}" loading="lazy" referrerpolicy="no-referrer" alt="">` : ''}</span>
        <div class="cand-info">
          <div class="cand-title">${esc(c.rawTitle)}</div>
          <div class="muted small">${esc(c.date)} ・ ${esc(c.shop)} ・ ${yen(c.price)} ・ <a href="${esc(c.mailLink)}" target="_blank" rel="noopener">メールを開く</a></div>
          ${ai}
        </div>
        <span class="badge ${tone}">${label}</span>
        <button class="btn small ghost" data-action="cr-cand" data-idx="${i}" title="カードラッシュで正式名と画像を選ぶ">🔎 照合</button>
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
      <h2>カードラッシュ連携</h2>
      <p class="muted small">カードの正式名・レアリティ・番号・型番と画像を<a href="https://www.cardrush-pokemon.jp/" target="_blank" rel="noopener">カードラッシュ</a>から取得します。カードラッシュは外部のサイトやサーバーから読み込めないため、PC版 Chrome に専用の拡張機能を入れて、そのブラウザで取得します（スマホでは使えません）。</p>
      <p id="cr-status" class="small" aria-live="polite">拡張機能を確認中…</p>
      <details class="small"><summary>拡張機能の入れ方</summary>
        <ol>
          <li><a href="https://github.com/snowpa/tcg-collection-app/archive/refs/heads/main.zip">リポジトリの ZIP</a> をダウンロードして展開する</li>
          <li>Chrome で <code>chrome://extensions</code> を開き、右上の「デベロッパー モード」をオンにする</li>
          <li>「パッケージ化されていない拡張機能を読み込む」で、展開したフォルダ内の <code>chrome-extension</code> フォルダを選ぶ</li>
          <li>このページを再読み込みして「接続テスト」</li>
        </ol></details>
      <div class="row">
        <button class="btn small" data-action="cr-test">接続テスト</button>
        <button class="btn small ghost" data-action="cr-open-site">カードラッシュを開く</button>
      </div>
    </section>

    <section class="panel">
      <h2>相場の計算</h2>
      <p class="muted small">PSA 鑑定品の相場は、カードラッシュの PSA10 の販売価格に次の割合をかけて求めます（PSA10 の販売がない場合は同じグレードの販売価格、なければ未鑑定の価格）。</p>
      <div class="table-wrap"><table class="table psa-table"><thead><tr><th>グレード</th><th class="r">PSA10 を 100% としたときの目安</th></tr></thead>
        <tbody>${Object.keys(MK.PSA_RATIO).sort((a, b) => b - a).map((n) => {
          const [lo, hi] = MK.PSA_RATIO[n];
          const f = (r) => `${Math.round(r * 1000) / 10}%`;
          return `<tr><td>PSA ${n}</td><td class="r">${lo === hi ? f(lo) : `${f(lo)} 〜 ${f(hi)}`}（使用: ${f(MK.psaRatio(n, s.psaPos))}）</td></tr>`;
        }).join('')}</tbody></table></div>
      <label class="fld inline"><span>目安の幅のどこを使うか</span>
        <select data-setting="psaPos">${Object.entries(MK.PSA_POS_LABEL).map(([v, l]) => opt(v, l, s.psaPos)).join('')}</select></label>
      <p class="muted small">変更後はホームの「相場を更新」で PSA 鑑定品の相場が取り直されます。</p>
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

// navIds: 前へ/次へで移動できるカードの並び（一覧から開いたときは絞り込み結果）
async function openCard(id, preset = {}, navIds = null) {
  const base = id ? state.cards.find((c) => c.id === id) : newCard(preset);
  if (!base) return;
  const c = structuredClone(base);
  c.cond = condOf(c);
  state.editing = c;
  state.navIds = navIds || [];
  state.editPhotos = await loadPhotos(c.cond.photos);
  state.removedPhotos = new Set();
  state.editingOrig = JSON.stringify(c);
  cardForm().innerHTML = '';
  renderCardForm();
  if (!cardDlg().open) cardDlg().showModal();
  // 順に照合中なら、開いたカードの検索をすぐ表示
  if (state.crWalk) openCrForEditing();
}

function editingChanged() {
  syncForm();
  return JSON.stringify(state.editing) !== state.editingOrig;
}

// 編集中のカードを保存する。保存したら true
async function commitEditing() {
  syncForm();
  const c = state.editing;
  if (!c.name) { toast('カード名を入力してください', 'error'); return false; }
  const isNew = !state.cards.some((x) => x.id === c.id && !x.deleted);
  // 同じセット・番号・鑑定のカードが登録済みなら枚数をまとめるか確認
  if (isNew && c.status === 'owned' && c.number) {
    const dup = live('owned').find((x) => setKey(x) === setKey(c) && x.number === c.number && (x.grade || '未鑑定') === (c.grade || '未鑑定') && !!x.sealed === !!c.sealed);
    if (dup && confirm(`同じカード「${title(dup)}」（${[dup.setCode, dup.number, dup.grade !== '未鑑定' ? dup.grade : ''].filter(Boolean).join(' ')}）が登録済みです。\n\nOK：登録済みのカードの枚数を +${qty(c)} する\nキャンセル：別のカードとして登録する`)) {
      const d = structuredClone(dup);
      d.quantity = qty(d) + qty(c);
      await saveCard(d);
      toast(`「${title(d)}」を ${d.quantity}枚 にしました`, 'ok');
      return true;
    }
  }
  // 状態写真: 追加分を保存し、外した分は削除の墓標にする
  const t = nowIso();
  const persisted = new Set(state.cards.find((x) => x.id === c.id)?.cond?.photos || []);
  const keep = new Set(c.cond.photos);
  const put = c.cond.photos.filter((id) => !persisted.has(id)).map((id) => ({ id, cardId: c.id, data: state.editPhotos[id], updatedAt: t }));
  const del = [...state.removedPhotos].filter((id) => persisted.has(id) && !keep.has(id)).map((id) => ({ id, deleted: true, updatedAt: t }));
  if (put.length || del.length) await db.putMany('photos', [...put, ...del]);
  await saveCard(c);
  state.editingOrig = JSON.stringify(c);
  return true;
}

// 前後のカードへ移動（変更があれば保存するか確認）
async function goCard(delta) {
  const ids = state.navIds;
  const j = ids.indexOf(state.editing.id) + delta;
  if (j < 0 || j >= ids.length) return;
  if (editingChanged()) {
    if (!confirm('変更を保存して移動しますか？\n（キャンセルするとこのカードに留まります）')) return;
    if (!(await commitEditing())) return;
    refreshView();
  }
  await openCard(ids[j], {}, ids);
}

// ================= 相場（カードラッシュ販売価格） =================

const MARKET_FRESH_MS = 24 * 60 * 60 * 1000;
const verNum = (v) => String(v || '0').split('.').reduce((a, x) => a * 1000 + Number(x || 0), 0);

// 1枚分の相場を取得する（検索語を順に試し、同じカードの商品から状態に合う価格を選ぶ）
async function fetchMarket(c) {
  const target = {
    name: c.name, number: c.number, setCode: c.setCode, rarity: c.rarity, grade: c.grade, sealed: c.sealed, rank: wantedRankOf(c),
    hint: [c.rawTitle, c.memo, c.condition].join(' '), // 1ED・ミラーなどの手がかり
    psaPos: state.settings.psaPos,
  };
  const base = { rank: target.rank, sig: marketSig(c), at: nowIso() };
  if (!c.name) return { ...base, error: 'カード名がありません' };
  let last = { error: '検索結果がありません' };
  for (const q of CR.queryCandidates(c.name, c.number).slice(0, 3)) {
    const r = await CR.search(q);
    if (r.items.length && !('price' in r.items[0])) {
      throw new Error('カードラッシュ連携の拡張機能が古いため価格を取得できません。chrome://extensions で拡張機能を更新してください');
    }
    const est = MK.estimate(target, r.items);
    if (!est.error) return { ...base, ...est };
    last = est;
    if (/特定できません/.test(est.error)) break; // より短い検索語では同名カードがさらに混ざる
  }
  return { ...base, error: last.error };
}

async function updateMarket(cards, { force = false } = {}) {
  if (state.marketRun) { toast('相場を更新中です'); return; }
  const v = await CR.ping();
  if (verNum(v) < verNum('1.1.0')) throw new Error(`カードラッシュ連携の拡張機能（v${v}）が古いため価格を取得できません。chrome://extensions で拡張機能を更新してください`);
  // 新しく取得済みで条件（状態・鑑定など）も変わっていないカードは飛ばす
  const todo = cards.filter((c) => force || !c.market?.at || c.market.sig !== marketSig(c) || Date.now() - new Date(c.market.at).getTime() > MARKET_FRESH_MS);
  if (!todo.length) { toast('すべて24時間以内に取得済みです（「すべて取り直す」で再取得できます）'); return; }
  const run = { done: 0, total: todo.length, ok: 0, ng: 0, stop: false };
  state.marketRun = run;
  renderMarketStatus();
  try {
    for (const c0 of todo) {
      if (run.stop) break;
      const c = structuredClone(state.cards.find((x) => x.id === c0.id) || c0);
      c.market = await fetchMarket(c);
      await saveCard(c); // 1件ずつ保存（途中で止めても取得分は残る）
      run.done++;
      if (c.market.error) run.ng++; else run.ok++;
      renderMarketStatus();
      await sleep(300);
    }
    toast(`相場を更新しました（取得 ${run.ok}件${run.ng ? `・取得できず ${run.ng}件` : ''}${run.stop ? '・中止' : ''}）`, 'ok');
  } finally {
    state.marketRun = null;
    renderMarketStatus();
    refreshView();
  }
}

// 画面下の進捗表示
function renderMarketStatus() {
  const el = $('#market-status');
  const r = state.marketRun;
  if (!r) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  el.innerHTML = `<span>相場を取得中… ${r.done} / ${r.total}（取得 ${r.ok}・不可 ${r.ng}）</span>
    <span class="bar"><i style="width:${(r.done / r.total) * 100}%"></i></span>
    <button class="btn small ghost" data-action="market-stop">中止</button>`;
}

function marketSectionHtml(c) {
  const m = c.market;
  const stale = m && m.sig && m.sig !== marketSig(c);
  return `
      <section class="sub">
        <div class="panel-head"><h3>相場（カードラッシュ販売価格）</h3>
          <button type="button" class="btn small" data-action="market-one">${m ? '相場を取り直す' : '相場を取得'}</button></div>
        ${!m ? '<p class="muted small">未取得です。状態評価・鑑定・未開封に合わせてカードラッシュの販売価格から算出します。</p>'
          : m.error ? `<p class="notice small">取得できませんでした: ${esc(m.error)}</p>`
            : `<p><strong class="mk-price">${yen(m.price)}</strong>${qty(c) > 1 ? ` <span class="muted small">× ${qty(c)}枚 = ${yen(m.price * qty(c))}</span>` : ''}
                ${m.estimated ? ' <span class="badge warn">推定</span>' : ''}${marketCheck(c) ? ' <span class="badge warn">要確認</span>' : ''}</p>
               ${marketCheck(c) ? `<p class="notice small">${esc(marketCheck(c))}。参照先の商品が手持ちのカードと同じか確認してください。違う場合は「🔎 カードラッシュから取得」で正しい商品を選び、相場を取り直してください。</p>` : ''}
               <p class="small">${esc(m.basis)}</p>
               <p class="muted small">参照: <a href="${esc(m.url)}" target="_blank" rel="noopener">${esc(m.listing)}</a></p>`}
        ${m ? `<p class="muted small">取得 ${esc(new Date(m.at).toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' }))}${stale ? ' ・ <strong>状態・鑑定などが変わったため取り直してください</strong>' : ''}</p>` : ''}
      </section>`;
}

// ================= カードラッシュ検索ダイアログ =================

// カードにカードラッシュの商品情報を反映（画像は中継経由で取得して端末に保存）
async function applyCardrush(c, item) {
  const p = CR.parseItem(item);
  c.name = p.name || c.name;
  if (p.rarity) c.rarity = p.rarity;
  if (p.number) c.number = p.number;
  if (p.setCode && p.setCode.toLowerCase() !== String(c.setCode || '').toLowerCase()) {
    c.setCode = p.setCode;
    // セット名は登録済みのセットから補う（なければ空にしてセット型番でまとめる）
    c.setName = state.sets.find((m) => !m.deleted && String(m.code).toLowerCase() === p.setCode.toLowerCase())?.name || '';
  }
  if (p.sealed) c.sealed = true;
  c.cardrushId = item.id;
  c.cardrushUrl = item.url;
  c.imageUrl = item.image;
  try {
    c.imageData = await resizeImage(await CR.imageDataUrl(item.image), 800);
    c.thumb = await makeThumb(c.imageData);
  } catch (e) {
    // 画像だけ取れない場合は直リンク表示にする
    console.warn('カードラッシュ画像の取得失敗', e);
    c.imageData = '';
    c.thumb = item.thumb || '';
  }
}

// 設定画面の拡張機能の状態表示
async function updateCrStatus() {
  const el = $('#cr-status');
  if (!el) return;
  try {
    const v = await CR.ping();
    el.innerHTML = `<span class="badge ok">接続済み</span> 拡張機能 v${esc(v)}`;
  } catch {
    el.innerHTML = '<span class="badge warn">未接続</span> 拡張機能が見つかりません。下の手順で PC版 Chrome に読み込んでください。';
  }
}

// queries: 自動で順に試す検索語（見つかった時点で止める）
function openCrPicker({ queries = [], number = '', heading = 'カードラッシュから選ぶ', onPick }) {
  state.cr = { q: queries[0] || '', number, heading, onPick, items: [], total: 0, page: 0, loading: false, error: '', note: '' };
  renderCrPicker();
  if (!$('#cr-dialog').open) $('#cr-dialog').showModal();
  if (queries.length) guard(crSearch)(1, queries);
  else $('#cr-q')?.focus();
}

async function crSearch(page, fallbacks = null) {
  const cr = state.cr;
  cr.loading = true;
  cr.error = '';
  cr.note = '';
  if (page === 1) cr.items = [];
  renderCrPicker();
  try {
    const tries = fallbacks || [cr.q];
    let r = { items: [], total: 0 };
    for (const q of tries) {
      cr.q = q;
      r = await CR.search(q, page);
      if (state.cr !== cr) return; // 途中で閉じた・検索し直した
      if (r.items.length) break;
    }
    if (fallbacks && cr.q !== tries[0] && r.items.length) cr.note = `「${tries[0]}」では見つからなかったため「${cr.q}」で検索しました。`;
    cr.items = page === 1 ? r.items : [...cr.items, ...r.items];
    cr.total = r.total || cr.items.length;
    cr.page = page;
  } catch (e) {
    cr.error = e.message;
  } finally {
    cr.loading = false;
    if (state.cr === cr) renderCrPicker();
  }
}

function renderCrPicker() {
  const cr = state.cr;
  if (!cr) return;
  // 番号が一致する商品を先頭に、状態ランク付き（中古）を後ろに
  const want = String(cr.number || '').replace(/\s/g, '');
  const scored = cr.items.map((item, i) => {
    const p = CR.parseItem(item);
    return { item, i, p, hit: !!want && p.number === want, used: !!p.condRank, sold: !!item.soldOut };
  }).sort((a, b) => (b.hit - a.hit) || (a.used - b.used) || (a.sold - b.sold) || (a.i - b.i));
  const walk = state.crWalk && cardDlg().open;
  $('#cr-body').innerHTML = `
    <header class="dlg-head"><h2>${esc(cr.heading)}</h2>
      <button type="button" class="icon-btn" data-action="cr-close" aria-label="閉じる">×</button></header>
    <div class="dlg-body">
      <form class="row" id="cr-form" style="margin-top:0">
        <input id="cr-q" class="grow" type="search" value="${esc(cr.q)}" placeholder="カード名（例: マリィ SR）" aria-label="カードラッシュで検索">
        <button class="btn primary" type="submit">検索</button>
      </form>
      ${cr.note ? `<p class="small">${esc(cr.note)}</p>` : ''}
      ${want ? `<p class="muted small">番号「${esc(want)}」に一致する商品を先頭に表示しています。</p>` : ''}
      ${cr.error ? `<div class="notice">${esc(cr.error)}${/ボット確認/.test(cr.error) ? ' <button type="button" class="btn small" data-action="cr-open-site">カードラッシュを開く</button>' : ''}</div>` : ''}
      ${cr.items.length ? `<p class="muted small">${cr.total}件中 ${cr.items.length}件を表示</p>
        <div class="cr-grid">${scored.map(({ item, i, p, hit, used, sold }) => `
          <button type="button" class="cr-item${hit ? ' hit' : ''}" data-action="cr-pick" data-idx="${i}">
            <span class="cr-img"><img src="${esc(item.thumb)}" loading="lazy" referrerpolicy="no-referrer" alt=""></span>
            <span class="cr-name">${esc(p.name)}</span>
            <span class="cr-meta">${esc([p.rarity, p.number, p.setCode].filter(Boolean).join(' · '))}</span>
            <span class="cr-badges">${hit ? '<span class="badge ok">番号一致</span>' : ''}${used ? `<span class="badge warn">${esc(p.condRank)}</span>` : ''}${sold ? '<span class="badge">売切</span>' : ''}</span>
          </button>`).join('')}</div>
        ${cr.items.length < cr.total ? `<div class="row center"><button type="button" class="btn" data-action="cr-more" ${cr.loading ? 'disabled' : ''}>もっと見る</button></div>` : ''}`
      : cr.loading ? '' : cr.page ? '<p class="muted">見つかりませんでした。キーワードを短くしてみてください（例: カード名だけ）。</p>' : ''}
      ${cr.loading ? '<p class="muted small" aria-live="polite">検索中…</p>' : ''}
    </div>
    <footer class="dlg-foot">
      <span class="muted small">画像・名称の出典: カードラッシュ</span><span class="spacer"></span>
      ${walk ? '<button type="button" class="btn ghost" data-action="cr-walk-end">照合を終了</button><button type="button" class="btn" data-action="cr-skip">このカードを飛ばす</button>' : '<button type="button" class="btn ghost" data-action="cr-close">閉じる</button>'}
    </footer>`;
}

// 編集中のカードに対して検索を開く
function openCrForEditing() {
  const c = state.editing;
  const pos = state.navIds.indexOf(c.id);
  openCrPicker({
    queries: CR.queryCandidates(c.name && c.name !== c.rawTitle ? c.name : c.rawTitle || c.name, c.number),
    number: c.number,
    heading: state.crWalk && pos >= 0 ? `カードラッシュで照合（${pos + 1} / ${state.navIds.length}）` : 'カードラッシュから選ぶ',
    onPick: async (item) => {
      syncForm();
      await applyCardrush(state.editing, item);
      // 保存はフォームの値を読み直すので、先に反映後の内容でフォームを描き直す
      renderCardForm();
      if (state.crWalk) {
        // 照合中は保存して次のカードへ
        if (!(await commitEditing())) return;
        refreshView();
        if (pos >= 0 && pos < state.navIds.length - 1) await goCard(1);
        else { state.crWalk = false; renderCardForm(); toast('照合が終わりました', 'ok'); }
      } else {
        toast('カードラッシュの情報を反映しました。内容を確認して保存してください', 'ok');
      }
    },
  });
}

function closeCard() {
  if (editingChanged() && !confirm('保存していない変更があります。破棄して閉じますか？')) return;
  cardDlg().close();
}

function renderCardForm() {
  const c = state.editing;
  const isNew = !state.cards.some((x) => x.id === c.id && !x.deleted);
  const img = c.imageData || c.imageUrl;
  // 再描画してもスクロール位置を保つ
  const scroll = $('.dlg-body', cardForm())?.scrollTop || 0;
  const pos = state.navIds.indexOf(c.id);
  const nav = !isNew && pos >= 0 && state.navIds.length > 1
    ? `<div class="nav-pos">
        <button type="button" class="icon-btn" data-action="card-prev" ${pos <= 0 ? 'disabled' : ''} aria-label="前のカード（←キー）">‹</button>
        <span class="small muted">${pos + 1} / ${state.navIds.length}</span>
        <button type="button" class="icon-btn" data-action="card-next" ${pos >= state.navIds.length - 1 ? 'disabled' : ''} aria-label="次のカード（→キー）">›</button>
      </div>` : '';
  cardForm().innerHTML = `
    <header class="dlg-head">
      <h2>${isNew ? (c.status === 'wish' ? 'ほしいものを追加' : 'カードを追加') : esc(title(c))}</h2>
      ${nav}
      <button type="button" class="icon-btn" data-action="close-card" aria-label="閉じる">×</button>
    </header>
    <div class="dlg-body">
      <div class="card-edit">
        <div class="edit-img">
          <div class="img-box">${img ? `<img src="${esc(img)}" referrerpolicy="no-referrer" alt="">` : ''}<span class="ph">画像なし</span></div>
          <label class="btn small">画像を選択<input type="file" accept="image/*" data-change="pick-image" hidden></label>
          ${img ? '<button type="button" class="btn small ghost" data-action="clear-image">画像を外す</button>' : ''}
          <button type="button" class="btn small" data-action="cr-card">🔎 カードラッシュから取得</button>
          <button type="button" class="btn small ghost" data-action="ai-identify">✨ AIでカード判定</button>
          ${c.cardrushUrl ? `<a class="small" href="${esc(c.cardrushUrl)}" target="_blank" rel="noopener">カードラッシュで見る</a>` : ''}
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
          <label class="check fld-check"><input type="checkbox" name="sealed" ${c.sealed ? 'checked' : ''}> 未開封<span class="muted small">（透明パック入りのプロモなど）</span></label>
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
      ${c.status === 'wish' ? '' : marketSectionHtml(c)}

      ${c.status === 'wish' ? '' : condSectionHtml(c)}
    </div>
    <footer class="dlg-foot">
      ${isNew ? '' : '<button type="button" class="btn danger ghost" data-action="delete-card">削除</button>'}
      <span class="spacer"></span>
      <button type="button" class="btn ghost" data-action="close-card">キャンセル</button>
      ${isNew ? '<button type="button" class="btn" data-action="save-continue" title="セット・購入先・購入日を引き継いで次の1枚を入力">保存して続けて追加</button>' : ''}
      ${!isNew && pos >= 0 && pos < state.navIds.length - 1 ? '<button type="button" class="btn" data-action="save-next">保存して次へ</button>' : ''}
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

        ${c.sealed ? '<p class="notice small">未開封のカードです。パック越しに確認できる範囲で状態を記録してください（見えない項目は「未確認」のままで構いません）。</p>' : ''}
        <h4>総合評価</h4>
        <div class="chips">${chip('cond.overall', '', '未評価', cond.overall)}${COND_RATINGS.map(([k, l]) => chip('cond.overall', k, l, cond.overall, `r-${k}`)).join('')}</div>
        ${fld('ひとこと', 'condition', c.condition, 'text', 'list="dl-cond" placeholder="例: 美品・スリーブ保管"')}

        <h4>センタリング</h4>
        <p class="muted small">表・裏それぞれ、上下左右の枠（ボーダー）の幅を入力すると比率を計算します。単位は mm でも定規の目盛りでも構いません。PSA10 の目安は 表 55:45・裏 75:25 以内です。</p>
        <div class="cent-grid">${centInputs('front', '表')}${centInputs('back', '裏')}</div>

        <div class="panel-head" style="margin:14px 0 6px"><h4 style="margin:0">欠陥</h4>
          ${uncheckedDefects(cond).length ? `<button type="button" class="btn small ghost" data-action="defects-none">未確認の${uncheckedDefects(cond).length}項目を「なし」にする</button>` : ''}</div>
        <div class="defects">${DEFECTS.map(([k, l]) => `<div class="defect-row"><span class="defect-name">${l}</span>
          <div class="chips sev">${SEVERITY.map(([v, vl]) => chip(`cond.defects.${k}`, v, vl, cond.defects[k], `sev-${v}`)).join('')}</div></div>`).join('')}</div>

        <h4>白かけの位置</h4>
        <p class="muted small">角・辺をタップして白かけのある位置を記録します。</p>
        <div class="wh-grid">${['front', 'back'].map((side) => whDiagram(side, cond.whiteMarks[side], cond.defects.whitening)).join('')}</div>

        <label class="fld"><span>状態の詳細メモ</span><textarea name="cond.note" rows="2" placeholder="例: 裏面右上に0.5mmほどの白かけ。ホロに薄い縦線。">${esc(cond.note)}</textarea></label>

        <h4>状態の写真</h4>
        <div class="cond-photos">
          ${cond.photos.map((id, i) => `<div class="cphoto"><button type="button" class="cphoto-img" data-action="view-photo" data-idx="${i}" aria-label="写真${i + 1}を拡大"><img src="${esc(state.editPhotos[id] || '')}" alt=""></button>
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
function whDiagram(side, marks, whitening) {
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
    <figcaption class="small">${marks.length ? esc(marks.map((p) => WH_LABEL[p]).join('・')) : `<span class="muted">${whitening === 'unchecked' ? '未確認' : 'なし'}</span>`}</figcaption>
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
    } else if (k === 'sealed') continue;
    else if (k === 'tags') c.tags = splitList(v);
    else if (k === 'quantity') c.quantity = Math.max(1, Math.floor(num(v)) || 1);
    else if (k === 'purchasePrice' || k === 'targetPrice') c[k] = v === '' ? '' : num(v);
    else c[k] = typeof v === 'string' ? v.trim() : v;
  }
  const sealed = cardForm().querySelector('[name="sealed"]');
  if (sealed) c.sealed = sealed.checked;
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
  nav: (el) => {
    state.view = el.dataset.view;
    state.selectMode = false;
    state.selected.clear();
    render();
    window.scrollTo(0, 0);
  },
  'sync-now': () => syncNow(),
  'new-card': (el) => openCard(null, el.dataset.status ? { status: el.dataset.status, purchaseDate: '' } : {}),
  'open-card': (el) => {
    const inResults = !!el.closest('#results');
    if (inResults && state.selectMode) { toggleSelected(el); return; }
    return openCard(el.dataset.id, {}, inResults ? state.resultIds : null);
  },
  'close-card': () => closeCard(),
  'cr-card': () => { syncForm(); openCrForEditing(); },
  'market-one': async (el) => {
    syncForm();
    el.disabled = true;
    el.textContent = '取得中…';
    try {
      state.editing.market = await fetchMarket(state.editing);
      renderCardForm();
      toast(state.editing.market.error ? '相場を取得できませんでした' : '相場を取得しました。保存すると反映されます', state.editing.market.error ? 'error' : 'ok');
    } finally { el.disabled = false; }
  },
  'market-all': (el) => updateMarket(live('owned'), { force: !!el.dataset.force }),
  'market-selected': () => updateMarket(live('owned').filter((c) => state.selected.has(c.id)), { force: true }),
  'market-stop': () => { if (state.marketRun) state.marketRun.stop = true; },
  'cr-cand': (el) => {
    const cand = state.candidates[Number(el.dataset.idx)];
    openCrPicker({
      queries: CR.queryCandidates(cand.ai?.name || cand.rawTitle, cand.ai?.number),
      number: cand.ai?.number || '',
      onPick: (item) => { cand.cr = item; if (cand.status !== 'imported') cand.checked = true; renderScanResults(); },
    });
  },
  'cr-pick': async (el) => {
    const cr = state.cr;
    const item = cr.items[Number(el.dataset.idx)];
    $('#cr-dialog').close();
    state.cr = null;
    if (cardDlg().open) toast('カードラッシュから取得中…');
    await cr.onPick(item);
  },
  'cr-more': () => crSearch(state.cr.page + 1),
  'cr-close': () => { state.cr = null; $('#cr-dialog').close(); },
  'cr-skip': async () => { state.cr = null; $('#cr-dialog').close(); if (state.navIds.indexOf(state.editing.id) < state.navIds.length - 1) await goCard(1); else state.crWalk = false; },
  'cr-walk-end': () => { state.crWalk = false; state.cr = null; $('#cr-dialog').close(); },
  'cr-walk': async () => {
    // 選択したカードを一覧の並び順で1枚ずつ照合
    const ids = state.resultIds.filter((id) => state.selected.has(id));
    if (!ids.length) return;
    await CR.ping(); // 拡張機能がなければここでエラー表示
    state.crWalk = true;
    await openCard(ids[0], {}, ids);
  },
  'cr-test': async (el) => {
    el.disabled = true;
    try {
      const v = await CR.ping();
      const r = await CR.search('ピカチュウ');
      toast(`接続できました（拡張機能 v${v}、「ピカチュウ」の検索結果 ${r.total}件）`, 'ok');
    } finally { el.disabled = false; updateCrStatus(); }
  },
  'cr-open-site': async () => {
    try { await CR.openSite(); } catch { window.open('https://www.cardrush-pokemon.jp/', '_blank', 'noopener'); }
  },
  'card-prev': () => goCard(-1),
  'card-next': () => goCard(1),
  'save-next': async () => {
    if (!(await commitEditing())) return;
    refreshView();
    toast('保存しました', 'ok');
    await goCard(1);
  },
  'save-continue': async () => {
    const c = state.editing;
    if (!(await commitEditing())) return;
    refreshView();
    // 同じセットの続きを入力しやすいよう、共通しそうな項目を引き継ぐ
    await openCard(null, { status: c.status, setCode: c.setCode, setName: c.setName, shop: c.shop, purchaseDate: c.purchaseDate, rarity: '' });
    toast('保存しました。続けて入力できます', 'ok');
    $('#card-form [name="name"]')?.focus();
  },
  'clear-image': () => { syncForm(); state.editing.imageData = ''; state.editing.imageUrl = ''; state.editing.thumb = ''; renderCardForm(); },
  'ai-identify': (el) => aiIdentifyEditing(el),
  'cond-today': () => { syncForm(); state.editing.cond.inspectedAt = today(); renderCardForm(); },
  'defects-none': () => {
    syncForm();
    DEFECTS.forEach(([k]) => { if (state.editing.cond.defects[k] === 'unchecked') state.editing.cond.defects[k] = 'none'; });
    renderCardForm();
  },
  'toggle-wh': (el) => {
    syncForm();
    const marks = state.editing.cond.whiteMarks[el.dataset.side];
    const i = marks.indexOf(el.dataset.pos);
    if (i >= 0) marks.splice(i, 1); else marks.push(el.dataset.pos);
    // 白かけ位置を付けたのに程度が「なし」なら「軽微」にする
    if (marks.length && !isDefect(state.editing.cond.defects.whitening)) state.editing.cond.defects.whitening = 'light';
    renderCardForm();
  },
  'del-photo': (el) => {
    if (!confirm('この写真を削除しますか？')) return;
    syncForm();
    const [id] = state.editing.cond.photos.splice(Number(el.dataset.idx), 1);
    state.removedPhotos.add(id);
    renderCardForm();
  },
  'view-photo': (el) => {
    $('#photo-view').src = state.editPhotos[state.editing.cond.photos[Number(el.dataset.idx)]] || '';
    $('#photo-dialog').showModal();
  },
  'close-photo': () => $('#photo-dialog').close(),
  'delete-card': async () => {
    if (!confirm(`「${title(state.editing)}」を削除しますか？`)) return;
    await deleteCards([state.editing.id]);
    cardDlg().close();
    refreshView();
  },
  'got-wish': async (el) => {
    await openCard(el.dataset.id);
    const c = state.editing;
    c.status = 'owned';
    c.purchaseDate = today();
    c.purchasePrice = c.targetPrice || '';
    renderCardForm();
    toast('購入価格と購入日を確認して保存してください');
  },
  layout: (el) => { state.filters.layout = el.dataset.layout; saveUi(); render(); },
  density: (el) => { state.filters.density = el.dataset.density; saveUi(); render(); },
  'toggle-filters': (el) => {
    state.filtersOpen = !state.filtersOpen;
    $('#filter-panel').hidden = !state.filtersOpen;
    el.classList.toggle('on', state.filtersOpen);
    el.setAttribute('aria-expanded', String(state.filtersOpen));
    saveUi();
  },
  'remove-filter': (el) => { state.filters[el.dataset.key] = ''; saveUi(); render(); },
  'clear-filters': () => { Object.assign(state.filters, { q: '', set: '', rarity: '', grade: '', tag: '', cond: '' }); saveUi(); render(); },
  'sort-by': (el) => {
    // 列見出しのクリック: 同じ列なら昇順/降順を切り替え
    const keys = el.dataset.sorts.split(',');
    const i = keys.indexOf(state.filters.sort);
    state.filters.sort = keys[i >= 0 ? (i + 1) % keys.length : 0];
    saveUi();
    render();
  },
  'filter-set': (el) => { Object.assign(state.filters, { q: '', set: el.dataset.key, rarity: '', grade: '', tag: '', cond: '', sort: 'number' }); saveUi(); state.view = 'collection'; render(); window.scrollTo(0, 0); },
  'filter-cond': (el) => { Object.assign(state.filters, { q: '', set: '', rarity: '', grade: '', tag: '', cond: el.dataset.cond }); saveUi(); state.view = 'collection'; render(); window.scrollTo(0, 0); },
  'toggle-select': () => { state.selectMode = !state.selectMode; state.selected.clear(); render(); },
  'select-all': () => { state.resultIds.forEach((id) => state.selected.add(id)); refreshView(); },
  'select-none': () => { state.selected.clear(); refreshView(); },
  'bulk-edit': () => openBulk(),
  'close-bulk': () => $('#bulk-dialog').close(),
  'bulk-delete': async () => {
    const n = state.selected.size;
    if (!confirm(`選択した${n}件のカードを削除しますか？`)) return;
    await deleteCards([...state.selected]);
    state.selected.clear();
    toast(`${n}件を削除しました`);
    refreshView();
  },
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
    await Promise.all([db.clear('cards'), db.clear('sets'), db.clear('meta'), db.clear('photos')]);
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
    state.editing.thumb = await makeThumb(state.editing.imageData);
    renderCardForm();
  },
  'add-photos': async (el) => {
    const files = [...(el.files || [])];
    if (!files.length) return;
    syncForm();
    const room = 8 - state.editing.cond.photos.length;
    for (const f of files.slice(0, room)) {
      const id = crypto.randomUUID();
      state.editPhotos[id] = await resizeImage(f, 1200);
      state.editing.cond.photos.push(id);
    }
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

const isTyping = (el) => el?.matches?.('input, textarea, select, [contenteditable="true"]');

document.addEventListener('keydown', (e) => {
  // テーブル行のキーボード操作
  if (e.key === 'Enter' && e.target.matches('tr[data-action]')) e.target.click();
  // カード詳細: ←/→ で前後のカードへ
  if (cardDlg().open && !isTyping(e.target) && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && state.navIds.length > 1) {
    e.preventDefault();
    guard(goCard)(e.key === 'ArrowLeft' ? -1 : 1);
    return;
  }
  // 「/」で検索欄へ
  if (e.key === '/' && !isTyping(e.target) && !document.querySelector('dialog[open]')) {
    const search = $('#col-search') || $('[data-filter="setQ"]') || $('[data-filter="wishQ"]');
    if (search) { e.preventDefault(); search.focus(); search.select(); }
  }
  // SVG の白かけ位置はキーボードでも切り替え可能に
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('g[data-action]')) { e.preventDefault(); guard(actions['toggle-wh'])(e.target); }
});

document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.dataset.change && changeActions[el.dataset.change]) { guard(changeActions[el.dataset.change])(el); return; }
  if ((el.name === 'status' || el.name === 'sealed') && el.closest('#card-form')) { syncForm(); renderCardForm(); return; }
  if (el.dataset.setting) {
    const k = el.dataset.setting;
    state.settings[k] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? num(el.value) : el.value.trim();
    saveSettings();
    if (k === 'clientId' && state.settings.clientId) G.loadGis().catch(() => {});
    if (['clientId', 'autoDrive', 'psaPos'].includes(k)) render();
    return;
  }
  if (el.dataset.source !== undefined) {
    const src = state.settings.sources[Number(el.dataset.source)];
    src[el.dataset.field] = el.type === 'checkbox' ? el.checked : el.value.trim();
    saveSettings();
    return;
  }
  if (el.dataset.filter === 'setSort') { state.setSort = el.value; saveUi(); renderSetList(); return; }
  if (el.dataset.filter && !['q', 'wishQ', 'setQ'].includes(el.dataset.filter)) {
    state.filters[el.dataset.filter] = el.type === 'checkbox' ? el.checked : el.value;
    saveUi();
    renderResults();
  }
});

let searchTimer = null;

document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.dataset.cent) {
    const side = el.dataset.cent;
    const v = Object.fromEntries(['l', 'r', 't', 'b'].map((k) => [k, $(`[name="cond.centering.${side}.${k}"]`).value]));
    $(`#cent-${side}`).innerHTML = centResultHtml(side, v);
    return;
  }
  if (el.dataset.filter === 'q') {
    // 入力のたびに1000件を描き直さないよう少し待つ
    state.filters.q = el.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => renderResults(), 180);
  }
  if (el.dataset.filter === 'setQ') { state.setQ = el.value; renderSetList(); }
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
    if (!(await commitEditing())) return;
    cardDlg().close();
    refreshView();
    toast('保存しました', 'ok');
  }));
  // Esc で閉じるときも未保存の変更を確認
  cardDlg().addEventListener('cancel', (e) => {
    if (editingChanged() && !confirm('保存していない変更があります。破棄して閉じますか？')) e.preventDefault();
  });
  $('#bulk-form').addEventListener('submit', guard(async (e) => { e.preventDefault(); await applyBulk(); }));
  cardDlg().addEventListener('close', () => { state.crWalk = false; });
  $('#cr-dialog').addEventListener('submit', (e) => {
    if (e.target.id !== 'cr-form') return;
    e.preventDefault();
    state.cr.q = $('#cr-q').value.trim();
    guard(crSearch)(1);
  });
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
  // 旧形式データの移行（写真の分離・サムネイル作成）は表示後に行う
  if (await migrateCards()) refreshView();
  if (await migrateUnchecked()) refreshView();
  // 一覧のツールバーをヘッダー（PC ではメニューも）の下に固定する位置
  const stickyTop = () => {
    const nav = $('#nav');
    const navH = getComputedStyle(nav).position === 'sticky' ? nav.offsetHeight : 0;
    document.documentElement.style.setProperty('--sticky-top', `${$('.app-head').offsetHeight + navH}px`);
  };
  stickyTop();
  window.addEventListener('resize', stickyTop);
  // 画面を離れるときは待たずに自動バックアップ
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') autoBackup(); });

  if (state.settings.clientId) G.loadGis().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('SW登録失敗', e));
  }
  // 永続ストレージを要求（ブラウザによる自動削除を防ぐ）
  navigator.storage?.persist?.().catch(() => {});
}

init().catch((e) => { console.error(e); toast(`起動に失敗しました: ${e.message}`, 'error'); });
