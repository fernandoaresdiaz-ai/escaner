/* Permite usar la app sin internet: guarda sus ficheros y el motor de escaneo */
const CACHE = 'escaner-v1';
const OPENCV_URL = 'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@5.0.0-release.1/dist/opencv.js';
const LOCAL = ['./', 'index.html', 'app.js', 'engine.js', 'worker.js', 'manifest.webmanifest', 'icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await c.addAll(LOCAL);
    try { await c.add(new Request(OPENCV_URL, { mode: 'cors' })); } catch (_) {}
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // El motor no cambia nunca (versión fija): primero la copia guardada
  if (req.url.startsWith(OPENCV_URL)) {
    e.respondWith((async () => {
      const c = await caches.open(CACHE);
      const hit = await c.match(OPENCV_URL);
      if (hit) return hit;
      const res = await fetch(new Request(OPENCV_URL, { mode: 'cors' }));
      if (res.ok) c.put(OPENCV_URL, res.clone());
      return res;
    })());
    return;
  }
  // Ficheros de la app: primero internet (para recibir mejoras), si no hay, la copia guardada
  if (url.origin === location.origin) {
    e.respondWith((async () => {
      const c = await caches.open(CACHE);
      try {
        const res = await fetch(req);
        if (res.ok) c.put(req, res.clone());
        return res;
      } catch (_) {
        return (await c.match(req, { ignoreSearch: true })) || (await c.match('index.html'));
      }
    })());
  }
});
