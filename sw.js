/* Last Orbit — سرویس‌ورکر برای نصب PWA و بازی آفلاین
 *
 * مشکل نسخهٔ قبلی (v1): استراتژی «اول کش» برای همه‌چیز + ignoreSearch باعث می‌شد
 * index.html قدیمی برای همیشه از کش خوانده شود و آپدیت‌های گیت‌هاب پیجز
 * هیچ‌وقت به کاربر نرسد.
 *
 * رفتار جدید:
 *  - صفحهٔ اصلی و ناوبری‌ها: network-first — همیشه تازه‌ترین نسخه از اینترنت.
 *  - فایل‌های ثابت (آیکون‌ها، مانیفست): اول کش + به‌روزرسانی پس‌زمینه‌ای.
 *  - با هر انتشار، CACHE را بالا ببر تا کش قدیمی کاملاً پاک شود (v3 = Last Orbit 1.5.0).
 */
const CACHE = 'last-orbit-v3';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-1024.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isPageRequest(req) {
  if (req.mode === 'navigate') return true;
  if (req.method !== 'GET') return false;
  try {
    const url = new URL(req.url);
    return url.origin === self.location.origin &&
      (url.pathname.endsWith('/') || url.pathname.endsWith('index.html'));
  } catch (e) { return false; }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return;   // درخواست خارجی: دست‌نخورده

  // صفحهٔ اصلی: همیشه اول اینترنت (آپدیت‌ها فوری می‌رسند)؛ آفلاین: از کش
  if (isPageRequest(req)) {
    e.respondWith(
      fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('./index.html', copy));
        }
        return res;
      }).catch(() =>
        caches.match('./index.html').then((hit) => hit || caches.match('./'))
      )
    );
    return;
  }

  // فایل‌های ثابت: اول کش، با تازه‌سازی پس‌زمینه‌ای
  e.respondWith(
    caches.match(req).then((cached) => {
      const net = fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => null);
      if (cached) return cached;
      return net.then((res) => {
        if (res) return res;
        throw new Error('offline + uncached: ' + req.url);
      });
    })
  );
});
