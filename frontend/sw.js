// Conservative service worker. Goal: the page still opens when the signal drops mid-party.
// Network first (so a redeploy is picked up right away), cache as the fallback. API and S3 calls are
// cross origin and never touched here. Visit the page with ?nosw=1 to remove this worker.
const CACHE = 'mb-shell-v1';
const SHELL = ['./', 'index.html', 'css/app.css', 'js/guest.js', 'js/config.js', 'js/uploader.js', 'js/errors.js', 'js/api.js', 'js/idb.js', 'js/net.js', 'js/ids.js', 'js/i18n.js', 'js/policy.js', 'js/media.js', 'js/dom.js', 'fonts/bricolage.woff2', 'icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      .catch(() => {})
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const WAIT_MS = 2500;
let slowUntil = 0; // when the network lost a race recently, stop waiting for it for a while

function offline(req, cache) {
  if (req.mode === 'navigate') return cache.match('index.html').then((hit) => hit || new Response('Offline', { status: 503, headers: { 'content-type': 'text/plain' } }));
  return new Response('Offline', { status: 503, headers: { 'content-type': 'text/plain' } });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const immutable = url.pathname.endsWith('.woff2') || url.pathname.endsWith('.svg');
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(req, { ignoreSearch: req.mode === 'navigate' });
      if (immutable && cached) return cached;
      const network = fetch(req).then((res) => {
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      });
      // First visit: nothing saved yet, so wait for the network.
      if (!cached) return network.catch(() => offline(req, cache));
      // Repeat visit: use the network answer if it comes quickly, otherwise open from the saved copy
      // (a weak signal must never make the page slow) and let the network refresh the copy for next time.
      // The page loads in layers (page, script, its imports), so once the network is known to be slow the
      // later layers do not each wait again.
      event.waitUntil(network.catch(() => {}));
      if (Date.now() < slowUntil) return cached;
      let settled = false;
      const answer = network.then(
        (res) => {
          settled = true;
          return res;
        },
        () => {
          settled = true;
          return cached;
        },
      );
      const giveUp = new Promise((resolve) =>
        setTimeout(() => {
          if (!settled) slowUntil = Date.now() + 30000;
          resolve(cached);
        }, WAIT_MS),
      );
      return Promise.race([answer, giveUp]);
    })(),
  );
});
