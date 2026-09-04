// ─── Service Worker: shell offline + carga instantánea ───────────
// Cachea el shell estático de la app (HTML/CSS/JS/íconos) para que:
//  1) la segunda visita en adelante cargue al toque, sin esperar red.
//  2) sin conexión, la PWA abra igual en vez de romperse.
//
// Estrategia mixta (v1.25): el documento principal (app.html, el que
// dice qué versión es) va a la red primero — así un usuario con señal
// ve el último deploy ya en la primera apertura, sin tener que abrir la
// app dos veces para que se actualice. El resto del shell (CSS/JS/
// íconos) sigue con stale-while-revalidate: sirve lo cacheado al toque
// y en paralelo pide la versión nueva para la PRÓXIMA visita — no hace
// falta acordarse de bumpear una versión en cada deploy. Sin conexión,
// todo cae al caché (o al aviso de sin conexión si no hay nada guardado
// todavía) — eso no cambia.
//
// Solo toca pedidos al propio origen (el shell). Todo lo demás — la
// API de Drive, Google Identity Services, Google Fonts — es de otro
// origen y pasa de largo sin que este Service Worker lo intercepte.

const CACHE_NAME = 'travel-diary-shell-v1';

const SHELL_FILES = [
  './app.html',
  './style.css',
  './drive.js',
  './exif.js',
  './debug.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png',
];

const OFFLINE_FALLBACK = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>旅 — Sin conexión</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:#f7f5f0;color:#1a1a18;font-family:-apple-system,'DM Sans',sans-serif;
    text-align:center;padding:2rem;}
  .mark{font-size:2.5rem;color:#c8a96e;margin-bottom:0.5rem;}
  p{color:#8a8880;max-width:28ch;margin:0 auto;}
</style></head>
<body><div><div class="mark">旅</div><p>Sin conexión y todavía no hay nada guardado para mostrar. Probá de nuevo cuando tengas señal.</p></div></body></html>`;

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL_FILES)).catch(() => {})
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(names =>
      Promise.all(names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // solo el propio origen

  // El documento principal (app.html, pedido con mode:'navigate' al abrir
  // la PWA o recargar) va siempre a la red primero — es el que dice qué
  // versión es, así que no puede quedar un paso atrás como el resto del
  // shell (ver v1.25 en CLAUDE.md). Si no hay conexión, cae al caché.
  event.respondWith(req.mode === 'navigate' ? networkFirst(req) : staleWhileRevalidate(req));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.ok) cache.put(req, fresh.clone());
    return fresh;
  } catch {
    const cached = await cache.match(req);
    if (cached) return cached;
    return new Response(OFFLINE_FALLBACK, { headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(req);

  const networkFetch = fetch(req).then(res => {
    if (res && res.ok && res.type === 'basic') cache.put(req, res.clone());
    return res;
  }).catch(() => null);

  if (cached) return cached;

  const fresh = await networkFetch;
  if (fresh) return fresh;

  return new Response('', { status: 504, statusText: 'Sin conexión' });
}
