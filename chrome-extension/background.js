// トレカ・コレクション → カードラッシュ連携（Chrome 拡張機能のバックグラウンド）
//
// カードラッシュは外部サイトから直接読み込めず（CORS 非対応）、サーバー経由のアクセスもボット対策で拒否されるため、
// 利用者自身の Chrome で取得して、アプリ（externally_connectable で許可したページ）に結果を返す。

const CR_BASE = 'https://www.cardrush-pokemon.jp';
const CR_IMAGE_PREFIX = '/data/cardrushpokemon/';
const VERSION = chrome.runtime.getManifest().version;
const CACHE_MS = 6 * 60 * 60 * 1000; // 同じ検索は6時間キャッシュしてアクセス回数を抑える
const cache = new Map();

chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  handle(msg || {})
    .then(sendResponse)
    .catch((e) => sendResponse({ error: String(e?.message || e) }));
  return true; // 非同期で応答する
});

async function handle(msg) {
  if (msg.action === 'search') return search(String(msg.q || ''), Number(msg.page || 1));
  if (msg.action === 'image') return image(String(msg.path || ''));
  if (msg.action === 'open') {
    // ボット確認画面が出たとき用に、カードラッシュをタブで開く
    await chrome.tabs.create({ url: CR_BASE + '/' });
    return { ok: true };
  }
  return { ok: true, service: 'cardrush-extension', version: VERSION };
}

async function crFetch(url) {
  const res = await fetch(url, { credentials: 'include' });
  if (res.status === 403 || res.status === 503) {
    throw new Error('カードラッシュのボット確認が表示されています。「カードラッシュを開く」で一度サイトを表示し、確認が終わってから再試行してください。');
  }
  if (!res.ok) throw new Error(`カードラッシュへのアクセスに失敗しました（HTTP ${res.status}）`);
  return res;
}

async function search(q, page) {
  q = q.trim();
  if (!q) return { items: [], total: 0, page: 1 };
  page = Math.max(1, Math.min(50, page || 1));
  const key = `${q}|${page}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;

  const url = `${CR_BASE}/product-list?keyword=${encodeURIComponent(q)}${page > 1 ? `&page=${page}` : ''}`;
  const html = await (await crFetch(url)).text();
  // Cloudflare は通常のページにも challenge-platform のスクリプトを埋め込むため、確認画面はタイトルで判定する
  if (/<title>\s*(しばらくお待ちください|Just a moment)/i.test(html) && !/class="item_data"/.test(html)) {
    throw new Error('カードラッシュのボット確認が表示されています。「カードラッシュを開く」で一度サイトを表示し、確認が終わってから再試行してください。');
  }
  const data = { ...parseCardrushList(html), page };
  cache.set(key, { at: Date.now(), data });
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  return data;
}

// 画像を base64 で返す（カードラッシュの画像パスのみ許可）
async function image(path) {
  if (!path.startsWith(CR_IMAGE_PREFIX) || path.includes('..')) throw new Error('許可されていない画像パスです');
  const res = await crFetch(CR_BASE + path);
  const buf = new Uint8Array(await res.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return { mimeType: res.headers.get('content-type') || 'image/jpeg', base64: btoa(bin) };
}

// ---------- 検索結果ページの解析 ----------

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
    // 販売価格（税込）と在庫数。売り切れは在庫表示がない
    const price = Number(((block.match(/class="figure">([\d,]+)円/) || [])[1] || '0').replace(/,/g, ''));
    const stockMatch = block.match(/class="stock">[^<\d]*(\d+)/);
    items.push({
      id: m[1],
      name,
      model,
      thumb,
      image: crOriginalImage(thumb),
      url: `${CR_BASE}/product/${m[1]}`,
      price,
      stock: stockMatch ? Number(stockMatch[1]) : 0,
      // 売り切れは在庫数の表示がなく、サムネイルに「SOLD OUT」（16進で 534f4c44204f5554）が重ねられる
      soldOut: /534f4c44204f5554/i.test(thumb) || !/class="stock"/.test(block),
    });
  }
  return { items, total };
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
