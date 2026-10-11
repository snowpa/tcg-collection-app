// カードラッシュ連携（GAS の中継ウェブアプリ経由で検索・画像取得）

async function call(proxyUrl, params) {
  if (!proxyUrl) throw new Error('設定画面で「カードラッシュ連携URL」（GAS ウェブアプリのURL）を入力してください');
  const u = new URL(proxyUrl);
  Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v));
  // GAS のデプロイ設定が違うと、JSON ではなく Google のログイン画面が返る（またはCORSで読めない）
  const DEPLOY_HINT = 'GAS の「デプロイを管理」で、次のユーザーとして実行「自分」、アクセスできるユーザー「全員」（「Google アカウントを持つ全員」ではない）にして、新しいバージョンでデプロイし直してください';
  let res;
  try {
    res = await fetch(u, { redirect: 'follow' });
  } catch {
    throw new Error(`カードラッシュ連携URLに接続できません。${DEPLOY_HINT}`);
  }
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch {
    if (/accounts\.google\.com|ServiceLogin|<html/i.test(text)) throw new Error(`中継スクリプトがログインを求めています。${DEPLOY_HINT}`);
    throw new Error('カードラッシュ連携URLの応答が正しくありません。GAS を「ウェブアプリ」としてデプロイしたURL（…/exec）か確認してください');
  }
  if (json.error) throw new Error(json.error);
  return json;
}

export const ping = (proxyUrl) => call(proxyUrl, {});

/** @returns {Promise<{items:{id,name,model,thumb,image,url}[], total:number, page:number}>} */
export const search = (proxyUrl, q, page = 1) => call(proxyUrl, { action: 'search', q, page: String(page) });

// 画像を dataURL で取得
export async function imageDataUrl(proxyUrl, imageUrl) {
  const path = new URL(imageUrl).pathname;
  const r = await call(proxyUrl, { action: 'image', path });
  return `data:${r.mimeType};base64,${r.base64}`;
}

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
