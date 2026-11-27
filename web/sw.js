// Офлайн-режим: после первого открытия сайт целиком хранится на устройстве
// и работает без интернета. Список файлов проверяется тестом (tests/engine.test.mjs).
const VERSION = 'znanie-v13';
// Опыты PhET (≈95 МБ) не скачиваются заранее: каждый сохраняется при первом открытии
// или по кнопке «Сохранить все опыты». Их кэш не очищается при обновлении сайта.
const PHET = 'znanie-phet';
const FILES = [
  './',
  'data/graphs/aral.json',
  'data/graphs/circle.json',
  'data/graphs/index.json',
  'data/graphs/linear.json',
  'data/graphs/ohm.json',
  'data/graphs/tselina.json',
  'data/library/algebra.json',
  'data/library/biology.json',
  'data/library/chemistry.json',
  'data/library/geography.json',
  'data/library/geometry.json',
  'data/library/history.json',
  'data/library/index.json',
  'data/library/physics.json',
  'data/phet.json',
  'icon.svg',
  'index.html',
  'js/a11y.js',
  'js/app.js',
  'js/engine.js',
  'js/graph-view.js',
  'js/ideas.js',
  'js/llm-browser.js',
  'js/doc-structure.js',
  'js/markdown.js',
  'js/online-browser.js',
  'js/qr.js',
  'js/teacher.js',
  'js/tutor-local.js',
  'manifest.webmanifest',
  'sims/greenhouse.html',
  'sims/ohm-law.html',
  'styles.css'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== PHET).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Сначала пробуем свежую версию с сервера: после обновления сайта все сразу видят новое.
// Нет сети или сервер долго не отвечает (слабая раздача) — отдаём сохранённую копию, сайт работает без интернета.
const NETWORK_TIMEOUT = 3000;
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.includes('/api/')) return;
  if (url.pathname.includes('/phet/')) {
    // Опыт: сохранённая копия, иначе скачиваем и сохраняем. Большие файлы в фоне не перекачиваем.
    event.respondWith((async () => {
      const cache = await caches.open(PHET);
      const cached = await cache.match(req, { ignoreSearch: true });
      if (cached) return cached;
      try {
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      } catch {
        return new Response('<!doctype html><meta charset="utf-8"><body style="font:16px system-ui;padding:24px">Этот опыт ещё не сохранён на устройстве. Открой его один раз, когда будет интернет или подключение к Коробке.</body>', { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }
    })());
    return;
  }
  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const fromCache = async () => (await cache.match(req, { ignoreSearch: true }))
      || (req.mode === 'navigate' ? await cache.match('index.html') : undefined);
    // cache: 'no-cache' — сверяемся с сервером, а не берём файл из обычного кэша браузера: иначе после
    // обновления сайта новый app.js мог встретиться со старым graph-view.js (GitHub Pages разрешает кэш на 10 минут).
    const network = (req.mode === 'navigate' ? fetch(req) : fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' })).then((res) => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    });
    let timer;
    const slow = new Promise((resolve) => { timer = setTimeout(resolve, NETWORK_TIMEOUT); });
    try {
      const res = await Promise.race([network, slow.then(() => undefined)]);
      if (res) return res;
      const cached = await fromCache(); // сеть медленная: показываем копию, а свежая версия сохранится в фоне
      if (cached) { event.waitUntil(network.catch(() => {})); return cached; }
      return await network;
    } catch {
      return (await fromCache()) || new Response('Нет сохранённой копии этой страницы', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    } finally {
      clearTimeout(timer);
    }
  })());
});
