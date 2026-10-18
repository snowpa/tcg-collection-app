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
  if (msg.action === 'h2search') return h2Search(String(msg.q || ''));
  if (msg.action === 'yysearch') return yySearch(String(msg.q || ''));
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

// ---------- 遊々亭（カード追加時にカードラッシュ以外から選ぶ用） ----------
// 検索結果は1ページにすべて出る。問い合わせは最低1秒あけて1件ずつ行い、結果は6時間キャッシュする
const YY_BASE = 'https://yuyu-tei.jp';
const YY_INTERVAL_MS = 1000;
let yyChain = Promise.resolve();
let yyLast = 0;

function yySearch(q) {
  q = q.trim();
  if (!q) return Promise.resolve({ items: [], total: 0, page: 1 });
  const key = `yy|${q}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return Promise.resolve(hit.data);
  const run = yyChain.then(async () => {
    const waitMs = yyLast + YY_INTERVAL_MS - Date.now();
    if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
    yyLast = Date.now();
    const res = await fetch(`${YY_BASE}/sell/poc/s/search?search_word=${encodeURIComponent(q)}`, { credentials: 'include' });
    if (res.status === 429) throw new Error('遊々亭のアクセス制限中です。しばらく（数分）待ってから再試行してください。');
    if (!res.ok) throw new Error(`遊々亭へのアクセスに失敗しました（HTTP ${res.status}）`);
    const data = parseYuyuteiList(await res.text());
    cache.set(key, { at: Date.now(), data });
    if (cache.size > 300) cache.delete(cache.keys().next().value);
    return data;
  });
  yyChain = run.catch(() => {}); // 失敗しても次の問い合わせは続ける
  return run;
}

// 検索結果ページはレアリティごとの見出し（cards-list）の下に商品が並ぶ。カードラッシュと同じ形（名前【レアリティ】{番号}）に変換する
function parseYuyuteiList(html) {
  const items = [];
  for (const section of html.split('class="py-4 cards-list"').slice(1)) {
    const rarity = crText((section.match(/<span\s+class="py-2[^"]*">([^<]*)<\/span>\s*Card List/) || [])[1] || '');
    for (const block of section.split('class="card-product position-relative').slice(1)) {
      const link = block.match(/href="(https:\/\/yuyu-tei\.jp\/sell\/poc\/card\/([\w-]+)\/(\d+))"/);
      const name = crText((block.match(/<h4[^>]*>([\s\S]*?)<\/h4>/) || [])[1] || '');
      if (!link || !name) continue;
      const number = crText((block.match(/<span\s+class="d-block border[^"]*">([^<]*)<\/span>/) || [])[1] || '');
      const price = Number(((block.match(/<strong[^>]*>\s*([\d,]+)\s*円/) || [])[1] || '0').replace(/,/g, ''));
      const stock = Number((crText((block.match(/cart_sell_zaiko"[^>]*>([\s\S]*?)<\/label>/) || [])[1] || '').match(/(\d+)\s*点/) || [])[1] || 0);
      const img = (block.match(/src="(https:\/\/card\.yuyu-tei\.jp\/poc\/)100_140(\/[^"]+)"/) || []);
      items.push({
        id: `yy-${link[2]}-${link[3]}`,
        // 「TD」「S-TD」は遊々亭の分類（構築デッキ収録）でレアリティではないので空にする
        name: `${name}【${rarity && !/^(-|S?-?TD)$/.test(rarity) ? rarity : '-'}】{${number || '-'}}`,
        model: yyModel(link[2]),
        thumb: img[1] ? `${img[1]}200_280${img[2]}` : '',
        image: img[1] ? `${img[1]}front${img[2]}` : '',
        url: link[1],
        price,
        stock,
        source: 'yuyutei',
        soldOut: /^\s*sold-out/.test(block.slice(0, 20)) || !stock,
      });
      if (items.length >= 200) break;
    }
  }
  return { items, total: items.length, page: 1 };
}

// 遊々亭のバージョン記号（s04a, sv02a, m02a）を型番（s4a, sv2a, m2a）にする。プロモ・デッキなど独自の記号は空にする
function yyModel(ver) {
  const m = String(ver).match(/^(s|sv|m)0*(\d+)([a-z]?)$/i);
  return m ? `${m[1]}${m[2]}${m[3]}` : '';
}

// ---------- 晴れる屋2（カードラッシュで見つからないときの予備） ----------
// アクセス回数の制限が厳しいため、問い合わせは最低3秒あけて1件ずつ行い、結果は6時間キャッシュする
const H2_BASE = 'https://www.hareruya2.com';
const H2_INTERVAL_MS = 3000;
let h2Chain = Promise.resolve();
let h2Last = 0;

function h2Search(q) {
  q = q.trim();
  if (!q) return Promise.resolve({ items: [], total: 0 });
  const key = `h2|${q}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return Promise.resolve(hit.data);
  const run = h2Chain.then(async () => {
    const waitMs = h2Last + H2_INTERVAL_MS - Date.now();
    if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
    h2Last = Date.now();
    const url = `${H2_BASE}/search?q=${encodeURIComponent(q).replace(/%20/g, '+')}&type=product`;
    const res = await fetch(url, { credentials: 'include' });
    if (res.status === 429) throw new Error('晴れる屋2のアクセス制限中です。しばらく（数分）待ってから相場を取り直してください。');
    if (!res.ok) throw new Error(`晴れる屋2へのアクセスに失敗しました（HTTP ${res.status}）`);
    const data = parseHareruya2List(await res.text());
    cache.set(key, { at: Date.now(), data });
    return data;
  });
  h2Chain = run.catch(() => {}); // 失敗しても次の問い合わせは続ける
  return run;
}

// 検索結果ページから商品を読み取り、カードラッシュと同じ形（名前〔状態〕(版)【レアリティ】{番号}）に変換する
function parseHareruya2List(html) {
  const items = [];
  for (const block of html.split('<li class="grid__item"').slice(1)) {
    const id = (block.match(/id="title--(\d+)"/) || [])[1];
    const title = crText((block.match(/id="title--\d+"\s*>([\s\S]*?)<\/h3>/) || [])[1] || '');
    if (!id || !title) continue;
    const price = Number(((block.match(/class="figure">\s*[¥￥]?\s*([\d,]+)/) || [])[1] || '0').replace(/,/g, ''));
    const inv = crText((block.match(/class="product__inventory">([\s\S]*?)<\/div>/) || [])[1] || '');
    const stock = Number((inv.match(/(\d+)/) || [])[1] || 0);
    const img = (block.match(/\ssrc="([^"]+\/cdn\/shop\/[^"]+)"/) || [])[1] || '';
    const thumb = img ? (img.startsWith('//') ? `https:${img}` : img) : '';
    items.push({ ...hareruya2Name(title), id: `h2-${id}`, title, url: `${H2_BASE}/products/${id}`, price, stock, thumb, image: thumb.replace(/&width=\d+/, ''), source: 'hareruya2', soldOut: !stock });
    if (items.length >= 100) break;
  }
  return { items, total: items.length, page: 1 };
}

// 「【PSA10】マリィ(SR){サポート}〈198/190〉[S4a]」→ { name: '〔PSA10鑑定済〕マリィ【SR】{198/190}', model: 'S4a' }
function hareruya2Name(title) {
  let t = title.trim();
  let rank = '';
  let variant = '';
  const pre = t.match(/^【([^】]*)】\s*/);
  if (pre) { rank = pre[1]; t = t.slice(pre[0].length); }
  const model = ((t.match(/\[([^\]]*)\]\s*$/) || [])[1] || '').trim();
  t = t.replace(/\[[^\]]*\]\s*$/, '');
  const number = ((t.match(/〈([^〉]*)〉/) || [])[1] || '').trim();
  t = t.replace(/〈[^〉]*〉/, '').replace(/\{[^}]*\}/, '').trim();
  let rarity = '';
  const rm = t.match(/\(([^()]*)\)\s*$/);
  if (rm) { rarity = rm[1].trim(); t = t.slice(0, rm.index).trim(); }
  const vm = t.match(/^(.*?)[:：](.+)$/); // 「マリィのプライド:SR仕様」→ マリィのプライド(SR仕様)
  if (vm) { t = vm[1].trim(); variant = vm[2].trim(); }
  if (/未開封/.test(rank)) { variant = [variant, '未開封'].filter(Boolean).join('/'); rank = ''; }
  const label = rank && /(PSA|BGS|ARS|CGC|PCG|ACE)\s*[\d.]+/i.test(rank) && !/鑑定/.test(rank) ? `${rank}鑑定済` : rank;
  return { name: `${label ? `〔${label}〕` : ''}${t}${variant ? `(${variant})` : ''}【${rarity || '-'}】{${number}}`, model };
}
