// 依存なしの簡易折れ線グラフ（SVG）

const fmtDate = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
};

const fmtYenShort = (v) => {
  const a = Math.abs(v);
  if (a >= 100_000_000) return `${(v / 100_000_000).toFixed(1)}億`;
  if (a >= 10_000) return `${(v / 10_000).toFixed(a >= 100_000 ? 0 : 1)}万`;
  return Math.round(v).toLocaleString('ja-JP');
};

// 目盛りをキリの良い値に丸める
function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

/**
 * @param {HTMLElement} el
 * @param {{name:string,color:string,points:{x:number,y:number}[]}[]} series
 */
export function lineChart(el, series, { height = 220 } = {}) {
  const pts = series.flatMap((s) => s.points);
  if (pts.length === 0) {
    el.innerHTML = '<p class="muted small">まだデータがありません</p>';
    return;
  }
  const W = 640, H = height, L = 52, R = 14, T = 14, B = 26;
  let xmin = Math.min(...pts.map((p) => p.x));
  let xmax = Math.max(...pts.map((p) => p.x));
  if (xmin === xmax) { xmin -= 86_400_000; xmax += 86_400_000; }
  const ymax = niceMax(Math.max(...pts.map((p) => p.y), 0));
  const ymin = 0;
  const sx = (x) => L + ((x - xmin) / (xmax - xmin)) * (W - L - R);
  const sy = (y) => T + (1 - (y - ymin) / (ymax - ymin)) * (H - T - B);

  let grid = '';
  for (let i = 0; i <= 4; i++) {
    const v = ymin + ((ymax - ymin) * i) / 4;
    const y = sy(v);
    grid += `<line x1="${L}" x2="${W - R}" y1="${y}" y2="${y}" class="gl"/>`
      + `<text x="${L - 6}" y="${y + 4}" text-anchor="end" class="axis">${fmtYenShort(v)}</text>`;
  }
  const xticks = [xmin, (xmin + xmax) / 2, xmax];
  const xl = xticks.map((x, i) => `<text x="${sx(x)}" y="${H - 6}" text-anchor="${['start', 'middle', 'end'][i]}" class="axis">${fmtDate(x)}</text>`).join('');

  const lines = series.map((s) => {
    const sorted = [...s.points].sort((a, b) => a.x - b.x);
    if (!sorted.length) return '';
    const d = sorted.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' ');
    const dots = sorted.length <= 40
      ? sorted.map((p) => `<circle cx="${sx(p.x)}" cy="${sy(p.y)}" r="3.5" fill="${s.color}"><title>${fmtDate(p.x)} ${s.name}: ¥${Math.round(p.y).toLocaleString('ja-JP')}</title></circle>`).join('')
      : '';
    return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>${dots}`;
  }).join('');

  const legend = series.length > 1
    ? `<div class="legend">${series.map((s) => `<span><i style="background:${s.color}"></i>${s.name}</span>`).join('')}</div>`
    : '';
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="${series.map((s) => s.name).join('・')}の推移">${grid}${xl}${lines}</svg>${legend}`;
}
