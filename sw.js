/* Last Orbit 2.0 — scoped offline shell, fresh HTML, bounded cache. */
const PREFIX = 'last-orbit:' + self.registration.scope + ':';
const CACHE = PREFIX + '2.0.0';
const ASSETS = [
  './', './index.html', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png',
  './icons/icon-1024.png', './icons/apple-touch-icon.png'
];
const absolute = path => new URL(path, self.registration.scope).href;
const assetURLs = new Set(ASSETS.map(absolute));
const pageURL = absolute('./index.html');

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(key => key !== CACHE && (key.startsWith(PREFIX) || /^last-orbit-v[1-4]$/.test(key)))
      .map(key => caches.delete(key))
  )).then(() => self.clients.claim()));
});

async function remember(url, response) {
  if(response && response.ok){
    try{ const cache = await caches.open(CACHE); await cache.put(url, response.clone()); }catch(e){}
  }
  return response;
}
async function page(request) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try{
    const response = await fetch(request, {signal:controller.signal});
    if(response.ok) return await remember(pageURL, response);
    const cached = await caches.match(pageURL);
    return cached || response;
  }catch(e){
    return await caches.match(pageURL) || new Response('Offline — please connect once to install Last Orbit.', {
      status:503, headers:{'Content-Type':'text/plain; charset=utf-8'}
    });
  }finally{ clearTimeout(timer); }
}
self.addEventListener('fetch', event => {
  const request = event.request;
  if(request.method !== 'GET') return;
  const url = new URL(request.url);
  if(url.origin !== self.location.origin) return;
  const canonical = url.origin + url.pathname;
  if(canonical === pageURL || canonical === absolute('./')){
    event.respondWith(page(request));
    return;
  }
  // Only precached assets belong to this game. Never cache arbitrary URLs.
  if(!assetURLs.has(canonical)) return;
  const network = fetch(request).then(response => remember(canonical, response)).catch(() => null);
  event.waitUntil(network.then(() => undefined));
  event.respondWith(caches.match(canonical).then(async cached => {
    if(cached) return cached;
    return await network || new Response('Offline', {status:503});
  }));
});
