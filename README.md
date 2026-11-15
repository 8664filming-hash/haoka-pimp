# 好咖皮條客前端

靜態網頁，沒有建置步驟。`index.html` 加 `css/app.css` 加 `js/*.js`（ES modules）。版面規格見交接包 `DESIGN.md`，後端契約見 `面板運作說明.md` 第 4 節與 `sql/02_rpcs.sql`、`sql/10_progress.sql`、`sql/20_multiuser.sql`。

## 一定要先改的兩個值（`js/adapter.js` 最上面的 CONFIG）
- `SUPABASE_URL`：公司 Supabase 專案網址，目前是佔位 `https://YOUR-PROJECT-REF.supabase.co`
- `SUPABASE_ANON_KEY`：公司專案的 publishable（anon）key，目前是佔位 `YOUR-PUBLISHABLE-KEY`。這是公開值，可以寫進網頁；**每人一把的私鑰絕對不要寫進任何檔案**。

兩個值沒改時，頁面一律顯示示範資料（全部標「示意資料」）。

## 檔案
- `js/adapter.js`：唯一知道後端長相的檔案。設定、金鑰處理、RPC 呼叫（opp_whoami、opp_list、opp_get、opp_progress、opp_dive、opp_stash、opp_unstash、opp_drop、opp_restore、opp_build、get_opp_realtime_topic）、Realtime、欄位正規化、`NICK` 顯示名對照。網頁端沒有任何寫入進度的呼叫。
- `js/mock.js`：示範資料與假動作，以及偵錯用的 `?mock=` 參數（`viewer`、`slow`、`crawlslow`、`crawlhang`、`crawlfail`、`realbuild`、`setfail` 等，說明在檔頭）。
- `js/app.js`：狀態、畫面、事件。待定文案集中在檔頭的 `TBD` 常數。
- `js/util.js`：時間（台北時區）、相對時間、倒數、中文斷行、金額。
- **發版只要換兩處**（v7 起）：
  1. `version.json` 寫新版本，例如 `{"version":"v8"}`。
  2. 全部網址後面的 `?vN` 換成同一個版本：`index.html`（css、js、manifest、圖示）、`js/app.js` 開頭兩個 import、`js/mock.js` 開頭的 import、`js/adapter.js` 動態匯入 mock 那一行、`manifest.webmanifest` 的圖示。可以用 `sed -i '' 's/?v7/?v8/g' index.html manifest.webmanifest js/*.js` 一次換。
  - `sw.js` 不用改：快取名固定是 `opp-co-shell`。HTML 和 version.json 一律走網路，而且不讀瀏覽器快取（no-store）。頁面會告訴 SW 目前的版本，SW 就把其他版本的檔清掉。
  - 頁面在載入、切回前景、取得焦點時，還有每 10 分鐘，都會抓一次 `version.json`。版本跟正在跑的 js（`?vN`）不同，就請 SW 換新並自動重新整理。抽屜、待決區、確認框開著，或輸入框有字時，先不整理，頂端改顯示「有新版本，點一下更新」。
  - 剛為某一版整理過、拿到的還是舊檔（GitHub Pages 換檔的那幾分鐘）：2 分鐘內不再自動整理，改顯示提示，避免一直重整。
  - **兩處要一起換**：只換 `version.json`、沒換 `?vN`，頁面會以為還是舊版，整理後只會顯示提示。
- `manifest.webmanifest`、`icons/`：加到主畫面用（短名「皮條客」，刻意不寫 start_url 與 scope）。圖示由 `00_專案指示與背景/面板icon_原檔_20261116.png` 用 sips 縮出：icon-192／512、icon-maskable-512（縮到 80% 再用底色 #213D74 補邊）、apple-touch-icon 180、favicon 32／16。圖示網址也帶 `?v`，改版時跟 CACHE 一起換。

## 金鑰與權限
- 用 `網址?k=金鑰` 開（也收 `#k=金鑰`）。金鑰存進 localStorage 的 `copp_key`（與個人版的 `opp_key` 分開），快照存 `copp.snapshot.v1:<金鑰前 6 碼>`，並留在網址列上。
- 開頁先呼叫 `opp_whoami`，依 `caps` 畫按鈕：沒有 `act`（viewer）就只剩「深入了解」（只看、不觸發讀全文）與「看進度」，沒有刪掉、暫存、取消暫存、救回來、不做、要做。
- 401／403：先再呼叫一次 `opp_whoami`，金鑰還有效就只當「沒權限」；金鑰無效才清掉 `copp_key`，顯示「金鑰失效，請向管理員重新索取網址」。
- `<meta name="referrer" content="no-referrer">` 已設，網址上的金鑰不會經由 Referer 送出去。

## 本機看示範
在這個資料夾起靜態伺服器，例如 `python3 -m http.server 8765`，開 `http://localhost:8765/`；加 `?mock=viewer` 看唯讀，`?tab=active` 直接看進行中籃。
