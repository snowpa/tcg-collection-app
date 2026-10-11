// カードラッシュの販売価格から、手持ちカードの状態に合った相場を求める
import { parseItem } from './cardrush.js';

// 表記ゆれを吸収して比較する（全角/半角・空白・大文字小文字）
export const norm = (s) => String(s || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
// カード名の比較用: ★・δ・記号や「デルタ種」の表記ゆれを除く
export const normName = (s) => norm(s).replace(/デルタ種/g, '').replace(/[★☆δΔ\-‐－・~〜]/g, '');

// 該当する状態の商品がないとき、無印（美品）価格に掛ける割合
export const RANK_FACTOR = { normal: 1, 'A-': 0.9, B: 0.75, C: 0.5 };
export const RANK_LABEL = { normal: '無印（美品）', 'A-': '状態A-', B: '状態B', C: '状態C' };

// PSA のグレード別の相場の目安（PSA10 の価格を 100% としたときの [下限, 上限]）
export const PSA_RATIO = {
  10: [1, 1], 9: [0.4, 0.6], 8: [0.2, 0.35], 7: [0.12, 0.2], 6: [0.08, 0.15],
  5: [0.06, 0.1], 4: [0.04, 0.07], 3: [0.03, 0.05], 2: [0.02, 0.04], 1: [0.015, 0.03],
};
export const PSA_POS_LABEL = { low: '下限', mid: '中央', high: '上限' };

// 目安の幅のどこを使うか（low=下限 / mid=中央 / high=上限）
export function psaRatio(n, pos = 'mid') {
  const [lo, hi] = PSA_RATIO[n];
  return pos === 'low' ? lo : pos === 'high' ? hi : (lo + hi) / 2;
}

const pct = (r) => `${Math.round(r * 1000) / 10}%`;

// 「状態B」「PSA10鑑定済」「※状態難/PSA10鑑定済」などを分類する
export function classifyRank(rank) {
  const r = String(rank || '').normalize('NFKC').toUpperCase();
  if (!r) return { kind: 'normal' };
  const g = r.match(/(PSA|BGS|ARS|PCG|CGC|ACE)\s*([\d.]+\+?)\s*鑑定/);
  if (g) return { kind: 'graded', grade: g[1] + g[2], damaged: /状態難/.test(r) };
  const c = r.match(/状態\s*(A-|B|C)/);
  if (c) return { kind: 'cond', rank: c[1] };
  return { kind: 'other' };
}

// カードの鑑定欄（例: PSA10 / psa 10 / 未鑑定）を比較用に正規化。未鑑定は空文字
export function normGrade(grade) {
  const g = String(grade || '').normalize('NFKC').toUpperCase().replace(/\s+/g, '');
  return /^(PSA|BGS|ARS|PCG|CGC|ACE)[\d.]+\+?$/.test(g) ? g : '';
}

// 「ピカチュウV(RR仕様/未開封)」→ { base: 'ピカチュウV', tokens: ['RR仕様', '未開封'] }
export function splitVariant(name) {
  const m = String(name || '').match(/^(.*?)[(（]([^()（）]*)[)）]\s*$/);
  return m ? { base: m[1].trim(), tokens: m[2].split(/[/／]/).map((t) => t.trim()).filter(Boolean) } : { base: String(name || '').trim(), tokens: [] };
}

const LANG = /(英語|中国語|韓国語|海外|繁体|簡体|タイ語|インドネシア)/;
const isRarityTok = (t) => /仕様$/.test(t);
const isSealedTok = (t) => /未開封/.test(t);
const isFirstTok = (t) => /^(1ED|1ST)/i.test(t.normalize('NFKC'));
const isEditionTok = (t) => isFirstTok(t) || /^(アンリミ|アンリミテッド|unlimited)$/i.test(t);
const isMirrorTok = (t) => /ミラー/.test(t);
const otherTokens = (x) => x.tokens.filter((t) => !isRarityTok(t) && !isSealedTok(t) && !isEditionTok(t) && !isMirrorTok(t) && !LANG.test(t));

// 鑑定品などは型番が「その他」「※状態難/鑑定カード」になっているので、型番不明として扱う
const knownModel = (m) => {
  const s = String(m || '').trim();
  return !s || s === 'その他' || s === '-' || /鑑定/.test(s) ? '' : norm(s);
};

const round10 = (n) => Math.round(n / 10) * 10;

const CR_PRODUCT = 'https://www.cardrush-pokemon.jp/product/';

/**
 * 【取得時に1回】検索結果から、手持ちのカードと同じ商品（状態・鑑定違いを含む）を集めて保存用の一覧にする
 * @param {{name:string, number?:string, setCode?:string, rarity?:string, sealed?:boolean, hint?:string}} target
 *   hint は購入時の商品名やメモ（1ED・ミラーなどの手がかり）
 * @param {{id,name,model,url,price,stock}[]} items カードラッシュの検索結果
 * @returns {{quotes:{id:string, n:string, p:number, s:number, k:string, r?:string, g?:string, d?:boolean}[]} | {error:string}}
 */
export function matchQuotes(target, items) {
  const own = splitVariant(target.name);
  const hint = norm([target.hint, target.name].join(' '));
  const cardR = norm(target.rarity) === 'promo' ? 'p' : norm(target.rarity);
  const rarityOk = (x) => {
    if (!cardR) return true;
    const lr = norm(x.p.rarity);
    const tokR = x.tokens.filter(isRarityTok).map((t) => norm(t.replace(/仕様$/, '')));
    if (lr === cardR || tokR.includes(cardR)) return true;
    if (cardR === 'p') return lr === 'p' || /-p$/.test(norm(x.p.number));
    return false; // レアリティが分かっているカードは、表記が一致する商品だけを使う（別版の誤マッチ防止）
  };

  let list = items
    .map((it) => {
      const p = parseItem(it);
      const v = splitVariant(p.name);
      return { it, p, r: classifyRank(p.condRank), base: v.base, tokens: v.tokens };
    })
    .filter((x) => x.it.price > 0)
    .filter((x) => normName(x.base) === normName(own.base))
    .filter((x) => !target.number || norm(x.p.number) === norm(target.number))
    .filter((x) => !target.setCode || !knownModel(x.p.setCode) || knownModel(x.p.setCode) === norm(target.setCode))
    .filter((x) => !!x.p.sealed === !!target.sealed)
    .filter((x) => !x.tokens.some((t) => LANG.test(t)) || LANG.test(hint))
    .filter(rarityOk);
  if (!list.length) return { error: '同じカード（名前・番号・型番・レアリティが一致）の商品が見つかりません' };

  // 1ED／アンリミ、ミラー、記念版などのバリエーションは手がかりで選ぶ（なければ通常版）
  const has1st = (x) => x.tokens.some(isFirstTok);
  if (list.some(has1st)) {
    const want = /1ed|1st/.test(hint);
    const f = list.filter((x) => has1st(x) === want);
    if (f.length) list = f;
  }
  const hasMirror = (x) => x.tokens.some(isMirrorTok);
  if (list.some(hasMirror)) {
    const want = /ミラー|モンスターボール|マスターボール/.test(hint);
    const f = list.filter((x) => hasMirror(x) === want);
    if (f.length) list = f;
  }
  const fits = (x) => otherTokens(x).every((t) => hint.includes(norm(t)));
  if (list.some(fits)) list = list.filter(fits);

  // 番号・型番・バリエーションが違うものが残っていると特定できない
  const variantKey = (x) => [norm(x.p.number), knownModel(x.p.setCode), otherTokens(x).map(norm).sort().join('/'), has1st(x), hasMirror(x)].join('|');
  const keyed = list.filter((x) => knownModel(x.p.setCode) || !list.some((y) => knownModel(y.p.setCode)));
  const variants = new Set(keyed.map(variantKey));
  if (variants.size > 1) {
    return { error: `同じ名前のカードが${variants.size}種類あり特定できません。カードラッシュで照合して番号・型番を入れてください` };
  }

  // 保存は必要な項目だけ（k: normal=無印 / cond=状態ランク / graded=鑑定品）
  const quotes = list.filter((x) => x.r.kind !== 'other').map((x) => ({
    id: x.it.id, n: x.it.name, p: x.it.price, s: x.it.stock || 0, k: x.r.kind,
    ...(x.r.kind === 'cond' ? { r: x.r.rank } : {}),
    ...(x.r.kind === 'graded' ? { g: x.r.grade, d: x.r.damaged } : {}),
  }));
  if (!quotes.length) return { error: '状態に合う商品が見つかりません' };
  return { quotes };
}

/**
 * 【表示のたびに】保存した商品一覧と、現在の状態・鑑定・設定から相場を計算する（通信なし）
 * @param {ReturnType<typeof matchQuotes>['quotes']} quotes
 * @param {{grade?:string, rank:'normal'|'A-'|'B'|'C', psaPos?:'low'|'mid'|'high'}} target
 * @returns {{price:number, basis:string, estimated:boolean, itemId:string, url:string, listing:string} | {error:string}}
 */
export function priceFromQuotes(quotes, target) {
  // 在庫ありを優先し、その中で最安
  const best = (xs) => [...xs].sort((a, b) => (b.s > 0) - (a.s > 0) || a.p - b.p)[0];
  const out = (q, price, basis, estimated = false) => ({ price, basis, estimated, itemId: q.id, url: CR_PRODUCT + q.id, listing: q.n });
  const yenStr = (n) => `${n.toLocaleString('ja-JP')}円`;

  const grade = normGrade(target.grade);
  let note = '';
  // PSA: PSA10 の販売価格 × グレード別の割合
  const psa = grade.match(/^PSA(\d+(?:\.\d+)?)$/);
  if (psa) {
    const n = Math.max(1, Math.min(10, Math.floor(Number(psa[1]))));
    const p10 = best(quotes.filter((q) => q.k === 'graded' && q.g === 'PSA10' && !q.d));
    if (p10 && n === 10) return out(p10, p10.p, 'PSA10鑑定済の販売価格');
    if (p10) {
      const pos = target.psaPos || 'mid';
      const [lo, hi] = PSA_RATIO[n];
      const ratio = psaRatio(n, pos);
      return out(p10, round10(p10.p * ratio), `PSA10 ${yenStr(p10.p)} × ${pct(ratio)}（PSA${n}の目安 ${pct(lo)}〜${pct(hi)}の${PSA_POS_LABEL[pos]}）`, true);
    }
    // PSA10 の販売がなければ、同じグレードの販売価格 → 未鑑定の価格の順で使う
  }
  // その他の鑑定品: 同じ鑑定の販売価格（状態難は除く）
  if (grade) {
    const hit = best(quotes.filter((q) => q.k === 'graded' && q.g === grade && !q.d));
    if (hit) return out(hit, hit.p, `${grade}鑑定済の販売価格`);
    note = `（${grade}の販売なし・未鑑定の価格で算出）`;
  }

  const want = target.rank || 'normal';
  const ofRank = (rk) => quotes.filter((q) => (rk === 'normal' ? q.k === 'normal' : q.k === 'cond' && q.r === rk));
  const exact = best(ofRank(want));
  if (exact) return out(exact, exact.p, `${RANK_LABEL[want]}の販売価格${note}`, !!note);

  // 同じ状態ランクの商品がない → 別ランクの価格を掛け率で換算（無印を優先）
  for (const rk of ['normal', 'A-', 'B', 'C']) {
    const q = best(ofRank(rk));
    if (!q) continue;
    const price = round10((q.p / RANK_FACTOR[rk]) * RANK_FACTOR[want]);
    return out(q, price, `${RANK_LABEL[want]}の販売なし。${RANK_LABEL[rk]} ${yenStr(q.p)}から換算${note}`, true);
  }
  return { error: '状態に合う商品が見つかりません（鑑定品のみ・状態難のみなど）' };
}

// 照合と計算をまとめて行う（テスト用）
export function estimate(target, items) {
  const m = matchQuotes(target, items);
  return m.error ? m : priceFromQuotes(m.quotes, target);
}
