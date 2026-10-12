// Gemini API でカード名を推定する（mercari-gas-parser の ai.ts を移植し、結果を JSON で受け取るように変更）

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';

// 応答全体（候補・グラウンディング情報を含む）を返す
async function request(apiKey, model, body) {
  if (!apiKey) throw new Error('設定画面で Gemini API キーを入力してください');
  const res = await fetch(`${BASE}${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.error) throw new Error(`Gemini エラー: ${j.error?.message || res.status}`);
  return j;
}

const textOf = (j) => (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();

async function generate(apiKey, model, parts, generationConfig) {
  return textOf(await request(apiKey, model, { contents: [{ parts }], generationConfig }));
}

/**
 * Google 検索で調べてから、カード（またはBOX）の日本での発売年を答えさせる
 * グラウンディング（google_search）と JSON 出力指定は併用できないので、本文の JSON を取り出して読む
 * @returns {{year:number|null, confidence:'high'|'medium'|'low', product:string, reason:string, sources:{title:string,uri:string}[]}}
 */
export async function researchYear({ apiKey, model, gameName, card }) {
  const info = [
    ['種類', card.isBox ? '未開封BOX・パック' : 'カード'],
    ['名前', card.name], ['レアリティ', card.rarity], ['番号', card.number],
    ['セットコード', card.setCode], ['セット名', card.setName],
    ['購入時の商品名', card.rawTitle], ['メモ', card.memo],
  ].filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join('\n');
  const prompt = `
あなたは${gameName}（日本語版）の専門家です。Google検索で調べて、次の${card.isBox ? '商品' : 'カード'}が日本で発売された年を答えてください。

${info}

ルール:
- ${card.isBox ? 'その商品' : '同じ名前のカードは版違いが多いので、レアリティ・番号・購入時の商品名に合う版を選び、そのカードが収録された商品'}の日本での発売年を答える。
- プロモカードは配布・同梱が始まった年を答える。
- 検索結果で裏付けが取れないときや、候補の版が複数あって決めきれないときは year を null にし、推測で埋めない。
- confidence は、検索結果で版と発売年がはっきり確認できたら high、おおむね確からしいが版の特定に少し不安があれば medium、それ以外は low。
- 最後に次の JSON だけを1行で出力する（前後に説明を書かない）:
{"year": 2010, "confidence": "high", "product": "収録商品名", "reason": "根拠を日本語で1〜2文"}
`.trim();
  const j = await request(apiKey, model, {
    contents: [{ parts: [{ text: prompt }] }],
    tools: [{ google_search: {} }],
    generationConfig: { temperature: 0 },
  });
  const text = textOf(j);
  const m = text.match(/\{[^{}]*"year"[^{}]*\}/g);
  if (!m) throw new Error(`AIの回答を読めませんでした: ${text.slice(0, 80)}`);
  const json = JSON.parse(m[m.length - 1]);
  const year = Number(json.year);
  const sources = (j.candidates?.[0]?.groundingMetadata?.groundingChunks || [])
    .map((g) => g.web).filter((w) => w?.uri).map((w) => ({ title: w.title || w.uri, uri: w.uri })).slice(0, 5);
  return {
    year: year >= 1996 && year <= new Date().getFullYear() + 1 ? Math.floor(year) : null,
    confidence: ['high', 'medium', 'low'].includes(json.confidence) ? json.confidence : 'low',
    product: String(json.product || ''),
    reason: String(json.reason || ''),
    sources,
  };
}

const CARD_SCHEMA = {
  type: 'OBJECT',
  properties: {
    isTargetCard: { type: 'BOOLEAN' },
    name: { type: 'STRING' },
    rarity: { type: 'STRING' },
    setCode: { type: 'STRING' },
    setName: { type: 'STRING' },
    number: { type: 'STRING' },
  },
  required: ['isTargetCard', 'name'],
};

/**
 * 商品名・価格・日付（＋画像）から正式なカード情報を推定する
 * @returns {{isTargetCard:boolean,name:string,rarity:string,setCode:string,setName:string,number:string}}
 */
export async function identifyCard({ apiKey, model, gameName, itemName, price, date, imageBase64, mimeType }) {
  const prompt = `
あなたは${gameName}の専門家です。
${imageBase64 ? '添付された商品画像と' : ''}以下のフリマ購入情報から、最も可能性の高い「正式なカード」を特定してください。
${imageBase64
    ? '画像（カードの絵柄、テキスト、SR/SARなどの加工）を最優先に判断し、商品名や価格は参考情報として扱ってください。'
    : '価格や日付も考慮して、レアリティや収録パックを推測してください。'}

入力情報:
商品名: ${itemName || '(不明)'}
価格: ${price || '(不明)'}円
日付: ${date || '(不明)'}

出力ルール:
- isTargetCard: ${gameName}のカード関連商品なら true。明らかに無関係（洋服、家電、他のカードゲームなど）なら false。
- name: カード名のみ（例: マリィ、ピカチュウex）。特定できない場合は元の商品名をそのまま入れる。
- rarity: SR / SAR / AR / UR / HR / CHR / CSR などの略号。不明なら空文字。
- setCode: 収録パックの型番（例: S4a、SV2a）。不明なら空文字。
- setName: 収録パック名（例: シャイニースターV）。不明なら空文字。
- number: カード番号（例: 198/190）。不明なら空文字。

例:
商品名「マリィ SR シャイニー」30000円 → {"isTargetCard":true,"name":"マリィ","rarity":"SR","setCode":"S4a","setName":"シャイニースターV","number":"198/190"}
商品名「ピカチュウ AR Vユニ」500円 → {"isTargetCard":true,"name":"ピカチュウ","rarity":"AR","setCode":"S12a","setName":"VSTARユニバース","number":"205/172"}
`.trim();

  const parts = [{ text: prompt }];
  if (imageBase64) parts.push({ inlineData: { mimeType: mimeType || 'image/jpeg', data: imageBase64 } });

  const text = await generate(apiKey, model, parts, {
    temperature: 0.1,
    responseMimeType: 'application/json',
    responseSchema: CARD_SCHEMA,
  });
  const json = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
  return {
    isTargetCard: json.isTargetCard !== false,
    name: json.name || itemName || '',
    rarity: json.rarity || '',
    setCode: json.setCode || '',
    setName: json.setName || '',
    number: json.number || '',
  };
}

// 画像URL → base64（CORS が許可されていない画像は失敗するので呼び出し側でフォールバックする）
export async function urlToBase64(url) {
  const res = await fetch(url, { mode: 'cors', referrerPolicy: 'no-referrer' });
  if (!res.ok) throw new Error(`画像取得失敗 ${res.status}`);
  const blob = await res.blob();
  if (blob.size < 100) throw new Error('画像が空です');
  const dataUrl = await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
  return splitDataUrl(dataUrl);
}

export function splitDataUrl(dataUrl) {
  const m = String(dataUrl).match(/^data:(.*?);base64,(.*)$/);
  return m ? { mimeType: m[1], base64: m[2] } : null;
}
