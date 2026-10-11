/**
 * カードラッシュ（ポケモン）検索の中継用 Google Apps Script
 *
 * GitHub Pages 上のアプリからはカードラッシュを直接読めない（CORS 非対応）ため、
 * このスクリプトをウェブアプリとして公開し、検索結果と画像を JSON で返す。
 * カードラッシュ以外の URL にはアクセスしない。
 */
const CR_BASE = 'https://www.cardrush-pokemon.jp';
const CR_IMAGE_PREFIX = '/data/cardrushpokemon/';
const CR_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const CACHE_SECONDS = 6 * 60 * 60; // 同じ検索は6時間キャッシュしてアクセス回数を抑える

function doGet(e) {
  const p = (e && e.parameter) || {};
  let out;
  try {
    if (p.action === 'search') out = crSearch(p.q || '', Number(p.page || 1));
    else if (p.action === 'image') out = crImage(p.path || '');
    else out = { ok: true, service: 'cardrush-proxy', version: 1 };
  } catch (err) {
    out = { error: String((err && err.message) || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function crFetch(url) {
  const res = UrlFetchApp.fetch(url, {
    headers: { 'User-Agent': CR_UA, 'Accept-Language': 'ja,en;q=0.8' },
    muteHttpExceptions: true,
    followRedirects: true,
  });
  const code = res.getResponseCode();
  if (code !== 200) throw new Error('カードラッシュへのアクセスに失敗しました（HTTP ' + code + '）');
  return res;
}

function crSearch(q, page) {
  q = String(q).trim();
  if (!q) return { items: [], total: 0 };
  page = Math.max(1, Math.min(50, page || 1));
  const cache = CacheService.getScriptCache();
  const key = 'search:' + Utilities.base64EncodeWebSafe(q + '|' + page).slice(0, 200);
  const hit = cache.get(key);
  if (hit) return JSON.parse(hit);

  const url = CR_BASE + '/product-list?keyword=' + encodeURIComponent(q) + (page > 1 ? '&page=' + page : '');
  const out = parseCardrushList(crFetch(url).getContentText('UTF-8'));
  out.page = page;
  try { cache.put(key, JSON.stringify(out), CACHE_SECONDS); } catch (e) { /* 100KB 超はキャッシュしない */ }
  return out;
}

// 画像を base64 で返す（カードラッシュの画像パスのみ許可）
function crImage(path) {
  path = String(path);
  if (path.indexOf(CR_IMAGE_PREFIX) !== 0 || path.indexOf('..') >= 0) throw new Error('許可されていない画像パスです');
  const blob = crFetch(CR_BASE + path).getBlob();
  return { mimeType: blob.getContentType() || 'image/jpeg', base64: Utilities.base64Encode(blob.getBytes()) };
}

// ---------- HTML 解析（Node でもテストできるよう純粋関数にしている） ----------

function parseCardrushList(html) {
  // 件数は「3,702」のようにカンマ区切り
  const total = Number(((html.match(/class="number">([\d,]+)</) || [])[1] || '0').replace(/,/g, ''));
  const items = [];
  const re = /<div class="item_data" data-product-id="(\d+)">([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) && items.length < 100) {
    const block = m[2];
    const name = crText((block.match(/<span class="goods_name">([\s\S]*?)<\/span>\s*(?:<wbr|<\/p>)/) || [])[1] || '');
    if (!name) continue;
    const model = crText((block.match(/class="model_number_value">([^<]*)</) || [])[1] || '');
    const img = block.match(/<img src="([^"]+)"(?: data-x2="([^"]+)")?/) || [];
    const thumb = img[2] || img[1] || '';
    items.push({
      id: m[1],
      name: name,
      model: model,
      thumb: thumb,
      image: crOriginalImage(thumb),
      url: CR_BASE + '/product/' + m[1],
      // 売り切れは在庫数の表示がなく、サムネイルに「SOLD OUT」（16進で 534f4c44204f5554）が重ねられる
      soldOut: /534f4c44204f5554/i.test(thumb) || !/class="stock"/.test(block),
    });
  }
  return { items: items, total: total };
}

// 一覧のサムネイル URL（…/_/<元画像パスの16進>00<サイズ情報>.jpg）から元画像の URL を復元する
function crOriginalImage(thumb) {
  const m = String(thumb).match(/\/_\/([0-9a-f]+)\.\w+$/i);
  if (!m) return thumb;
  let path = '';
  for (let i = 0; i + 1 < m[1].length; i += 2) {
    const code = parseInt(m[1].substr(i, 2), 16);
    if (code === 0) break;
    path += String.fromCharCode(code);
  }
  return /^product\/[\w.-]+$/.test(path) ? CR_BASE + CR_IMAGE_PREFIX + path : thumb;
}

function crText(s) {
  return String(s)
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
