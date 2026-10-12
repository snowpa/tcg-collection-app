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
