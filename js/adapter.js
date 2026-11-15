// =====================================================================
// 資料轉接層：整個前端只有這個檔案知道後端長什麼樣。
// 契約來源：交接包 sql/02_rpcs.sql、sql/10_progress.sql、sql/20_multiuser.sql 與 面板運作說明.md 第 4 節。
// 有設定又有金鑰就連真後端（Supabase RPC）；否則退回示範模式（假資料，不連網路）。
//
// 提供給 app.js 的介面（兩種模式相同）：
//   const api = await createAdapter();
//   api.mode                      'live' 或 'mock'
//   await api.whoami()            → { role, kind, caps:{read,act,add,edit,fulltext,remind,progress,notion,mac,admin} }（opp_whoami）
//   await api.list()              → { items: [正規化卡片], serverTime: ms|null }（opp_list 的 items＋doing＋gone，不含全文與步驟）
//   await api.get(id)             → 單張卡，含 detailText 與 progressSteps（opp_get）
//   await api.progress(id)        → 單張卡，含 progressSteps，不含全文（opp_progress）
//   await api.act(id, action, o)  → 更新後的卡。action：dive｜stash｜unstash｜deleted｜skipped｜restore｜build
//   api.subscribe(onPing, onState)→ 取消函式；onPing() 代表「有變動，請重抓」，onState(bool) 代表即時連線狀態
//   網頁端沒有任何寫入進度的呼叫：進度只由企劃流程用 planner 金鑰回寫。
// =====================================================================

export const CONFIG = {
  SUPABASE_URL: 'https://ebxhycczmmyhaytodmgk.supabase.co',   // 待填：公司 Supabase 專案網址（Dashboard > Settings > API）
  // 公開的 publishable（anon）key，可以寫進網頁。每人一把的私鑰絕不寫在這裡，只從網址 ?k=、#k= 或 localStorage 來。
  SUPABASE_ANON_KEY: 'sb_publishable_yM3AAfdBh4l6sKbiO0tT1Q_DJ2DQ4sg',   // 待填
  KEY_STORAGE: 'copp_key',          // 與個人版的 opp_key 分開，兩個面板不互蓋
  SNAPSHOT_KEY: 'copp.snapshot.v1', // 與個人版的 opp.snapshot.* 分開
  POLL_MS: 15000,          // 輪詢備援
  FAST_POLL_MS: 3000,      // 有「讀全文中」或「建資料夾中」時加快
  TIMEOUT_MS: 15000,       // 一般請求逾時
  SLOW_MS: 3000,           // 超過這麼久還沒回來，就顯示「載入比較久」
  GONE_HOURS: 72,
  RPC: { whoami: 'opp_whoami', list: 'opp_list', get: 'opp_get', progress: 'opp_progress', topic: 'get_opp_realtime_topic',
         dive: 'opp_dive', stash: 'opp_stash', unstash: 'opp_unstash', drop: 'opp_drop', restore: 'opp_restore', build: 'opp_build' },
};

// 後端回來的英文名字或程式名 → 畫面上的顯示名。沒列到的照原字顯示。
export const NICK = {
  'Company Claude': '公司 Claude', 'company claude': '公司 Claude', 'company_claude': '公司 Claude', 'claude': '公司 Claude', 'Claude': '公司 Claude',
  'system': '系統自動', 'System': '系統自動',
};
export const nick = n => NICK[n] || n;

export class AdapterError extends Error {
  constructor(kind, message, status) { super(message); this.kind = kind; this.status = status; }
}

const qs = new URLSearchParams(location.search);

// ---------- 金鑰：網址 ?k= 帶進來（也收 #k=），存 localStorage，並留在網址上 ----------
export function tokenFrom(s) {
  s = String(s || '').trim(); if (!s) return '';
  let m = s.match(/\/k\/([A-Za-z0-9_-]{20,})/); if (m) return m[1];
  m = s.match(/[?&#]k=([^&#\s]+)/); if (m) { try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; } }
  m = s.match(/#([A-Za-z0-9_-]{20,})/); if (m) return m[1];
  m = s.match(/^[A-Za-z0-9_-]{20,}$/); return m ? m[0] : '';
}
const LS = { get: k => { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} }, del: k => { try { localStorage.removeItem(k); } catch (e) {} } };
let KEY = '';
(function initKey() {
  // 金鑰來源順序：網址 ?k=、網址 #k=（相容舊做法）、localStorage。
  // 金鑰留在網址上（改成 ?k=金鑰、拿掉 #），iPhone 加到主畫面時網址帶著金鑰，獨立 App 第一次開也有。
  const fromUrl = tokenFrom(location.search) || tokenFrom(location.hash);
  if (fromUrl.length >= 20) { KEY = fromUrl; LS.set(CONFIG.KEY_STORAGE, KEY); } else KEY = LS.get(CONFIG.KEY_STORAGE);
  if (KEY.length >= 20) {
    try { const u = new URL(location.href); u.hash = ''; u.searchParams.set('k', KEY); history.replaceState(null, '', u.pathname + u.search); } catch (e) {}
  }
})();
export const hasKey = () => KEY.length >= 20;
export function saveKey(k) { KEY = k; LS.set(CONFIG.KEY_STORAGE, k); try { const u = new URL(location.href); u.hash = ''; u.searchParams.set('k', k); history.replaceState(null, '', u.pathname + u.search); } catch (e) {} }  // 網址也一起換，不然重新整理會讀回舊的 ?k=
export const keyTag = () => KEY.slice(0, 6);        // 快照用，不是完整金鑰

export async function createAdapter() {
  const mockFlag = qs.get('mock');
  const forceMock = mockFlag !== null && mockFlag !== '0';
  const configured = CONFIG.SUPABASE_URL.startsWith('http') && !CONFIG.SUPABASE_URL.includes('YOUR-PROJECT-REF') && !CONFIG.SUPABASE_ANON_KEY.startsWith('YOUR-');
  if (!configured) console.info('[好咖皮條客] adapter.js 的 SUPABASE_URL / SUPABASE_ANON_KEY 還是待填佔位，目前顯示示範資料');
  if (hasKey() && !forceMock && configured) return liveAdapter();
  const { mockAdapter } = await import('./mock.js?v2');   // ?v 跟 sw.js 的 CACHE 一起換
  return mockAdapter(forceMock ? mockFlag : '');
}

// ---------- 正規化：後端欄位 → 前端欄位 ----------
export const LANES_STORED = ['tender', 'grant', 'pitch', 'watch'];   // active 不存，由 status = doing 推導
const ts = v => { if (!v) return null; const n = typeof v === 'number' ? v : Date.parse(v); return Number.isFinite(n) ? n : null; };
const arr = v => Array.isArray(v) ? v.map(x => String(x)).filter(Boolean) : (typeof v === 'string' && v ? [v] : []);
const str = v => (v == null ? '' : String(v));
// 網址只收 http(s)，其他（javascript:、data: 等）一律當成沒有網址，不畫成連結
export const safeUrl = v => { const u = str(v).trim(); return /^https?:\/\//i.test(u) ? u : ''; };
// 正式連結欄位 links（sql/23）：[{kind, label, url}]，kind = pool｜review｜pay｜session｜other；只收 https://
export const LINK_KINDS = ['pool', 'review', 'pay', 'session', 'other'];
function links(v) {
  if (!Array.isArray(v)) return [];
  return v.filter(x => x && typeof x === 'object').map(x => ({ kind: LINK_KINDS.includes(x.kind) ? x.kind : 'other', label: str(x.label).trim(), url: /^https:\/\//i.test(str(x.url).trim()) ? str(x.url).trim() : '' })).filter(x => x.url);
}
const int = v => { const n = Number(v); return Number.isFinite(n) ? Math.round(n) : null; };
const STEP_ST = ['pending', 'current', 'done', 'skipped', 'blocked'];
const PROG_ST = ['none', 'queued', 'active', 'blocked', 'overdue', 'done', 'failed'];

function steps(v) {
  if (!Array.isArray(v)) return null;          // null = 這次回傳沒帶步驟（opp_list），前端要另外去拿
  return v.filter(s => s && typeof s === 'object').map(s => ({
    key: str(s.key), name: str(s.name) || str(s.key), status: STEP_ST.includes(s.status) ? s.status : 'pending',
    dueAt: ts(s.due_at), doneAt: ts(s.done_at), owner: nick(str(s.owner)), note: str(s.note),
  }));
}

export function normalize(r) {
  const status = r.status === 'stashed' ? 'snoozed' : (['new', 'doing', 'dropped', 'expired'].includes(r.status) ? r.status : 'new');
  return {
    id: str(r.id), title: str(r.title), shortTitle: str(r.short_title), org: str(r.org),
    lane: LANES_STORED.includes(r.lane) ? r.lane : '', basket: str(r.basket),
    status,
    amountLabel: str(r.amount_label), currency: str(r.currency), amountDisplay: str(r.amount_display),
    deadline: ts(r.deadline), deadlineText: str(r.deadline_text), deadlineApprox: !!r.deadline_approx,
    expiresAt: ts(r.expire_at), snoozeUntil: ts(r.remind_at), stashDueAt: ts(r.stash_due_at), decidedAt: ts(r.decided_at),
    sourceUrl: safeUrl(r.source_url), sourceSite: str(r.source_site), foundBy: nick(str(r.found_by)), foundAt: ts(r.created_at), isDemo: !!r.is_demo,
    why: str(r.why), quick: arr(r.quick), facts: arr(r.facts), warn: arr(r.warn), firstStep: str(r.first_step), fit: str(r.fit),
    // 標案結構化欄位（公司版新增）。honor（導演地位）公司版不用，前端忽略。
    caseNo: str(r.case_no), tenderMethod: str(r.tender_method), bidBond: str(r.bid_bond), performancePeriod: str(r.performance_period), qualification: str(r.qualification),
    crawlStatus: str(r.crawl_status) || 'none', crawlError: str(r.crawl_error), hasFullText: !!r.has_full_text,
    detailText: str(r.full_text), attachments: Array.isArray(r.attachments) ? r.attachments.filter(a => a && safeUrl(a.url)).map(a => ({ name: str(a.name), url: safeUrl(a.url), type: str(a.type) })) : [],
    folderStatus: str(r.folder_status) || 'none', folderError: str(r.folder_error), folderName: str(r.folder_name), folderPath: str(r.folder_path),
    notionUrl: safeUrl(r.notion_url), notionStatus: str(r.notion_status),
    links: links(r.links),   // 沒有就是空陣列
    dropReason: str(r.drop_reason),
    // 進度摘要（opp_list 每張 doing 卡都有）。progress_status 由後端 _opp_card 現算，前端照用。
    progressStatus: PROG_ST.includes(r.progress_status) ? r.progress_status : (status === 'doing' ? 'active' : 'none'),
    progressState: str(r.progress_state), progressStage: str(r.progress_stage), progressStageKey: str(r.progress_stage_key),
    progressPct: int(r.progress_pct), progressStepN: int(r.progress_step_n), progressStepTotal: int(r.progress_step_total),
    progressNote: str(r.progress_note), progressBlocker: str(r.progress_blocker), progressOutcome: str(r.progress_outcome),
    progressDueAt: ts(r.progress_due_at), progressArchiveAt: ts(r.progress_archive_at),
    progressUpdatedAt: ts(r.progress_updated_at), progressUpdatedBy: nick(str(r.progress_updated_by)),
    progressSteps: steps(r.progress_steps),
  };
}

// ---------- 真後端（Supabase REST + Realtime） ----------
function liveAdapter() {
  const base = CONFIG.SUPABASE_URL.replace(/\/+$/, '');
  const headers = { 'content-type': 'application/json', apikey: CONFIG.SUPABASE_ANON_KEY };
  async function rpc(name, body, timeout) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeout || CONFIG.TIMEOUT_MS);
    let res;
    try { res = await fetch(base + '/rest/v1/rpc/' + name, { method: 'POST', headers, body: JSON.stringify({ p_key: KEY, ...body }), signal: ac.signal, cache: 'no-store' }); }
    catch (e) { throw new AdapterError(ac.signal.aborted ? 'timeout' : (navigator.onLine === false ? 'offline' : 'network'), ac.signal.aborted ? '連線逾時' : '連不上伺服器'); }
    finally { clearTimeout(t); }
    let data = null; const txt = await res.text();
    try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = txt; }
    if (!res.ok) {
      const msg = String((data && (data.message || data.error || data.hint)) || ('HTTP ' + res.status));
      if (res.status === 401 || res.status === 403) {
        // 權限不足（例如唯讀金鑰按到寫入）與金鑰失效都回 401/403。先用 opp_whoami 確認金鑰本身還有效，有效就只是沒權限，不清金鑰。
        if (name !== CONFIG.RPC.whoami && name !== CONFIG.RPC.list) {
          try { await rpc(CONFIG.RPC.whoami, {}); throw new AdapterError('perm', msg, res.status); }   // 保留後端原訊息（例如 only an admin key can build tender cards）
          catch (e) { if (!(e instanceof AdapterError) || e.kind !== 'auth') throw (e instanceof AdapterError && e.kind === 'perm' ? e : new AdapterError('server', msg, res.status)); }
        }
        LS.del(CONFIG.KEY_STORAGE); KEY = ''; throw new AdapterError('auth', msg, res.status);
      }
      if (res.status === 404 || /not found/i.test(msg)) throw new AdapterError('state', msg, res.status);   // P0002：卡不見了，重抓列表
      throw new AdapterError(res.status === 400 || res.status === 422 ? 'state' : 'server', msg, res.status);
    }
    return data;
  }
  const card = d => { d = Array.isArray(d) ? d[0] : d; return d && typeof d === 'object' && d.id ? normalize(d) : null; };
  const R = CONFIG.RPC;
  return {
    mode: 'live',
    async whoami() {
      const d = await rpc(R.whoami, {});
      return { role: str(d && d.role), kind: str(d && d.kind), caps: (d && d.caps) || {} };
    },
    async list() {
      const d = await rpc(R.list, { p_gone_hours: CONFIG.GONE_HOURS });
      if (!d || !Array.isArray(d.items)) throw new AdapterError('server', '回傳格式不對');
      const all = [].concat(d.items, d.doing || [], d.gone || []).map(normalize);
      return { items: all, serverTime: ts(d.server_time) };
    },
    async get(id) { return card(await rpc(R.get, { p_id: id })); },
    async progress(id) { return card(await rpc(R.progress, { p_id: id })); },
    async act(id, action, o = {}) {
      switch (action) {
        case 'dive': return card(await rpc(R.dive, { p_id: id, ...(o.force ? { p_force: true } : {}) }));
        case 'stash': return card(await rpc(R.stash, { p_id: id }));
        case 'unstash': return card(await rpc(R.unstash, { p_id: id }));
        case 'deleted': case 'skipped': return card(await rpc(R.drop, { p_id: id, p_reason: action }));
        case 'restore': return card(await rpc(R.restore, { p_id: id }));
        case 'build': return card(await rpc(R.build, { p_id: id }));
      }
      throw new AdapterError('server', '未知動作');
    },
    subscribe(onPing, onState) {
      let stopFn = () => {}, dead = false;
      rpc(R.topic, {}).then(t => { if (!dead && typeof t === 'string' && t) stopFn = realtime(base, t, onPing, onState); else onState(false); }).catch(() => onState(false));
      return () => { dead = true; stopFn(); };
    },
    setKey(k) { KEY = k; LS.set(CONFIG.KEY_STORAGE, k); },
  };
}

// Supabase Realtime（Phoenix 協定）。只聽 broadcast；任何訊息都只當成「請重抓」，不信任內容。
function realtime(base, channel, onPing, onState) {
  const url = base.replace(/^http/, 'ws') + '/realtime/v1/websocket?apikey=' + encodeURIComponent(CONFIG.SUPABASE_ANON_KEY) + '&vsn=1.0.0';
  const topic = 'realtime:' + channel;
  let ws, hb, rt, n = 0, stop = false, tries = 0;
  const send = o => { try { ws.send(JSON.stringify(o)); } catch (e) {} };
  function open() {
    if (stop) return;
    try { ws = new WebSocket(url); } catch (e) { onState(false); return; }
    ws.onopen = () => {
      send({ topic, event: 'phx_join', ref: String(++n), payload: { config: { broadcast: { self: false, ack: false }, presence: { key: '' }, postgres_changes: [], private: false }, access_token: CONFIG.SUPABASE_ANON_KEY } });
      hb = setInterval(() => send({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: String(++n) }), 25000);
    };
    ws.onmessage = ev => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.topic !== topic) return;
      if (m.event === 'phx_reply') { if (m.payload && m.payload.status === 'ok') { if (tries) onPing(); tries = 0; onState(true); } else onState(false); }
      else if (m.event === 'broadcast') onPing();
      else if (m.event === 'phx_error' || m.event === 'phx_close') onState(false);
    };
    ws.onclose = () => { clearInterval(hb); onState(false); if (!stop) rt = setTimeout(open, Math.min(30000, 1500 * 2 ** tries++)); };
    ws.onerror = () => { try { ws.close(); } catch (e) {} };
  }
  const vis = () => { if (!document.hidden && (!ws || ws.readyState > 1)) { clearTimeout(rt); open(); } };
  document.addEventListener('visibilitychange', vis);
  open();
  return () => { stop = true; clearTimeout(rt); clearInterval(hb); document.removeEventListener('visibilitychange', vis); try { ws.close(); } catch (e) {} };
}
