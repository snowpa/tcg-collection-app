// Gemini API でカード名を推定する（mercari-gas-parser の ai.ts を移植し、結果を JSON で受け取るように変更）

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';

async function generate(apiKey, model, parts, generationConfig) {
  if (!apiKey) throw new Error('設定画面で Gemini API キーを入力してください');
  const res = await fetch(`${BASE}${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({ contents: [{ parts }], generationConfig }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.error) throw new Error(`Gemini エラー: ${j.error?.message || res.status}`);
  return (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
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

// スプレッドシートの「10年後予測」列に相当する参考予想
export async function forecast10y({ apiKey, model, gameName, card, currentPrice }) {
  const prompt = `
あなたは${gameName}の市場動向に詳しいアナリストです。以下のカードの10年後の参考価格を予想してください。
カード: ${card.name} ${card.rarity || ''} ${card.setCode || ''} ${card.setName || ''} ${card.number || ''}
鑑定: ${card.grade || '未鑑定'}
購入日: ${card.purchaseDate || '不明'} / 購入価格: ${card.purchasePrice || '不明'}円 / 現在の参考価格: ${currentPrice || '不明'}円

出力: 「¥xx,xxx前後（理由を40字以内）」の形式で1行のみ。前置きや注意書きは不要です。
`.trim();
  return generate(apiKey, model, [{ text: prompt }], { temperature: 0.4 });
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
