// ポケモンカードゲーム（日本語版）の商品の略号（セットコード）→ 発売年
// 出典: Wikipedia「ポケモンカードゲームの発売タイトル一覧」（2026-10-12 取得）から、略号と発売日を抜き出して作成。
// 複数の発売年がある略号、1文字の略号、シリーズ名と紛らわしい略号（BW・XY）は除いている。
// プロモ（S-P / SV-P など）は複数年にまたがるので含めない。カードに手で入力した発売年があればそちらを優先する。

const YEARS = [
  [2007, 'DP3'],
  [2009, 'L1 PtR'],
  [2010, 'BW1 CS1 L2 L3 LL PW'],
  [2011, 'BTV BW2 BW3 BW4'],
  [2012, 'BW5 BW6 BW7 BW8 DS MDB WAK'],
  [2013, 'BW9 EBB K+K MG XY1'],
  [2014, 'XY2 XY3 XY4 XY5 XYA XYB XYC'],
  [2015, 'CP1 CP2 XY6 XY7 XY8 XY9 XYD XYE XYF'],
  [2016, 'CP3 CP4 CP5 CP6 SM1 SMA SMB XY10 XY11 XYG XYH'],
  [2017, 'SM1+ SM2 SM2+ SM3 SM3+ SM4+ SM4A SM4S SM5M SM5S SMC SMD SME SMF'],
  [2018, 'SM5+ SM6 SM6a SM6b SM7 SM7a SM7b SM8 SM8a SM8b SM9 SMG SMH SMI SMJ'],
  [2019, 'S1 SA SB SM10 SM10a SM10b SM11 SM11a SM11b SM12 SM12a SM9a SM9b SMK SML SMM SMN SP1'],
  [2020, 'S1a S2 S2a S3 S3a S4 S4a SD SEF SEK SP2'],
  [2021, 'S5 S5a S6 S6a S7 S8 S8a S8b SF SGG SGI SH SI SJ SP3 SP4 SP5'],
  [2022, 'S10 S10a S10b S11 S11a S12 S12a S9 S9a SK SLD SLL SO SP6 SPD SPZ'],
  [2023, 'SV1a SV1S SV1V SV2a SV2D SV2P SV3 SV3a SV4a SV4K SV4M SVAL SVAM SVAW SVB SVC SVD SVEL'],
  [2023, 'SVEM SVF SVG WCS23'],
  [2024, 'SV5a SV5K SV5M SV6 SV6a SV7 SV7a SV8 SV8a SVHK SVHM SVI SVJL SVJP SVK SVLN SVLS SVM'],
  [2025, 'M1L M1S M2 M2a MA MC SV10 SV11B SV11W SV9 SV9a SVN SVOD SVOM'],
  [2026, 'M3 M4'],
];

const TABLE = new Map(YEARS.flatMap(([year, codes]) => codes.split(' ').map((code) => [code.toLowerCase(), year])));

// セットコード（例: S4a / s4a / SV2a）から発売年を返す。分からなければ null
// 2種同時発売（S5I・S5R、SM2K・SM2L など）は一覧では「S5」「SM2」とまとめて書かれているので、末尾の1文字を外しても探す
export function yearFromSetCode(code) {
  const key = String(code || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
  if (!key) return null;
  if (TABLE.has(key)) return TABLE.get(key);
  const m = key.match(/^(.*\d)[a-z]$/);
  return m && TABLE.has(m[1]) ? TABLE.get(m[1]) : null;
}

// 弾の名前 → 発売年（同じ一覧の「拡張パック」「強化拡張パック」「ハイクラスパック」「コンセプトパック」の商品名から作成）。
// 型番のない未開封BOX・パックの商品名（例: 拡張パック『黒炎の支配者』）から発売年を出すために使う。
const NAME_YEARS = [
  [2007, ["ひかる闇"]],
  [2009, ["ソウルシルバーコレクション", "ハートゴールドコレクション"]],
  [2010, ["よみがえる伝説", "ブラックコレクション", "ホワイトコレクション", "頂上大激突"]],
  [2011, ["サイコドライブ", "ダークラッシュ", "ヘイルブリザード", "レッドコレクション"]],
  [2012, ["コールドフレア", "フリーズボルト", "プラズマゲイル", "ライデンナックル", "ラセンフォース", "リューズブラスト", "リューノブレード"]],
  [2013, ["EXバトルブースト", "コレクションX", "コレクションY", "メガロキャノン"]],
  [2014, ["ガイアボルケーノ", "タイダルストーム", "ファントムゲート", "ライジングフィスト", "ワイルドブレイズ"]],
  [2015, ["エメラルドブレイク", "バンデットリング", "マグマ団VSアクア団 ダブルクライシス", "伝説キラコレクション", "破天の怒り", "赤い閃光", "青い衝撃"]],
  [2016, ["コレクション サン", "コレクション ムーン", "プレミアムチャンピオンパック「EX×M×BREAK」", "ポケキュンコレクション", "ポケットモンスターカードゲーム 拡張パック 20th Anniversary", "伝説ドリームキラコレクション", "冷酷の反逆者", "爆熱の闘士", "目覚める超王"]],
  [2017, ["GXバトルブースト", "ひかる伝説", "アローラの月光", "ウルトラサン", "ウルトラムーン", "キミを待つ島々", "サン&ムーン", "光を喰らう闇", "新たなる試練の向こう", "覚醒の勇者", "超次元の暴獣", "闘う虹を見たか"]],
  [2018, ["GXウルトラシャイニー", "ウルトラフォース", "タッグボルト", "ダークオーダー", "チャンピオンロード", "ドラゴンストーム", "フェアリーライズ", "禁断の光", "裂空のカリスマ", "超爆インパクト", "迅雷スパーク"]],
  [2019, ["TAG TEAM GX タッグオールスターズ", "オルタージェネシス", "ジージーエンド", "スカイレジェンド", "ダブルブレイズ", "ドリームリーグ", "ナイトユニゾン", "フルメタルウォール", "ミラクルツイン", "リミックスバウト"]],
  [2020, ["VMAXライジング", "シャイニースター", "ムゲンゾーン", "仰天のボルテッカー", "伝説の鼓動", "反逆クラッシュ", "爆炎ウォーカー"]],
  [2021, ["25th ANNIVERSARY COLLECTION", "VMAXクライマックス", "イーブイヒーローズ", "フュージョンアーツ", "一撃マスター", "双璧のファイター", "摩天パーフェクト", "漆黒のガイスト", "白銀のランス", "蒼空ストリーム", "連撃マスター"]],
  [2022, ["Pokémon GO", "VSTARユニバース", "スターバース", "スペースジャグラー", "タイムゲイザー", "ダークファンタズマ", "バトルリージョン", "パラタイムトリガー", "ロストアビス", "白熱のアルカナ"]],
  [2023, ["クレイバースト", "シャイニートレジャーex", "スカーレットex", "スノーハザード", "トリプレットビート", "バイオレットex", "ポケモンカード151", "レイジングサーフ", "古代の咆哮", "未来の一閃", "黒炎の支配者"]],
  [2024, ["クリムゾンヘイズ", "サイバージャッジ", "ステラミラクル", "テラスタルフェスex", "ナイトワンダラー", "ワイルドフォース", "変幻の仮面", "楽園ドラゴーナ", "超電ブレイカー"]],
  [2025, ["MEGAドリームex", "インフェルノX", "バトルパートナーズ", "ブラックボルト", "ホワイトフレア", "メガシンフォニア", "メガブレイブ", "ロケット団の栄光", "熱風のアリーナ"]],
  [2026, ["ニンジャスピナー", "ムニキスゼロ"]],
];

const normText = (t) => String(t || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
const NAMES = NAME_YEARS.flatMap(([year, names]) => names.map((name) => [normText(name), year]));

// 商品名に含まれる弾の名前から発売年を返す。分からない、または発売年の違う弾が混ざっている場合は null
export function yearFromName(text) {
  const t = normText(text);
  if (!t) return null;
  const years = new Set(NAMES.filter(([name]) => t.includes(name)).map(([, year]) => year));
  return years.size === 1 ? [...years][0] : null;
}

// 商品名のかっこ内のコード（例: 拡張パック『黒炎の支配者』(SV3)）から発売年を返す。分からなければ null
export function yearFromNameCode(text) {
  for (const m of String(text || '').matchAll(/[(（]([A-Za-z0-9+]{2,8})[)）]/g)) {
    const y = yearFromSetCode(m[1]);
    if (y) return y;
  }
  return null;
}
