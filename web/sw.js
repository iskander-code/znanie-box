// Офлайн-режим: после первого открытия сайт целиком хранится на устройстве
// и работает без интернета. Список файлов проверяется тестом (tests/engine.test.mjs).
const VERSION = 'znanie-v1';
const FILES = [
  './',
  'data/graphs/aral.json',
  'data/graphs/circle.json',
  'data/graphs/index.json',
  'data/graphs/linear.json',
  'data/graphs/ohm.json',
  'data/graphs/tselina.json',
  'data/library/algebra.json',
  'data/library/geometry.json',
  'data/library/history.json',
  'data/library/index.json',
  'data/library/physics.json',
  'icon.svg',
  'index.html',
  'js/app.js',
  'js/engine.js',
  'js/graph-view.js',
  'js/llm-browser.js',
  'js/tutor-local.js',
  'manifest.webmanifest',
  'styles.css'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Сначала отдаём сохранённую копию (мгновенно и без интернета), в фоне обновляем её.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.includes('/api/')) return;
  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const cached = await cache.match(req, { ignoreSearch: true })
      || (req.mode === 'navigate' ? await cache.match('index.html') : undefined);
    const fresh = fetch(req).then((res) => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    }).catch(() => undefined);
    if (cached) { event.waitUntil(fresh); return cached; }
    return (await fresh) || new Response('Нет сохранённой копии этой страницы', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  })());
});
