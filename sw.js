/* 离线缓存：应用外壳 + CDN 运行时缓存 */
const CACHE = 'music-player-v1';
const SHELL = [
  './',
  './index.html',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  'https://cdn.tailwindcss.com',
  'https://cdnjs.cloudflare.com/ajax/libs/jsmediatags/3.9.5/jsmediatags.min.js'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.allSettled(SHELL.map(u => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* 缓存优先，未命中走网络并写入缓存（音频 blob: 与 LRCLIB 请求不缓存） */
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.protocol === 'blob:' || url.hostname.includes('lrclib.net')) return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: url.hostname.includes('tail') || url.hostname.includes('cdnjs') })
      .then(hit => hit || fetch(e.request).then(res => {
        if (res.ok || res.type === 'opaque') {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }))
      .catch(() => caches.match('./index.html'))
  );
});
