// 只快取同網域的畫面檔，讓離線時還打得開。API 請求在別的網域，這裡完全不碰。
// v7 起：發版只要換 version.json 和 js／css 網址的 ?vN，這支不用改（頁面會用 version.json 判斷有沒有新版，見 README）。
// 規則：先連網路，連不上才用快取。HTML 與 version.json 用 no-store，不讀瀏覽器的 HTTP 快取（GitHub Pages 會快取 10 分鐘）。
const CACHE = 'opp-co-shell';
const SHELL = ['./', 'index.html'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting())); });
// 換版接手（v6 → v7 免滑掉，D 審稿 #2「問版本」）：刪舊快取、claim，再問每個視窗是哪一版。
// 有回答 v7 以上的不動（v7 起頁面自己看 version.json）；沒回答的（v6 的頁面）才重新導到同一個網址（保留 ?k=）。
// navigate 不能放進 waitUntil：導覽要等這支 SW 啟用完才會經過它的 fetch，放進去會互等卡死。瀏覽器不支援 navigate 就跳過。
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
  setTimeout(() => self.clients.matchAll({ type: 'window' }).then(cs => cs.forEach(c => new Promise(res => {
    const ch = new MessageChannel(), t = setTimeout(() => res(null), 1500);
    ch.port1.onmessage = ev => { clearTimeout(t); res(ev.data); };
    try { c.postMessage({ ask: 'version' }, [ch.port2]); } catch (err) { clearTimeout(t); res(null); }
  }).then(v => (/^v\d+$/.test(v || '') && +String(v).slice(1) >= 7) ? null : (typeof c.navigate === 'function' ? Promise.resolve(c.navigate(c.url)).catch(() => null) : null))))
    .catch(() => {}), 0);
});
self.addEventListener('message', e => {
  if (e.data === 'skipWaiting') { self.skipWaiting(); return; }
  // 頁面告訴我目前版本（例如 v8）：把網址帶 ?v 其他版本的快取刪掉，避免一直累積
  const keep = e.data && e.data.keep;
  if (keep && /^v\d+$/.test(keep)) e.waitUntil(caches.open(CACHE).then(c => c.keys().then(ks => Promise.all(ks.map(k => { const m = new URL(k.url).search.match(/^\?(v\d+)$/); return m && m[1] !== keep ? c.delete(k) : null; })))));
});
self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin) return;
  // 快取的鑰匙網址拿掉 ?k=（金鑰），Cache Storage 裡不留任何人的金鑰（D 審稿 #7）
  const key = new URL(u); key.hash = '';
  if (key.searchParams.has('k')) key.searchParams.delete('k');   // 只有帶金鑰時才重組網址，不然 ?v7 這類版本號會被改寫成 ?v7=，同一個檔存兩份
  const fresh = r.mode === 'navigate' || /(\/|\.html|version\.json)$/.test(u.pathname);
  const req = fresh ? new Request(r.url, { cache: 'no-store', credentials: 'same-origin' }) : r;
  e.respondWith(fetch(req).then(res => { if (res.ok && !/version\.json$/.test(u.pathname)) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(key.href, copy)); } return res; })
    .catch(() => caches.match(key.href).then(m => m || caches.match(r, { ignoreSearch: true })).then(m => m || (r.mode === 'navigate' ? caches.match('index.html') : Response.error()))));
});
