// 好咖皮條客主程式 v90（v3 新設計：首頁五個房間 × 暮光色塊，外觀每人自選）。
// 只透過 adapter.js 取得與寫入資料；資料、權限、RPC 與 v81 完全相同，換的是畫面與互動。
// 設計稿：AI工作夾/1122_皮條客_樣張/皮條客_設計v3.html；功能對照：AI工作夾/1122_皮條客_v3備料/01_功能對照表.md
import { createAdapter, CONFIG, AdapterError, hasKey, keyTag, tokenFrom, saveKey, safeUrl, RK, SCAN_LANES, SKINS } from './adapter.js?v90';   // ?v 跟 version.json 一起換（GitHub Pages 會快取 10 分鐘，不帶版本號會新舊混搭）
import { esc, H, D, URGENT_DAYS, fmtDate, fmtDay, fmtClock, relTime, fmtLeft, shortLeft, softBreak, splitAmount } from './util.js?v90';

const $ = s => document.querySelector(s);
const LANES = [
  { k: 'tender', n: '政府標案', d: '已公告、公司可投的採購' },
  { k: 'grant', n: '補助徵件', d: '公司名義可申請的補助' },
  { k: 'pitch', n: '企劃提案', d: '品牌與機關合作企劃' },
  { k: 'active', n: '進行中', d: '決定要做的案子，最急的在最上面' },
  { k: 'watch', n: '盯案後續', d: '還在等正式公告' },
];
const LN = Object.fromEntries(LANES.map(b => [b.k, b.n]));
// v90：分頁＝首頁＋五籃＋封存（封存在最右，往左滑才看得到，照 Borry 2026-11-16）
const ORDER = ['home', 'tender', 'grant', 'pitch', 'active', 'watch', 'archive'];
const TAB_N = Object.assign({ home: '首頁', archive: '封存' }, LN);
const INBOX_LANES = ['tender', 'grant', 'pitch', 'watch'];
const FALLBACK_LANE = 'pitch';
const HOLD_HOUR = 8;

// ===== 文案集中在這裡 =====
export const TBD = {
  stashToast: name => '「' + name + '」放進待決區，到期前肉咖會在 LINE 群組提醒',
  remindLine: at => '暫存到 ' + fmtDate(at) + '，肉咖會在 LINE 群組提醒',
  remindPassed: '已到提醒時間，請決定要不要做',
  previewRemind: at => '暫存中，到期前肉咖會在 LINE 群組提醒（' + fmtDate(at) + '）',
  sheetNote: '到期前肉咖會在 LINE 群組提醒；網頁自己不會跳通知。',
  laneEmpty: '有新的案子會自動出現在這裡，不用重新整理。',
  folderFailHelp: '請找管理員處理。這張卡已經記成「要做」，不會不見。',
  progressFailHelp: '請找管理員處理。',
  crawlFailHint: '上面的條件是先整理好的，全文要自己開連結看。',
};
const AUTH_MSG = '金鑰失效，請向管理員重新索取網址';
const TENDER_ADMIN = '政府標案由管理員或有權限的同事決定要不要做。你可以暫存，或跟肉咖說你的看法。';
const OUTCOME = { won: '得標／核定', lost: '未得標', submitted: '已送件結案', withdrawn: '作廢' };
const PAY_STEP = 'pay_approval';
const SUBMIT_KEYS = ['seal_submit', 'seal_and_bid', 'submit'];
const POST_SUBMIT_KEYS = ['qualify', 'pitch_prep', 'pitch_present', 'await_opening', 'under_review', 'result'];
const MILESTONE = { pitch_prep: '簡報', pitch_present: '簡報', qualify: '資格審查', await_opening: '開標', under_review: '審查結果', result: '結果' };
const milestone = it => MILESTONE[it.progressStageKey] || it.progressStage || '下一步';
const submitStep = it => it.progressSteps && it.progressSteps.find(x => SUBMIT_KEYS.includes(x.key) && (x.status === 'done' || x.status === 'skipped'));
const sentTag = it => { const s = submitStep(it); return '已送件' + (s && s.doneAt ? ' ' + fmtDay(s.doneAt).replace(/（.）$/, '') : ''); };
function submitted(it) {
  if (it.status !== 'doing' || it.progressStatus === 'done') return false;
  if (POST_SUBMIT_KEYS.includes(it.progressStageKey)) return true;
  return !!(it.progressSteps && it.progressSteps.some(x => SUBMIT_KEYS.includes(x.key) && (x.status === 'done' || x.status === 'skipped')));
}
const URL_RE = /https?:\/\/[^\s<>"'，。、；！？）」』】]+/i;
const noteUrl = note => { const m = String(note || '').match(URL_RE); return m ? safeUrl(m[0].replace(/[.,;:!?)\]]+$/, '')) : ''; };
const noteText = note => String(note || '').replace(URL_RE, '').replace(/[：:\s]+$/, '').trim();
const isClaude = u => { try { const h = new URL(u).hostname; return h === 'claude.ai' || h.endsWith('.claude.ai'); } catch (e) { return false; } };
const linkLabel = (key, u) => key === PAY_STEP ? '去領標付款' : isClaude(u) ? '進領標對話' : '開啟連結';
const linkBtn = (key, u, cls) => '<a class="' + (cls || 'bq') + ' step-link" href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">' + linkLabel(key, u) + '</a>';
const LINK_DEFAULT = { pool: 'Pool', review: '內審', pay: '去領標付款', session: '進領標對話', other: '開啟連結' };
const linkText = l => l.label || LINK_DEFAULT[l.kind] || '開啟連結';
const linksOf = it => Array.isArray(it.links) ? it.links : [];
const linkOf = (it, kind) => linksOf(it).find(l => l.kind === kind);
const extLink = (l, cls, text) => '<a class="' + cls + '" href="' + esc(l.url) + '" target="_blank" rel="noopener noreferrer">' + esc(text || linkText(l)) + '</a>';
const bidDone = it => !!it && (it.bidState === 'paid' || it.bidState === 'fetched');
function payUrl(it) {
  if (it.status !== 'doing' || bidDone(it)) return '';
  const pay = linkOf(it, 'pay'); if (pay) return pay.url;
  if (it.progressStageKey !== PAY_STEP) return '';
  const st = it.progressSteps && it.progressSteps.find(x => x.key === PAY_STEP);
  return noteUrl(st && st.note) || noteUrl(it.progressNote);
}
const UP = '<i class="up" aria-hidden="true">▾</i>';

// ---------------- 狀態 ----------------
const qs = new URLSearchParams(location.search);
const S = {
  items: new Map(),
  net: 'loading', hadData: false, slow: false, lastOk: null, rt: false, firstNet: false,
  caps: null, who: null,
  tab: ORDER.includes(qs.get('tab')) ? qs.get('tab') : 'home',
  sheet: false, drawer: null,   // drawer = {id, view:'preview'|'full'|'progress'|'chat'|'archived'|'followups'|'skin'}
  detail: new Map(), prog: new Map(),
  textOpen: new Set(), attOpen: new Set(), fresh: new Set(),
  fu: { open: null, list: null, filter: 'open', busy: false, err: false, byItem: new Map(), ticket: 0 },
  bul: { d: null, err: false, sig: '', at: 0, busy: false, open: 0 },
  scan: {}, scanBusy: new Set(),
  arch: { list: null, q: '', year: '', busy: false }, archMap: new Map(), dlg: null,
  msgs: new Map(), msgBusy: new Set(), pend: new Map(), draft: new Map(), events: new Map(), evBusy: new Set(),
  bidPage: null, bidForm: { amount: '', receipt: '', note: '' }, bidSumOpen: new Set(), mine: false, presence: null, presOpen: new Set(), presOff: false,
  fx: new Set(),   // v90：收合列展開中的 key（說明、全部步驟、案件資料…）
  cx: new Set(),   // v90：卡片「⋯」展開中的卡
  skin: 1, prefRemote: null, prefBusy: false,   // v90：外觀（1 暮光色塊、2 片場夜拍、3 黑白場記板）；prefRemote：true＝跟著金鑰、false＝後端還沒開
};
let api, lastFocus = null, depth = 0, ignorePop = false;
const locks = new Set(), mutDone = {};
let OFF = 0;
const tnow = () => Date.now() + OFF;
const can = k => !!(S.caps && S.caps[k]);
const normName = x => String(x || '').replace(/[ \t\n\v\f\r]/g, '').toLowerCase();
const myNames = () => new Set(((S.who && S.who.aliases && S.who.aliases.length ? S.who.aliases : S.who && S.who.role ? [S.who.role] : [])).map(normName).filter(Boolean));
const ownerIsMe = s => { const me = myNames(); return !!me.size && String(s.ownerRaw || '').split(/[、，,／/;；&＋+]/).some(x => me.has(normName(x))); };
const stepOpenNow = s => s.status === 'current' || s.status === 'blocked';
const mineSteps = it => (it.progressSteps || []).filter(s => stepOpenNow(s) && ownerIsMe(s));
const bidManaged = (s, it) => !!s && (s.key === PAY_STEP || s.key === 'bid_fetch') && bidDone(it);
const canMarkStep = (s, it) => it && it.status === 'doing' && it.progressStatus !== 'done' && !bidManaged(s, it) && (can('admin') || can('progress') || (can('act') && ownerIsMe(s)));
const trackLabel = l => String(l || '').replace(/\S*:\/\/\S*|www\.\S*/gi, '').trim().slice(0, 60) || '檔案';
function track(id, action, stepKey, label) {
  if (!api || !api.track || !id) return;
  const d = {}; if (stepKey) d.step_key = stepKey; if (label) d.label = trackLabel(label);
  try { Promise.resolve(api.track(id, action, Object.keys(d).length ? d : null)).catch(() => {}); } catch (e) {}
}
const canBuild = it => can('act') && (it.lane !== 'tender' || can('admin') || can('build_tender'));
const items = () => [...S.items.values()];
const get = id => S.items.get(id);

// ---------------- 籃子推導 ----------------
const archived = it => it.status === 'doing' && it.progressStatus === 'done' && it.progressArchiveAt && it.progressArchiveAt <= tnow();
function laneOf(it) {
  if (it.status === 'doing') return archived(it) ? null : 'active';
  if (it.status !== 'new') return null;
  return INBOX_LANES.includes(it.lane) ? it.lane : FALLBACK_LANE;
}
const homeLane = it => INBOX_LANES.includes(it.lane) ? it.lane : FALLBACK_LANE;

// ---------------- 倒數 ----------------
function target(it) {
  if (it.status === 'doing') {
    if (it.progressStatus === 'done' && it.progressArchiveAt) return { kind: 'arch', at: it.progressArchiveAt };
    if (submitted(it)) return it.progressDueAt ? { kind: 'due', at: it.progressDueAt } : { kind: 'tbd', at: Infinity };
    return it.deadline ? { kind: 'dl', at: it.deadline } : { kind: 'none', at: Infinity };
  }
  if (it.deadline && (!it.expiresAt || it.deadline <= it.expiresAt)) return { kind: 'dl', at: it.deadline };
  if (it.expiresAt) return { kind: 'ttl', at: it.expiresAt };
  return { kind: 'none', at: Infinity };
}
const vanishAt = it => target(it).at;
function lvOf(it) {
  const t = target(it), m = t.at - tnow();
  if (t.kind === 'dl' || t.kind === 'due') return m < URGENT_DAYS * D ? 'hot' : m < 7 * D ? 'warm' : 'calm';
  if (t.kind === 'tbd') return 'warm';
  if (t.kind === 'ttl') return m < D ? 'warm' : 'calm';
  return 'calm';
}
const approx = it => !!it.deadlineApprox && !!it.deadline;
const APPROX_NOTE = '（時間以公告為準）';
// v90：卡片右上的倒數（設計稿 .cd）：大字是剩幾天，急件前面加 ▲；沒有日期的換成文字
function cd3(it) {
  const t = target(it), m = t.at - tnow(), hot = lvOf(it) === 'hot';
  const b = (x, s, cls) => ({ cls: (cls || '') + (hot ? ' urg' : ''), html: '<b>' + (hot && !cls ? '▲ ' : '') + x + '</b>' + (s ? '<span>' + s + '</span>' : '') });
  if (t.kind === 'none') return b('沒有截止日', '', 'txt');
  if (t.kind === 'tbd') return b(esc(milestone(it)) + '日期未定', '', 'txt');
  if (m <= 0) return b(t.kind === 'dl' ? '時間到' : t.kind === 'due' ? '已逾期' : t.kind === 'arch' ? '即將撤下' : '即將收走', '');
  const left = (t.kind === 'dl' && approx(it) ? '約 ' : '') + shortLeft(m);
  return b(left, t.kind === 'dl' ? '後截止' : t.kind === 'due' ? '後' + esc(milestone(it)) : t.kind === 'arch' ? '後撤下' : '後收走');
}
const cdSpan = it => { const c = cd3(it); return '<span class="cd' + c.cls + '" data-cd="' + esc(it.id) + '" data-mode="c3">' + c.html + '</span>'; };
function cdFull(it) {
  const t = target(it), m = t.at - tnow();
  if (t.kind === 'none') return '沒寫';
  if (t.kind === 'tbd') return '日期未定';
  if (m <= 0) return t.kind === 'dl' ? '時間到' : t.kind === 'due' ? '已逾期' : t.kind === 'arch' ? '即將撤下' : '即將收走';
  return (t.kind === 'dl' && approx(it) ? '約 ' : '') + fmtLeft(m);
}
function cdLine(it) {
  const t = target(it), m = t.at - tnow();
  if (t.kind === 'none') return '沒寫截止日';
  if (t.kind === 'dl') return m <= 0 ? '截止時間到了' : '剩 <b>' + (approx(it) ? '約 ' : '') + fmtLeft(m) + '</b> 截止' + (approx(it) ? APPROX_NOTE : '');
  return m <= 0 ? '即將收走' : '<b>' + fmtLeft(m) + '</b> 後收走';
}
function tick() {
  document.querySelectorAll('[data-cd]').forEach(e => {
    const it = get(e.dataset.cd); if (!it) return;
    const mode = e.dataset.mode;
    if (mode === 'c3') { const c = cd3(it); e.className = 'cd' + c.cls; e.innerHTML = c.html; }
    else if (mode === 'line') e.innerHTML = cdLine(it); else e.textContent = cdFull(it);
  });
  document.querySelectorAll('[data-rel]').forEach(e => { e.textContent = relTime(Number(e.dataset.rel), tnow()); });
  document.querySelectorAll('[data-elapsed]').forEach(e => {
    const d = S.detail.get(e.dataset.elapsed); if (!d) return;
    const sec = Math.floor((tnow() - d.t0) / 1000);
    e.textContent = sec;
    const hint = e.parentNode && e.parentNode.querySelector('[data-elapsed-hint]');
    if (hint) hint.textContent = crawlHint(sec);
  });
  renderSummary();
}

// ---------------- 進度狀態 ----------------
function pv(it) {
  const ps = it.progressStatus, now = tnow();
  const dlPassed = it.deadline && it.deadline <= now;
  if (ps === 'failed') return { k: 'failed', badge: it.folderStatus === 'failed' ? '資料夾沒建成' : '流程失敗', alert: 'stuck' };
  if (ps === 'done') return { k: 'done', badge: '已完成' };
  if (ps === 'blocked') return { k: 'blocked', badge: '卡住', alert: 'stuck' };
  if (submitted(it)) {
    const d = it.progressDueAt;
    if (d && d <= now) return { k: 'sent', badge: '這步逾期', alert: 'late', sent: true };
    if (d && d - now < URGENT_DAYS * D) return { k: 'sent', badge: '即將到期', alert: 'late', sent: true };
    return { k: 'sent', badge: '進行中', sent: true };
  }
  if (ps === 'overdue') return { k: 'overdue', badge: '這步逾期', alert: 'late' };
  if (dlPassed) return { k: 'dlpass', badge: '截止已到', alert: 'late' };
  if (ps === 'queued') return { k: 'queued', badge: '建立工作區中' };
  const soon = (it.progressDueAt && it.progressDueAt - now < D) || (it.deadline && it.deadline - now < URGENT_DAYS * D);
  if (soon) return { k: 'soon', badge: '即將逾期', alert: 'late' };
  return { k: 'active', badge: '進行中' };
}
const folderWait = it => it.status === 'doing' && ['none', 'queued', 'building'].includes(it.folderStatus);
const folderWaitText = it => it.folderStatus === 'building' ? '正在建立工作資料夾' : '已排隊，等 Mac 接工作';
const pct = it => Math.max(0, Math.min(100, it.progressPct == null ? 0 : it.progressPct));
// 目前這一步：步驟清單有抓到就用清單（current／blocked，沒有就最後一步）；沒抓到就只有階段名
const curStep = it => { const st = it.progressSteps; if (!st || !st.length) return null; return st.find(stepOpenNow) || null; };
const curIdx = it => { const st = it.progressSteps; if (st && st.length) { const i = st.findIndex(stepOpenNow); return i < 0 ? st.length - 1 : i; } return it.progressStepN ? it.progressStepN - 1 : 0; };
const stepTotal = it => (it.progressSteps && it.progressSteps.length) || it.progressStepTotal || 0;

// ---------------- 方塊字頭像（設計稿 .av）：同事用一個字，自己那顆是亮的 ----------------
// 照名冊對（Borry 2026-11-16 名字對照）；對不到就取第一個字，英文取大寫字首
const AVC = { borry: 'B', '蘇尚珄': 'B', '巴西': '巴', louis: '巴', '詹家維': '巴', '石頭': '石', '張佑維': '石', cc: 'C', '阿包': '包', '承益': '包', '包承益': '包', bosen: 'Bo', '蔡博森': 'Bo', '肉咖': '肉', davidchiu: '昊', '昊奇': '昊' };
function avc(name) {
  const n = String(name || '').split(/[、，,／/;；&＋+]/)[0].replace(/^管理員[-－]?/, '').trim();
  if (!n) return '';
  const k = normName(n); if (AVC[k] || AVC[n]) return AVC[k] || AVC[n];
  return /^[A-Za-z]/.test(n) ? n[0].toUpperCase() : n[0];
}
const av = (name, raw) => { const c = avc(name); if (!c) return ''; const me = raw != null && ownerIsMe({ ownerRaw: raw }); return '<span class="av' + (me ? ' me' : '') + '" aria-hidden="true">' + esc(c) + '</span>'; };
const myName = () => { const r = S.who && S.who.role ? String(S.who.role) : ''; return r.replace(/^管理員[-－]?/, '').trim() || r; };

// ---------------- 小積木 ----------------
const linkTag = it => /^（之前在盯案後續/.test(it.why) ? '之前在盯案後續' : /^正式公告已上看板/.test(it.why) ? '正式公告已上看板' : '';
const amtText = it => { const a = splitAmount(it.amountDisplay); return a.num ? (it.amountLabel ? it.amountLabel + ' ' : '') + (it.currency || '') + a.num + (a.unit ? ' ' + a.unit : '') : (it.amountLabel ? it.amountLabel + ' ' : '') + (a.text || '沒寫金額'); };
function amtBig(it) {
  const a = splitAmount(it.amountDisplay);
  const t = a.num ? (it.currency || '') + a.num + (a.unit ? ' ' + a.unit : '') : (a.text || '沒寫金額');
  return '<p class="amt">' + esc(t) + (it.amountLabel ? '<small>' + esc(it.amountLabel) + '</small>' : '') + '</p>';
}
const link = it => it.sourceUrl ? '<a class="bl" href="' + esc(it.sourceUrl) + '" target="_blank" rel="noopener noreferrer">' + (it.sourceSite ? '開啟原始連結（' + esc(it.sourceSite) + '）' : '開啟原始連結') + '</a>' : '';
const para = s => esc(s).split(/\n{2,}/).map(p => p.replace(/\n/g, '<br>')).join('<br><br>');
// 收合列（設計稿 fold）：key 存在 S.fx
function fold(key, label, html, meta) {
  const o = S.fx.has(key);
  return '<div class="fo"><button class="fb" type="button" data-act="fold" data-k="' + esc(key) + '" aria-expanded="' + o + '"><span class="ft">' + label + '</span>' + (meta ? '<span class="fm">' + meta + '</span>' : '') + '<span class="cv" aria-hidden="true">' + (o ? UP : '▾') + '</span></button>' + (o ? '<div class="fc">' + html + '</div>' : '') + '</div>';
}
const blk = (h, html) => html ? '<div class="blk">' + (h ? '<h3>' + h + '</h3>' : '') + html + '</div>' : '';

// ---------------- 畫面：頂列 ----------------
function renderLive() {
  const el = $('#live'); if (!el) return;
  let dot = '', txt = '';
  const mock = api && api.mode === 'mock';
  if (S.net === 'loading') { dot = 'idle'; txt = S.hadData ? '更新中' : '載入中'; }
  else if (S.net === 'offline') { dot = 'off'; txt = S.lastOk ? '離線・' + fmtClock(S.lastOk) : '連不上伺服器'; }
  else if (S.net === 'auth') { dot = 'off'; txt = '金鑰失效'; }
  else { dot = S.rt ? '' : 'idle'; txt = (mock ? '示範資料' : S.rt ? '即時更新' : '每 15 秒更新') + '・' + fmtClock(S.lastOk); }
  if (S.caps && !can('act') && S.net !== 'auth') txt += '（唯讀）';
  el.innerHTML = '<i class="dot ' + dot + '"></i>' + txt;
}
function renderSummary() {
  // 待決 N（頂列右邊那行字）＋ 急件小字（首頁、進行中不顯示：首頁那條帶子、進行中第一張卡已經講了）
  const hb = $('#holdbtn');
  if (hb) { const hn = holdItems().length; hb.hidden = S.net === 'auth' || !S.hadData; hb.innerHTML = '待決 <b>' + hn + '</b>'; hb.setAttribute('aria-label', '待決區，' + hn + ' 筆'); }
  const hr = $('#hot'); if (!hr) return;
  const u = S.hadData && S.tab !== 'home' && S.tab !== 'active' ? urgentOne() : null;
  hr.innerHTML = u ? '<button class="urgl" data-act="open-hot" data-id="' + esc(u.it.id) + '" type="button" title="' + esc(u.txt) + '"><span>▲ ' + esc(u.txt) + '</span></button>' : '';
  hr.hidden = !u;
}
function urgentOne() {
  const now = tnow();
  const c = activeItems().filter(it => it.progressStatus !== 'done').map(it => ({ it, at: keyTime(it) })).filter(x => x.at && x.at > now && x.at - now < URGENT_DAYS * D).sort((a, b) => a.at - b.at);
  if (!c.length) return null;
  const { it, at } = c[0];
  const lab = !submitted(it) && it.deadline === at ? '截止' : milestone(it);
  const n = nm(it), sn = n.length > 8 ? n.slice(0, 8) + '…' : n;
  return { it, txt: '剩 ' + shortLeft(at - now) + '｜' + sn + ' ' + fmtDay(at) + hm(at) + ' ' + lab };
}
const hasHot = () => activeItems().some(it => it.progressStatus !== 'done' && (pv(it).alert || lvOf(it) === 'hot'));
function renderNotice() {
  const el = $('#notice'); let html = '';
  const mockNoKey = api && api.mode === 'mock' && !hasKey();
  if (S.net === 'auth') html = '<span>' + AUTH_MSG + '。</span><button type="button" data-act="paste-key">貼上金鑰</button>';
  else if (S.net === 'offline') html = '<span>' + (S.lastOk ? '連不到伺服器，畫面是 ' + fmtClock(S.lastOk) + ' 的內容。恢復連線後會自動更新。' : '連不到伺服器，也沒有上次的內容可以顯示。') + '</span><button type="button" data-act="retry">重試</button>';
  else if (S.net === 'loading' && S.slow) html = '<span class="spin"></span><span>' + (S.hadData ? '連線比較慢，先顯示上次的內容。' : '載入比較久，網路可能很慢，請稍等。') + '</span>';
  else if (mockNoKey) html = '<span>沒有金鑰，現在看到的是示範資料。</span><button type="button" data-act="paste-key">貼上金鑰</button>';
  else if (S.net === 'ok' && S.slow) html = '<span class="spin"></span><span>正在更新…</span>';
  el.hidden = !html; el.innerHTML = html;
}

// ---------------- 清單 ----------------
function sortList(l) { return l.sort((a, b) => vanishAt(a) - vanishAt(b) || (b.foundAt || 0) - (a.foundAt || 0)); }
const inbox = () => items().filter(i => i.status === 'new');
const activeItems = () => sortActive(items().filter(i => laneOf(i) === 'active'));
const keyTime = it => { const c = []; if (!submitted(it) && it.deadline) c.push(it.deadline); if (it.progressDueAt) c.push(it.progressDueAt); return c.length ? Math.min(...c) : null; };
const isClosed = it => it.progressStatus === 'done' ? 1 : 0;
const isStuck = it => (pv(it).k === 'blocked' || it.progressStatus === 'blocked') ? 1 : 0;
const sortActive = l => l.sort((a, b) => { const ka = keyTime(a), kb = keyTime(b);
  return isClosed(a) - isClosed(b) || (ka == null) - (kb == null) || (ka || 0) - (kb || 0) || isStuck(b) - isStuck(a) || (b.progressUpdatedAt || b.decidedAt || 0) - (a.progressUpdatedAt || a.decidedAt || 0); });
// 進行中「下一個關鍵時間」換成一句話：公告截止還沒到、但這一步的內部期限過了，寫「這步逾期」而不是「時間到」
function keyLeft(it) {
  const at = keyTime(it); if (!at) return '沒有日期';
  const ms = at - tnow(); if (ms > 0) return '剩 ' + shortLeft(ms);
  return it.progressDueAt && it.progressDueAt <= tnow() && !(it.deadline && it.deadline <= tnow() && !submitted(it)) ? '這步逾期' : '時間到';
}
const laneList = k => k === 'active' ? activeItems() : sortList(inbox().filter(i => laneOf(i) === k));
const mineItems = () => activeItems().filter(i => i.progressStatus !== 'done' && mineSteps(i).length);

// ---------------- 卡片（v3：一張卡三行，其餘收進「⋯」或抽屜） ----------------
const moreBtn = (id, name) => { const x = S.cx.has(id); return '<button class="bx" type="button" data-act="cx" data-id="' + esc(id) + '" aria-expanded="' + x + '" aria-label="' + (x ? '收起' : '更多動作') + '：' + esc(name) + '">' + (x ? '收起' : '⋯') + '</button>'; };
function bidLine(it) {   // 卡面灰色小字（沒申請就不畫）
  if (!bidOk(it) || it.bidState === 'none') return '';
  const v = verdictOf(it);
  return it.bidState === 'requested' ? '領標中：' + it.bidRequestedBy
    : it.bidState === 'paid' ? (bidFetching(it) ? '肉咖抓檔中' : '已付：' + it.bidPaidBy + (it.bidPaidAt ? ' ' + fmtDay(it.bidPaidAt).replace(/（.）/, '') : ''))
    : '已領標' + ((it.bidFetchedBy || it.bidPaidBy) ? '：' + (it.bidFetchedBy || it.bidPaidBy) : '') + (v ? '・肉咖建議' + v[0] : '');
}
function card(it) {
  const id = esc(it.id), x = S.cx.has(it.id), hot = lvOf(it) === 'hot';
  const sub = [it.org, bidLine(it), linkTag(it), it.isDemo ? '示意資料' : ''].filter(Boolean).map(esc).join('・');
  const acts = x ? '<div class="acts">' + (can('act') ? '<button class="bq" type="button" data-act="del" data-id="' + id + '">刪掉</button><button class="bq" type="button" data-act="hold" data-id="' + id + '">暫存</button>' : '') +
    '<span class="gr"></span><button class="bp" type="button" data-act="dive" data-id="' + id + '">深入了解</button></div>' : '';
  return '<article class="card c3' + (hot ? ' hot' : '') + (S.fresh.has(it.id) ? ' fresh' : '') + '" data-b="' + homeLane(it) + '" data-id="' + id + '"><div class="cw">' +
    '<button class="cmain" type="button" data-act="open-card" data-id="' + id + '" aria-label="' + esc(it.title) + '"><span class="c1"><span class="ttl sb">' + softBreak(nm(it)) + '</span>' + cdSpan(it) + '</span>' +
    (sub ? '<span class="c2"><span>' + sub + '</span></span>' : '') + '</button>' + moreBtn(it.id, nm(it)) + '</div>' + acts + '</article>';
}
function segs(it) {
  const st = it.progressSteps, tot = stepTotal(it), ci = curIdx(it), done = it.progressStatus === 'done';
  if (!tot) return '<span class="segs" aria-hidden="true"><i class="' + (pct(it) >= 100 ? 'd' : 'c') + '"></i></span>';
  let h = '';
  for (let i = 0; i < tot; i++) { const s = st && st[i]; const d = s ? (s.status === 'done' || s.status === 'skipped') : i < ci || done; h += '<i class="' + (d ? 'd' : i === ci && !done ? 'c' : '') + '"></i>'; }
  return '<span class="segs" aria-hidden="true">' + h + '</span>';
}
function anomaly(it) {   // 進行中卡第三行之後的異常一行（有才畫）
  const p = pv(it);
  if (p.k === 'blocked') return '▲ 卡住：' + (it.progressBlocker || '原因沒寫');
  if (p.k === 'failed') return '▲ ' + (it.folderStatus === 'failed' ? '資料夾沒建成：' + (it.folderError || '原因不明') : '失敗：' + (it.progressBlocker || it.progressNote || '原因不明'));
  if (p.k === 'overdue') return '▲ ' + (it.progressBlocker || '這步已過內部期限');
  if (p.k === 'dlpass') return '▲ 公告截止時間已到，請確認是否已送出';
  return '';
}
function acard(it) {
  const id = esc(it.id), x = S.cx.has(it.id), hot = lvOf(it) === 'hot', s = curStep(it), ci = curIdx(it), tot = stepTotal(it), p = pv(it);
  const stage = (s && s.name) || it.progressStage || '建立工作區';
  const turn = s && s.owner ? (ownerIsMe(s) ? '輪到你' : '輪到 ' + s.owner) : '';
  const line = [stage, turn, tot ? (ci + 1) + '／' + tot : '', submitted(it) ? sentTag(it) : '', it.isDemo ? '示意資料' : ''].filter(Boolean).map(esc).join('・');
  const an = anomaly(it);
  const extra = p.k === 'done' ? '<span class="gf"><span>✓ ' + (OUTCOME[it.progressOutcome] ? '已結案：' + OUTCOME[it.progressOutcome] : '已完成') + '</span></span>'
    : an ? '<span class="anom">' + esc(an) + '</span>'
    : folderWait(it) ? '<span class="gf"><span class="spin" aria-hidden="true"></span><span>' + folderWaitText(it) + '</span></span>' : '';
  const pu = payUrl(it), ls = ['pool', 'review'].map(k => linkOf(it, k)).filter(Boolean);
  const payBtn = pu && can('pay') ? '<a class="bm" href="' + esc(pu) + '" target="_blank" rel="noopener noreferrer" aria-label="「' + esc(nm(it)) + '」去領標付款">去領標付款</a>' : '';
  const acts = payBtn || x ? '<div class="acts">' + payBtn + '<span class="gr"></span>' + (x ? (ls.length ? ls.map(l => extLink(l, 'bl')).join('') : '<span class="lg">這案還沒有 Pool、內審連結</span>') : '') + '</div>' : '';
  return '<article class="card c3' + (hot ? ' hot' : '') + (S.fresh.has(it.id) ? ' fresh' : '') + '" data-b="active" data-id="' + id + '"><div class="cw">' +
    '<button class="cmain" type="button" data-act="open-progress" data-id="' + id + '" aria-label="' + esc(it.title) + '，' + esc(p.badge) + '"><span class="c1"><span class="ttl sb">' + softBreak(nm(it)) + '</span>' + cdSpan(it) + '</span>' + segs(it) +
    '<span class="c2">' + (s && s.owner ? av(s.owner, s.ownerRaw) : '') + '<span>' + line + '</span></span>' + extra + '</button>' + moreBtn(it.id, nm(it)) + '</div>' + acts + '</article>';
}
const skel = () => '<div class="sk"></div><div class="sk"></div><div class="sk"></div><p class="vh" role="status">載入中</p>';

// ---------------- 房間狀態（要不要你動手：靠符號與字，不靠亮暗） ----------------
function need(k) {
  if (S.caps && !can('act')) return { on: false, s: '只能看', t: '唯讀，只能看' };
  if (k === 'active') { const m = mineItems().length; return m ? { on: true, s: '要你動手', t: '要你動手・' + m + ' 案輪到你' } : { on: false, s: '不用動手', t: '不用你動手・別人的步驟在跑' }; }
  if (k === 'watch') return { on: false, s: '不用動手', t: '不用動手・肉咖盯著' };
  const n = laneList(k).length; return n ? { on: true, s: '要你看', t: '要你看・' + n + ' 張等決定' } : { on: false, s: '不用動手', t: '不用動手・這籃收工了' };
}
const rst = (k, long) => { const x = need(k); return '<span class="rst ' + (x.on ? 'on' : 'off') + '"><i aria-hidden="true">' + (x.on ? '●' : '○') + '</i>' + (long ? x.t : x.s) + '</span>'; };

// ---------------- 畫面：分頁 ----------------
function renderTabs() {
  const loadingEmpty = !S.hadData && S.net === 'loading', hot = !loadingEmpty && hasHot();
  const n = k => k === 'home' ? mineItems().length : k === 'archive' ? (S.arch.list ? S.arch.list.length : '') : laneList(k).length;
  $('#tabs').innerHTML = ORDER.map(k => '<button class="tab" type="button" data-b="' + k + '" data-tab="' + k + '"' + (S.tab === k ? ' aria-current="page"' : '') + '>' +
    (k === 'active' && hot ? '<i class="hot" aria-hidden="true">▲</i>' : '') + '<b>' + (loadingEmpty ? '·' : n(k)) + '</b><span>' + TAB_N[k] + (k === 'active' && hot ? '<span class="vh">，有急件</span>' : '') + '</span></button>').join('');
  $('#tabs').hidden = S.net === 'auth' && !S.hadData;
}

// ---------------- 畫面：首頁（五個房間） ----------------
const WD = '日一二三四五六';
function hello() {
  const d = new Date(tnow() + 8 * H), hr = d.getUTCHours();
  return '<p class="dl2">' + (d.getUTCMonth() + 1) + ' 月 ' + d.getUTCDate() + ' 日 週' + WD[d.getUTCDay()] + '・' + (hr < 11 ? '早安' : hr < 18 ? '午安' : '晚安') + (myName() ? '，' + esc(myName()) : '') + '</p>';
}
function homePage() {
  if (!S.hadData && S.net === 'loading') return skel();
  const all = activeItems(), act = all.filter(i => i.progressStatus !== 'done'), a = act[0], m = mineItems();
  const left = keyLeft;
  let band;
  if (m.length) { const s = mineSteps(m[0])[0]; band = '<button class="band b3" type="button" data-act="open-progress" data-id="' + esc(m[0].id) + '"><span class="tx"><b>輪到你 ' + m.length + ' 案</b><span>' + esc((s && s.name) || m[0].progressStage || '') + '・' + esc(nm(m[0])) + '</span></span><span class="ar" aria-hidden="true">›</span></button>'; }
  else if (a) { const s = curStep(a); band = '<button class="band b3" type="button" data-act="open-progress" data-id="' + esc(a.id) + '"><span class="tx"><b>最急：' + esc(nm(a)) + '</b><span>' + esc(left(a)) + (s && s.owner ? '・輪到 ' + esc(s.owner) : '') + '</span></span><span class="ar" aria-hidden="true">›</span></button>'; }
  else band = '<div class="band b3"><span class="tx"><b>今天沒有要追的</b><span>好～Cut！</span></span></div>';
  const room = k => {
    if (k === 'active') {
      const hot = a && lvOf(a) === 'hot', bad = act.filter(x => pv(x).alert).length;
      return '<button class="room w" type="button" data-b="active" data-tab="active"><span class="rt"><span class="rn">進行中</span>' + rst('active') + '</span>' +
        '<span class="rg"><span class="n">' + all.length + '<small>案</small></span>' + (a ? '<span class="rc"><span class="l1">' + (hot ? '▲ ' : '') + '最急' + esc(left(a)) + '・' + esc(nm(a)) + '</span><span class="l2">' + (bad ? bad + ' 案卡住或快到期' : '沒有卡住的') + '</span></span>'
          : '<span class="rc"><span class="l1">沒有進行中的案子</span><span class="l2">到待看的房間按「要做」</span></span>') + '</span></button>';
    }
    const l = laneList(k), f = l[0], hot = f && lvOf(f) === 'hot', t = f && target(f);
    const lt = !f ? (k === 'watch' ? '肉咖盯著' : '這籃收工了') : t.kind === 'none' ? '沒有截止日' : t.at - tnow() <= 0 ? '時間到' : (hot ? '▲ ' : '') + '最急剩 ' + (approx(f) ? '約 ' : '') + shortLeft(t.at - tnow());
    return '<button class="room" type="button" data-b="' + k + '" data-tab="' + k + '"><span class="rt"><span class="rn">' + LN[k] + '</span>' + rst(k) + '</span><span class="n">' + l.length + '<small>張</small></span><span class="rb"><span class="l2">' + esc(lt) + '</span></span></button>';
  };
  return hello() + band + '<div class="rooms">' + room('active') + room('tender') + room('grant') + room('pitch') + room('watch') + '</div>' + rkStrip() + homeFoot();
}
function rkState() { return SCAN_LANES.some(scanning) ? 'think' : [...S.pend.values()].some(l => l.length) ? 'speak' : 'idle'; }
const rkFace = (cls) => '<span class="rk' + (cls ? ' ' + cls : '') + '" data-st="' + rkState() + '" aria-hidden="true"><img alt="" src="icons/rouka.jpg?v90"></span>';
function rkStrip() {
  const lasts = SCAN_LANES.map(k => lastScan(scanOf(k))).filter(Boolean), last = lasts.length ? Math.max(...lasts) : 0;
  const n = unreadReplies().length;
  const t = SCAN_LANES.some(scanning) ? '掃描中，掃完判讀過才會上看板' : n ? '有 ' + n + ' 則新回覆' : last ? (tnow() - last < D ? hm(last) : fmtDay(last)) + ' 掃過一輪，有事直接跟牠說' : '有事直接跟牠說';
  return '<div class="rks r3"><button class="rkm" type="button" data-act="open-chat">' + rkFace() + '<span class="tx"><b>肉咖</b><span>' + esc(t) + '</span></span><span class="ar" aria-hidden="true">›</span></button></div>';
}
const homeFoot = () => '<button class="skl" type="button" data-act="open-skin"><span>外觀</span><b>' + SKINS[S.skin] + '</b><span class="ar" aria-hidden="true">›</span></button><div class="foot"><img alt="好咖 BUDDY PLUS!" src="icons/logo.png?v90"><span>好咖皮條客 ' + esc(APP_V) + '</span></div>';

// ---------------- 畫面：籃頁（房間頂只留名字、數量、狀態；其餘收進「說明」） ----------------
function laneHead(k, n) {
  const o = S.fx.has('bh-' + k), l = laneList(k), f = k === 'active' ? l.filter(i => i.progressStatus !== 'done')[0] : l[0];
  let lead = '';
  if (f) { const at = k === 'active' ? keyTime(f) : target(f).at; lead = (k === 'active' ? '最急：' + keyLeft(f) : Number.isFinite(at) && at ? (at - tnow() <= 0 ? '最急：時間到' : (lvOf(f) === 'hot' ? '▲ ' : '') + '最急剩 ' + shortLeft(at - tnow())) : '最上面') + '｜' + nm(f); }
  const owners = k === 'active' ? [...new Map(l.filter(i => i.progressStatus !== 'done').map(curStep).filter(s => s && s.owner).map(s => [s.owner, s])).values()] : [];
  const info = '<div class="bhi"><p class="desc">' + esc(LANES.find(x => x.k === k).d) + '</p>' + (lead ? '<p class="desc">' + esc(lead) + '</p>' : '') +
    (owners.length ? '<p class="who"><span class="lb">現在輪到</span>' + owners.slice(0, 6).map(s => av(s.owner, s.ownerRaw)).join('') + '</p>' : '') +
    (k === 'tender' ? '<p class="desc">「要做」只有管理員和有權限的同事能按' + (canBuild({ lane: 'tender' }) ? '，你可以按。' : '。') + '</p>' : '') + scanBox(k) + '</div>';
  const mineN = k === 'active' ? mineItems().length : 0;
  return '<div class="bhw" data-b="' + k + '"><div class="bh"><h2>' + LN[k] + '</h2><button class="bhb" type="button" data-act="fold" data-k="bh-' + k + '" aria-expanded="' + o + '">說明 ' + (o ? UP : '▾') + '</button><span class="cn">' + n + '</span></div>' +
    '<div class="bh2">' + (S.hadData ? rst(k, true) : '') + '<span class="gr"></span>' + (k === 'active' && (mineN || S.mine) && can('act') ? '<button class="tog" type="button" data-act="mine-tog" aria-pressed="' + !!S.mine + '">' + (S.mine ? '看全部' : '只看我的（' + mineN + '）') + '</button>' : '') + '</div>' + (o ? info : '') + '</div>';
}
function laneEmpty(k) {
  if (k === 'active') return '<div class="empty"><b>' + (S.mine ? '現在沒有輪到你的步驟' : '這籃收工了') + '</b><p>' + (S.mine ? '別人的步驟還在跑，關掉篩選看全部。' : '沒有進行中的案子。到待看的籃按「要做」，案子會出現在這裡。') + '</p>' +
    (S.mine ? '<button class="bp" type="button" data-act="mine-tog">看全部進行中</button>' : '<button class="bp" type="button" data-tab="tender">去看政府標案</button>') + '</div>';
  return '<div class="empty"><b>這籃收工了</b><p>' + TBD.laneEmpty + '</p>' + scanBox(k) + '</div>';
}
function lanePage(k) {
  const loadingEmpty = !S.hadData && S.net === 'loading';
  let l = laneList(k);
  if (k === 'active') { if (S.mine && !mineItems().length) S.mine = false; if (S.mine) l = mineItems(); }
  const body = loadingEmpty ? skel() : l.length ? l.map(k === 'active' ? acard : card).join('') : laneEmpty(k);
  return laneHead(k, loadingEmpty ? '·' : l.length) + body;
}

// ---------------- 畫面：封存（分頁內就是列表；點一列看唯讀詳細） ----------------
const KIND = OUTCOME;
const KIND_DESC = { won: '得標或補助核定', lost: '沒有得標或沒入選', submitted: '已經送件，後續不追了', withdrawn: '做一半不要了' };
const thisYear = () => new Date(tnow() + 8 * H).getUTCFullYear();
function archivePage() {
  if (!S.arch.list && !S.arch.busy) loadArchive();
  const y = thisYear(), years = [y, y - 1, y - 2, y - 3], l = S.arch.list;
  const rows = !l ? '<p class="lg">讀取封存中…</p>' : l.length ? l.map(archRow).join('')
    : '<div class="empty"><b>' + (S.arch.err ? '封存讀不到' : S.arch.q || S.arch.year ? '找不到「' + esc(S.arch.q || S.arch.year) + '」' : '還沒有結案的案子') + '</b><p>' + (S.arch.err ? '請稍後再試。' : S.arch.q || S.arch.year ? '換個關鍵字，或清掉年份篩選。' : '在進行中的進度按「結案…」就會放到這裡。') + '</p>' +
      (S.arch.q || S.arch.year ? '<button class="bp" type="button" data-act="arch-clear">清除搜尋與篩選</button>' : '') + '</div>';
  return '<div class="bhw" data-b="archive"><div class="bh"><h2>封存</h2><span class="cn">' + (l ? l.length : '·') + '</span></div><p class="desc">已結案、作廢的案子。點一列看當時的進度與檔案。</p></div>' +
    '<label class="fld"><span>搜尋案名、機關、案號</span><input id="arch-q" type="search" value="' + esc(S.arch.q) + '" placeholder="例：觀光" autocomplete="off"></label>' +
    '<div class="chips" style="margin-top:10px">' + [''].concat(years).map(v => '<button class="chip" type="button" data-act="arch-year" data-y="' + v + '" aria-pressed="' + (String(S.arch.year) === String(v)) + '">' + (v ? v + ' 年' : '全部年份') + '</button>').join('') + '</div>' +
    '<p class="lg" aria-live="polite">' + (S.arch.busy ? '<span class="spin"></span> 搜尋中…' : '') + '</p>' + rows;
}
function archRow(it) {
  const id = esc(it.id), x = S.cx.has(it.id), real = it.folderStatus === 'done' && /^\//.test(it.folderPath);
  const ls = ['pool', 'review'].map(k => linkOf(it, k)).filter(Boolean);
  const sub = [it.org, KIND[it.archiveKind] || '已結案', it.archivedAt ? fmtDay(it.archivedAt) + ' 結案' : '', it.caseNo].filter(Boolean).map(esc).join('・');
  return '<div class="arow"><div class="cw"><button class="tx" type="button" data-act="arch-open" data-id="' + id + '"><b class="sb">' + softBreak(it.title) + '</b><span>' + sub + '</span></button>' + moreBtn(it.id, it.title) + '</div>' +
    (x ? '<div class="acts">' + ls.map(l => extLink(l, 'bl')).join('') + (real ? '<button class="bl" type="button" data-act="copy-path" data-id="' + id + '">複製路徑</button>' : '') + '<span class="gr"></span>' +
      (can('admin') ? '<button class="bq" type="button" data-act="arch-reopen" data-id="' + id + '">放回進行中</button>' : '') + '</div>' : '') + '</div>';
}

// ---------------- 畫面：主區 ----------------
const WIDE = matchMedia('(min-width:1100px)');
function renderMain() {
  const main = $('#main');
  const keepY = window.scrollY;
  const de = document.documentElement; de.dataset.tab = S.tab === 'home' ? 'today' : S.tab;   // 光場（設計稿用 today 當首頁的鍵）
  renderTabs(); renderSummary();
  let html;
  if (S.net === 'auth' && !S.hadData) html = '<div class="empty"><b>金鑰失效</b><p>請向管理員重新索取網址。</p><button class="bp" type="button" data-act="paste-key">貼上金鑰</button></div>';
  else if (S.net === 'offline' && !S.hadData) html = '<div class="empty"><b>載入失敗</b><p>連不到伺服器，也沒有上次的內容可以顯示。請確認網路後再試。</p><button class="bp" type="button" data-act="retry">再試一次</button></div>';
  else if (S.tab === 'home') html = homePage();
  else if (S.tab === 'archive') html = archivePage();
  else if (WIDE.matches) html = '<div class="board">' + ['tender', 'grant', 'pitch', 'active', 'watch'].map(k => '<div class="col' + (k === S.tab ? ' sel' : '') + '" data-b="' + k + '">' + lanePage(k) + '</div>').join('') + '</div>';
  else html = '<div data-b="' + S.tab + '">' + lanePage(S.tab) + '</div>';
  const ae = document.activeElement, kq = ae && ae.id === 'arch-q' ? [ae.selectionStart, ae.selectionEnd] : null;
  main.innerHTML = html;
  if (kq) { const t = $('#arch-q'); if (t) { t.focus({ preventScroll: true }); try { t.setSelectionRange(kq[0], kq[1]); } catch (e) {} } }
  window.scrollTo(0, keepY);
  S.fresh.clear();
}
const renderBoard = renderMain;
function goTab(k, dir) {
  if (!ORDER.includes(k)) return;
  const changed = k !== S.tab; S.tab = k; renderMain();
  if (changed) { window.scrollTo(0, 0); const f = $('#main').firstElementChild; if (f && !SW.rm.matches) { f.classList.add(dir === 'l' ? 'swipe-l' : dir === 'r' ? 'swipe-r' : 'in'); } }
  const t = $('#tabs [aria-current]'); if (t && t.scrollIntoView) t.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// ---------------- 畫面：待決區（暫存中、剛完成的、剛收走的；有內容的段才顯示） ----------------
const holdItems = () => sortList(items().filter(i => i.status === 'snoozed'));
const doneItems = () => items().filter(archived).sort((a, b) => (b.progressArchiveAt || 0) - (a.progressArchiveAt || 0));
const goneItems = () => items().filter(i => i.status === 'dropped' || i.status === 'expired').sort((a, b) => (b.decidedAt || 0) - (a.decidedAt || 0)).slice(0, 50);
const goneWhy = it => it.dropReason === 'deleted' ? '你刪掉的' : it.dropReason === 'skipped' ? '你決定不做的' : '時間到，自動收走';
const holdRow = (it, sub, btns) => '<div class="arow pc" data-id="' + esc(it.id) + '"><b class="sb">' + softBreak(it.title) + '</b><span>' + sub + '</span>' + (btns ? '<div class="acts">' + btns + '</div>' : '') + '</div>';
function renderSheet() {
  const h = holdItems(), f = doneItems(), g = goneItems(), none = [];
  renderSummary();
  const sh = $('#sheet'); const sc = sh.querySelector('.db') ? sh.querySelector('.db').scrollTop : 0;
  let b = '';
  if (h.length) b += blk('暫存的卡', h.map(it => { const id = esc(it.id), rem = it.snoozeUntil; return holdRow(it, (rem ? (rem > tnow() ? TBD.remindLine(rem) : TBD.remindPassed) + '・' : '') + '<span data-cd="' + id + '" data-mode="line">' + cdLine(it) + '</span>',
    (can('act') ? '<button class="bq" type="button" data-act="unstash" data-id="' + id + '">現在放回面板</button><button class="bq" type="button" data-act="del" data-id="' + id + '">刪掉</button>' : '') + '<span class="gr"></span><button class="bp" type="button" data-act="dive" data-id="' + id + '">深入了解</button>'); }).join(''));
  else none.push('暫存的卡');
  if (f.length) b += blk('剛完成的', f.map(it => holdRow(it, (OUTCOME[it.progressOutcome] ? OUTCOME[it.progressOutcome] + '，' : '') + (it.progressArchiveAt ? fmtDay(it.progressArchiveAt) + '從看板撤下' : '已從看板撤下') + '。工作資料夾仍保留。',
    '<span class="gr"></span><button class="bp" type="button" data-act="open-progress" data-id="' + esc(it.id) + '">看進度</button>')).join(''));
  else none.push('剛完成的');
  if (g.length) b += blk('剛刪掉或不做的（' + CONFIG.GONE_HOURS + ' 小時內可以救回）', g.map(it => { const dead = it.deadline && it.deadline <= tnow();
    return holdRow(it, goneWhy(it) + (it.decidedAt ? '，' + fmtClock(it.decidedAt) : '') + (dead ? '・截止已過，救不回來' : ''), can('act') && !dead ? '<button class="bq" type="button" data-act="restore" data-id="' + esc(it.id) + '">救回來</button>' : ''); }).join(''));
  else none.push('剛刪掉的');
  if (!b) b = '<div class="empty"><b>沒有等你決定的</b><p>按「暫存」的案子會放在這裡，到期前肉咖會在 LINE 群組提醒。</p></div>';
  b += '<p class="last">' + (none.length && (h.length || f.length || g.length) ? '現在沒有：' + none.join('、') + '。' : '') + TBD.sheetNote + '</p>';
  sh.innerHTML = '<div class="dh"><h2>待決區</h2><button class="xb" data-act="close-hold" type="button">關閉 ✕</button></div><div class="db">' + b + '</div>';
  sh.querySelector('.db').scrollTop = sc;
  sh.classList.toggle('show', S.sheet);
}

// ---------------- 抽屜（手機底部整頁、桌機右側；一次只有一層，對話與領標在同一個抽屜換內容，有返回） ----------------
function viewOf() {
  if (S.drawer && ['chat', 'archived', 'followups', 'skin'].includes(S.drawer.view)) return S.drawer.view;
  const it = S.drawer && get(S.drawer.id); if (!it) return null;
  return it.status === 'doing' ? 'progress' : S.drawer.view;
}
const STRUCT = [['caseNo', '案號'], ['tenderMethod', '招標方式'], ['bidBond', '押標金'], ['performancePeriod', '履約期限'], ['qualification', '資格門檻']];
const STRUCT_TITLES = { caseNo: ['案號'], tenderMethod: ['招標方式'], bidBond: ['押標金'], performancePeriod: ['履約期限', '履約'], qualification: ['資格門檻', '資格'] };
const kv = rows => rows.length ? '<dl class="kv">' + rows.map(r => '<dt>' + r[0] + '</dt><dd>' + r[1] + '</dd>').join('') + '</dl>' : '';
const structRows = it => STRUCT.filter(([k]) => it[k]).map(([k, n]) => [n, '<span class="sbp">' + softBreak(it[k]) + '</span>']);
function factsRows(it) {
  const skip = new Set(); STRUCT.forEach(([k]) => { if (it[k]) STRUCT_TITLES[k].forEach(t => skip.add(t)); });
  return it.facts.map(f => { const m = f.match(/^([^：]{1,14})：([\s\S]+)$/); return m ? { t: m[1], v: m[2] } : { t: '', v: f }; }).filter(x => !skip.has(x.t)).map(x => [x.t ? esc(x.t) : '備註', '<span class="sbp">' + softBreak(x.v) + '</span>']);
}
const metaLine = it => {
  const parts = [];
  if (it.foundBy) parts.push('由 ' + esc(it.foundBy) + ' 找到');
  if (it.sourceSite) parts.push('來源 ' + esc(it.sourceSite));
  if (it.foundAt) parts.push(fmtClock(it.foundAt) + ' 進來');
  return parts.length ? '<p class="lg">' + parts.join('，') + '</p>' : '';
};
const agLine = it => '<p class="ag">' + [LN[homeLane(it)], it.org, linkTag(it), it.isDemo ? '示意資料' : ''].filter(Boolean).map(esc).join('・') + '</p>';
function dlAttr(it) {   // 截止那一行：「▲ 11/23（一）17:00 截止・剩 1 天 6 小時」
  const t = target(it), m = t.at - tnow(), hot = lvOf(it) === 'hot';
  if (t.kind === 'none') return '<p class="attr"><span>沒寫截止日</span></p>';
  const dtx = esc(it.deadlineText) || (it.deadline ? fmtDate(it.deadline) : '');
  if (t.kind === 'dl') return '<p class="attr"><span>' + (hot ? '▲ ' : '') + dtx + ' 截止・' + (m > 0 ? '剩 ' : '') + '<span data-cd="' + esc(it.id) + '">' + cdFull(it) + '</span>' + (approx(it) ? APPROX_NOTE : '') + '</span></p>';
  if (t.kind === 'ttl') return '<p class="attr"><span>' + (it.deadline ? '截止 ' + dtx + '・' : '') + '沒處理 <span data-cd="' + esc(it.id) + '">' + cdFull(it) + '</span> 後收走</span></p>';
  return '';
}
// ----- 領標（sql/29、31）：只記錄誰申請、誰付了，付款一律自己在採購網完成 -----
const NTD = n => n == null ? '' : 'NT$' + Number(n).toLocaleString('en-US');
const VERDICT = { go: ['建議投', 'v-go'], no: ['不投', 'v-no'], maybe: ['再看', 'v-maybe'] };
const verdictOf = it => { const v = it.bidSummary && it.bidSummary.advice && it.bidSummary.advice.verdict; return VERDICT[v] || (it.bidSummary ? VERDICT.maybe : null); };
const bidOk = it => it.lane === 'tender' && ['new', 'snoozed', 'doing'].includes(it.status) &&
  (it.status !== 'doing' || it.bidState !== 'none' || (it.progressSteps || []).some(s => s.key === PAY_STEP && s.status !== 'done' && s.status !== 'skipped'));
const bidFetching = it => it.bidState === 'paid' && !!it.bidFetchStartedAt && !(it.bidFetchFailedAt && it.bidFetchFailedAt > it.bidFetchStartedAt);
const bidHot = it => bidOk(it) && (it.bidState === 'requested' || (it.status === 'doing' && it.progressStageKey === PAY_STEP && !bidDone(it)));   // 有人申請了還沒付：領標盒放最上面
const bidPayLink = it => linkOf(it, 'pay') || (it.sourceUrl ? { kind: 'other', label: '開公告頁', url: it.sourceUrl, fallback: true } : null);
function sumVal(v) {
  if (v == null || v === '' || (Array.isArray(v) && !v.length)) return '';
  if (Array.isArray(v)) return '<ul>' + v.map(x => '<li class="sbp">' + softBreak(typeof x === 'object' && x ? Object.entries(x).map(([a, b]) => a + '：' + b).join('；') : String(x)) + '</li>').join('') + '</ul>';
  if (typeof v === 'object') return '<ul>' + Object.entries(v).map(([a, b]) => '<li class="sbp">' + softBreak(a + '：' + (typeof b === 'object' ? JSON.stringify(b) : String(b))) + '</li>').join('') + '</ul>';
  return '<p class="sbp">' + softBreak(String(v)) + '</p>';
}
const SUM_KEYS = [['eligibility', '資格'], ['scoring', '評分方式'], ['budget', '預算'], ['deadline', '截止與時程'], ['presentation', '簡報'], ['bond_schedule', '押標金與期程'], ['open_questions', '還要問的']];
function bidSummaryHTML(it) {
  const s = it.bidSummary; if (!s) return '';
  const v = verdictOf(it), rs = s.advice && s.advice.reasons;
  const rest = SUM_KEYS.map(([k, t]) => { const h = sumVal(s[k]); return h ? '<div class="blk"><h3>' + t + '</h3>' + h + '</div>' : ''; }).join('');
  return (v ? '<p class="due">肉咖讀完的建議：' + v[0] + '</p>' : '') + (rs ? sumVal(rs) : '') + (rest ? fold('bidsum-' + it.id, '看領標文件的重點', rest) : '');
}
function bidIn(it) {
  const id = esc(it.id), st = it.bidState, lines = [];
  if (st === 'none') lines.push('還沒有人領標。領標不代表要做，只是拿到更詳細的文件。' + (can('pay') ? '' : '要領標請找有付款權限的同事（阿包或 CC）。'));
  if (it.bidRequestedBy && st !== 'none') lines.push(esc(it.bidRequestedBy) + (it.bidRequestedAt ? ' ' + fmtDay(it.bidRequestedAt).replace(/（.）/, '') : '') + ' 申請了領標' + (st === 'requested' ? '，等付領標費。' : '。'));
  if (st === 'paid' || st === 'fetched') lines.push(it.bidPaidBy ? '已付：' + esc(it.bidPaidBy) + (it.bidPaidAt ? ' ' + fmtDay(it.bidPaidAt).replace(/（.）/, '') : '') + (it.bidPaidAmount != null ? ' ' + NTD(it.bidPaidAmount) : '') + (it.bidHasReceipt ? '（有憑據序號）' : '') + (it.bidPaidNote ? '，' + esc(it.bidPaidNote) : '') : '免費領標');
  if (st === 'paid') lines.push(bidFetching(it) ? '<span class="spin" aria-hidden="true"></span>肉咖抓檔中，' + esc(relTime(it.bidFetchStartedAt, tnow())) + '開始' : it.bidFetchFailedAt ? '上次抓檔沒成功（' + fmtDate(it.bidFetchFailedAt) + '），肉咖會再試' : '領標費付了，等肉咖抓文件，抓完會寫重點。');
  if (st === 'fetched') lines.push('已領標：' + esc(it.bidFetchedBy || '肉咖') + (it.bidFetchedAt ? ' ' + fmtDay(it.bidFetchedAt).replace(/（.）/, '') : '') + ' 抓到文件' + (it.bidFetchNote ? '（' + esc(it.bidFetchNote) + '）' : ''));
  const btn = can('pay') && (st === 'none' || st === 'requested') ? '<div class="sbt"><button class="bp" type="button" data-act="bid-open" data-id="' + id + '">' + (st === 'none' ? '我要領標' : '去領標付款') + '</button></div>'
    : st === 'requested' && can('act') && !can('pay') ? '<p class="lg">你的金鑰不能付領標費，找阿包或 CC。</p>' : '';
  return lines.map(x => '<p>' + x + '</p>').join('') + bidSummaryHTML(it) + btn;
}
const bidBox = it => '<div class="blk"><h3>領標</h3><div class="box">' + bidIn(it) + '</div></div>';
function bidFoldOrBox(it) { if (!bidOk(it)) return ''; return bidHot(it) ? '' : fold('bid-' + it.id, '領標', '<div class="box">' + bidIn(it) + '</div>', esc(bidLine(it) || '還沒有人領')); }
const BID_STEPS = ['在這頁按「前往採購網領標」，會開採購網登入頁。', '選「廠商」登入：帳號、密碼、驗證碼都自己輸入。好咖的帳號是「好咖文創股份有限公司」。',
  '登入後會直接進這一案的「電子領標」。沒有的話，回卡片開原始連結，在公告頁最下面按「電子領標」。', '第 1 步「領標說明」：按「下一步」，跳出提醒就按「確認」。',
  '第 2 步「領標付費」：先看總計多少錢。', '還沒有人付過：選「是，進行付費流程」，按「下一步」。', '已經有人付過：選「否，已付費」，輸入憑據序號就好，不要再付一次。',
  '總計 0 元：免費領標，不用付錢，直接下一步。', '選付款方式：點數卡（信用卡或 ATM）、隨身碼（月帳單）或 HiNet 寬頻帳號（電信帳單），照畫面付款。',
  '第 3 步「取得領標憑據」：記下憑據序號（一長串數字），能截圖就截圖。', '第 5 步「招標文件下載」：手機能按「全部下載」就下載；下載不了也沒關係，貼了序號肉咖會幫忙抓。',
  '回這頁按「我付好了」，把憑據序號貼上。'];
const BID_NOTES = ['一張憑據只能給一家公司投標用。', '登入放太久會被登出。付款前如果發現被登出了，先重新登入。', '採購網是電腦版網頁，手機上字會很小，可以放大或把手機轉橫。', '憑據也會寄到採購網帳號登記的信箱。'];
const factOf = (it, re) => { const f = it.facts.find(x => re.test(x)); return f ? f.replace(/^[^：]{1,10}：/, '') : ''; };
function bidView(it) {   // 領標付款頁（同一個抽屜換內容，有返回）
  const id = esc(it.id), st = it.bidState, pl = bidPayLink(it), f = S.bidForm;
  const fee = factOf(it, /^(領標費|文件費|領標)/);
  const done = st === 'paid' || st === 'fetched';
  const body = '<p class="amt">' + esc(fee || '金額看採購網') + '<small>領標費' + (fee ? '' : '（公告沒寫，進採購網第 2 步看總計）') + '</small></p>' +
    kv([['案名', esc(it.title)], ['機關', esc(it.org || '沒寫')], ['截止', it.deadline ? esc(it.deadlineText || fmtDate(it.deadline)) : '沒寫'], ['電子領標', esc(factOf(it, /^(電子領標|現場領標)/) || '公告沒寫')]]) +
    (pl ? '<div class="sbt"><a class="bp" href="' + esc(pl.url) + '" target="_blank" rel="noopener noreferrer" data-act="bid-ext" data-id="' + id + '">' + (pl.fallback ? '開公告頁（還沒有領標入口）' : '前往採購網領標') + '</a></div>' : '<p class="lg">這張卡沒有採購網連結，請到原始公告領標。</p>') +
    '<div class="fos">' + fold('bidhow', '怎麼用手機領標', '<ol class="bp-steps">' + BID_STEPS.map(x => '<li>' + esc(x) + '</li>').join('') + '</ol>', BID_STEPS.length + ' 步') + fold('bidnote', '要注意', '<ul class="lgl">' + BID_NOTES.map(x => '<li><span>' + esc(x) + '</span></li>').join('') + '</ul>') + '</div>' +
    (done ? '<p class="noteb">已經有人付過了：' + esc(it.bidPaidBy || '') + (it.bidPaidAmount != null ? ' ' + NTD(it.bidPaidAmount) : '') + '。不要再付一次。</p>'
      : '<div class="blk"><h3>付完填這裡（都是選填）</h3>' +
        '<label class="fld"><span>付了多少（元）</span><input id="bid-amt" type="text" inputmode="numeric" autocomplete="off" maxlength="9" value="' + esc(f.amount) + '" placeholder="例如 200"></label>' +
        '<label class="fld"><span>憑據序號（填了 Mac 可以免費重新下載）</span><input id="bid-rc" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="64" value="' + esc(f.receipt) + '"></label>' +
        '<label class="fld"><span>備註</span><input id="bid-note" type="text" maxlength="200" value="' + esc(f.note) + '" placeholder="例如：用公司卡"></label></div>') +
    '<p class="last">付款由你自己在手機上做，肉咖不碰錢。這裡只是記錄。</p>';
  const foot = done ? '<span class="gr"></span><button class="bq" type="button" data-act="bid-close">返回</button>'
    : '<span class="gr"></span><button class="bm" type="button" data-act="bid-paid" data-id="' + id + '"' + (f.busy ? ' disabled' : '') + '>' + (f.busy ? '送出中…' : '我付好了，送出紀錄') + '</button>';
  return { t: '領標付款・' + nm(it), back: 'bid-close', b: body, f: foot };
}
function bidErr(e) {
  const m = String(e && e.message || '');
  const T = [[/^already_paid/, '這張已經有人付過了（畫面會重抓，看是誰付的）'], [/^already_fetched/, '這張已經抓過文件了'], [/^not_tender/, '只有政府標案可以領標'],
    [/^bad_card_status/, '這張卡已經刪掉或過期，不能領標'], [/^bad_amount/, '金額要在 0～10,000,000 之間'], [/^note_too_long/, '備註最多 200 字'], [/^receipt_too_long/, '憑據序號最多 64 字'],
    [/cannot pay/, '你的金鑰沒有領標付款的權限'], [/not found/i, '這張卡不見了，重新整理一次']];
  const hit = T.find(([re]) => re.test(m)); return hit ? hit[1] : reason(e);
}
async function bidOpen(id) {
  const it = get(id); if (!it) return;
  S.bidPage = id; S.bidForm = { amount: '', receipt: '', note: '' }; renderDrawer();
  if (it.bidState === 'none') {
    try { const c = await api.requestBid(id); if (c) put(c); renderAll(); }
    catch (e) { if (e instanceof AdapterError && e.kind === 'perm') loadWho(); if (/^already_(paid|fetched)/.test(e.message || '')) refreshCard(id); toast(bidErr(e), { bad: true }); }
  }
}
async function bidPaid(id) {
  const f = S.bidForm; if (!f || f.busy) return;
  const amt = String(f.amount || '').replace(/[,\s，NT$]/gi, '');
  if (amt && !/^\d+(\.\d{1,2})?$/.test(amt)) { toast('金額只能填數字', { bad: true }); return; }
  const amount = amt ? Number(amt) : null, receipt = String(f.receipt || '').trim(), note = String(f.note || '').trim();
  f.busy = true; renderDrawer();
  try {
    const c = await api.markPaid(id, amount, note, receipt);
    f.receipt = '';
    if (c) put(c);
    S.bidPage = null; S.bidForm = { amount: '', receipt: '', note: '' };
    toast('收到：' + (myName() || '你') + ' 付了領標費' + (amount != null ? ' ' + NTD(amount) : '') + '，肉咖去抓文件了');
    clap(); renderAll(); ensureEvents(id, true);
  } catch (e) {
    f.busy = false; f.receipt = '';
    if (e instanceof AdapterError && e.kind === 'perm') loadWho();
    if (e instanceof AdapterError && e.kind === 'auth') setAuth();
    if (/^already_(paid|fetched)/.test(e.message || '')) { S.bidPage = null; refreshCard(id); }
    toast(bidErr(e), { bad: true }); renderAll();
  }
}
async function refreshCard(id) { try { const c = await api.get(id); if (c) put(c); renderAll(); } catch (e) {} }

// ----- 快速預覽、完整內容 -----
function previewView(it) {
  const rem = it.status === 'snoozed' ? it.snoozeUntil : null, id = esc(it.id);
  const b = agLine(it) + amtBig(it) + dlAttr(it) + (bidOk(it) && bidHot(it) ? bidBox(it) : '') +
    blk('為什麼適合', it.why ? '<p class="sbp">' + softBreak(it.why) + '</p>' : '') +
    blk('先知道這幾件', it.quick.length ? '<ul>' + it.quick.map(x => '<li class="sbp">' + softBreak(x) + '</li>').join('') + '</ul>' : '') +
    (it.warn.length ? '<p class="noteb sbp">要注意：' + softBreak(it.warn[0]) + '</p>' : '') +
    blk('第一步', it.firstStep ? '<p class="sbp">' + softBreak(it.firstStep) + '</p>' : '') +
    (rem ? '<p class="lg">' + (rem > tnow() ? TBD.previewRemind(rem) : TBD.remindPassed) + '</p>' : '') +
    '<div class="fos">' + bidFoldOrBox(it) + (structRows(it).length ? fold('pdata-' + it.id, '案件資料', kv(structRows(it)) + metaLine(it)) : '') + '</div>';
  const f = (can('act') ? '<button class="bq" type="button" data-act="del" data-id="' + id + '">刪掉</button>' + (it.status === 'snoozed' ? '' : '<button class="bq" type="button" data-act="hold" data-id="' + id + '">暫存</button>') : '') +
    '<span class="gr"></span><button class="bm" type="button" data-act="dive" data-id="' + id + '">深入了解</button>';
  return { t: nm(it), b, f };
}
function crawlHTML(it) {
  const id = esc(it.id);
  if (it.detailText) {
    const open = S.textOpen.has(it.id), ao = S.attOpen.has(it.id), n = it.attachments.length;
    const att = n ? '<div class="att"><button class="bl att-toggle" data-act="toggle-att" data-id="' + id + '" type="button" aria-expanded="' + ao + '" aria-controls="att-' + id + '">附件 ' + n + ' 個 <span aria-hidden="true">' + (ao ? '▾' : '▸') + '</span></button>' +
      '<ul id="att-' + id + '"' + (ao ? '' : ' hidden') + '>' + it.attachments.map(a => '<li><a href="' + esc(a.url) + '" target="_blank" rel="noopener noreferrer">' + esc(a.name || a.url) + '</a></li>').join('') + '</ul></div>' : '';
    return '<div class="blk dt-text"><h3>公告全文</h3><div class="txt' + (open ? ' open' : '') + '">' + para(it.detailText) + '</div>' +
      '<button class="bl" data-act="toggle-text" data-id="' + id + '" type="button">' + (open ? '收合全文' : '展開全文') + '</button>' + att + '</div>';
  }
  const d = S.detail.get(it.id), st = it.crawlStatus;
  if (!can('act') && !(d && d.busy) && st !== 'crawling')
    return '<div class="blk"><h3>公告全文</h3><p>還沒有讀全文。你的金鑰只能看，不能讀全文。</p>' + (it.sourceUrl ? '<div class="sbt"><a class="bq" href="' + esc(it.sourceUrl) + '" target="_blank" rel="noopener noreferrer">開原始連結</a></div>' : '') + '</div>';
  if (d && d.timedOut && !d.busy)
    return '<div class="blk"><h3>讀全文逾時</h3><p>已經等超過 60 秒，還沒讀完。上面的條件還可以看。</p><div class="sbt"><button class="bp" data-act="retry-detail" data-id="' + id + '" type="button">再讀一次</button>' +
      (it.sourceUrl ? '<a class="bq" href="' + esc(it.sourceUrl) + '" target="_blank" rel="noopener noreferrer">開原始連結</a>' : '') + '</div></div>';
  if (st === 'failed' && !(d && d.busy) && !it.sourceUrl)
    return '<div class="blk"><h3>沒有全文</h3><p>' + esc(it.crawlError || '這張卡沒有來源網址') + '。這張卡沒有來源網址可以讀，上面的條件是先整理好的。</p></div>';
  if (st === 'failed' && !(d && d.busy))
    return '<div class="blk"><h3>抓取失敗，開原始連結</h3><p>' + esc(it.crawlError || '沒有抓到全文') + (it.sourceUrl ? '。' + TBD.crawlFailHint : '。') + '</p><div class="sbt">' +
      (it.sourceUrl ? '<a class="bp" href="' + esc(it.sourceUrl) + '" target="_blank" rel="noopener noreferrer">開原始連結</a>' : '') + '<button class="bq" data-act="retry-detail" data-id="' + id + '" type="button">再讀一次</button></div></div>';
  if (st === 'none' && !(d && d.busy)) return '';
  const t0 = d && d.t0 || tnow(), sec = Math.floor((tnow() - t0) / 1000);
  return '<div class="blk" aria-live="polite"><h3><span class="spin" aria-hidden="true"></span> 正在讀全文</h3><p class="lg">已等 <span data-elapsed="' + id + '">' + sec + '</span> 秒，<span data-elapsed-hint="' + id + '">' + crawlHint(sec) + '</span></p></div>';
}
function crawlHint(sec) { return sec > 10 ? '比平常久，再等一下；超過 60 秒會停止。讀完會自動出現在這裡。' : '通常 2 到 10 秒。讀完會自動出現在這裡，你也可以先看上面的條件。'; }
const purgeBtn = it => can('admin') ? '<button class="bl purge" data-act="purge-start" data-id="' + esc(it.id) + '" type="button">徹底刪除這張卡…</button>' : '';
function fullView(it) {
  const id = esc(it.id), okb = canBuild(it), inbox = it.status === 'new' || it.status === 'snoozed';
  const data = kv([['案名', '<span class="sbp">' + softBreak(it.title) + '</span>'], ['機關', esc(it.org || '沒寫')], ['金額', esc(amtText(it))]].concat(structRows(it), factsRows(it))) +
    crawlHTML(it) + '<div class="blk"><h3>來源</h3>' + metaLine(it) + link(it) + '</div>' + (inbox && can('admin') ? '<p class="adm">' + purgeBtn(it) + '</p>' : '');
  const b = agLine(it) + amtBig(it) + dlAttr(it) +
    blk('為什麼適合' + (it.fit ? '・契合度 ' + esc(it.fit) : ''), (it.why ? '<p class="sbp">' + softBreak(it.why) + '</p>' : '<p class="lg">沒寫</p>') + it.warn.map(w => '<p class="noteb sbp">要注意：' + softBreak(w) + '</p>').join('')) +
    blk('第一步', it.firstStep ? '<p class="sbp">' + softBreak(it.firstStep) + '</p>' : '') +
    (inbox && can('act') && !okb ? '<p class="noteb">' + TENDER_ADMIN + '</p>' : '') +
    (bidHot(it) ? bidBox(it) : '') +
    '<div class="fos">' + bidFoldOrBox(it) + fold('data-' + it.id, '案件資料與公告全文', data, it.detailText ? '全文已讀' : '') + '</div>';
  const n = (threadOf(it.id) || []).filter(m => !sysMsg(m)).length;
  const f = inbox && can('act')
    ? '<button class="bq" type="button" data-act="no" data-id="' + id + '">不做</button><span class="gr"></span>' + chatBtn(it.id, n) + (okb ? '<button class="bm wf" type="button" data-act="yes" data-id="' + id + '">要做，建立公司工作區</button>' : '')
    : '<span class="gr"></span>' + chatBtn(it.id, n) + '<button class="bp" type="button" data-act="close-drawer">回到面板</button>';
  return { t: nm(it), b, f };
}
const chatBtn = (key, n) => { const u = unreadReplies().filter(m => (m.itemId || '') === key).length, d = (S.draft.get(key) || '').trim();
  return '<button class="bq" type="button" data-act="dock-toggle" data-key="' + esc(key) + '" aria-label="跟肉咖說，' + n + ' 則' + (u ? '，有 ' + u + ' 則新回覆' : '') + (d ? '，有沒送出的草稿' : '') + '">跟肉咖說（' + n + '）' + (u ? '<i class="rk-dot" aria-hidden="true"></i>' : '') + (d ? '・有草稿' : '') + '</button>'; };

// ----- 進度抽屜：一打開只看到「現在這一步」，其餘收成列 -----
const stepOpen = new Set();
const ST_TXT = { done: '完成', skipped: '略過', current: '進行中', blocked: '卡住', pending: '還沒開始' };
const signOf = s => s.sign || ((String(s.note || '').match(/需簽章[：:]\s*([^。\n]+)/) || [])[1] || '').trim();
const isSealStep = s => /seal|sign/i.test(s.key) || /用印|簽章|簽名/.test(s.name);
const ring = s => s.status === 'done' || s.status === 'skipped' ? 'done' : s.status === 'blocked' ? 'blk' : s.status === 'current' ? 'cur' : '';
function stepMeta(s, it) {
  const late = s.dueAt && s.dueAt < tnow() && s.status !== 'done' && s.status !== 'skipped', parts = [];
  if (it && stepOpenNow(s) && ownerIsMe(s)) parts.push('輪到你');
  if (s.status === 'current') parts.push('進行中'); if (s.status === 'blocked') parts.push('卡住');
  if (s.owner) parts.push(s.owner);
  if (s.status === 'done') parts.push(s.doneAt ? (tnow() - s.doneAt < 24 * H ? relTime(s.doneAt, tnow()) : fmtDay(s.doneAt).replace(/（.）/, '') + ' 完成') : '完成');
  else if (s.status === 'skipped') parts.push('略過');
  else if (s.dueAt) parts.push((late ? '已逾期 ' : '') + fmtDay(s.dueAt) + ' 前');
  return parts.map(esc).join('・');
}
function stepRow(s, i, all, it) {
  const k = it.id + '|' + s.key, open = stepOpen.has(k), cur = stepOpenNow(s);
  return '<li class="' + (cur ? 'cur' : '') + '"><button class="sr" type="button" data-act="step-tog" data-id="' + esc(it.id) + '" data-k="' + esc(s.key) + '" aria-expanded="' + open + '"><i class="ring ' + ring(s) + '" aria-hidden="true"></i><span class="tx"><b>' + esc(s.name) + '</b><span>' + stepMeta(s, it) + '</span></span>' + (s.owner ? av(s.owner, s.ownerRaw) : '') + '<span class="cv" aria-hidden="true">' + (open ? UP : '▾') + '</span></button>' + (open ? stepDetail(s, it) : '') + '</li>';
}
function stepDetail(s, it, lite) {
  const rows = [['狀態', ST_TXT[s.status] || esc(s.status)], ['負責', s.owner ? esc(s.owner) : '還沒指定']];
  const sg = signOf(s); if (sg || isSealStep(s)) rows.push(['需簽章', sg ? esc(sg) : '待 CC 確認']);
  if (!lite && s.dueAt) rows.push(['期限', fmtDate(s.dueAt) + (s.dueAt < tnow() && s.status !== 'done' && s.status !== 'skipped' ? '（已逾期）' : '')]);
  if (s.doneAt) rows.push(['完成', fmtDate(s.doneAt)]);
  const urls = (String(s.note || '').match(new RegExp(URL_RE.source, 'g')) || []).map(x => safeUrl(x.replace(/[.,;:!?)\]]+$/, ''))).filter(Boolean).filter(u => !linksOf(it).some(l => l.url === u));
  const txt = noteText(String(s.note || '').replace(new RegExp(URL_RE.source, 'g'), ''));
  return '<div class="sd">' + (!lite && txt ? '<p class="sbp">' + softBreak(txt) + '</p>' : '') + kv(rows) + (!lite && urls.length ? '<div class="sbt">' + urls.map(x => linkBtn(s.key, x, 'bq')).join('') + '</div>' : '') +
    stepFiles(s, it) + (lite ? '' : stepBtns(s, it)) + stepHist(s, it) + '</div>';
}
const stepLinks = (it, key) => linksOf(it).filter(l => l.stepKey && l.stepKey === key);
const dlUrl = u => { const m = String(u).match(/^https:\/\/drive\.google\.com\/file\/d\/([\w-]+)/); return m ? 'https://drive.google.com/uc?export=download&id=' + m[1] : u; };
function stepFiles(s, it) {
  const ls = stepLinks(it, s.key); if (!ls.length) return '<p class="lg">這一步還沒有文件。</p>';
  const id = esc(it.id), k = esc(s.key);
  return ls.map(l => { const lb = esc(linkText(l)), u = esc(l.url);
    return '<div class="fl"><b>' + lb + '</b><a class="bl" href="' + u + '" target="_blank" rel="noopener noreferrer" data-act="file-open" data-id="' + id + '" data-k="' + k + '" data-label="' + lb + '">開啟</a>' +
      '<a class="bl" href="' + esc(dlUrl(l.url)) + '" target="_blank" rel="noopener noreferrer" download data-act="file-dl" data-id="' + id + '" data-k="' + k + '" data-label="' + lb + '">下載</a>' +
      '<button class="bl" type="button" data-act="file-share" data-id="' + id + '" data-k="' + k + '" data-label="' + lb + '" data-url="' + u + '">分享</button></div>'; }).join('');
}
function stepBtns(s, it) {
  if (!canMarkStep(s, it)) return stepOpenNow(s) && can('act') && s.owner ? '<p class="lg">這步是 ' + esc(s.owner) + ' 的。要催可以跟肉咖說。</p>' : '';
  const id = esc(it.id), k = esc(s.key), b = (st, t, cls) => '<button class="' + (cls || 'bq') + '" type="button" data-act="step-mark" data-id="' + id + '" data-k="' + k + '" data-st="' + st + '">' + t + '</button>';
  const done = s.status === 'done' || s.status === 'skipped';
  return '<div class="sbt">' + (done ? b('undone', '退回未完成') : b('done', '完成這一步', 'bm') + (s.status === 'blocked' ? b('current', '解除卡住') : s.status === 'current' ? '' : b('current', '標成進行中'))) + '</div>';
}
function stepHist(s, it) {
  const ev = it && S.events.get(it.id), lines = [];
  (ev && ev.list || []).filter(e => /^step:/.test(e.action) && e.detail && (e.detail.step_key || e.detail.step) === s.key).forEach(e => {
    const to = e.action.slice(5), f = ST_TXT[e.detail.from] || '', t = to === 'undone' ? '退回未完成' : ST_TXT[to] || ST_TXT[e.detail.to] || '';
    lines.push('<li><span>' + (e.at ? fmtDate(e.at) + ' ' : '') + '<b>' + esc(e.actor || '不明') + '</b> ' + (t ? (f ? esc(f) + ' → ' : '改成 ') + esc(t) : esc(e.action)) + (e.detail.note ? '（' + esc(String(e.detail.note)) + '）' : '') + '</span></li>');
  });
  const TRK = { 'track:open_file': '開啟了', 'track:download_file': '下載了', 'track:share_file': '分享了' };
  (ev && ev.list || []).filter(e => TRK[e.action] && e.detail && e.detail.step_key === s.key).slice(0, 3).forEach(e => {
    lines.push('<li><span>' + (e.at ? fmtDate(e.at) + ' ' : '') + '<b>' + esc(e.actor || '不明') + '</b> ' + TRK[e.action] + ' ' + esc(String(e.detail.label || '文件')) + '</span></li>');
  });
  if (!lines.length && s.status === 'current' && it && it.progressUpdatedAt) lines.push('<li><span>' + fmtDate(it.progressUpdatedAt) + ' <b>' + esc(it.progressUpdatedBy || '不明') + '</b> 更新進度</span></li>');
  return '<p class="lg">紀錄</p>' + (lines.length ? '<ul class="lgl">' + lines.join('') + '</ul>' : '<p class="lg">' + (!ev ? '讀取紀錄中…' : ev.err ? '紀錄讀不到，等一下會自動再試。' : '這一步還沒有變更紀錄。') + '</p>');
}
async function ensureEvents(id, force) {
  if (!api || !api.events || S.net === 'auth' || S.evBusy.has(id)) return;
  if (!force && S.events.has(id)) return;
  S.evBusy.add(id);
  try { S.events.set(id, { list: await api.events(id, 100), at: tnow() }); }
  catch (e) { if (!S.events.has(id) || S.events.get(id).err) S.events.set(id, { list: [], at: tnow(), err: true }); }
  finally { S.evBusy.delete(id); }
  redrawDrawer(id);
}
function folderRow(it) {
  const fs = it.folderStatus;
  if (fs === 'failed') return '<p class="warnb">資料夾沒建成：' + esc(it.folderError || '原因不明') + '。' + TBD.folderFailHelp + '</p>';
  if (folderWait(it)) return '<p class="noteb"><span class="spin"></span> ' + folderWaitText(it) + '，通常 1 到 2 分鐘內建好。你可以先回到面板，不用等。</p>';
  const p = it.folderPath, real = /^\//.test(p);
  if (!real) return p || it.folderName ? '<p class="lg">這張是示意卡，不會真的建資料夾：' + esc(it.folderName || p) + '</p>' : '';
  return '<p class="lg">工作資料夾' + (it.isDemo ? '（示意路徑）' : '') + '</p><p class="path">' + esc(p) + '</p>';
}
function filesRow(it) {   // Pool、內審、去領標等正式連結（掛在步驟上的不算）
  const keys = new Set((it.progressSteps || []).map(s => s.key));
  const ls = linksOf(it).filter(l => !(l.stepKey && keys.has(l.stepKey))); if (!ls.length) return '<p class="lg">這案還沒有 Pool、內審連結。</p>';
  return '<div class="sbt">' + ls.map(l => extLink(l, l.kind === 'pay' && !bidDone(it) ? 'bm' : 'bq')).join('') + '</div>';
}
function stband(it) {
  const p = pv(it), s = curStep(it);
  if (p.k === 'done') return '<div class="stband okb">✓ ' + (OUTCOME[it.progressOutcome] ? '已結案：' + OUTCOME[it.progressOutcome] : '已完成') + (it.progressArchiveAt ? '・' + (it.progressArchiveAt > tnow() ? fmtDay(it.progressArchiveAt) + '從看板撤下' : '已從看板撤下') : '') + '</div>';
  if (p.k === 'blocked') return '<div class="stband">▲ 卡住：' + esc(it.progressBlocker || '原因沒寫') + '</div>';
  if (p.k === 'failed') return '<div class="stband">▲ ' + (it.folderStatus === 'failed' ? '資料夾沒建成：' + esc(it.folderError || '原因不明') : '流程失敗：' + esc(it.progressBlocker || it.progressNote || '原因不明')) + '。' + TBD.progressFailHelp + '</div>';
  if (p.k === 'overdue') return '<div class="stband">▲ 這步逾期：' + esc(it.progressBlocker || '這步已過內部期限') + '</div>';
  if (p.k === 'dlpass') return '<div class="stband">▲ 公告截止時間已到（' + esc(it.deadlineText || fmtDate(it.deadline)) + '），面板不會自動收走，請確認是否已送出。</div>';
  if (s && ownerIsMe(s)) return '<div class="stband">輪到你：' + esc(s.name) + '</div>';
  return '<div class="stband okb">照進度走' + (s && s.owner ? '・輪到 ' + esc(s.owner) : '') + '</div>';
}
function keyLine(it) {   // 關鍵時間一行
  const sent = submitted(it);
  if (sent) { const d = it.progressDueAt, m = d ? d - tnow() : 0; return '<p class="attr"><span>' + (d && m < URGENT_DAYS * D ? '▲ ' : '') + esc(milestone(it)) + ' ' + (d ? fmtDate(d) + '・' + (m <= 0 ? '已逾期' : '剩 ' + fmtLeft(m)) : '日期未定') + '</span><span>' + esc(sentTag(it)) + '</span></p>'; }
  if (!it.deadline) return '<p class="attr"><span>沒寫截止日</span></p>';
  return '<p class="attr"><span>' + (lvOf(it) === 'hot' ? '▲ ' : '') + '截止 ' + esc(it.deadlineText || fmtDate(it.deadline)) + '・' + (it.deadline > tnow() ? '剩 <span data-cd="' + esc(it.id) + '">' + cdFull(it) + '</span>' : '時間到') + (approx(it) ? APPROX_NOTE : '') + '</span></p>';
}
function progressView(it) {
  const id = esc(it.id), st = it.progressSteps, s = curStep(it), ci = curIdx(it), tot = stepTotal(it), closed = it.progressStatus === 'done';
  const busy = S.prog.get(it.id) && S.prog.get(it.id).busy;
  const payNow = s && s.key === PAY_STEP && !bidDone(it);
  const sName = (s && s.name) || it.progressStage || '建立工作區';
  const note = s ? noteText(s.note) : '', nUrl = s ? noteUrl(s.note) : '';
  const act = closed ? '' : payNow ? (nUrl && can('pay') ? '<div class="sbt">' + linkBtn(PAY_STEP, nUrl, 'bm') + '</div>' : '') + '<p class="lg">領標費付完，這一步會自動完成。' + (can('pay') ? '' : can('act') ? '你的金鑰不能付領標費，找阿包或 CC。' : '') + '</p>'
    : s ? stepBtns(s, it) : !st ? '<p class="lg">' + (busy ? '讀取步驟中…' : '步驟清單還沒抓到。') + '</p>' : '';
  const box = '<div class="blk"><h3>現在這一步</h3><div class="box"><div class="n1"><b>' + esc(sName) + '</b><span>' + (tot ? '第 ' + (ci + 1) + '／' + tot + ' 步' : pct(it) + '%') + '</span></div>' + segs(it) +
    (s && s.dueAt ? '<p class="due">期限 ' + fmtDate(s.dueAt) + (s.dueAt < tnow() ? '（已逾期）' : '') + '</p>' : '') +
    (note ? '<p class="noteb sbp">' + softBreak(note) + '</p>' : '') + (it.progressNote && it.progressNote !== note ? '<p class="noteb sbp">' + softBreak(it.progressNote) + '</p>' : '') + act +
    (s ? fold('cur-' + it.id, '這一步的文件與紀錄', stepDetail(s, it, true), stepLinks(it, s.key).length ? stepLinks(it, s.key).length + ' 份文件' : '') : '') + '</div></div>';
  const fuL = S.fu.byItem.get(it.id) || [], fuOpen = fuL.filter(f => f.status === 'open');
  const steps = st && st.length ? '<ul class="steps">' + st.map((x, i, a) => stepRow(x, i, a, it)).join('') + '</ul>' : '<p class="lg">' + (st ? '還沒有步驟清單。' : '讀取步驟中…') + '</p>';
  const canCopy = it.folderStatus === 'done' && /^\//.test(it.folderPath);
  const data = kv([['案名', '<span class="sbp">' + softBreak(it.title) + '</span>'], ['機關', esc(it.org || '沒寫')], ['類別', esc(LN[homeLane(it)]) + (submitted(it) ? '・' + esc(sentTag(it)) : '')], ['金額', esc(amtText(it))]]
      .concat(it.deadline ? [['公告截止', esc(it.deadlineText || fmtDate(it.deadline))]] : [], structRows(it), it.decidedBy ? [['誰決定', esc(it.decidedBy) + (it.decidedAt ? ' ' + fmtDay(it.decidedAt).replace(/（.）/, '') : '') + ' 按了要做']] : [],
        it.progressUpdatedAt ? [['最後更新', fmtDate(it.progressUpdatedAt) + '，由 ' + esc(it.progressUpdatedBy || '不明') + ' 更新']] : [])) +
    (bidOk(it) && !bidHot(it) ? bidBox(it) : '') + filesRow(it) + folderRow(it) + (canCopy ? '<div class="sbt"><button class="bq" type="button" data-act="copy-path" data-id="' + id + '">複製路徑</button></div>' : '') +
    (it.why ? blk('為什麼適合', '<p class="sbp">' + softBreak(it.why) + '</p>') : '') + it.warn.map(w => '<p class="noteb sbp">要注意：' + softBreak(w) + '</p>').join('') +
    crawlHTML(it) + (factsRows(it).length ? blk('完整條件', kv(factsRows(it))) : '') + '<div class="blk"><h3>來源</h3>' + metaLine(it) + link(it) + '</div>';
  const manage = (can('act') ? '<button class="bq" type="button" data-act="arch-start" data-id="' + id + '">' + (closed ? '改結案結果…' : '結案…') + '</button>' : '') + (can('admin') ? '<button class="bl purge" type="button" data-act="purge-start" data-id="' + id + '">徹底刪除…</button>' : '');
  const b = stband(it) + keyLine(it) + (bidHot(it) ? bidBox(it) : '') + box +
    '<div class="fos">' + fold('steps-' + it.id, '全部步驟', steps, pct(it) + '%') +
    fold('todo-' + it.id, '這案的追蹤事項', fuL.length ? '<div class="fu-list">' + fuOpen.concat(fuL.filter(f => f.status !== 'open')).map(f => fuRow(f, true)).join('') + '</div>' : '<p class="lg">沒有。在 LINE 交代肉咖記的事會出現在這裡。</p>', fuOpen.length ? fuOpen.length + ' 件' : '沒有') +
    fold('data-' + it.id, '案件資料、Pool 與內審', data) +
    (manage ? fold('adm-' + it.id, '管理這一案', '<div class="sbt">' + manage + '</div>') : '') + '</div>';
  const n = (threadOf(it.id) || []).filter(m => !sysMsg(m)).length;
  return { t: nm(it), b, f: '<span class="gr"></span>' + chatBtn(it.id, n) };
}

// ----- 封存的案子（唯讀） -----
function archivedView(it) {
  const real = it.folderStatus === 'done' && /^\//.test(it.folderPath), st = it.progressSteps, id = esc(it.id);
  const b = '<div class="stband okb">✓ ' + (KIND[it.archiveKind] || '已結案') + (it.archivedAt ? '・' + fmtDate(it.archivedAt) + ' 結案' : '') + '</div>' + agLine(it) + '<p class="attr"><span>' + esc(amtText(it)) + '</span></p>' +
    (it.progressNote ? '<p class="noteb sbp">' + softBreak(it.progressNote) + '</p>' : '') + (it.progressUpdatedBy ? '<p class="lg">最後由 ' + esc(it.progressUpdatedBy) + ' 更新</p>' : '') +
    '<div class="fos">' + fold('asteps-' + it.id, '全部步驟', st && st.length ? '<ul class="steps">' + st.map((x, i, a) => stepRow(x, i, a, it)).join('') + '</ul>' : '<p class="lg">讀取步驟中…</p>') +
    fold('adata-' + it.id, '案件資料、Pool 與內審', kv(structRows(it).concat(factsRows(it))) + filesRow(it) + (real ? '<p class="lg">工作資料夾</p><p class="path">' + esc(it.folderPath) + '</p><div class="sbt"><button class="bq" type="button" data-act="copy-path" data-id="' + id + '">複製路徑</button></div>' : '') + '<div class="blk"><h3>來源</h3>' + metaLine(it) + link(it) + '</div>') +
    (can('admin') ? fold('aadm-' + it.id, '管理這一案', '<div class="sbt"><button class="bq" type="button" data-act="arch-reopen" data-id="' + id + '">放回進行中</button>' + purgeBtn(it) + '</div>') : '') + '</div>';
  const n = (threadOf(it.id) || []).filter(m => !sysMsg(m)).length;
  return { t: '封存・' + nm(it), b, f: '<button class="bq" type="button" data-act="arch-back">回到封存</button><span class="gr"></span>' + chatBtn(it.id, n) };
}

// ----- 外觀（每人自選，入口在首頁最下面一行） -----
const SKD = { 1: '深夜藍紫底，每個房間一個顏色', 2: '深色底，只有進行中是紅的', 3: '黑白高對比，跟著手機的淺色深色' };
function skinView() {
  const b = '<p class="lead">選一個自己看得順的。只改你自己的畫面，別人看到的不變。</p>' + Object.keys(SKINS).map(v => { const on = String(S.skin) === v;
      return '<button class="sko" type="button" data-act="skin-set" data-v="' + v + '" aria-pressed="' + on + '"' + (S.prefBusy ? ' disabled' : '') + '><i class="sw sw' + v + '" aria-hidden="true"></i><span class="tx"><b>' + SKINS[v] + '</b><span>' + SKD[v] + '</span></span><span class="ck" aria-hidden="true">' + (on ? '✓ 使用中' : '') + '</span></button>'; }).join('') +
    '<p class="last">' + (S.prefRemote === true ? '存在你這把金鑰的設定裡，換手機打開也一樣。' : S.prefRemote === false ? '目前只記在這支手機：資料庫還沒開「每人外觀」的欄位，等管理員開通後會跟著你的金鑰走。' : '讀取你的設定中…') + '</p>';
  return { t: '外觀', b, f: '' };
}

// ----- 跟肉咖說（卡片內：同一個抽屜換成對話，有返回；全域：頂列「肉咖」） -----
const MSG_NOTE = '肉咖會處理或轉給負責的視窗；花錢、刪檔、付款要 Borry 本人同意。';
const MSG_ST = { sending: '傳送中', new: '已送出', picked: '肉咖收到了', received: '肉咖收到了', seen: '肉咖收到了', handling: '肉咖收到了', in_progress: '肉咖收到了', done: '處理完', handled: '處理完' };
const MSG_MAX = 1000;
let tmpN = 0;
const SYS_KIND = { paid: '付款紀錄', step: '進度紀錄', bid: 'Pool 偵測' };
const sysMsg = m => !!m.kind && m.kind !== 'msg';
const canDelMsg = () => can('admin') && !!api && !!api.msgDelete && !S.msgDelOff;
function msgLi(m, all) {
  const del = canDelMsg() && !m.pending && m.id ? '<button class="msg-del" data-act="msg-del" data-mid="' + esc(m.id) + '" data-key="' + esc(m.itemId || '') + '" type="button" aria-label="刪掉這則' + (sysMsg(m) ? '紀錄' : '（連同回覆）') + '">🗑</button>' : '';
  const when = m.createdAt ? ' · <span data-rel="' + m.createdAt + '">' + relTime(m.createdAt, tnow()) + '</span>' : '';
  if (sysMsg(m)) return '<div class="msg sys"><small>' + esc(SYS_KIND[m.kind] || '系統紀錄') + when + del + '</small>' + para(m.body) + '</div>';
  const rk = m.author === RK, st = m.pending ? MSG_ST.sending : rk ? '' : (MSG_ST[m.status] || '');
  const orig = rk && m.replyTo ? all.find(x => x.id === m.replyTo) : null;
  return '<div class="msg ' + (rk ? '' : 'me') + (m.pending ? ' pending' : '') + '"><small>' + esc(m.author || '不明') + when + del + '</small>' +
    (orig ? '<span class="msg-q">回覆「' + esc(orig.body.length > 24 ? orig.body.slice(0, 24) + '…' : orig.body) + '」</span>' : '') + para(m.body) + (st ? '<span class="msg-st">' + st + '</span>' : '') + '</div>';
}
function threadOf(key) {
  const st = S.msgs.get(key);
  const list = st ? st.list.filter(m => (m.itemId || '') === key) : null;
  const pend = S.pend.get(key) || [];
  return list ? list.slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)).concat(pend) : null;
}
function threadHTML(key, emptyTxt) {
  const th = threadOf(key);
  return '<div class="msgs" aria-live="polite">' + (!th ? '<div class="msg sys">讀取對話中…</div>' : th.length ? th.map(m => msgLi(m, th)).join('')
    : '<div class="msg sys">' + (S.msgs.get(key) && S.msgs.get(key).err ? '對話讀不到，等一下會自動再試。' : emptyTxt) + '</div>') + '</div>';
}
function composer(key) {
  if (!can('act')) return '<p class="lg">你的金鑰只能看對話，不能發言。</p>';
  const d = S.draft.get(key) || '';
  return '<div class="cmp"><label class="vh" for="chat-input">要跟肉咖說的話</label><textarea id="chat-input" data-key="' + esc(key) + '" maxlength="' + MSG_MAX + '" rows="1" placeholder="' + (key ? '例：這案幫我盯截止時間' : '想請肉咖做什麼？') + '">' + esc(d) + '</textarea><button class="bm" type="button" data-act="msg-send" data-key="' + esc(key) + '">傳給肉咖</button></div>';
}
function cardChatView(it) {
  const k = it.id, n = (threadOf(k) || []).length;
  const b = '<div class="chhead">' + rkFace() + '<p>這裡講的只跟這一案有關。' + MSG_NOTE + '</p></div>' + threadHTML(k, '還沒有對話。想到什麼直接講，例如「這案幫我問窗口簡報幾點」。') +
    (canDelMsg() && n ? '<p class="adm"><button class="bl purge" type="button" data-act="msg-clear" data-key="' + esc(k) + '">清空這張卡的對話…</button></p>' : '');
  return { t: '跟肉咖說・' + nm(it), back: 'dock-toggle', backKey: k, b, f: composer(k) };
}
function chatView() {
  const unread = {}, last = new Map();
  unreadReplies().filter(m => m.itemId).forEach(m => { unread[m.itemId] = (unread[m.itemId] || 0) + 1; });
  msgsAll().filter(m => m.itemId).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).forEach(m => { if (!last.has(m.itemId)) last.set(m.itemId, m); });
  const recent = [...last.values()].slice(0, 8);
  const oth = recent.length ? fold('chatcards', '各案最近對話', recent.map(m => { const it = get(m.itemId), u = unread[m.itemId] || 0, body = m.body.length > 40 ? m.body.slice(0, 40) + '…' : m.body;
      return '<button class="arow cc-row" type="button" data-act="chat-card" data-id="' + esc(m.itemId) + '"><b>' + esc(it ? nm(it) : (m.itemShortTitle || '已不在看板的案子')) + (u ? '・' + u + ' 則新回覆' : '') + '</b><span>' + (sysMsg(m) ? '' : esc(m.author || '不明') + '：') + esc(body) + '・' + relTime(m.createdAt, tnow()) + '</span></button>'; }).join(''),
      Object.keys(unread).length ? Object.keys(unread).length + ' 案有新回覆' : recent.length + ' 案') : '';
  const b = '<div class="chhead">' + rkFace() + '<p>公司電腦上的守宮，負責找案、讀公告、建資料夾、提醒大家。這裡講的不綁案子。' + MSG_NOTE + '</p></div>' +
    presHTML() + (oth ? '<div class="fos" style="margin:0 0 14px">' + oth + '</div>' : '') + threadHTML('', '還沒有對話。有事直接跟肉咖說。');
  return { t: '跟肉咖說', b, f: composer('') };
}
async function loadPresence() {
  if (!can('admin') || !api || !api.presence || S.presOff) return;
  try { S.presence = await api.presence(); }
  catch (e) { if (/Could not find the function|PGRST202/i.test(e.message || '') || (e instanceof AdapterError && e.kind === 'perm')) S.presOff = true; else if (!S.presence) S.presence = 'err'; }
  if (S.drawer && S.drawer.view === 'chat') renderDrawer();
}
function presText(p) {
  if (p.status === 'today') return '✅ 今天 ' + (p.lastSeenAt ? hm(p.lastSeenAt) + ' ' : '') + '開過';
  if (p.status === 'recent') return '✅ ' + (p.statusText || '最近開過');
  if (p.status === 'stale') return '😴 ' + (p.lastSeenAt ? Math.floor((tnow() - p.lastSeenAt) / D) + ' 天沒開' : '很久沒開');
  return '⏳ 還沒打開';
}
function presHTML() {
  if (!can('admin') || S.presOff || !S.presence) return '';
  if (S.presence === 'err') return '<div class="fos" style="margin:0 0 14px">' + fold('pres', '誰接進來了', '<p class="lg">讀不到，等一下再打開一次。</p>') + '</div>';
  const list = S.presence.map(p => { const o = S.presOpen.has(p.name), n = esc(p.name);
    return '<div class="todo"><button class="tx" type="button" data-act="pres-tog" data-n="' + n + '" aria-expanded="' + o + '"><b>' + n + '</b>　' + esc(presText(p)) +
      (o ? '<small>第一次打開：' + (p.firstSeenAt ? fmtDate(p.firstSeenAt) : '還沒') + '・最後一次打開：' + (p.lastSeenAt ? fmtDate(p.lastSeenAt) : '還沒') + (p.seenCount ? '（共 ' + p.seenCount + ' 次）' : '') + '・最後一次動作：' + (p.lastActionAt ? fmtDate(p.lastActionAt) : '還沒有') + '</small>' : '') + '</button></div>'; }).join('');
  return '<div class="fos" style="margin:0 0 14px">' + fold('pres', '誰接進來了', list, S.presence.filter(p => p.status === 'today').length + '／' + S.presence.length + ' 今天開過') + '</div>';
}

// ----- 追蹤公告（報告一次開一段；追蹤事項點圈標完成） -----
const FU_FILTERS = [['open', '開著'], ['done', '已完成'], ['dropped', '已取消'], ['all', '全部']];
const FU_SRC = { line: 'LINE', panel: '面板', other: '其他' };
const fuCanEdit = () => can('progress') || can('admin');
const tpDay = ms => Math.floor((ms + 8 * H) / D);
const fuGet = id => [S.fu.open, S.fu.list, ...S.fu.byItem.values()].reduce((a, l) => a || (l || []).find(f => f.id === id), null);
const fuOverdue = f => f.status === 'open' && !!f.dueAt && f.dueAt < tnow();
const fuToday = f => f.status === 'open' && !!f.dueAt && !fuOverdue(f) && tpDay(f.dueAt) === tpDay(tnow());
function fuDue(f) {
  if (f.status === 'done') return '完成' + (f.doneAt ? ' ' + fmtDay(f.doneAt) : '');
  if (f.status === 'dropped') return '已取消' + (f.doneAt ? ' ' + fmtDay(f.doneAt) : '');
  if (!f.dueAt) return '沒有期限';
  if (fuOverdue(f)) return '▲ 逾期 ' + fmtDate(f.dueAt);
  if (fuToday(f)) return '今天截止 ' + fmtClock(f.dueAt);
  return '期限 ' + fmtDate(f.dueAt);
}
function fuRow(f, inCard) {
  const id = esc(f.id), meta = [esc(f.owner || '還沒指定'), esc(fuDue(f))];
  if (f.requestedBy) meta.push(esc(f.requestedBy) + ' 交代');
  meta.push('來源 ' + esc(FU_SRC[f.source] || f.source || '其他'));
  const card = !inCard && f.itemId ? '<button class="bl" data-act="fu-card" data-id="' + esc(f.itemId) + '" type="button">' + esc(f.itemShortTitle || '相關案子') + '</button>' : '';
  const ringBtn = fuCanEdit() ? '<button class="tk" type="button" data-act="' + (f.status === 'open' ? 'fu-done' : 'fu-reopen') + '" data-id="' + id + '" aria-label="' + (f.status === 'open' ? '標成完成' : '改回未完成') + '：' + esc(f.title) + '"><i class="ring ' + (f.status === 'done' ? 'done' : '') + '" aria-hidden="true"></i></button>'
    : '<i class="ring ' + (f.status === 'done' ? 'done' : '') + '" aria-hidden="true"></i>';
  return '<div class="todo fu ' + f.status + (fuOverdue(f) ? ' over' : '') + (S.fu.busyIds && S.fu.busyIds.has(f.id) ? ' busy' : '') + '">' + ringBtn + '<span class="tx"><span class="sbp">' + softBreak(f.title) + '</span><small>' + meta.join('・') + '</small>' +
    (f.note ? '<small>補充：' + esc(f.note) + '</small>' : '') + (f.status !== 'open' && f.closeNote ? '<small>' + (f.status === 'done' ? '依據' : '原因') + '：' + esc(f.closeNote) + '</small>' : '') + card +
    (fuCanEdit() && f.status === 'open' ? '<button class="bl" type="button" data-act="fu-drop" data-id="' + id + '">取消…</button>' : '') + '</span></div>';
}
function renderFuBtn() {
  const b = $('#fubtn'); if (!b) return;
  b.hidden = S.net === 'auth' || !api || (!api.followupList && !api.bulletin);
  const l = S.fu.open || [], fn = l.length, over = l.filter(fuOverdue).length, today = l.filter(fuToday).length;
  const urg = bulUrgent(), n = urg + fn;
  b.innerHTML = '追蹤公告' + (n ? '<b class="bdg">' + n + '</b>' : '');
  b.setAttribute('aria-label', '追蹤公告' + (urg ? '，' + urg + ' 案今明兩天截止' : '') + (fn ? '，' + fn + ' 件追蹤未完成' + (over ? '，' + over + ' 件逾期' : '') + (today ? '，' + today + ' 件今天到期' : '') : ''));
}
const BUL_SEC = { schedule: '行程', bid: '領標', followup: '追蹤事項', summary: '摘要' };
const bulDays = s => s.deadline ? tpDay(s.deadline) - tpDay(tnow()) : s.daysLeft;
const bulUrgent = () => { const d = S.bul.d; return d ? d.sections.filter(s => s.kind === 'case' && (s.title || s.lines.length) && (x => x === 0 || x === 1)(bulDays(s))).length : 0; };
async function loadBul(force) {
  if (!api || !api.bulletin || S.net === 'auth' || S.bul.busy) return;
  if (!force && Date.now() - S.bul.at < 30e3) return;
  S.bul.busy = true; S.bul.at = Date.now();
  let d = S.bul.d, err = false;
  try { d = await api.bulletin(); }
  catch (e) { if (e instanceof AdapterError && e.kind === 'auth') { S.bul.busy = false; setAuth(); renderAll(); return; } err = true; }
  S.bul.busy = false;
  const sig = JSON.stringify([d, err && !d]);
  if (sig === S.bul.sig) return;
  S.bul.sig = sig; S.bul.d = d; S.bul.err = err;
  renderFuBtn();
  if (S.drawer && S.drawer.view === 'followups') renderDrawer();
}
setInterval(() => { if (S.drawer && S.drawer.view === 'followups' && !document.hidden) loadBul(true); }, 60e3);
const bulLine = x => { const m = x.match(/^([^：:\s\d][^：:\s]{0,9})([：:])(?!\d)(.*)$/s); return '<li><span>' + (m ? '<b>' + esc(m[1]) + '</b>' + m[2] + esc(m[3]) : esc(x)) + '</span></li>'; };
const bulList = ls => ls.length ? '<ul class="lgl">' + ls.map(bulLine).join('') + '</ul>' : '';
function bulDue(s) {
  const n = bulDays(s), when = s.deadline ? fmtDay(s.deadline) + (s.dateOnly ? '' : hm(s.deadline)) : '';
  const lab = n == null ? '' : n < 0 ? '已過截止' : n === 0 ? '▲ 今天截止' : n === 1 ? '▲ 明天截止' : '剩 ' + n + ' 天';
  return lab || when ? (lab ? lab + (when ? '・' : '') : '') + when : (s.stamp || '');
}
// 報告分段：摘要、各案（合成一段「各案」每案一行可點）、行程、領標…；一次開一段，預設開第一段
function bulSections() {
  const d = S.bul.d; if (!d) return [];
  const secs = d.sections.length ? d.sections : d.body.trim() ? [{ kind: 'summary', text: d.body, lines: [] }] : [];
  const fuShown = api && api.followupList && !S.fu.err, out = [], cases = [];
  secs.forEach(s => {
    if (s.kind === 'case') { if (s.title || s.lines.length) cases.push(s); return; }
    if (s.kind === 'followup' && fuShown) return;
    const body = s.lines.length ? bulList(s.lines) : s.text.trim() ? '<p>' + para(s.text) + '</p>' : '';
    if (body) out.push({ h: s.kind === 'summary' ? '摘要' : BUL_SEC[s.kind] || s.title || '其他', body });
  });
  if (cases.length) out.splice(out.length && out[0].h === '摘要' ? 1 : 0, 0, { h: '各案 ' + cases.length + ' 件', body: cases.map(s => '<div class="todo"><span class="tx">' +
    (s.itemId ? '<button class="bl" style="padding:0" data-act="fu-card" data-id="' + esc(s.itemId) + '" type="button">' + softBreak(s.title || '（沒寫案名）') + '</button>' : '<b>' + softBreak(s.title || '（沒寫案名）') + '</b>') +
    '<small>' + esc(bulDue(s)) + '</small>' + bulList(s.lines) + '</span></div>').join('') });
  return out;
}
function fuView() {
  const d = S.bul.d, secs = bulSections(), g = d && d.generatedAt;
  const rep = '<div class="blk"><h3>今天的報告' + (g ? '・<span data-rel="' + g + '">' + relTime(g, tnow()) + '</span>更新' + (d.source === 'daily11' ? '・11:00 查證版' : '') : '') + '</h3>' +
    (!secs.length ? '<p class="lg">報告準備中</p>' : secs.map((s, i) => { const o = S.bul.open === i; return '<div class="rep"><button class="rpb" type="button" data-act="rep-tog" data-i="' + i + '" aria-expanded="' + o + '"><b>' + esc(s.h) + '</b><span class="cv" aria-hidden="true">' + (o ? UP : '▾') + '</span></button>' + (o ? '<div class="rp">' + s.body + '</div>' : '') + '</div>'; }).join('')) + '</div>';
  const l = S.fu.list, f = S.fu.filter;
  const empty = { open: '目前沒有開著的追蹤事項。同事在 LINE 或面板交代肉咖「幫我記得…」「幫我追蹤…」，就會出現在這裡。', done: '還沒有完成的事項。', dropped: '沒有取消的事項。', all: '還沒有任何追蹤事項。' }[f];
  const fu = api && api.followupList ? '<div class="blk"><h3>追蹤事項</h3><div class="chips">' + FU_FILTERS.map(([k, t]) => '<button class="chip" type="button" data-act="fu-filter" data-f="' + k + '" aria-pressed="' + (k === f) + '">' + t + (k === 'open' && S.fu.open ? ' ' + S.fu.open.length : '') + '</button>').join('') + '</div>' +
    (!l ? '<p class="lg">讀取追蹤事項中…</p>' : l.length ? l.map(x => fuRow(x, false)).join('') : '<p class="lg">' + (S.fu.err ? '追蹤事項讀不到，請稍後再試。' : empty) + '</p>') +
    '<p class="last">' + (S.fu.busy && l ? '<span class="spin"></span> 更新中…　' : '') + (fuCanEdit() ? '點左邊的圈標成完成。' : '只有管理員能標完成或取消。') + '到期當天或逾期，肉咖會在 LINE 另外提醒。</p></div>' : '';
  return { t: '追蹤公告', b: rep + fu, f: '' };
}
async function loadFu() {
  if (!api || !api.followupList || S.net === 'auth') return;
  try {
    const l = await api.followupList('open', null, 200), same = JSON.stringify(l) === JSON.stringify(S.fu.open);
    S.fu.open = l; if (!same) renderFuBtn();
    if (S.drawer && S.drawer.view === 'followups') { if (S.fu.filter === 'open') { if (!same || !S.fu.list) { S.fu.list = l; S.fu.err = false; renderDrawer(); } } else loadFuList(); }
    const dr = S.drawer && get(S.drawer.id);
    if (dr && viewOf() === 'progress') loadItemFu(dr.id);
  } catch (e) { if (e instanceof AdapterError && e.kind === 'auth') { setAuth(); renderAll(); } }
}
async function loadFuList() {
  if (!api || !api.followupList) return;
  const f = S.fu.filter, ticket = ++S.fu.ticket;
  S.fu.busy = true;
  try {
    const l = await api.followupList(f, null, 200);
    if (ticket !== S.fu.ticket) return;
    S.fu.list = l; S.fu.err = false; if (f === 'open') { S.fu.open = l; renderFuBtn(); }
  } catch (e) {
    if (ticket !== S.fu.ticket) return;
    if (e instanceof AdapterError && e.kind === 'auth') { setAuth(); renderAll(); return; }
    S.fu.err = true; if (!S.fu.list) S.fu.list = [];
  } finally { if (ticket === S.fu.ticket) { S.fu.busy = false; if (S.drawer && S.drawer.view === 'followups') renderDrawer(); } }
}
const fuItemBusy = new Set();
async function loadItemFu(id) {
  if (!api || !api.followupList || fuItemBusy.has(id)) return;
  fuItemBusy.add(id);
  try { const l = await api.followupList('all', id, 50), old = S.fu.byItem.get(id); S.fu.byItem.set(id, l); if (JSON.stringify(old) !== JSON.stringify(l) && S.drawer && S.drawer.id === id) renderDrawer(); }
  catch (e) {} finally { fuItemBusy.delete(id); }
}
function fuOpenCard(itemId) {
  const it = get(itemId);
  if (!it) { toast('這張卡已經不在看板上，可以到封存找'); return; }
  S.drawer = null; openDrawer(itemId, it.status === 'doing' ? 'progress' : 'full');
}
async function fuSet(fid, patch, okMsg) {
  if (!fuCanEdit()) { toast(reason(new AdapterError('perm', '')), { bad: true }); return; }
  S.fu.busyIds = S.fu.busyIds || new Set(); S.fu.busyIds.add(fid); renderDrawer();
  try {
    const res = await api.followupUpdate(fid, patch);
    const putF = l => l && l.forEach((x, i) => { if (x.id === fid && res) l[i] = res; });
    putF(S.fu.list); putF(S.fu.open); S.fu.byItem.forEach(putF);
    toast(okMsg); loadFuList(); loadFu();
  } catch (e) {
    if (e instanceof AdapterError && e.kind === 'auth') setAuth();
    if (e instanceof AdapterError && e.kind === 'perm') loadWho();
    toast('沒有改成功：' + reason(e), { bad: true });
  } finally { S.fu.busyIds.delete(fid); renderAll(); }
}

// ---------------- 抽屜：畫出來 ----------------
function renderDrawer() {
  const dr = $('#drawer');
  if (!S.drawer) { dr.classList.remove('show'); return; }
  const v = S.drawer.view;
  let it = null, view = null;
  if (v === 'chat') view = chatView();
  else if (v === 'followups') view = fuView();
  else if (v === 'skin') view = skinView();
  else if (v === 'archived') { it = S.archMap.get(S.drawer.id); if (!it) { closeDrawer(true); goTab('archive'); return; } view = dockShow.has(it.id) ? cardChatView(it) : archivedView(it); }
  else {
    it = get(S.drawer.id); const vw = viewOf();
    if (!it || !vw) { dr.classList.remove('show'); return; }
    view = S.bidPage === it.id ? bidView(it) : dockShow.has(it.id) ? cardChatView(it) : vw === 'progress' ? progressView(it) : vw === 'full' ? fullView(it) : previewView(it);
  }
  const key = v + ':' + (S.drawer.id || '') + ':' + (S.bidPage ? 'bid' : dockShow.has(S.drawer.id) ? 'chat' : '');
  const keep = chatFocus();
  const old = dr.querySelector('.db'), same = dr.dataset.key === key, sc = old && same ? old.scrollTop : 0;
  const back = view.back ? '<button class="back" type="button" data-act="' + view.back + '"' + (view.backKey != null ? ' data-key="' + esc(view.backKey) + '"' : '') + '>‹ 返回</button>' : '';
  dr.innerHTML = '<div class="dh">' + back + '<h2 id="drt">' + esc(view.t) + '</h2><button class="xb" type="button" data-act="close-drawer">關閉 ✕</button></div><div class="db" tabindex="0">' + view.b + '</div>' + (view.f ? '<div class="df">' + view.f + '</div>' : '');
  dr.setAttribute('aria-labelledby', 'drt');
  if (!dr.classList.contains('show')) dr.style.animation = ''; else if (same) dr.style.animation = 'none';
  dr.dataset.key = key;
  const db = dr.querySelector('.db');
  db.scrollTop = same ? sc : (dr.querySelector('.msgs') && (v === 'chat' || dockShow.has(S.drawer.id)) ? db.scrollHeight : 0);
  dr.classList.add('show');
  chatRestore(keep);
  if (v === 'chat') markSeen(''); else if (it && dockShow.has(it.id)) markSeen(it.id);
}
function renderAll() {
  renderLive(); renderNotice(); renderMain(); renderSheet();
  if (S.drawer) { if (!['chat', 'archived', 'followups', 'skin'].includes(S.drawer.view) && !get(S.drawer.id)) closeDrawer(true); else renderDrawer(); }
  renderDlg(); renderRk(); renderFuBtn(); syncOverlay();
}

// ---------------- 疊層開關 ----------------
function syncOverlay() {
  const any = S.sheet || !!S.drawer;
  $('#scrim').classList.toggle('show', any);
  $('#app').inert = any;
  $('#app').setAttribute('aria-hidden', any ? 'true' : 'false');
  document.documentElement.classList.toggle('lock', any);
  const want = (S.drawer ? 1 : 0) + (S.sheet ? 1 : 0);
  if (want && !depth) { history.pushState({ opp: 1 }, ''); }
  if (!want && depth) { ignorePop = true; history.back(); }
  depth = want ? 1 : 0;
}
function openDrawer(id, view) {
  const it = get(id); if (!it) return;
  if (!S.drawer) lastFocus = document.activeElement;
  S.drawer = { id, view: view || 'preview' }; S.bidPage = null;
  if (it.status === 'doing') { ensureProgress(id); loadItemFu(id); ensureEvents(id, true); }
  else if (view === 'full') ensureDetail(id);
  ensureMsgs(id);
  renderDrawer(); syncOverlay();
  $('#drawer .xb')?.focus({ preventScroll: true });
}
function openPanel(view) { if (!S.drawer) lastFocus = document.activeElement; S.drawer = { id: '__' + view, view }; renderDrawer(); syncOverlay(); $('#drawer .xb')?.focus({ preventScroll: true }); }
function closeDrawer(silent) {
  if (S.drawer && S.drawer.id) dockShow.delete(S.drawer.id);
  S.drawer = null; S.bidPage = null; S.bidForm = { amount: '', receipt: '', note: '' }; $('#drawer').classList.remove('show'); syncOverlay();
  if (!silent) restoreFocus();
}
function openSheet() { if (!S.sheet) lastFocus = document.activeElement; S.sheet = true; renderSheet(); syncOverlay(); $('#sheet .xb')?.focus({ preventScroll: true }); }
function closeSheet() { S.sheet = false; $('#sheet').classList.remove('show'); syncOverlay(); restoreFocus(); }
function restoreFocus() {
  const a = document.activeElement;
  if (a && ((!S.drawer && $('#drawer').contains(a)) || (!S.sheet && $('#sheet').contains(a)))) a.blur();
  if (!S.sheet && !S.drawer && lastFocus && document.contains(lastFocus) && lastFocus !== document.body) { try { lastFocus.focus({ preventScroll: true }); } catch (e) {} }
}

// ---------------- toast ----------------
let toastT;
function toast(msg, opt = {}) {
  const t = $('#toast'); clearTimeout(toastT);
  t.className = opt.bad ? 'bad' : '';
  t.innerHTML = '<span class="sbp">' + softBreak(msg) + '</span>' + (opt.undo ? '<button type="button" id="toast-undo">復原</button>' : '');
  t.hidden = false; void t.offsetWidth; t.classList.add('show');
  if (opt.undo) $('#toast-undo').onclick = () => { t.classList.remove('show'); t.hidden = true; opt.undo(); };
  toastT = setTimeout(() => { t.classList.remove('show'); t.hidden = true; }, opt.bad ? 7000 : 6000);
}
function clap() { const m = $('#app'); m.classList.remove('clap'); void m.offsetWidth; m.classList.add('clap'); }

// ---------------- 寫入：樂觀更新，失敗就還原 ----------------
const nextRemind = () => { const d = new Date(tnow() + 8 * H); d.setUTCDate(d.getUTCDate() + 1); d.setUTCHours(HOLD_HOUR, 0, 0, 0); return d.getTime() - 8 * H; };
const reason = e => {
  if (!(e instanceof AdapterError)) return '發生錯誤';
  if (e.kind === 'state') return /deadline/i.test(e.message) ? '截止日已經過了，救不回來' : '這張卡的狀態已經變了，已重新同步';
  if (e.kind === 'perm') return /admin/i.test(e.message) ? '政府標案由管理員或有權限的同事決定要不要做' : '你的金鑰沒有這個權限';
  return { timeout: '連線逾時', network: '連不上伺服器', offline: '目前沒有網路', auth: AUTH_MSG }[e.kind] || e.message;
};
const short = t => t.length > 14 ? t.slice(0, 14) + '…' : t;
const nm = it => short(it.shortTitle || it.title);
const NEXT = { stash: 'snoozed', unstash: 'new', deleted: 'dropped', skipped: 'dropped', restore: 'new', build: 'doing' };
const mergeCard = (old, res) => ({ ...res,
  detailText: res.detailText || (old ? old.detailText : ''),
  attachments: res.attachments.length ? res.attachments : (old ? old.attachments : []),
  progressSteps: res.progressSteps || (old ? old.progressSteps : null) });
async function mutate(id, action, msg, undo) {
  const it = get(id); if (!it || locks.has(id)) return false;
  if (!can('act') || (action === 'build' && !canBuild(it))) { toast(reason(new AdapterError('perm', action === 'build' && can('act') ? 'admin' : '')), { bad: true }); return false; }
  const prev = { ...it };
  locks.add(id);
  const next = { ...it, status: NEXT[action] };
  if (action === 'stash') next.snoozeUntil = nextRemind();
  if (action === 'unstash' || action === 'restore') next.snoozeUntil = null;
  if (action === 'deleted' || action === 'skipped') { next.dropReason = action; next.decidedAt = tnow(); }
  if (action === 'build') Object.assign(next, { folderStatus: 'queued', progressStatus: 'queued', progressStage: '建立工作區', progressPct: 0, decidedAt: tnow() });
  S.items.set(id, next); S.cx.delete(id);
  renderAll();
  if (msg) toast(msg, { undo: undo ? () => undo(prev) : null });
  try {
    const res = await api.act(id, action);
    mutDone[id] = tnow();
    if (res && S.items.has(id)) S.items.set(id, mergeCard(get(id), res));
    saveSnapshot();
    return true;
  } catch (e) {
    S.items.set(id, prev);
    if (e instanceof AdapterError && e.kind === 'auth') setAuth();
    toast('沒有成功，已經還原：' + reason(e) + (e.kind === 'auth' ? '' : '。'), { bad: true });
    if (e instanceof AdapterError && e.kind === 'state') refresh();
    if (e instanceof AdapterError && e.kind === 'perm') loadWho();
    return false;
  } finally {
    locks.delete(id); renderAll();
    if (action === 'build') { kickPoll(); if (S.drawer && S.drawer.id === id && get(id) && get(id).status === 'doing') ensureProgress(id, true); }
  }
}
const undoDrop = prev => mutate(prev.id, 'restore', '已復原').then(ok => { if (ok && prev.status === 'snoozed') mutate(prev.id, 'stash'); });
function actDrop(id, why, msg) { const it = get(id); if (!it) return; if (S.drawer && S.drawer.id === id) closeDrawer(true); mutate(id, why, msg(it), undoDrop); }
const actDel = id => actDrop(id, 'deleted', it => '刪掉「' + nm(it) + '」，' + CONFIG.GONE_HOURS + ' 小時內可以救回');
const actNo = id => actDrop(id, 'skipped', it => '不做「' + nm(it) + '」，已收走');
function actHold(id) { const it = get(id); if (!it) return; if (S.drawer && S.drawer.id === id) closeDrawer(true); mutate(id, 'stash', TBD.stashToast(nm(it)), () => mutate(id, 'unstash', '已復原')); }
function actUnstash(id) { const it = get(id); if (!it) return; if (S.drawer && S.drawer.id === id) closeDrawer(true); mutate(id, 'unstash', '「' + nm(it) + '」放回' + LN[homeLane(it)] + '了', () => mutate(id, 'stash', '已復原')); }
function actBuild(id) {   // 要做：沒有復原（一按下就會啟動公司工作區）
  const it = get(id); if (!it) return;
  mutate(id, 'build', '好～Cut！「' + nm(it) + '」排進進行中，肉咖在建公司工作區').then(ok => { if (ok) { clap(); if (S.drawer && S.drawer.id === id) closeDrawer(true); goTab('active'); } });
}

// ---------------- 深入了解：資料庫端讀全文 ----------------
const wait = ms => new Promise(r => setTimeout(r, ms));
const redrawDrawer = id => { if (S.drawer && S.drawer.id === id) renderDrawer(); };
function put(c) { if (c && S.items.has(c.id)) S.items.set(c.id, mergeCard(get(c.id), c)); }
async function ensureDetail(id, force) {
  const it = get(id); if (!it) return;
  if (it.detailText && !force) return;
  const cur = S.detail.get(id); if (cur && cur.busy) return;
  if (!can('act')) { if (it.hasFullText || it.crawlStatus === 'done') { try { put(await api.get(id)); redrawDrawer(id); } catch (e) {} } return; }
  S.detail.set(id, { busy: true, t0: tnow() });
  redrawDrawer(id);
  try {
    let c = it;
    if (force || it.crawlStatus === 'none' || it.crawlStatus === 'failed') c = (await api.act(id, 'dive', { force })) || it;
    else if (it.crawlStatus === 'done' || it.hasFullText) c = (await api.get(id)) || it;
    put(c); redrawDrawer(id);
    const t0 = tnow();
    while (c.crawlStatus === 'crawling' && tnow() - t0 < 60000 && get(id)) { await wait(2000); c = (await api.get(id)) || c; put(c); redrawDrawer(id); }
    if (c.crawlStatus === 'crawling') { S.detail.set(id, { busy: false, timedOut: true, t0: (S.detail.get(id) && S.detail.get(id).t0) || t0 }); saveSnapshot(); return; }
    if (c.crawlStatus === 'done' && !c.detailText) { c = (await api.get(id)) || c; put(c); }
    saveSnapshot();
  } catch (e) {
    if (!get(id)) return;
    if (e instanceof AdapterError && e.kind === 'auth') setAuth();
    if (e instanceof AdapterError && e.kind === 'perm') loadWho();
    toast('讀全文沒有成功：' + reason(e), { bad: true });
  } finally { const d = S.detail.get(id); if (!(d && d.timedOut)) S.detail.delete(id); renderAll(); }
}
async function ensureProgress(id, force) {
  const it = get(id); if (!it || it.status !== 'doing') return;
  const cur = S.prog.get(id);
  if (cur && cur.busy) return;
  if (!force && it.progressSteps && cur && cur.at === it.progressUpdatedAt) return;
  S.prog.set(id, { busy: true, at: cur && cur.at });
  try {
    const c = it.hasFullText && !it.detailText ? await api.get(id) : await api.progress(id);
    put(c); S.prog.set(id, { busy: false, at: get(id) && get(id).progressUpdatedAt });
  } catch (e) {
    S.prog.set(id, { busy: false, at: cur && cur.at });
    if (e instanceof AdapterError && e.kind === 'auth') { setAuth(); renderAll(); }
  }
  redrawDrawer(id);
  if (get(id) && laneOf(get(id)) === 'active') renderMain();
}

// ---------------- 跟肉咖說：讀寫 ----------------
const SEEN_KEY = () => 'copp.msgseen.v1:' + (api && api.mode === 'mock' ? 'mock:' + (qs.get('mock') || '') : keyTag());
function seenStore() {
  let o = null; try { o = JSON.parse(localStorage.getItem(SEEN_KEY()) || 'null'); } catch (e) {}
  if (!o || typeof o !== 'object') { o = { base: tnow(), keys: {} }; try { localStorage.setItem(SEEN_KEY(), JSON.stringify(o)); } catch (e) {} }
  return o;
}
function markSeen(key) {
  const o = seenStore(), all = msgsAll().filter(m => m.author === RK && !sysMsg(m) && (m.itemId || '') === key);
  const t = Math.max(tnow(), ...all.map(m => m.createdAt || 0));
  if ((o.keys[key] || 0) >= t) return;
  o.keys[key] = t; try { localStorage.setItem(SEEN_KEY(), JSON.stringify(o)); } catch (e) {}
  renderRk();
}
const msgsAll = () => { const seen = new Set(), out = []; S.msgs.forEach(v => v.list.forEach(m => { if (!seen.has(m.id)) { seen.add(m.id); out.push(m); } })); return out; };
function unreadReplies() { const o = seenStore(); return msgsAll().filter(m => m.author === RK && !sysMsg(m) && m.createdAt && m.createdAt > Math.max(o.base || 0, o.keys[m.itemId || ''] || 0)); }
function renderRk() {
  const b = $('#rkbtn'); if (!b) return;
  const n = unreadReplies().length;
  b.hidden = S.net === 'auth';
  b.innerHTML = rkFace() + '肉咖' + (n ? '<i class="rk-dot" aria-hidden="true"></i>' : '');
  b.setAttribute('aria-label', '跟肉咖說' + (n ? '，有 ' + n + ' 則新回覆' : ''));
}
async function ensureMsgs(key, force) {
  if (!api || !api.msgList || S.net === 'auth' || S.msgBusy.has(key)) return;
  S.msgBusy.add(key);
  try {
    const list = await api.msgList(key, CONFIG.MSG_LIMIT);
    const old = S.msgs.get(key), same = old && JSON.stringify(old.list) === JSON.stringify(list);
    S.msgs.set(key, { list, at: tnow() });
    if (!same || !old) { if (S.drawer && (S.drawer.view === 'chat' ? key === '' : S.drawer.id === key)) renderDrawer(); renderRk(); }
  } catch (e) {
    if (e instanceof AdapterError && e.kind === 'auth') { setAuth(); renderAll(); }
    else if (!S.msgs.has(key)) { S.msgs.set(key, { list: [], at: tnow(), err: true }); if (S.drawer && S.drawer.id === key) renderDrawer(); }
  } finally { S.msgBusy.delete(key); }
}
function loadMsgs() { ensureMsgs(''); const did = S.drawer && S.drawer.id; if (did && did.slice(0, 2) !== '__') ensureMsgs(did); }
const dockShow = new Set();
const STEP_ERR = [[/not_step_owner/, '這一步不是你負責的，只有負責人或管理員可以按'], [/bid_managed/, '這一步照領標狀態由系統自動處理'], [/note_too_long/, '備註最多 200 字'],
  [/no_step/, '這一步不見了，重新整理一次'], [/bad_status/, '狀態不對，重新整理一次'], [/not found/i, '這張卡不見了，重新整理一次']];
async function doStepMark() {
  const d = S.dlg; if (!d || d.busy) return;
  d.busy = true; renderDlg();
  try {
    const it = get(d.id), s = it && (it.progressSteps || []).find(x => x.key === d.k);
    const c = await api.stepMark(d.id, d.k, d.st, String(d.note || '').trim());
    if (c) put(c);
    S.dlg = null; renderDlg();
    if (d.st === 'done') { const nx = curStep(get(d.id) || {}); clap(); toast('好～Cut！「' + (s ? s.name : '這一步') + '」完成' + (nx && nx.owner ? '，換 ' + nx.owner + '。' : '。')); }
    else toast({ current: '已標成進行中', undone: '已退回未完成' }[d.st] || '已更新');
    renderAll(); ensureEvents(d.id, true);
  } catch (e) {
    S.dlg = null; renderDlg();
    if (e instanceof AdapterError && e.kind === 'auth') setAuth();
    if (e instanceof AdapterError && e.kind === 'perm') loadWho();
    const hit = STEP_ERR.find(([re]) => re.test(e.message || ''));
    toast((hit ? hit[1] : reason(e)), { bad: true }); ensureProgress(d.id, true);
  }
}
async function shareFile(id, k, label, url) {
  track(id, 'share_file', k, label);
  if (navigator.share) { try { await navigator.share({ title: label || '文件', url }); return; } catch (e) { if (e && e.name === 'AbortError') return; } }
  copyText(url, '已複製連結，可以貼到 LINE 或其他地方');
}
function copyText(t, okMsg) {
  const ok = () => toast(okMsg || '已複製'), no = () => toast('這個瀏覽器不讓複製，請長按連結自己複製', { bad: true });
  const fb = () => { try { const a = document.createElement('textarea'); a.value = t; a.setAttribute('readonly', ''); a.style.position = 'fixed'; a.style.opacity = '0'; document.body.appendChild(a); a.select(); const r = document.execCommand('copy'); a.remove(); r ? ok() : no(); } catch (e) { no(); } };
  if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(t).then(ok, fb); else fb();
}
async function doMsgDel() {
  const d = S.dlg; if (!d || d.busy) return;
  const key = d.id; S.dlg.busy = true; renderDlg();
  try {
    if (d.type === 'msgclear') { const r = await api.msgClear(key); toast('已清空這張卡的對話' + (r && r.deleted != null ? '（' + r.deleted + ' 則）' : '')); }
    else { const r = await api.msgDelete(d.mid); toast('已刪掉' + (r && r.deleted > 1 ? '，連同回覆共 ' + r.deleted + ' 則' : '這則')); }
    S.dlg = null; renderDlg();
    await ensureMsgs(key, true); ensureMsgs('');
  } catch (e) {
    S.dlg = null; renderDlg();
    if (/Could not find the function|PGRST202/i.test(e.message || '')) { S.msgDelOff = true; toast('刪對話的功能還沒開通', { bad: true }); renderDrawer(); return; }
    if (e instanceof AdapterError && e.kind === 'auth') setAuth();
    if (e instanceof AdapterError && e.kind === 'perm') loadWho();
    toast('沒有刪掉：' + reason(e), { bad: true });
    ensureMsgs(key, true);
  }
}
function toggleDock(k) {
  if (dockShow.has(k)) { dockShow.delete(k); if ((S.draft.get(k) || '').trim()) toast('有沒送出的字，已幫你留著'); else S.draft.delete(k); }
  else { dockShow.add(k); ensureMsgs(k); }
  renderDrawer();
  if (dockShow.has(k)) { markSeen(k); $('#chat-input')?.focus({ preventScroll: true }); }
}
const KEEP_IDS = ['chat-input', 'bid-amt', 'bid-rc', 'bid-note'];
function chatFocus() { const a = document.activeElement; return a && KEEP_IDS.includes(a.id) ? [a.selectionStart, a.selectionEnd, a.id] : null; }
function chatRestore(k) { if (!k) return; const t = document.getElementById(k[2] || 'chat-input'); if (t) { t.focus({ preventScroll: true }); try { t.setSelectionRange(k[0], k[1]); } catch (e) {} } }
async function msgSend(key) {
  const text = (S.draft.get(key) || '').trim();
  if (!text) { toast('還沒打字。先寫一句再傳。', { bad: true }); $('#chat-input')?.focus(); return; }
  if (text.length > MSG_MAX) { toast('訊息太長，最多 ' + MSG_MAX + ' 字', { bad: true }); return; }
  if (!can('act')) { toast(reason(new AdapterError('perm', '')), { bad: true }); return; }
  const tmp = { id: 'tmp' + (++tmpN), itemId: key, author: (S.who && S.who.role) || '我', body: text, status: 'sending', createdAt: tnow(), pending: true };
  S.pend.set(key, (S.pend.get(key) || []).concat(tmp));
  S.draft.set(key, '');
  renderDrawer(); renderRk();
  try {
    await api.msgAdd(key, text);
    S.pend.set(key, (S.pend.get(key) || []).filter(m => m !== tmp));
    await ensureMsgs(key, true);
    if (key) ensureMsgs('');
    renderDrawer(); renderRk();
  } catch (e) {
    S.pend.set(key, (S.pend.get(key) || []).filter(m => m !== tmp));
    if (!S.draft.get(key)) S.draft.set(key, text);
    if (e instanceof AdapterError && e.kind === 'auth') setAuth();
    if (e instanceof AdapterError && e.kind === 'perm') loadWho();
    toast('沒有送出，已經放回輸入框：' + reason(e), { bad: true });
    renderAll();
  }
}
document.addEventListener('input', e => {
  const bf = { 'bid-amt': 'amount', 'bid-rc': 'receipt', 'bid-note': 'note' }[e.target.id];
  if (bf) { S.bidForm[bf] = e.target.value; return; }
  if (e.target.id === 'step-note' && S.dlg) { S.dlg.note = e.target.value; return; }
  if (e.target.id !== 'chat-input') return;
  S.draft.set(e.target.dataset.key || '', e.target.value);
  e.target.style.height = '48px'; e.target.style.height = Math.min(120, e.target.scrollHeight + 2) + 'px';
});
document.addEventListener('keydown', e => {
  if (e.target.id === 'chat-input' && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); msgSend(e.target.dataset.key || ''); }
});

// ---------------- 立即掃描（後端 opp_scan_request／opp_scan_status） ----------------
const SCAN_COOL = 15 * 60e3;
const scanShared = k => k === 'pitch' && !!S.scan.grant && !(S.scan.pitch && (S.scan.pitch.status || S.scan.pitch.lastDoneAt));
const scanOf = k => scanShared(k) ? S.scan.grant : S.scan[k];
const scanning = k => { const x = scanOf(k); return !!x && (x.status === 'queued' || x.status === 'running'); };
const hm = ms => { const d = new Date(ms + 8 * H); return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0'); };
const lastScan = x => x && (x.lastDoneAt || (x.status === 'done' ? x.doneAt : null));
const scanPhase = x => !x ? '' : x.status === 'queued' ? '排隊中' : ({ judging: '肉咖判讀中', sending: '送進看板中' }[x.phase] || '掃描中');
const scanDur = k => k === 'watch' ? '3～5' : '2～5';
function scanBox(k) {
  if (!SCAN_LANES.includes(k)) return '';
  if (k === 'watch' && !(S.scanSeen && S.scanSeen.has('watch'))) return '';
  if (S.scanClosed && S.scanClosed.has(k)) return '';
  const x = scanOf(k), last = lastScan(x), now = tnow(), shared = scanShared(k);
  const lastTxt = last ? '上次掃描 ' + (now - last < D ? hm(last) : fmtDate(last)) : '';
  let st = '';
  const res = x && (x.resultMain || (x.added == null ? '' : '新增 ' + x.added + ' 件'));
  const det = x && x.resultDetail ? '・' + x.resultDetail : '';
  if (scanning(k)) st = scanPhase(x) + '，全程約 ' + scanDur(k) + ' 分鐘，判讀過才會上看板';
  else if (x && x.status === 'done' && x.doneAt && now - x.doneAt < SCAN_COOL) st = (lastTxt ? lastTxt + '・' : '') + '完成：' + (res || '沒有新的') + det;
  else if (x && x.status === 'failed') st = (lastTxt ? lastTxt + '・' : '') + '失敗：' + (((x.resultMain || '') + (x.resultDetail ? '（' + x.resultDetail + '）' : '')) || '沒有回報原因');
  else st = lastTxt;
  if (shared) st = (st ? st + '・' : '') + '跟補助徵件一起掃';
  const cool = last && now - last < SCAN_COOL;
  const btn = !can('act') ? ''
    : scanning(k) ? '<button type="button" disabled aria-disabled="true">↻ 掃描中…</button>'
    : cool ? '<button type="button" disabled aria-disabled="true" title="15 分鐘內掃過，晚點再掃">↻ 剛掃過</button>'
    : '<button type="button" data-act="scan" data-lane="' + (shared ? 'grant' : k) + '" aria-label="請肉咖立即掃描' + (shared ? LN.grant + '和' + LN.pitch : LN[k]) + '">↻ 立即掃描</button>';
  return '<p class="scan" data-scan="' + k + '" aria-live="polite"><span>' + esc(st || '還沒掃過') + '</span>' + btn + '</p>';
}
function renderScan() { document.querySelectorAll('.scan[data-scan]').forEach(el => { const k = el.dataset.scan; el.outerHTML = scanBox(k) || '<span></span>'; }); renderRk(); if (S.tab === 'home') renderMain(); }
async function loadScan() {
  if (!api || !api.scanStatus || S.net === 'auth' || S.scanBusy.has('*')) return;
  S.scanBusy.add('*');
  try {
    const list = await api.scanStatus(), was = {};
    SCAN_LANES.forEach(k => { was[k] = scanning(k); });
    const seen = new Set(list.map(x => x.lane)), seenChanged = !S.scanSeen || [...seen].join() !== [...S.scanSeen].join();
    S.scanSeen = seen;
    const before = JSON.stringify(S.scan);
    list.forEach(x => { if (!S.scanBusy.has(x.lane)) S.scan[x.lane] = x; });
    if (seenChanged) renderMain(); else if (JSON.stringify(S.scan) !== before) renderScan();
    if (SCAN_LANES.some(k => was[k] && !scanning(k))) ping();
    if (SCAN_LANES.some(scanning)) kickPoll();
  } catch (e) { if (e instanceof AdapterError && e.kind === 'auth') { setAuth(); renderAll(); } }
  finally { S.scanBusy.delete('*'); }
}
async function scanNow(k) {
  if (!SCAN_LANES.includes(k) || scanning(k) || S.scanBusy.has(k)) return;
  if (!can('act')) { toast(reason(new AdapterError('perm', '')), { bad: true }); return; }
  const prev = S.scan[k];
  S.scanBusy.add(k);
  S.scan[k] = Object.assign({}, prev || { lane: k }, { status: 'queued', createdAt: tnow(), doneAt: null, added: null });
  renderScan(); kickPoll();
  try {
    const res = await api.scanRequest(k);
    if (res) S.scan[k] = Object.assign({}, res, { lastDoneAt: res.lastDoneAt || (prev && prev.lastDoneAt) || null });
    toast(res && res.state === 'already' ? '「' + LN[k] + '」已經在掃描了，全程約 ' + scanDur(k) + ' 分鐘'
      : res && res.state === 'recent' ? '「' + LN[k] + '」15 分鐘內剛掃過，先看看新卡'
      : '叫肉咖去掃「' + LN[k] + '」了，掃描加判讀全程約 ' + scanDur(k) + ' 分鐘');
  } catch (e) {
    S.scan[k] = prev;
    if (e instanceof AdapterError && e.kind === 'auth') setAuth();
    if (e instanceof AdapterError && e.kind === 'perm') loadWho();
    if (e instanceof AdapterError && e.kind === 'state' && /lane must be/i.test(e.message)) { S.scanClosed = S.scanClosed || new Set(); S.scanClosed.add(k); toast('這欄的立即掃描還沒開通'); return; }
    toast('沒有開始掃描：' + reason(e), { bad: true });
  } finally { S.scanBusy.delete(k); renderScan(); kickPoll(); }
}

// ---------------- 封存、結案與徹底刪除（sql/25） ----------------
const getAny = id => get(id) || S.archMap.get(id);
const shortName = it => (it.shortTitle || it.title || '').trim();
const purgeOk = (it, t) => { t = String(t || '').trim(); return !!t && (t === shortName(it) || t === (it.title || '').trim()); };
function closeDlg() { S.dlg = null; renderDlg(); const d = $('#drawer.show'); if (d) d.querySelector('.xb')?.focus({ preventScroll: true }); }
function renderDlg() {
  const wrap = $('#dlg'); if (!wrap) return;
  const msgDlg = d => d.type === 'msgdel' || d.type === 'msgclear';
  const d = S.dlg, it = d && (d.type === 'fu' ? fuGet(d.id) : msgDlg(d) ? (getAny(d.id) || { title: '全面板', shortTitle: '全面板' }) : getAny(d.id));
  if (!d || !it) { wrap.hidden = true; wrap.innerHTML = ''; S.dlg = null; return; }
  const name = esc(shortName(it));
  const keepFocus = document.activeElement && wrap.contains(document.activeElement) ? document.activeElement.id : '';
  let h = '';
  if (d.type === 'archive' && d.step === 'pick') {
    h = '<h2 id="dlt">' + (d.re ? '改結案結果：' : '結案：') + name + '</h2><p>' + (d.re ? '只改結果，結案日不變。' : '選一個結果。案子會在進行中再留 14 天才從看板撤下，封存隨時找得到；資料夾和 Drive 都保留。') + '</p>' +
      ['won', 'lost', 'submitted', 'withdrawn'].map(k => '<label class="opt"><input type="radio" name="arch-kind" value="' + k + '"' + (d.kind === k ? ' checked' : '') + '><span>' + KIND[k] + '<small>' + KIND_DESC[k] + '</small></span></label>').join('') +
      '<label class="fld"><span>備註（選填）</span><input id="arch-note" type="text" maxlength="200" placeholder="例如：決標公告日 11/20" value="' + esc(d.note) + '"></label>' +
      '<div class="da"><button class="bq" data-act="dlg-close" type="button">取消</button><button class="bm" data-act="arch-next" type="button"' + (d.kind ? '' : ' disabled') + '>下一步</button></div>';
  } else if (d.type === 'archive') {
    h = '<h2 id="dlt">確定結案？</h2><p>' + (d.re ? '確定把「' + name + '」的結果改成『' + KIND[d.kind] + '』？' : '確定把「' + name + '」封存為『' + KIND[d.kind] + '』？') + '</p>' + (d.note ? '<p class="lg">備註：' + esc(d.note) + '</p>' : '') +
      (d.re ? '' : '<p class="lg">' + (can('admin') ? '封存後幾秒內可以按「復原」，之後在封存按「放回進行中」。' : '封存後要找管理員才能放回進行中。') + '</p>') +
      '<div class="da"><button class="bq" data-act="arch-back-pick" type="button">返回</button><button class="bm" data-act="arch-confirm" type="button">' + (d.re ? '確定修改' : '確定封存') + '</button></div>';
  } else if (d.type === 'fu') {
    const done = d.to === 'done';
    h = '<h2 id="dlt">' + (done ? '標成完成' : '取消這件事') + '</h2><p>「' + esc(it.title) + '」' + (it.owner ? '（' + esc(it.owner) + '）' : '') + '</p>' +
      '<label class="fld"><span>' + (done ? '完成的依據' : '取消的原因') + '（選填）</span><input id="fu-note" type="text" maxlength="500" placeholder="' + (done ? '例如：群組 11/16 Louis 說已回' : '例如：改外景，不用了') + '" value="' + esc(d.note) + '"></label>' +
      '<div class="da"><button class="bq" data-act="dlg-close" type="button">返回</button><button class="bm" data-act="fu-confirm" type="button">' + (done ? '標成完成' : '確定取消') + '</button></div>';
  } else if (d.type === 'stepmark') {
    const s = (it.progressSteps || []).find(x => x.key === d.k), sn = esc(s ? s.name : d.k);
    const w = { done: '標成完成', current: s && s.status === 'blocked' ? '解除卡住' : '標成進行中', undone: '退回未完成' }[d.st] || '更新';
    h = '<h2 id="dlt">' + (d.st === 'undone' ? '把「' + sn + '」退回未完成？' : d.st === 'current' && s && s.status === 'blocked' ? '解除「' + sn + '」的卡住？' : '把「' + sn + '」' + w + '？') + '</h2><p>「' + name + '」。按下去會記下是你按的，大家都看得到。</p>' +
      '<label class="fld"><span>備註（選填，最多 200 字）</span><input id="step-note" type="text" maxlength="200" value="' + esc(d.note || '') + '" placeholder="例如：石頭已用印、寄出"></label>' +
      '<div class="da"><button class="bq" data-act="dlg-close" type="button">取消</button><button class="bm" data-act="step-mark-confirm" type="button"' + (d.busy ? ' disabled' : '') + '>' + w + '</button></div>';
  } else if (msgDlg(d)) {
    const all = d.type === 'msgclear';
    h = '<h2 id="dlt">' + (all ? '清空這張卡的對話' : '刪掉這則訊息') + '</h2><p>' + (all ? '「' + name + '」底下的對話會全部刪掉（包含肉咖的回覆和付款、步驟通知），無法復原。卡片、進度和付款紀錄不會動。' : '這則訊息和底下的回覆會一起刪掉，無法復原。') + '</p>' +
      '<div class="da"><button class="bq" data-act="dlg-close" type="button">取消，留著</button><button class="bm danger" data-act="msg-del-confirm" type="button"' + (d.busy ? ' disabled' : '') + '>' + (all ? '確定清空' : '確定刪掉') + '</button></div>';
  } else if (d.type === 'purge') {
    const ok = purgeOk(it, d.typed);
    h = '<h2 id="dlt">徹底刪除「' + name + '」</h2><p>這個動作救不回來。只刪資料庫裡的紀錄，電腦裡的資料夾和 Drive 檔案不會動。</p>' +
      '<label class="fld"><span>輸入短案名「' + name + '」才能刪除</span><input id="purge-in" type="text" autocomplete="off" value="' + esc(d.typed) + '"></label>' +
      '<div class="da"><button class="bq" data-act="dlg-close" type="button">取消，留著</button><button class="bm danger" data-act="purge-confirm" type="button"' + (ok ? '' : ' disabled') + '>徹底刪除這一案</button></div>';
  }
  wrap.innerHTML = '<div class="dl" role="alertdialog" aria-modal="true" aria-labelledby="dlt">' + h + '</div>'; wrap.hidden = false;
  const f = (keepFocus && document.getElementById(keepFocus)) || wrap.querySelector('#fu-note, #step-note, #purge-in, input[name=arch-kind]:checked, input[name=arch-kind], .bm');
  f && f.focus({ preventScroll: true });
}
document.addEventListener('input', e => {
  if (!S.dlg) return;
  if (e.target.id === 'arch-note' || e.target.id === 'fu-note') S.dlg.note = e.target.value;
  else if (e.target.id === 'purge-in') { S.dlg.typed = e.target.value; const b = $('#dlg [data-act=purge-confirm]'), it = getAny(S.dlg.id); if (b && it) b.disabled = !purgeOk(it, S.dlg.typed); }
});
document.addEventListener('change', e => { if (S.dlg && e.target.name === 'arch-kind') { S.dlg.kind = e.target.value; renderDlg(); } });
function archNext() { if (!S.dlg || !S.dlg.kind) return; const n = $('#arch-note'); if (n) S.dlg.note = n.value.trim(); S.dlg.step = 'confirm'; renderDlg(); }
async function doArchive() {
  const d = S.dlg, it = d && get(d.id); if (!it) { closeDlg(); return; }
  if (!can('act')) { toast(reason(new AdapterError('perm', '')), { bad: true }); return; }
  const prev = { ...it }, kind = d.kind, note = d.note, re = it.progressStatus === 'done';
  S.dlg = null; renderDlg();
  const at = re && it.progressArchiveAt ? it.progressArchiveAt : tnow() + 14 * D;
  const fin = kind === 'withdrawn' ? 'skipped' : 'done';
  S.items.set(it.id, { ...it, progressStatus: 'done', progressState: 'done', progressOutcome: kind, archiveKind: kind, progressArchiveAt: at, archivedAt: at - 14 * D,
    progressNote: note || it.progressNote, progressPct: 100,
    progressSteps: re || !it.progressSteps ? it.progressSteps : it.progressSteps.map(s => s.status === 'done' || s.status === 'skipped' ? s : { ...s, status: fin, doneAt: fin === 'done' ? tnow() : null }) });
  locks.add(it.id); renderAll();
  toast(re ? '已把「' + nm(it) + '」改成『' + KIND[kind] + '』' : '結案：' + KIND[kind] + '。「' + nm(it) + '」14 天後從看板撤下，封存隨時找得到', { undo: can('admin') && !re ? () => doUnarchive(it.id, prev) : null });
  try {
    const res = await api.archive(it.id, kind, note);
    mutDone[it.id] = tnow();
    if (res) { S.items.set(it.id, mergeCard(get(it.id), res)); S.archMap.set(it.id, get(it.id)); }
    S.arch.list = null; saveSnapshot();
  } catch (e) {
    S.items.set(it.id, prev);
    if (e instanceof AdapterError && e.kind === 'auth') setAuth();
    if (e instanceof AdapterError && e.kind === 'perm') loadWho();
    toast('沒有封存成功，已經還原：' + reason(e), { bad: true });
  } finally { locks.delete(it.id); renderAll(); }
}
async function doUnarchive(id, prev) {
  try {
    const res = await api.unarchive(id);
    S.items.set(id, res ? mergeCard(prev, res) : prev); S.archMap.delete(id); S.arch.list = null;
    if (S.drawer && S.drawer.view === 'archived' && S.drawer.id === id) S.drawer = { id, view: 'progress' };
    toast('已放回進行中'); renderAll(); refresh();
  } catch (e) {
    if (e instanceof AdapterError && e.kind === 'perm') loadWho();
    toast('沒有放回成功：' + reason(e), { bad: true });
  }
}
async function doPurge() {
  const d = S.dlg, it = d && getAny(d.id); if (!it) { closeDlg(); return; }
  const typed = d.typed.trim(); if (!purgeOk(it, typed) || !can('admin')) return;
  const b = $('#dlg [data-act=purge-confirm]'); if (b) { b.disabled = true; b.textContent = '刪除中…'; }
  try {
    await api.purge(it.id, typed);
    S.items.delete(it.id); S.archMap.delete(it.id);
    if (S.arch.list) S.arch.list = S.arch.list.filter(x => x.id !== it.id);
    S.dlg = null;
    if (S.drawer && S.drawer.id === it.id) closeDrawer(true);
    toast('徹底刪除了「' + nm(it) + '」。檔案沒有動。');
    saveSnapshot(); renderAll();
  } catch (e) {
    if (e instanceof AdapterError && e.kind === 'auth') setAuth();
    if (e instanceof AdapterError && e.kind === 'perm') loadWho();
    toast('沒有刪除：' + (e instanceof AdapterError && /confirm|title/i.test(e.message) ? '短案名不對' : reason(e)), { bad: true });
    renderDlg();
  }
}
let archT;
async function loadArchive() {
  if (!api || !api.archiveList || S.net === 'auth') return;
  const q = S.arch.q, y = S.arch.year, ticket = (S.arch.ticket = (S.arch.ticket || 0) + 1);
  S.arch.busy = true;
  try {
    const list = await api.archiveList(q, y, 100);
    if (ticket !== S.arch.ticket) return;
    S.arch.list = list; list.forEach(x => S.archMap.set(x.id, x)); S.arch.err = false;
  } catch (e) {
    if (e instanceof AdapterError && e.kind === 'auth') { setAuth(); renderAll(); return; }
    S.arch.err = true; if (!S.arch.list) S.arch.list = [];
  } finally { if (ticket === S.arch.ticket) { S.arch.busy = false; if (S.tab === 'archive') renderMain(); else renderTabs(); } }
}
document.addEventListener('input', e => { if (e.target.id !== 'arch-q') return; S.arch.q = e.target.value; clearTimeout(archT); archT = setTimeout(loadArchive, 300); });
function openArchived(id) {
  if (!S.archMap.get(id)) return;
  if (!S.drawer) lastFocus = document.activeElement;
  S.drawer = { id, view: 'archived' };
  ensureMsgs(id);
  renderDrawer(); syncOverlay();
  if (api.progress && !S.archMap.get(id).progressSteps) api.progress(id).then(c => { if (c) { const o = S.archMap.get(id) || {}; S.archMap.set(id, { ...o, ...c, archiveKind: c.archiveKind || o.archiveKind, archivedAt: o.archivedAt || c.archivedAt }); if (S.drawer && S.drawer.id === id) renderDrawer(); } }).catch(() => {});
}

// ---------------- 外觀：每人自選，存在該人金鑰的設定（後端還沒開時只記在這支手機） ----------------
const SKIN_LS = () => 'copp.skin.v1:' + (api && api.mode === 'mock' ? 'mock:' + (qs.get('mock') || '') : keyTag());
function applySkin(v) { S.skin = SKINS[v] ? Number(v) : 1; document.documentElement.dataset.skin = S.skin; const m = document.querySelector('meta[name=theme-color]'); if (m) m.content = S.skin === 3 ? '#ffffff' : '#07060d'; }
function skinCache(v) { try { if (v) localStorage.setItem(SKIN_LS(), String(v)); return Number(localStorage.getItem(SKIN_LS()) || 0); } catch (e) { return 0; } }
async function loadPrefs(fromWho) {
  if (fromWho && fromWho.skin) { S.prefRemote = true; applySkin(fromWho.skin); skinCache(S.skin); return; }
  if (!api || !api.prefGet) { S.prefRemote = false; return; }
  try { const p = await api.prefGet(); S.prefRemote = true; if (p && p.skin) { applySkin(p.skin); skinCache(S.skin); } }
  catch (e) { if (e instanceof AdapterError && e.kind === 'missing') S.prefRemote = false; }
  if (S.drawer && S.drawer.view === 'skin') renderDrawer();
  renderMain();
}
async function setSkin(v) {
  v = Number(v); if (!SKINS[v] || v === S.skin || S.prefBusy) return;
  const prev = S.skin;
  applySkin(v); skinCache(v); renderAll();
  const undo = () => setSkin(prev);
  if (S.prefRemote === false || !api.prefSet) { toast('外觀換成「' + SKINS[v] + '」，先記在這支手機。', { undo }); return; }
  S.prefBusy = true; renderDrawer();
  try { await api.prefSet({ skin: v }); S.prefRemote = true; toast('外觀換成「' + SKINS[v] + '」，只改你自己的畫面。', { undo }); }
  catch (e) {
    if (e instanceof AdapterError && e.kind === 'missing') { S.prefRemote = false; toast('外觀換成「' + SKINS[v] + '」，先記在這支手機。', { undo }); }
    else { applySkin(prev); skinCache(prev); toast('外觀沒有存成功：' + reason(e), { bad: true }); }
  } finally { S.prefBusy = false; renderAll(); }
}

// ---------------- 自動換新版（v7 起的機制，v90 照用；不用重新加到主畫面） ----------------
// version.json 跟 js 網址的 ?vN 一樣。載入、切回前景、取得焦點、每 10 分鐘抓一次（no-store）；
// 版本不同就請 SW 換新並重新整理。抽屜、待決區、確認框開著，或輸入框有字：先不整理，頂端顯示「有新版本，點一下更新」。
const APP_V = ((new URL(import.meta.url)).search.match(/v\d+/) || [''])[0];
document.documentElement.dataset.v = APP_V;
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', e => { if (e.data && e.data.ask === 'version' && e.ports && e.ports[0]) e.ports[0].postMessage(APP_V); });
  if (navigator.serviceWorker.startMessages) navigator.serviceWorker.startMessages();
}
let newV = '', verAt = 0;
const busyNow = () => !!(S.drawer || S.sheet || S.dlg) || [...S.draft.values()].some(v => v && v.trim()) ||
  [...document.querySelectorAll('textarea, input[type=text], input[type=search]')].some(e => e.value && e.value.trim());
async function checkVersion() {
  if (!APP_V || Date.now() - verAt < 5000) return;
  verAt = Date.now();
  try {
    const r = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' }); if (!r.ok) return;
    const v = String(((await r.json()) || {}).version || '');
    if (!/^v\d+$/.test(v) || v === APP_V) { const b = $('#updbar'); if (b) b.hidden = true; kickWaiting(); return; }
    newV = v;
    let tried = null; try { tried = JSON.parse(sessionStorage.getItem('copp.upd') || 'null'); } catch (e) {}
    if (busyNow() || (tried && tried.v === v && Date.now() - tried.at < 120e3)) { showUpd(); return; }
    doUpdate();
  } catch (e) {}
}
// v90：換版那一下（舊頁面 reg.update() 後馬上重新整理），新 SW 偶爾會停在 waiting（本機模擬 A 抓到）。
// 頁面已經是新版就不用再整理，只要叫它接手，舊快取才清得掉、離線才開得到新版。
function kickWaiting() { try { navigator.serviceWorker.getRegistration().then(reg => { if (reg && reg.waiting) reg.waiting.postMessage('skipWaiting'); }).catch(() => {}); } catch (e) {} }
function showUpd() { const b = $('#updbar'); if (!b) return; b.textContent = '有新版本，點一下更新'; b.hidden = false; }
async function doUpdate(byUser) {
  let marked = false;
  try { sessionStorage.setItem('copp.upd', JSON.stringify({ v: newV, at: Date.now() })); const r = JSON.parse(sessionStorage.getItem('copp.upd') || 'null'); marked = !!r && r.v === newV; } catch (e) {}
  if (!marked && !byUser) { showUpd(); return; }
  try {
    const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
    if (reg) { await reg.update().catch(() => {}); if (reg.waiting) reg.waiting.postMessage('skipWaiting'); }
  } catch (e) {}
  location.reload();
}
if (window.visualViewport) {
  const vv = window.visualViewport, kb = () => { const h = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    document.documentElement.style.setProperty('--kb', h + 'px'); document.documentElement.classList.toggle('kbopen', h > 80); };
  vv.addEventListener('resize', kb); vv.addEventListener('scroll', kb);
}

// ---------------- 讀取：快照、逾時、輪詢、即時 ----------------
let SNAP = '';
const snapKey = () => SNAP || (SNAP = CONFIG.SNAPSHOT_KEY + ':' + (api.mode === 'mock' ? 'mock:' + (qs.get('mock') || '') : keyTag()));
function loadSnapshot() {
  try {
    const s = JSON.parse(localStorage.getItem(snapKey()) || 'null');
    if (s && Array.isArray(s.items) && s.items.length) { s.items.forEach(i => S.items.set(i.id, i)); S.lastOk = s.at; S.hadData = true; if (s.caps) S.caps = s.caps; return true; }
  } catch (e) {}
  return false;
}
function saveSnapshot() {
  if (S.net === 'auth') return;
  try { localStorage.setItem(snapKey(), JSON.stringify({ at: S.lastOk || tnow(), caps: S.caps, items: items().map(i => ({ ...i, detailText: i.detailText.slice(0, 30000) })) })); } catch (e) {}
}
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new AdapterError('timeout', '連線逾時')), ms))]);
const sig = () => JSON.stringify(items().map(i => [i.id, i.status, i.lane, i.snoozeUntil, i.deadline, i.expiresAt, i.title, i.folderStatus, i.folderPath, i.folderError, i.crawlStatus, i.crawlError, i.detailText.length, i.amountDisplay, i.why,
  i.progressStatus, i.progressStage, i.progressPct, i.progressStepN, i.progressNote, i.progressBlocker, i.progressUpdatedAt, i.progressArchiveAt, i.progressSteps ? i.progressSteps.length : -1, JSON.stringify(i.links || []), i.bidState]));
let inflight = false, again = false, pollT, pingT, unsub = () => {};
function setAuth() {
  S.net = 'auth'; clearTimeout(pollT); clearTimeout(pingT);
  try { unsub(); } catch (e) {} unsub = () => {}; S.rt = false;
  try { localStorage.removeItem(snapKey()); } catch (e) {}
}
async function refresh() {
  if (S.net === 'auth') return;
  if (inflight) { again = true; return; }
  inflight = true;
  const t0 = tnow(), before = sig(), prevNet = S.net, hadSlow = S.slow;
  const slowT = setTimeout(() => { S.slow = true; renderNotice(); renderLive(); }, CONFIG.SLOW_MS);
  try {
    const r = await withTimeout(api.list(), CONFIG.TIMEOUT_MS);
    if (r.serverTime) OFF = r.serverTime - Date.now();
    const known = new Set(S.items.keys()), added = [], next = new Map();
    r.items.forEach(x => {
      const keepLocal = locks.has(x.id) || (mutDone[x.id] && mutDone[x.id] > t0);
      const old = S.items.get(x.id);
      next.set(x.id, keepLocal && old ? old : mergeCard(old, x));
      if (!known.has(x.id) && x.status === 'new') added.push(x);
    });
    locks.forEach(id => { if (!next.has(id) && S.items.has(id)) next.set(id, S.items.get(id)); });
    S.items = next; S.net = 'ok'; S.hadData = true; S.lastOk = tnow();
    if (S.firstNet && added.length) { added.forEach(a => S.fresh.add(a.id)); toast('新進 ' + added.length + ' 筆：「' + nm(added[0]) + '」' + (added.length > 1 ? ' 等' : '')); }
    S.firstNet = true; saveSnapshot();
    const dr = S.drawer && get(S.drawer.id);
    if (dr && viewOf() === 'full' && dr.crawlStatus === 'done' && !dr.detailText) ensureDetail(dr.id);
    if (dr && viewOf() === 'progress') { ensureProgress(dr.id); if ([...stepOpen].some(k => k.startsWith(dr.id + '|')) || S.fx.has('cur-' + dr.id)) ensureEvents(dr.id, true); }
    // v90：首頁的「輪到你」、房間的方塊頭像都要步驟負責人，進行中的卡一律補抓步驟（唯讀也抓，v81 只在 act 時抓）
    items().filter(i => laneOf(i) === 'active' && i.progressStatus !== 'done').forEach(i => ensureProgress(i.id));
    loadMsgs(); loadScan(); loadFu(); loadBul();
  } catch (e) {
    if (e instanceof AdapterError && e.kind === 'auth') setAuth(); else S.net = 'offline';
  } finally {
    clearTimeout(slowT); S.slow = false; inflight = false;
    if (sig() !== before || S.net !== prevNet || hadSlow) renderAll(); else { renderLive(); renderNotice(); }
    if (again) { again = false; refresh(); }
  }
}
async function loadWho() {
  try { const w = await api.whoami(); S.who = w; S.caps = w.caps || {}; saveSnapshot(); loadPrefs(w.prefs); }
  catch (e) { if (e instanceof AdapterError && e.kind === 'auth') setAuth(); }
  renderAll();
}
const needFast = () => items().some(i => i.crawlStatus === 'crawling' || folderWait(i)) || SCAN_LANES.some(scanning);
function schedulePoll() { clearTimeout(pollT); if (S.net === 'auth') return; pollT = setTimeout(async () => { if (!document.hidden) await refresh(); schedulePoll(); }, needFast() ? CONFIG.FAST_POLL_MS : CONFIG.POLL_MS); }
function kickPoll() { schedulePoll(); }
const ping = () => { clearTimeout(pingT); pingT = setTimeout(refresh, 150); };

// ---------------- 事件 ----------------
function copyPath(id) {
  const it = getAny(id); if (!it || !it.folderPath) return;
  copyText(it.folderPath, '已複製本機資料夾位置');
}
document.addEventListener('click', e => {
  const act = e.target.closest('[data-act]'), a = act && act.dataset.act, id = act && act.dataset.id;
  if (e.target.id === 'scrim') { S.drawer ? closeDrawer() : closeSheet(); return; }
  const tab = !a && e.target.closest('[data-tab]'); if (tab) { if (S.drawer) closeDrawer(true); if (S.sheet) closeSheet(); goTab(tab.dataset.tab); return; }
  if (e.target.id === 'dlg') { closeDlg(); return; }
  if (!a) return;
  switch (a) {
    case 'open-card': { const it = get(id); if (it) openDrawer(id, it.status === 'doing' ? 'progress' : 'preview'); break; }
    case 'cx': S.cx.has(id) ? S.cx.delete(id) : S.cx.add(id); renderMain(); $('[data-act=cx][data-id="' + CSS.escape(id) + '"]')?.focus({ preventScroll: true }); break;
    case 'fold': { const k = act.dataset.k; S.fx.has(k) ? S.fx.delete(k) : S.fx.add(k);
      if (/^cur-/.test(k) && S.fx.has(k)) { const cid = k.slice(4); ensureEvents(cid); const c = get(cid), s = c && curStep(c); if (s) track(cid, 'open_step', s.key); }
      if (act.closest('#drawer')) renderDrawer(); else renderMain();
      document.querySelector('[data-act=fold][data-k="' + CSS.escape(k) + '"]')?.focus({ preventScroll: true }); break; }
    case 'del': actDel(id); break;
    case 'hold': actHold(id); break;
    case 'unstash': actUnstash(id); break;
    case 'dive': if (S.sheet) closeSheet(); openDrawer(id, 'full'); break;
    case 'no': actNo(id); break;
    case 'yes': actBuild(id); break;
    case 'open-progress': if (S.sheet) closeSheet(); openDrawer(id, 'progress'); break;
    case 'restore': mutate(id, 'restore', '已救回來，放回待看'); break;
    case 'paste-key': pasteKey(); break;
    case 'retry': refresh(); break;
    case 'retry-detail': ensureDetail(id, true); break;
    case 'toggle-text': S.textOpen.has(id) ? S.textOpen.delete(id) : S.textOpen.add(id); renderDrawer(); break;
    case 'toggle-att': S.attOpen.has(id) ? S.attOpen.delete(id) : S.attOpen.add(id); renderDrawer(); $('#drawer [data-act=toggle-att]')?.focus({ preventScroll: true }); break;
    case 'close-drawer': closeDrawer(); break;
    case 'close-hold': closeSheet(); break;
    case 'open-hold': if (S.drawer) closeDrawer(true); openSheet(); break;
    case 'open-chat': if (S.sheet) closeSheet(); openChat(); break;
    case 'open-fu': if (S.sheet) closeSheet(); openFu(); break;
    case 'upd': doUpdate(true); break;
    case 'open-skin': openPanel('skin'); break;
    case 'skin-set': setSkin(act.dataset.v); break;
    case 'copy-path': copyPath(id); break;
    case 'arch-start': { const x = get(id), re = !!(x && x.progressStatus === 'done'); S.dlg = { type: 'archive', id, kind: re && x.archiveKind || '', note: '', step: 'pick', re }; renderDlg(); break; }
    case 'arch-reopen': doUnarchive(id, getAny(id)); break;
    case 'arch-next': archNext(); break;
    case 'arch-back-pick': S.dlg.step = 'pick'; renderDlg(); break;
    case 'arch-confirm': doArchive(); break;
    case 'arch-open': openArchived(id); break;
    case 'arch-back': closeDrawer(true); goTab('archive'); break;
    case 'arch-year': S.arch.year = act.dataset.y || ''; loadArchive(); renderMain(); break;
    case 'arch-clear': S.arch.q = ''; S.arch.year = ''; loadArchive(); renderMain(); break;
    case 'purge-start': S.dlg = { type: 'purge', id, typed: '' }; renderDlg(); break;
    case 'purge-confirm': doPurge(); break;
    case 'msg-del': S.dlg = { type: 'msgdel', id: act.dataset.key || '', mid: act.dataset.mid }; renderDlg(); break;
    case 'msg-clear': S.dlg = { type: 'msgclear', id: act.dataset.key || '' }; renderDlg(); break;
    case 'msg-del-confirm': doMsgDel(); break;
    case 'bid-open': bidOpen(id); break;
    case 'bid-close': S.bidPage = null; S.bidForm = { amount: '', receipt: '', note: '' }; renderDrawer(); break;
    case 'bid-paid': bidPaid(id); break;
    case 'bid-ext': break;
    case 'mine-tog': S.mine = !S.mine; if (S.tab !== 'active') S.tab = 'active'; renderMain(); break;
    case 'step-mark': S.dlg = { type: 'stepmark', id, k: act.dataset.k, st: act.dataset.st, note: '' }; renderDlg(); break;
    case 'step-mark-confirm': doStepMark(); break;
    case 'file-open': track(id, 'open_file', act.dataset.k, act.dataset.label); break;
    case 'file-dl': track(id, 'download_file', act.dataset.k, act.dataset.label); break;
    case 'file-share': shareFile(id, act.dataset.k, act.dataset.label, act.dataset.url); break;
    case 'pres-tog': { const n = act.dataset.n || ''; S.presOpen.has(n) ? S.presOpen.delete(n) : S.presOpen.add(n); renderDrawer(); break; }
    case 'open-hot': { const h = get(id); if (h) openDrawer(id, laneOf(h) === 'active' ? 'progress' : 'preview'); break; }
    case 'dock-toggle': toggleDock(act.dataset.key || ''); break;
    case 'step-tog': { const k = id + '|' + (act.dataset.k || ''); stepOpen.has(k) ? stepOpen.delete(k) : stepOpen.add(k); if (stepOpen.has(k)) { ensureEvents(id); if (get(id)) track(id, 'open_step', act.dataset.k); } renderDrawer(); $('#drawer [data-act=step-tog][data-k="' + CSS.escape(act.dataset.k || '') + '"]')?.focus({ preventScroll: true }); break; }
    case 'chat-card': { const it = get(id); if (!it) toast('這張卡已經不在看板上，可以到封存找'); else { S.drawer = null; dockShow.add(id); openDrawer(id, it.status === 'doing' ? 'progress' : 'preview'); } break; }
    case 'rep-tog': { const i = Number(act.dataset.i); S.bul.open = S.bul.open === i ? -1 : i; renderDrawer(); break; }
    case 'fu-filter': S.fu.filter = act.dataset.f; S.fu.list = null; loadFuList(); renderDrawer(); break;
    case 'fu-card': fuOpenCard(id); break;
    case 'fu-done': case 'fu-drop': S.dlg = { type: 'fu', id, to: a === 'fu-done' ? 'done' : 'dropped', note: '' }; renderDlg(); break;
    case 'fu-reopen': fuSet(id, { status: 'open' }, '已改回未完成'); break;
    case 'fu-confirm': { const d = S.dlg; if (d && d.type === 'fu') { S.dlg = null; renderDlg(); fuSet(d.id, Object.assign({ status: d.to }, d.note.trim() ? { close_note: d.note.trim() } : {}), d.to === 'done' ? '標成完成了' : '已取消這件事'); } break; }
    case 'dlg-close': closeDlg(); break;
    case 'msg-send': msgSend(act.dataset.key || ''); break;
    case 'scan': scanNow(act.dataset.lane); break;
  }
});
function openChat() { if (!S.drawer) lastFocus = document.activeElement; S.drawer = { id: '__chat', view: 'chat' }; ensureMsgs(''); loadPresence(); renderDrawer(); syncOverlay(); ($('#chat-input') || $('#drawer .xb'))?.focus({ preventScroll: true }); }
function openFu() { if (!S.drawer) lastFocus = document.activeElement; S.drawer = { id: '__fu', view: 'followups' }; if (S.fu.filter === 'open' && S.fu.open) S.fu.list = S.fu.open; else S.fu.list = null; loadFuList(); loadBul(true); renderDrawer(); syncOverlay(); $('#drawer .xb')?.focus({ preventScroll: true }); }
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { const dk = S.drawer && S.drawer.id;
    if (S.dlg) closeDlg(); else if (S.bidPage) { S.bidPage = null; renderDrawer(); } else if (dk && dockShow.has(dk)) toggleDock(dk); else if (S.drawer) closeDrawer(); else if (S.sheet) closeSheet(); return; }
  if (e.key === 'Tab' && (S.dlg || S.drawer || S.sheet)) {
    const box = S.dlg ? $('#dlg') : S.drawer ? $('#drawer') : $('#sheet');
    const f = [...box.querySelectorAll('button,a[href],input,textarea,select,summary,[tabindex="0"]')].filter(x => !x.disabled && x.offsetParent !== null);
    if (!f.length) return; const first = f[0], last = f[f.length - 1];
    if (!box.contains(document.activeElement)) { first.focus(); e.preventDefault(); }
    else if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
    else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
  }
});
window.addEventListener('popstate', () => {
  if (ignorePop) { ignorePop = false; return; }
  if (S.dlg) { S.dlg = null; renderDlg(); }
  if (S.drawer || S.sheet) { depth = 0; if (S.drawer && S.drawer.id) dockShow.delete(S.drawer.id); S.drawer = null; S.sheet = false; S.bidPage = null; $('#drawer').classList.remove('show'); $('#sheet').classList.remove('show'); syncOverlay(); renderAll(); }
});
// ---------------- 手機左右滑動切分頁（1099 以下；每一個分頁上面都有同功能的按鈕） ----------------
const SW = { mq: matchMedia('(max-width: 1099px)'), rm: matchMedia('(prefers-reduced-motion: reduce)'), on: false, x: 0, y: 0 };
const overlayOpen = () => !!S.drawer || !!S.dlg || S.sheet;
$('#main').addEventListener('touchstart', e => {
  SW.on = false;
  if (!SW.mq.matches || e.touches.length !== 1 || overlayOpen() || S.net === 'auth') return;
  const t = e.touches[0]; if (t.clientX <= 24) return;
  SW.on = true; SW.x = t.clientX; SW.y = t.clientY;
}, { passive: true });
$('#main').addEventListener('touchend', e => {
  if (!SW.on) return; SW.on = false;
  const t = e.changedTouches[0], dx = t.clientX - SW.x, dy = t.clientY - SW.y;
  if (Math.abs(dx) <= 60 || Math.abs(dx) < Math.abs(dy) * 1.5 || overlayOpen() || !SW.mq.matches) return;
  const i = ORDER.indexOf(S.tab), j = i + (dx < 0 ? 1 : -1);
  if (i < 0 || j < 0 || j >= ORDER.length) return;
  goTab(ORDER[j], dx < 0 ? 'l' : 'r');
}, { passive: true });
$('#main').addEventListener('touchcancel', () => { SW.on = false; }, { passive: true });
(WIDE.addEventListener ? WIDE.addEventListener.bind(WIDE, 'change') : WIDE.addListener.bind(WIDE))(() => renderMain());
window.addEventListener('online', () => refresh());
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });

// ---------------- 啟動 ----------------
function pasteKey() {
  const v = window.prompt('貼上完整網址或金鑰（管理員給你的專屬網址）');
  const k = tokenFrom(v) || String(v || '').trim();
  if (k.length >= 20) { saveKey(k); location.reload(); } else if (v) toast('這不像金鑰，請貼完整網址', { bad: true });
}
function startUpdates() {   // 自動換新版：說明卡頁面也要（不然沒金鑰的人永遠停在舊版）
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
    navigator.serviceWorker.ready.then(reg => { if (reg.active) reg.active.postMessage({ keep: APP_V }); kickWaiting(); }).catch(() => {});
  }
  checkVersion();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkVersion(); });
  window.addEventListener('focus', () => checkVersion());
  setInterval(() => checkVersion(), 10 * 60e3);
}
function renderNoKey() {
  ['#fubtn', '#rkbtn', '#holdbtn', '#hot'].forEach(s => { const b = $(s); if (b) b.hidden = true; });
  $('#tabs').hidden = true; $('#notice').hidden = true;
  $('#live').innerHTML = '<i class="dot off"></i>還沒有金鑰';
  $('#main').innerHTML = '<div class="empty"><b>需要你的專屬網址</b><p>請用大器私訊給你的專屬網址打開，或從手機主畫面的『好咖皮條客』打開。在 LINE 裡點開的話，請按右下角用 Safari 或 Chrome 開啟。</p><button class="bp" data-act="paste-key" type="button">貼上金鑰</button></div>';
}
(async function boot() {
  if (!hasKey() && !new URLSearchParams(location.search).has('mock')) { renderNoKey(); startUpdates(); return; }
  api = await createAdapter();
  applySkin(skinCache() || 1);           // 先用這支手機記的外觀畫，避免閃一下；whoami／opp_pref_get 回來再以金鑰設定為準
  loadSnapshot();
  S.net = 'loading'; renderAll();
  unsub = api.subscribe(ping, on => { S.rt = on; renderLive(); }) || (() => {});
  loadWho();
  renderRk();
  await refresh();
  schedulePoll();
  setInterval(tick, 30000);
  setInterval(() => { if (document.querySelector('[data-elapsed]')) tick(); }, 1000);
  startUpdates();
})();
