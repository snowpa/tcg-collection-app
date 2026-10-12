// オフライン用 Service Worker（ネットワーク優先・失敗時にキャッシュ）
const CACHE = 'tcg-collection-v23';
const ASSETS = [
  './', './index.html', './style.css', './manifest.json', './icon.svg',
  './js/app.js', './js/db.js', './js/google.js', './js/parser.js', './js/gemini.js', './js/chart.js', './js/cardrush.js', './js/market.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  // 同一オリジンの GET のみ扱う（Google API や画像の直リンクは素通し）
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    // ブラウザの HTTP キャッシュ（GitHub Pages は最大10分）に古い版が残らないよう、毎回サーバーに更新を確認する
    fetch(req, { cache: 'no-cache' })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(async () => (await caches.match(req)) || (req.mode === 'navigate' ? caches.match('./index.html') : Response.error())),
  );
});
