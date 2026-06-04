// The Deal Room — service worker (offline shell, live APIs)
const CACHE = 'dealroom-v2';
const ASSETS = ['./index.html', './manifest.webmanifest', './icon-dealroom.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(k => k !== CACHE).map(k => caches.delete(k))
  )).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;                      // POST/agent/grade calls → straight to network
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;            // ElevenLabs, Anthropic, esm.sh, fonts → untouched
  e.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy));
      return res;
    }).catch(() => hit))
  );
});
