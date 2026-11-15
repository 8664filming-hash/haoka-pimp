// 只快取同網域的畫面檔，讓離線時還打得開。API 請求在別的網域，這裡完全不碰。
// 規則：先連網路，連不上才用快取，所以改版後不會卡在舊版。
const CACHE = 'opp-co-shell-v6';  // 每次改版換一個名字
// 畫面檔帶 ?v 版本號（跟 CACHE 同步換），和 index.html／import 用的網址一致
const V = 'v6';
const SHELL = ['./', 'index.html', 'css/app.css?' + V, 'js/app.js?' + V, 'js/adapter.js?' + V, 'js/util.js?' + V, 'js/mock.js?' + V, 'manifest.webmanifest?' + V, 'icons/favicon-32.png?' + V, 'icons/icon-192.png?' + V, 'icons/apple-touch-icon.png?' + V];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin) return;
  // 快取的鑰匙網址拿掉 ?k=（金鑰），Cache Storage 裡不留任何人的金鑰（D 審稿 #7）
  const key = new URL(u); key.hash = '';
  if (key.searchParams.has('k')) key.searchParams.delete('k');   // 只有帶金鑰時才重組網址，不然 ?v6 這類版本號會被改寫成 ?v6=，同一個檔存兩份
  e.respondWith(fetch(r).then(res => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(key.href, copy)); } return res; })
    .catch(() => caches.match(r, { ignoreSearch: true }).then(m => m || (r.mode === 'navigate' ? caches.match('index.html') : Response.error()))));
});
