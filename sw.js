// 好咖皮條客 Service Worker（v90 起：快取名帶版號，只清自己前綴的舊快取）
// 只快取同網域的畫面檔，讓離線時還打得開。API 請求在別的網域，這裡完全不碰。
// 規則：先連網路，連不上才用快取。HTML 與 version.json 用 no-store，不讀瀏覽器的 HTTP 快取（GitHub Pages 會快取 10 分鐘）。
//
// 為什麼 v90 要改這支（v81 的說明寫「這支不用改」）：
// 1. 快取名換成帶版號（opp-co-shell-v90）：這支檔案的內容一變，瀏覽器就會裝新的 SW，舊快取在 activate 時一起清掉。
// 2. 只刪自己前綴（opp-co-shell）的舊快取：GitHub Pages 的網域 8664filming-hash.github.io 底下的其他 repo 跟這裡共用 Cache Storage，
//    v81 的寫法（不是自己這個名字就刪）會連別的頁面的快取一起刪。
// 3. install 就 skipWaiting、activate 就 clients.claim：同事主畫面上開著的舊版（v81）不用重裝、不用滑掉，
//    v81 頁面自己會發現 version.json 變了 → 請 SW 換新 → 重新整理一次就是 v90（見備料 03_SW更新方案與本機驗證.md）。
// 發版：這支只改 VERSION 一行（跟 version.json、所有 ?vN 同一個字）。
const VERSION = 'v91';
const PREFIX = 'opp-co-shell';
const CACHE = PREFIX + '-' + VERSION;
const SHELL = ['./', 'index.html'];
// 只清自己前綴的舊快取。activate 清一次；新版頁面載入時（message keep）再清一次——
// 換版那幾秒，舊 SW 還沒交棒前處理的請求會把舊快取 put 回來（本機模擬 A 抓到過），所以第二次一定要有。
const dropOld = () => caches.keys().then(ks => Promise.all(ks.filter(k => (k === PREFIX || k.startsWith(PREFIX + '-')) && k !== CACHE).map(k => caches.delete(k))));
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).catch(() => {}).then(() => self.skipWaiting())); });   // cache:'reload'：不拿瀏覽器 HTTP 快取裡的舊 index（GitHub Pages 給 max-age=600；本機模擬 C 抓到斷網時開出舊版）
// 換版接手：刪自己前綴的舊快取、claim，再問每個視窗是哪一版。
// 有回答 v7 以上的不動（v7 起頁面自己看 version.json，會自己重新整理或出提示條）；沒回答的（v6 以前的頁面）才重新導到同一個網址（保留 ?k=）。
// navigate 不能放進 waitUntil：導覽要等這支 SW 啟用完才會經過它的 fetch，放進去會互等卡死。瀏覽器不支援 navigate 就跳過。
self.addEventListener('activate', e => {
  e.waitUntil(dropOld().then(() => self.clients.claim()));
  setTimeout(() => self.clients.matchAll({ type: 'window' }).then(cs => cs.forEach(c => new Promise(res => {
    const ch = new MessageChannel(), t = setTimeout(() => res(null), 1500);
    ch.port1.onmessage = ev => { clearTimeout(t); res(ev.data); };
    try { c.postMessage({ ask: 'version' }, [ch.port2]); } catch (err) { clearTimeout(t); res(null); }
  }).then(v => (/^v\d+$/.test(v || '') && +String(v).slice(1) >= 7) ? null : (typeof c.navigate === 'function' ? Promise.resolve(c.navigate(c.url)).catch(() => null) : null))))
    .catch(() => {}), 0);
});
self.addEventListener('message', e => {
  if (e.data === 'skipWaiting') { self.skipWaiting(); return; }
  // 頁面告訴我目前版本（例如 v90）：把網址帶 ?v 其他版本的快取刪掉，避免一直累積。manifest 與圖示刻意留在 ?v81，不刪
  const keep = e.data && e.data.keep;
  if (keep && /^v\d+$/.test(keep)) e.waitUntil(dropOld().then(() => new Promise(r => setTimeout(r, 8000))).then(dropOld).then(() => caches.open(CACHE)).then(c => c.keys().then(ks => Promise.all(ks.map(k => { const u = new URL(k.url), m = u.search.match(/^\?(v\d+)$/); return m && m[1] !== keep && !/(manifest\.webmanifest|\/icons\/)/.test(u.pathname) ? c.delete(k) : null; })))));
});
self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin) return;
  // 快取的鑰匙網址拿掉 ?k=（金鑰），Cache Storage 裡不留任何人的金鑰
  const key = new URL(u); key.hash = '';
  if (key.searchParams.has('k')) key.searchParams.delete('k');
  const fresh = r.mode === 'navigate' || /(\/|\.html|version\.json)$/.test(u.pathname);
  const req = fresh ? new Request(r.url, { cache: 'no-store', credentials: 'same-origin' }) : r;
  e.respondWith(fetch(req).then(res => { if (res.ok && !/version\.json$/.test(u.pathname)) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(key.href, copy)); } return res; })
    .catch(() => caches.match(key.href).then(m => m || caches.match(r, { ignoreSearch: true })).then(m => m || (r.mode === 'navigate' ? caches.match('index.html') : Response.error()))));
});
