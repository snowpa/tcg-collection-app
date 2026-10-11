// カードラッシュ連携（Chrome 拡張機能「トレカ・コレクション カードラッシュ連携」経由で検索・画像取得）

// 拡張機能の ID（manifest.json の key で固定している）
export const EXTENSION_ID = 'cblfamljonlennohgbbpkbnhpeaapfjf';

export class NoExtensionError extends Error {}

const NO_EXT = 'カードラッシュ連携の Chrome 拡張機能が見つかりません。PC版 Chrome に拡張機能を読み込んでください（設定画面の「カードラッシュ連携」を参照）。';

function call(msg, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    // 拡張機能が入っていない（またはスマホ・Chrome 以外）の場合 chrome.runtime 自体がない
    const rt = globalThis.chrome?.runtime;
    if (!rt?.sendMessage) { reject(new NoExtensionError(NO_EXT)); return; }
    const timer = setTimeout(() => reject(new Error('カードラッシュ連携の応答がありません。少し待ってから再試行してください')), timeoutMs);
    try {
      rt.sendMessage(EXTENSION_ID, msg, (res) => {
        clearTimeout(timer);
        const err = globalThis.chrome.runtime.lastError;
        if (err || !res) { reject(new NoExtensionError(NO_EXT)); return; }
        if (res.error) { reject(new Error(res.error)); return; }
        resolve(res);
      });
    } catch {
      clearTimeout(timer);
      reject(new NoExtensionError(NO_EXT));
    }
  });
}

/** 拡張機能が使えるか確認する。使えればバージョンを返す */
export async function ping() {
  return (await call({ action: 'ping' }, 5000)).version;
}

/** @returns {Promise<{items:{id,name,model,thumb,image,url,soldOut}[], total:number, page:number}>} */
export const search = (q, page = 1) => call({ action: 'search', q, page });

// 画像を dataURL で取得
export async function imageDataUrl(imageUrl) {
  const r = await call({ action: 'image', path: new URL(imageUrl).pathname });
  return `data:${r.mimeType};base64,${r.base64}`;
}

// ボット確認が出たときにカードラッシュをタブで開く
export const openSite = () => call({ action: 'open' });

/**
 * 「〔状態B〕マリィ【SR】{198/190}」+ 型番「s4a」を分解する
 * @returns {{name:string, rarity:string, number:string, setCode:string, condRank:string}}
 */
export function parseItem(item) {
  let s = String(item.name || '').trim();
  // 中古の状態ランク表記（〔状態B〕など）は名前から外す
  const rank = s.match(/^〔([^〕]*)〕\s*/);
  if (rank) s = s.slice(rank[0].length);
  const num = s.match(/\{([^}]*)\}\s*$/);
  if (num) s = s.slice(0, num.index).trim();
  const rar = s.match(/【([^】]*)】\s*$/);
  if (rar) s = s.slice(0, rar.index).trim();
  const rarity = rar && rar[1] !== '-' ? rar[1] : '';
  return { name: s, rarity, number: num ? num[1].trim() : '', setCode: String(item.model || '').trim(), condRank: rank ? rank[1] : '' };
}

// フリマの商品名などから検索語を作る（ノイズになりやすい語を除く）
const NOISE = /(ポケモンカード(ゲーム)?|ポケカ|美品|完美品|極美品|即日発送|即発送|匿名配送|送料無料|まとめ売り|psa\s*\d+|bgs\s*[\d.]+|鑑定品?|未使用|新品|正規品|本物|1円|スタート|状態良好?|プロモ|promo)/gi;
export function queryFrom(text) {
  return String(text || '')
    .replace(/[【】\[\]（）()「」『』{}〔〕<>＜＞・/／|｜!！?？★☆♪#＃]/g, ' ')
    .replace(NOISE, ' ')
    .split(/\s+/)
    .filter((w) => w && !/^\d{1,3}$/.test(w))
    .slice(0, 3)
    .join(' ');
}

/**
 * 自動検索で順に試す検索語。カードラッシュの検索は全語 AND なので、
 * 番号（例: 198/190）が分かれば「名前 番号」→「番号」、次に名前の語を減らしていく
 */
export function queryCandidates(text, number) {
  const words = queryFrom(text).split(' ').filter(Boolean);
  const no = String(number || '').replace(/\s/g, '');
  const list = [];
  if (/\d+\/\d+/.test(no)) {
    if (words[0]) list.push(`${words[0]} ${no}`);
    list.push(no);
  }
  for (let n = words.length; n >= 1; n--) list.push(words.slice(0, n).join(' '));
  return [...new Set(list)].filter(Boolean);
}
