// 購入完了メールの解析（mercari-gas-parser の utils.ts を移植）

// 検索対象のメール。label 条件は不要（取込済みはアプリ側でメールIDで管理する）
export const DEFAULT_SOURCES = [
  { key: 'mercari', label: 'メルカリ', enabled: true, query: 'from:no-reply@mercari.jp "【メルカリ】ご購入ありがとうございます"' },
  { key: 'yahoo', label: 'Yahoo!', enabled: true, query: '(subject:Yahoo subject:支払い手続完了)' },
  { key: 'rakuma', label: '楽天ラクマ', enabled: true, query: 'subject:"[楽天ラクマ] ご購入ありがとうございます"' },
  { key: 'magi', label: 'magi', enabled: true, query: 'subject:"【magi】ご購入ありがとうございます"' },
  { key: 'snkrdunk', label: 'スニダン', enabled: true, query: 'subject:"【SNKRDUNK】ご購入ありがとうございます"' },
];

// 対象カードと判定するキーワード（ホワイトリスト）
export const DEFAULT_KEYWORDS = [
  'ポケカ', 'ポケモン', 'PSA',
  'ex', 'v', 'vmax', 'vstar', 'gx', 'lv.x',
  'プロモ', 'promo', 'edition', '1st',
  'sr', 'sar', 'ur', 'hr', 'ar', 'chr', 'csr',
];

// 除外キーワード（ブラックリスト）
export const DEFAULT_EXCLUDE = ['ちいかわ', 'ミルクチャン', 'ディズニー', 'ナガノマーケット', 'ガンダム', 'ドラゴンボール'];

// 本文から金額を抽出（合計 → 商品金額の順に優先）
export function extractPrice(body) {
  const pricePatterns = [
    /合計\(税込\)：\s*[¥￥]\s*([\d,]+)/, // スニダン
    /支払い金額（※）\s*[:：]\s*([\d,]+)\s*円/, // Yahoo
    /(?:商品金額|商品代金|価格|支払(?:い)?金額)\s*[:：]\s*[¥￥]?\s*([\d,]+)(?:\s*円)?/,
    /[¥￥]\s*([\d,]+)/, // フォールバック
  ];
  for (const pattern of pricePatterns) {
    const match = body.match(pattern);
    if (match) return parseInt(match[1].replace(/,/g, ''), 10);
  }
  return 0;
}

// メルカリの商品ID（m12345678901）を抽出
export function extractMercariId(body) {
  const match = body.match(/mercari\.com\/item\/(m\d+)/);
  if (match) return match[1];
  const idMatch = body.match(/商品ID\s*[:：]\s*(m\d+)/);
  if (idMatch) return idMatch[1];
  return null;
}

// メルカリ商品画像のURL
export function mercariImageUrl(mercariId) {
  return mercariId ? `https://static.mercdn.net/item/detail/orig/photos/${mercariId}_1.jpg` : '';
}

// 本文から商品名を抽出
export function extractItemName(body) {
  // Yahoo（転送メールにも対応）
  const yahooMatch = body.match(/[> ]*商品タイトル\s*[:：]\s*(.+)/);
  if (yahooMatch) return yahooMatch[1].trim();

  // メルカリ・ラクマ・magi（スニダンより先に判定してラクマのフッターへの誤マッチを防ぐ）
  const nameMatch = body.match(/商品名\s*[:：]\s*(.+)/);
  if (nameMatch) return nameMatch[1].trim();

  // スニダン: 「■ 商品情報」の後の「・商品名」
  const snkrdunkMatch = body.match(/■ 商品情報[\s\S]*?\n\s*・([^\r\n]+)/);
  if (snkrdunkMatch) return snkrdunkMatch[1].trim();

  return null;
}

export function hasKeyword(text, keywords) {
  return keywords.some((k) => k && text.includes(k));
}

// AI の旧形式「マリィ (SR, S4a シャイニースターV, 198/190)」やスプレッドシートの「予測名称」を分解する
export function parseFormalName(s) {
  const out = { name: '', rarity: '', setCode: '', setName: '', number: '' };
  if (!s) return out;
  const m = String(s).trim().match(/^(.*?)\s*[（(](.*)[)）]\s*$/);
  if (!m) { out.name = String(s).trim(); return out; }
  out.name = m[1].trim();
  for (const part of m[2].split(/[,，、]/).map((t) => t.trim()).filter(Boolean)) {
    if (/\d+\s*\/\s*\d+/.test(part) && !out.number) {
      out.number = part.replace(/\s/g, '');
    } else if (!out.rarity && /^[A-Za-z]{1,4}$/.test(part)) {
      out.rarity = part.toUpperCase();
    } else if (!out.setName) {
      const sm = part.match(/^([A-Za-z0-9][A-Za-z0-9-]*)\s+(.+)$/);
      if (sm) { out.setCode = sm[1]; out.setName = sm[2]; } else { out.setName = part; }
    }
  }
  return out;
}

// 「198/190」→ { n: 198, total: 190 }
export function parseCardNumber(number) {
  const m = String(number || '').match(/(\d+)\s*\/\s*(\d+)/);
  if (m) return { n: parseInt(m[1], 10), total: parseInt(m[2], 10) };
  const only = String(number || '').match(/(\d+)/);
  return only ? { n: parseInt(only[1], 10), total: null } : null;
}
