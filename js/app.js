// 好咖皮條客主程式：狀態、畫面、事件。只透過 adapter.js 取得與寫入資料。版面規格見交接包 DESIGN.md。
import { createAdapter, CONFIG, AdapterError, hasKey, keyTag, tokenFrom, saveKey, safeUrl, RK, SCAN_LANES } from './adapter.js?v81';   // ?v 跟 sw.js 的 CACHE 一起換（GitHub Pages 會快取 10 分鐘，不帶版本號會新舊混搭）
import { esc, H, D, URGENT_DAYS, fmtDate, fmtDay, fmtClock, relTime, fmtLeft, shortLeft, softBreak, splitAmount } from './util.js?v81';

const $ = s => document.querySelector(s);
const LANES = [
  { k: 'tender', n: '政府標案', d: '已公告、公司可投的採購' },
  { k: 'grant', n: '補助徵件', d: '公司名義可申請的補助' },
  { k: 'pitch', n: '企劃提案', d: '品牌與機關合作企劃' },
  { k: 'active', n: '進行中', d: '你已決定要做的案子' },
  { k: 'watch', n: '盯案後續', d: '還在等正式公告' },
];
const LN = Object.fromEntries(LANES.map(b => [b.k, b.n]));
const INBOX_LANES = ['tender', 'grant', 'pitch', 'watch'];
const FALLBACK_LANE = 'pitch';     // 後端沒給 lane 的卡先放企劃提案（見回報「已知問題」）
const HOLD_HOUR = 8;               // 暫存後隔天幾點提醒（後端 opp_stash 同規則）

// ===== 文案集中在這裡 =====
// 提醒：2026-11-16 定案，暫存與追蹤提醒由肉咖在 LINE 公司群組發。
// 其餘（資料夾出事找誰、新案子由誰放進來、全文由誰整理）還沒決定，先寫中性說法，定案後只改這一處。
export const TBD = {
  stashToast: name => '「' + name + '」放進待決區，到期前肉咖會在 LINE 群組提醒',
  remindLine: at => '提醒時間：' + fmtDate(at) + '，肉咖會在 LINE 群組提醒',
  remindPassed: '已到提醒時間，請決定要不要做',
  previewRemind: at => '暫存中，到期前肉咖會在 LINE 群組提醒（' + fmtDate(at) + '）',
  sheetEmpty: '按「暫存」的案子會放在這裡，到期前肉咖會在 LINE 群組提醒。',
  sheetNote: '到期前肉咖會在 LINE 群組提醒；網頁自己不會跳通知。',
  laneEmpty: '有新的案子會自動出現在這裡，不用重新整理。',
  boardEmpty: '有新的案子會自動出現在這裡，不用重新整理。',
  folderFailHelp: '請找管理員處理。這張卡已經記成「要做」，不會不見。',
  progressFailHelp: '請找管理員處理。',
  crawlFailHint: '上面的條件是先整理好的，全文要自己開連結看。',
};
// ===== 其他固定文案 =====
const AUTH_MSG = '金鑰失效，請向管理員重新索取網址';
const TENDER_ADMIN = '政府標案由管理員決定要不要做';   // sql/21：lane = tender 的 opp_build 只給 admin
const OUTCOME = { won: '得標／核定', lost: '未得標', submitted: '已送件結案', withdrawn: '作廢' };   // 結案結果（sql/25 opp_archive 的 kind；看板和封存區同一套字）
// ----- 步驟備註裡的網址 → 按鈕（只收 http(s)，經過 adapter 的 safeUrl） -----
const PAY_STEP = 'pay_approval';   // 等待付款同意（領標付款）
// ----- 已送件：送件之後不再看公告截止日（不顯示「截止已到／時間到」、不亮紅、不算進行中異常），倒數改看下一個內部期限 -----
// 判斷：送件那一步（seal_submit；預設步驟的 seal_and_bid、submit 同義）已完成或略過，或目前步驟的鍵在送件後清單裡。
// 清單之後流程改名，只改這兩行。
const SUBMIT_KEYS = ['seal_submit', 'seal_and_bid', 'submit'];
const POST_SUBMIT_KEYS = ['qualify', 'pitch_prep', 'pitch_present', 'await_opening', 'under_review', 'result'];
// 送件後盯的是「目前這一步」與「下一個里程碑」（v4）。里程碑短名：步驟鍵對得到就用短名，對不到就用步驟名稱。
const MILESTONE = { pitch_prep: '簡報', pitch_present: '簡報', qualify: '資格審查', await_opening: '開標', under_review: '審查結果', result: '結果' };
const milestone = it => MILESTONE[it.progressStageKey] || it.progressStage || '下一步';
const submitStep = it => it.progressSteps && it.progressSteps.find(x => SUBMIT_KEYS.includes(x.key) && (x.status === 'done' || x.status === 'skipped'));
const sentTag = it => { const s = submitStep(it); return '已送件' + (s && s.doneAt ? ' ' + fmtDay(s.doneAt).replace(/（.）$/, '') : ''); };   // 例：已送件 11/10
function submitted(it) {
  if (it.status !== 'doing' || it.progressStatus === 'done') return false;
  if (POST_SUBMIT_KEYS.includes(it.progressStageKey)) return true;
  return !!(it.progressSteps && it.progressSteps.some(x => SUBMIT_KEYS.includes(x.key) && (x.status === 'done' || x.status === 'skipped')));
}
const URL_RE = /https?:\/\/[^\s<>"'，。、；！？）」』】]+/i;
const noteUrl = note => { const m = String(note || '').match(URL_RE); return m ? safeUrl(m[0].replace(/[.,;:!?)\]]+$/, '')) : ''; };
const noteText = note => String(note || '').replace(URL_RE, '').replace(/[：:\s]+$/, '').trim();   // 網址畫成按鈕後，備註只留文字
const isClaude = u => { try { const h = new URL(u).hostname; return h === 'claude.ai' || h.endsWith('.claude.ai'); } catch (e) { return false; } };
const linkLabel = (key, u) => key === PAY_STEP ? '去領標付款' : isClaude(u) ? '進領標對話' : '開啟連結';
const linkBtn = (key, u, cls) => '<a class="btn ' + (cls || 'btn-ghost') + ' step-link" href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">' + linkLabel(key, u) + '</a>';
// ----- 正式連結 links（sql/23）-----
const LINK_DEFAULT = { pool: 'Pool 官方文件與成品', review: '標案內審', pay: '去領標付款', session: '進領標對話', other: '開啟連結' };
const linkText = l => l.label || LINK_DEFAULT[l.kind] || '開啟連結';
const linksOf = it => Array.isArray(it.links) ? it.links : [];
const linkOf = (it, kind) => linksOf(it).find(l => l.kind === kind);
const extLink = (l, cls, text) => '<a class="' + cls + '" href="' + esc(l.url) + '" target="_blank" rel="noopener noreferrer">' + esc(text || linkText(l)) + '</a>';
// 卡片上的「去領標付款」：先看 links 的 pay；沒有才用備援——目前那一步是 pay_approval，網址取該步備註（步驟清單有抓過時），再不然看整張卡的 progress_note
const bidDone = it => !!it && (it.bidState === 'paid' || it.bidState === 'fetched');   // v81：已付款或已領標（含 Pool 偵測）
function payUrl(it) {
  if (it.status !== 'doing' || bidDone(it)) return '';   // v81：付過、領過就不再叫人去付款（D 審 v80）
  const pay = linkOf(it, 'pay'); if (pay) return pay.url;
  if (it.progressStageKey !== PAY_STEP) return '';
  const st = it.progressSteps && it.progressSteps.find(x => x.key === PAY_STEP);
  return noteUrl(st && st.note) || noteUrl(it.progressNote);
}

const IC = {
  trash: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/></svg>',
  bm: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12v18l-6-4-6 4z"/></svg>',
  dive: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>',
  inbox: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 13l2-8h12l2 8M4 13v6h16v-6M4 13h5l1 2h4l1-2h5"/></svg>',
  warn: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4l9 16H3zM12 10v5M12 17.5v.5"/></svg>',
};

// ---------------- 狀態 ----------------
const qs = new URLSearchParams(location.search);
const S = {
  items: new Map(),
  net: 'loading',      // loading | ok | offline | auth
  hadData: false,      // 畫面上是不是已經有資料可看（快照或網路）
  slow: false, lastOk: null, rt: false, firstNet: false,
  caps: null,          // opp_whoami 的 caps；null＝還不知道，寫入按鈕先不畫
  who: null,
  tab: LANES.some(l => l.k === qs.get('tab')) ? qs.get('tab') : 'tender',
  sheet: false, drawer: null,   // drawer = {id, view:'preview'|'full'|'progress'}
  detail: new Map(),   // id → {busy, timedOut, t0}
  prog: new Map(),     // id → {busy, at}：進度步驟抓過的版本（progressUpdatedAt）
  textOpen: new Set(), attOpen: new Set(), fresh: new Set(),
  fu: { open: null, list: null, filter: 'open', busy: false, err: false, byItem: new Map(), ticket: 0 },
  bul: { d: null, err: false, sig: '', at: 0, busy: false },   // v81：追蹤公告的每日報告（sql/37）   // 追蹤事項（v7）：open＝頂列數字用，list＝抽屜目前篩選
  scan: {}, scanBusy: new Set(),   // 立即掃描：三籃最新狀態
  arch: { list: null, q: '', year: '', busy: false }, archMap: new Map(), dlg: null,   // 封存區、結案與徹底刪除的確認框
  msgs: new Map(), msgBusy: new Set(), pend: new Map(), draft: new Map(), events: new Map(), evBusy: new Set(),
  bidPage: null, bidForm: { amount: '', receipt: '', note: '' }, bidSumOpen: new Set(), mine: false, presence: null, presOpen: new Set(), presOff: false,   // v8   // 跟肉咖說：key＝卡片 id（不綁案子是 ''）   // attOpen：附件清單展開中的卡（重畫時保留）
};
let api, lastFocus = null, depth = 0, ignorePop = false;
const locks = new Set(), mutDone = {};
let OFF = 0;                                   // 伺服器時間與本機時間的差，倒數用校正後的時間
const tnow = () => Date.now() + OFF;
const can = k => !!(S.caps && S.caps[k]);      // 依 opp_whoami 決定畫不畫按鈕；viewer 只有 read
// v8：「我負責的步驟」——步驟 owner 照 sql/32 的規則比對 whoami 的 aliases（多人用 、，,／/;；&＋+ 分隔，不分大小寫、去掉空白）
const normName = x => String(x || '').replace(/[ \t\n\v\f\r]/g, '').toLowerCase();   // v81：跟 sql/32 一樣只去半形空白類，全形空白不算（D 複審 v80）
const myNames = () => new Set(((S.who && S.who.aliases && S.who.aliases.length ? S.who.aliases : S.who && S.who.role ? [S.who.role] : [])).map(normName).filter(Boolean));
const ownerIsMe = s => { const me = myNames(); return !!me.size && String(s.ownerRaw || '').split(/[、，,／/;；&＋+]/).some(x => me.has(normName(x))); };
const stepOpenNow = s => s.status === 'current' || s.status === 'blocked';   // 等你確認：只算目前這一步（或卡住的那步），之後的步驟還輪不到
const mineSteps = it => (it.progressSteps || []).filter(s => stepOpenNow(s) && ownerIsMe(s));
const bidManaged = (s, it) => !!s && (s.key === PAY_STEP || s.key === 'bid_fetch') && bidDone(it);   // v81：後端會回 bid_managed（D 複審 v80）
const canMarkStep = (s, it) => it && it.status === 'doing' && it.progressStatus !== 'done' && !bidManaged(s, it) && (can('admin') || can('progress') || (can('act') && ownerIsMe(s)));
const trackLabel = l => String(l || '').replace(/\S*:\/\/\S*|www\.\S*/gi, '').trim().slice(0, 60) || '檔案';
function track(id, action, stepKey, label) {   // sql/34：先送、不等回應，失敗也不擋開檔
  if (!api || !api.track || !id) return;
  const d = {}; if (stepKey) d.step_key = stepKey; if (label) d.label = trackLabel(label);
  try { Promise.resolve(api.track(id, action, Object.keys(d).length ? d : null)).catch(() => {}); } catch (e) {}
}
const canBuild = it => can('act') && (it.lane !== 'tender' || can('admin') || can('build_tender'));   // 政府標案的「要做」：admin 或 caps.build_tender（sql/21、28）；舊後端沒回 build_tender 就當 false

const items = () => [...S.items.values()];
const get = id => S.items.get(id);

// ---------------- 籃子推導 ----------------
const archived = it => it.status === 'doing' && it.progressStatus === 'done' && it.progressArchiveAt && it.progressArchiveAt <= tnow();
function laneOf(it) {
  if (it.status === 'doing') return archived(it) ? null : 'active';
  if (it.status !== 'new') return null;
  return INBOX_LANES.includes(it.lane) ? it.lane : FALLBACK_LANE;
}
const homeLane = it => INBOX_LANES.includes(it.lane) ? it.lane : FALLBACK_LANE;   // 籃子徽章用（救回或暫存時回得去的籃）

// ---------------- 倒數（只做顯示；真正收走看資料庫的 status 與 expire_at） ----------------
function target(it) {
  if (it.status === 'doing') {
    if (it.progressStatus === 'done' && it.progressArchiveAt) return { kind: 'arch', at: it.progressArchiveAt };
    if (submitted(it)) return it.progressDueAt ? { kind: 'due', at: it.progressDueAt } : { kind: 'tbd', at: Infinity };   // 送件後：盯下一個里程碑（目前步驟的期限）
    return it.deadline ? { kind: 'dl', at: it.deadline } : { kind: 'none', at: Infinity };   // 進行中不會被收走，只看公告截止
  }
  if (it.deadline && (!it.expiresAt || it.deadline <= it.expiresAt)) return { kind: 'dl', at: it.deadline };
  if (it.expiresAt) return { kind: 'ttl', at: it.expiresAt };
  return { kind: 'none', at: Infinity };
}
const vanishAt = it => target(it).at;
function lvOf(it) {
  const t = target(it), m = t.at - tnow();
  if (t.kind === 'dl') return m < URGENT_DAYS * D ? 'hot' : m < 7 * D ? 'warm' : 'calm';   // 紅色只給真的截止日
  if (t.kind === 'due') return m < URGENT_DAYS * D ? 'hot' : m < 7 * D ? 'warm' : 'calm';   // 送件後的里程碑：照截止日的顏色規則，4 天內紅色
  if (t.kind === 'tbd') return 'warm';                                                       // 日期未定：暖色提醒
  if (t.kind === 'ttl') return m < D ? 'warm' : 'calm';
  return 'calm';
}
const approx = it => !!it.deadlineApprox && !!it.deadline;   // finder 只知道大概日期（deadline_approx = true）
const APPROX_NOTE = '（時間以公告為準）';
function cdShort(it) {
  const t = target(it), m = t.at - tnow();
  if (t.kind === 'none') return '<span class="nodl">沒寫截止日</span>';
  if (t.kind === 'tbd') return '<span class="nodl tbd">' + esc(milestone(it)) + '日期未定</span>';
  if (t.kind === 'due') return '<b>' + (m <= 0 ? '已逾期' : shortLeft(m)) + '</b> ' + esc(milestone(it));
  if (t.kind === 'dl') return '<b>' + (m <= 0 ? '時間到' : (approx(it) ? '約 ' : '') + shortLeft(m)) + '</b>' + (m <= 0 ? '' : ' 截止');
  if (t.kind === 'arch') return '<b>' + (m <= 0 ? '即將' : shortLeft(m)) + '</b> ' + (m <= 0 ? '撤下' : '後撤下');
  return '<b>' + (m <= 0 ? '即將' : shortLeft(m)) + '</b> ' + (m <= 0 ? '收走' : '後收走');
}
function cdFull(it) {
  const t = target(it), m = t.at - tnow();
  if (t.kind === 'none') return '沒寫';
  if (t.kind === 'tbd') return '日期未定';
  if (m <= 0) return t.kind === 'dl' ? '時間到' : t.kind === 'due' ? '已逾期' : t.kind === 'arch' ? '即將撤下' : '即將收走';
  return (t.kind === 'dl' && approx(it) ? '約 ' : '') + fmtLeft(m);
}
function cdLine(it) {            // 待決區用：「剩 6 天 5 小時 截止」
  const t = target(it), m = t.at - tnow();
  if (t.kind === 'none') return '沒寫截止日';
  if (t.kind === 'dl') return m <= 0 ? '截止時間到了' : '剩 <b>' + (approx(it) ? '約 ' : '') + fmtLeft(m) + '</b> 截止' + (approx(it) ? APPROX_NOTE : '');
  return m <= 0 ? '即將收走' : '<b>' + fmtLeft(m) + '</b> 後收走';
}
function tick() {
  document.querySelectorAll('[data-cd]').forEach(e => {
    const it = get(e.dataset.cd); if (!it) return;
    const mode = e.dataset.mode;
    if (mode === 'short') e.innerHTML = cdShort(it); else if (mode === 'line') e.innerHTML = cdLine(it); else e.textContent = cdFull(it);
    e.dataset.lvl = lvOf(it);
    const card = e.closest('.card'); if (card) card.dataset.lvl = lvOf(it);
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

// ---------------- 進度狀態（畫面用） ----------------
// 後端 progress_status：none｜queued｜active｜blocked｜overdue｜done｜failed。
// 「截止已到」與「即將逾期」由前端用公告 deadline 與 progress_due_at 判斷（DESIGN.md 第四節），文案和「這步逾期」分開。
function pv(it) {
  const ps = it.progressStatus, now = tnow();
  const dlPassed = it.deadline && it.deadline <= now;
  if (ps === 'failed') return { k: 'failed', badge: it.folderStatus === 'failed' ? '資料夾沒建成' : '流程失敗', cls: 'pst-hot', bar: 'hot', alert: 'stuck' };
  if (ps === 'done') return { k: 'done', badge: '已完成', cls: 'pst-done', bar: 'ok' };
  if (ps === 'blocked') return { k: 'blocked', badge: '卡住', cls: 'pst-block', bar: 'warm', alert: 'stuck' };
  if (submitted(it)) {   // 送件後：不看公告截止；盯目前步驟的期限（4 天內或逾期算異常，日期未定不算）
    const d = it.progressDueAt;
    if (d && d <= now) return { k: 'sent', badge: '這步逾期', cls: 'pst-hot', bar: 'hot', alert: 'late', sent: true };
    if (d && d - now < URGENT_DAYS * D) return { k: 'sent', badge: '即將到期', cls: 'pst-hot', bar: 'hot', alert: 'late', sent: true };
    return { k: 'sent', badge: '進行中', cls: 'pst-on', bar: 'calm', sent: true };
  }
  if (ps === 'overdue') return { k: 'overdue', badge: '這步逾期', cls: 'pst-hot', bar: 'hot', alert: 'late' };
  if (dlPassed) return { k: 'dlpass', badge: '截止已到', cls: 'pst-hot', bar: 'hot', alert: 'late' };
  if (ps === 'queued') return { k: 'queued', badge: '建立工作區中', cls: 'pst-on', bar: 'calm' };
  const soon = (it.progressDueAt && it.progressDueAt - now < D) || (it.deadline && it.deadline - now < URGENT_DAYS * D);
  if (soon) return { k: 'soon', badge: '即將逾期', cls: 'pst-hot', bar: 'hot', alert: 'late' };
  return { k: 'active', badge: '進行中', cls: 'pst-on', bar: 'calm' };
}
const folderWait = it => it.status === 'doing' && ['none', 'queued', 'building'].includes(it.folderStatus);
const folderWaitText = it => it.folderStatus === 'building' ? '正在建立工作資料夾' : '已排隊，等 Mac 接工作';
const fracText = it => it.progressStepTotal ? '第 ' + (it.progressStepN || 1) + '／' + it.progressStepTotal + ' 步' : '';
const pct = it => Math.max(0, Math.min(100, it.progressPct == null ? 0 : it.progressPct));
const byLine = (at, who) => at ? '<span data-rel="' + at + '">' + relTime(at, tnow()) + '</span>由<b> ' + esc(who || '不明') + ' </b>更新' : '';

// ---------------- 小積木 ----------------
const chip = it => { const l = homeLane(it); return '<span class="chip b-' + l + '"><i></i>' + LN[l] + '</span>'; };
// F 的盯案後續：正式公告上看板時，why 開頭會寫明兩張卡接上了，在標籤列標出來
const linkTag = it => /^（之前在盯案後續/.test(it.why) ? '<span class="link-badge">之前在盯案後續</span>' : /^正式公告已上看板/.test(it.why) ? '<span class="link-badge">正式公告已上看板</span>' : '';
const demo = it => linkTag(it) + (it.isDemo ? '<span class="demo-badge">示意資料</span>' : '');
const demo1 = it => (mineSteps(it).length ? '<span class="mine-badge">等你確認</span>' : '') || linkTag(it) || (it.isDemo ? '<span class="demo-badge">示意資料</span>' : '');   // 等你確認優先（徽章最多 2 個）   // 進行中卡已有狀態徽章：再多一個就好（徽章最多 2 個）
const orgLine = it => it.org && !it.title.includes(it.org) ? '<p class="dt-org">' + esc(it.org) + '</p>' : '';
const cardOrg = it => it.org && !it.title.includes(it.org) ? '<p class="org">' + esc(it.org) + '</p>' : '';
function amt(it) {
  const lab = it.amountLabel ? '<em>' + esc(it.amountLabel) + '</em>' : '';
  const a = splitAmount(it.amountDisplay);
  if (a.num) {
    const long = a.num.length > 7 ? ' long' : '';
    return '<span class="amt' + long + '">' + lab + (it.currency ? '<i>' + esc(it.currency) + '</i>' : '') + '<b>' + esc(a.num) + '</b>' + (a.unit ? '<u>' + esc(a.unit) + '</u>' : '') + '</span>';
  }
  const t = a.text || '沒寫金額';
  return '<span class="amt noamt">' + (it.amountLabel && t.includes(it.amountLabel) ? '' : lab) + '<b>' + esc(t) + '</b></span>';
}
const amtText = it => { const a = splitAmount(it.amountDisplay); return a.num ? (it.amountLabel ? it.amountLabel + ' ' : '') + (it.currency || '') + a.num + (a.unit ? ' ' + a.unit : '') : (it.amountLabel ? it.amountLabel + ' ' : '') + (a.text || '沒寫金額'); };
const method = it => it.tenderMethod ? '<span class="method">' + esc(it.tenderMethod) + '</span>' : '';
const link = it => it.sourceUrl ? '<a href="' + esc(it.sourceUrl) + '" target="_blank" rel="noopener noreferrer">' + (it.sourceSite ? '開啟原始連結（' + esc(it.sourceSite) + '）' : '開啟原始連結') + '</a>' : '';
const para = s => esc(s).split(/\n{2,}/).map(p => p.replace(/\n/g, '<br>')).join('<br><br>');

// ---------------- 畫面：頂端 ----------------
function renderLive() {
  const el = $('#live'); let dot = '', txt = '';
  const mock = api && api.mode === 'mock';
  if (S.net === 'loading') { dot = 'idle'; txt = S.hadData ? '更新中，先顯示上次的內容' : '載入中'; }
  else if (S.net === 'offline') { dot = 'off'; txt = S.lastOk ? '離線中，顯示 ' + fmtClock(S.lastOk) + ' 的內容' : '連不上伺服器'; }
  else if (S.net === 'auth') { dot = 'off'; txt = '金鑰失效'; }
  else { dot = S.rt ? '' : 'idle'; txt = '<span class="lv-p">' + (mock ? '示範資料，' : S.rt ? '即時更新，' : '每 15 秒更新，') + '</span>' + fmtClock(S.lastOk) + ' 更新'; }   // v75：手機收起前綴，留時間
  if (S.caps && !can('act') && S.net !== 'auth') txt += '（唯讀）';
  el.innerHTML = '<span class="dot ' + dot + '"></span><span>' + txt + '</span>';
}
function renderSummary() {
  const now = tnow();
  const live = items().filter(i => i.status === 'new').length;
  const act = activeItems().length;
  const hot = items().filter(i => (i.status === 'new' || i.status === 'snoozed') && i.deadline && i.deadline > now && i.deadline - now < URGENT_DAYS * D).length;
  // v73（Borry「上面黃色的地方的資訊就合併到那一區去 最緊急的就一樣小字在上面提醒」）：右上角多一行最緊急的一件，點了打開那張卡
  const u = S.hadData ? urgentOne() : null; void hot;
  // v75：「待決 N」接在筆數後面；暫存 0 件但有剛完成或剛收走的卡時顯示「待決 0」，讓人進得去；什麼都沒有才不顯示
  const hn = holdItems().length, hold = S.net !== 'auth' && (hn || doneItems().length || goneItems().length);
  $('#sum').innerHTML = S.hadData ? '<b>' + live + '</b> 筆待看' + (act ? '<span class="sep"> · </span><b>' + act + '</b> 筆進行中' : '') +
    (hold ? '<span class="sep sum-hold-sep"> · </span><button class="sum-hold" type="button" data-act="open-hold" aria-haspopup="dialog" aria-label="待決區，' + hn + ' 筆">待決 <b>' + hn + '</b></button>' : '') : '';
  // v74：急件小字獨立一列、整列寬、單行截斷（v73 放在 #sum 裡，真資料一長就把標題擠成直排）
  const hr = $('#hot');
  if (hr) { hr.innerHTML = u ? '<button class="hot-line" data-act="open-hot" data-id="' + esc(u.it.id) + '" type="button" title="' + esc(u.txt) + '">⚠ ' + esc(u.txt) + '</button>' : ''; hr.hidden = !u; }
}
// 最緊急的一件：只從進行中挑（Borry「截止日要放的是進行中的！」）——卡住、逾期、4 天內到期，取下一個關鍵時間最早的（卡住當成現在）；進行中沒有急件就不顯示
function urgentOne() {   // v74（Borry「截止日要放的是進行中的！」）：進行中、還沒結案的卡，取還沒到的下一個關鍵時間最近、而且 4 天內的那件；卡住原因不放這裡
  const now = tnow();
  const c = activeItems().filter(it => it.progressStatus !== 'done').map(it => ({ it, at: keyTime(it) })).filter(x => x.at && x.at > now && x.at - now < URGENT_DAYS * D).sort((a, b) => a.at - b.at);
  if (!c.length) return null;
  const { it, at } = c[0];
  const lab = !submitted(it) && it.deadline === at ? '截止' : milestone(it);
  const n = nm(it), sn = n.length > 8 ? n.slice(0, 8) + '…' : n;
  return { it, txt: '剩 ' + shortLeft(at - now) + '｜' + sn + ' ' + fmtDay(at) + hm(at) + ' ' + lab };
}
function dayClock(t) {   // 今天 10:00／明天 10:00／11/20 10:00（台北時間）
  const dd = Math.floor((t + 8 * H) / D) - Math.floor((tnow() + 8 * H) / D);
  return (dd === 0 ? '今天' : dd === 1 ? '明天' : fmtDay(t).replace(/（.）/, '')) + ' ' + hm(t);
}
const hasHot = () => activeItems().some(it => it.progressStatus !== 'done' && (pv(it).alert || lvOf(it) === 'hot'));
function anomalyText() {
  const act = activeItems(), a = act.map(pv);
  const stuck = a.filter(p => p.alert === 'stuck').length, late = a.filter(p => p.alert === 'late').length;
  const parts = [];
  if (stuck) parts.push(stuck + ' 筆卡住');
  if (late) parts.push(late + ' 筆即將逾期或已逾期');
  // 送件後的卡：目前步驟 4 天內到期、逾期或卡住，點名寫出來，例如「恆春觀光推廣影片：簡報 2 天後」（日期未定的不算）
  const named = act.filter((it, i) => submitted(it) && a[i].alert).slice(0, 2).map(it => {
    const d = it.progressDueAt, m = d ? d - tnow() : 0;
    const when = pv(it).k === 'blocked' ? '卡住' : !d ? '' : m <= 0 ? '已逾期' : shortLeft(m) + '後';
    return nm(it) + '：' + milestone(it) + (when ? ' ' + when : '');
  });
  // 先寫進行中總數（送件後的卡也算），再寫其中幾筆異常，避免把「4 筆卡住」看成「只有 4 筆進行中」
  return parts.length ? '進行中 ' + act.length + ' 筆，其中 ' + parts.join('、') + '。' + (named.length ? named.join('；') + '。' : '') : '';
}
// 通知列一次只放一則：金鑰失效＞離線＞載入過慢＞進行中異常（DESIGN.md 第一節）
function renderNotice() {
  const el = $('#notice'); let html = '', cls = 'notice';
  const mockNoKey = api && api.mode === 'mock' && !hasKey();
  const anom = S.hadData ? anomalyText() : '';
  if (S.net === 'auth') {
    cls += ' bad';
    html = '<span class="txt">' + AUTH_MSG + '。</span><button type="button" data-act="paste-key">貼上金鑰</button>';
  } else if (S.net === 'offline') {
    cls += ' off';
    html = '<span class="txt">' + (S.lastOk ? '連不到伺服器，畫面是 ' + fmtClock(S.lastOk) + ' 的內容。恢復連線後會自動更新。' : '連不到伺服器，也沒有上次的內容可以顯示。') + '</span><button type="button" data-act="retry">重試</button>';
  } else if (S.net === 'loading' && S.slow) {
    html = '<span class="spin"></span><span class="txt">' + (S.hadData ? '連線比較慢，先顯示上次的內容，等一下會自動更新。' : '載入比較久，網路可能很慢，請稍等。') + '</span>';
  } else if (mockNoKey) {   // v73：進行中異常的黃色通知列拿掉，改成右上角小字＋進行中標籤變黃
    void anom;
    cls += ' off';
    html = '<span class="txt">沒有金鑰，現在看到的是示範資料。</span><button type="button" data-act="paste-key">貼上金鑰</button>';
  } else if (S.net === 'ok' && S.slow) {
    html = '<span class="spin"></span><span class="txt">正在更新…</span>';
  }
  el.className = cls; el.hidden = !html; el.innerHTML = html;
}

// ---------------- 畫面：看板 ----------------
function sortList(l) { return l.sort((a, b) => vanishAt(a) - vanishAt(b) || (b.foundAt || 0) - (a.foundAt || 0)); }
const inbox = () => items().filter(i => i.status === 'new');
const activeItems = () => sortActive(items().filter(i => laneOf(i) === 'active'));   // 通知列點名也照急迫順序
// 進行中排序：先卡住與逾期，再依進度最後更新新到舊
// 進行中排序（v7，Borry「最急的要最上面」）：每張卡算「下一個關鍵時間」＝還沒送件的公告截止、目前步驟期限（送件後就是下一個里程碑），取比較早的；
// 由近到遠，同時間卡住的在前；沒有任何日期的放後面；已結案的放最下面
const keyTime = it => { const c = []; if (!submitted(it) && it.deadline) c.push(it.deadline); if (it.progressDueAt) c.push(it.progressDueAt); return c.length ? Math.min(...c) : null; };
const isClosed = it => it.progressStatus === 'done' ? 1 : 0;
const isStuck = it => (pv(it).k === 'blocked' || it.progressStatus === 'blocked') ? 1 : 0;
const sortActive = l => l.sort((a, b) => { const ka = keyTime(a), kb = keyTime(b);
  return isClosed(a) - isClosed(b) || (ka == null) - (kb == null) || (ka || 0) - (kb || 0) || isStuck(b) - isStuck(a) || (b.progressUpdatedAt || b.decidedAt || 0) - (a.progressUpdatedAt || a.decidedAt || 0); });

function card(it) {
  const lv = lvOf(it), id = esc(it.id), t = esc(nm(it));
  const btns = can('act')
    ? '<div class="ca"><button class="del" data-act="del" data-id="' + id + '" type="button" aria-label="刪掉「' + t + '」">' + IC.trash + '<span>刪掉</span></button>' +
      '<button data-act="hold" data-id="' + id + '" type="button" aria-label="暫存「' + t + '」">' + IC.bm + '<span>暫存</span></button>' +
      '<button class="go" data-act="dive" data-id="' + id + '" type="button" aria-label="深入了解「' + t + '」">' + IC.dive + '<span>深入了解</span></button></div>'
    : '<div class="ca"><button class="go go-wide" data-act="dive" data-id="' + id + '" type="button" aria-label="深入了解「' + t + '」">' + IC.dive + '<span>深入了解</span></button></div>';
  return '<article class="card b-' + homeLane(it) + (S.fresh.has(it.id) ? ' fresh' : '') + '" data-id="' + id + '" data-lvl="' + lv + '" tabindex="0" aria-label="' + esc(it.title) + '">' +
    '<div class="c1"><span class="tm" data-cd="' + id + '" data-mode="short" data-lvl="' + lv + '">' + cdShort(it) + '</span>' + demo(it) + '</div>' +
    cardOrg(it) + '<h3 class="sb">' + softBreak(it.title) + '</h3>' + bidLine(it) + btns + '</article>';   // v73：金額、招標方式收進抽屜（Borry「畫面簡潔一點點」）
}
function acard(it) {
  const lv = lvOf(it), id = esc(it.id), p = pv(it);
  let meta;
  if (p.k === 'blocked') meta = '<p class="meta-line block-reason">卡住：' + esc(it.progressBlocker || '原因沒寫') + '</p>';
  else if (p.k === 'failed') meta = '<p class="meta-line fail-reason">' + (it.folderStatus === 'failed' ? '資料夾沒建成：' + esc(it.folderError || '原因不明') : '失敗：' + esc(it.progressBlocker || it.progressNote || '原因不明')) + '</p>';
  else if (p.k === 'overdue') meta = '<p class="meta-line fail-reason">' + esc(it.progressBlocker || '這步已過內部期限') + '</p>';
  else if (p.k === 'dlpass') meta = '<p class="meta-line fail-reason">公告截止時間已到，請確認是否已送出</p>';
  else if (folderWait(it)) meta = '<p class="meta-line"><span class="spin"></span>' + folderWaitText(it) + '</p>';
  else if (p.k === 'done') meta = '<p class="meta-line">' + (OUTCOME[it.progressOutcome] ? '已結案：<b>' + OUTCOME[it.progressOutcome] + '</b>' : '已完成') + (it.progressUpdatedAt ? '，<span data-rel="' + it.progressUpdatedAt + '">' + relTime(it.progressUpdatedAt, tnow()) + '</span>' : '') + '</p>';
  else meta = '';   // v73：誰更新、何時更新收進抽屜
  const sent = submitted(it);
  // 送件後（v4）：左上大字是目前步驟、旁邊狀態徽章；下一行倒數盯下一個里程碑，「已送件 11/10」縮成小標籤
  const top = sent
    ? '<div class="c1 sent-top"><span class="step-big sb">' + softBreak(it.progressStage || '下一步') + '</span><span class="pst ' + p.cls + '">' + p.badge + '</span>' + demo1(it) + '</div>' +
      '<p class="stage sent-row"><span class="tm" data-cd="' + id + '" data-mode="short" data-lvl="' + lv + '">' + cdShort(it) + '</span><span class="sent-tag">' + esc(sentTag(it)) + '</span></p>'
    : '<div class="c1"><span class="tm" data-cd="' + id + '" data-mode="short" data-lvl="' + lv + '">' + cdShort(it) + '</span>' + demo1(it) + '</div>' +
      '<p class="stage"><b>' + esc(it.progressStage || '建立工作區') + '</b><span class="pst ' + p.cls + '">' + p.badge + '</span></p>';
  return '<article class="card b-active' + (S.fresh.has(it.id) ? ' fresh' : '') + '" data-id="' + id + '" data-pst="' + p.bar + '" data-lvl="' + lv + '" tabindex="0" aria-label="' + esc(it.title) + '，' + p.badge + '">' + top +
    cardOrg(it) + '<h3 class="sb">' + softBreak(it.title) + '</h3>' + bidLine(it) +
    '<div class="prog-row"><div class="pbar" aria-hidden="true"><i style="width:' + pct(it) + '%"></i></div><span class="frac">' + fracText(it) + '</span></div>' +
    meta + '<div class="ca">' + (payUrl(it) ? '<a class="go go-wide pay-link" href="' + esc(payUrl(it)) + '" target="_blank" rel="noopener noreferrer" aria-label="「' + esc(nm(it)) + '」去領標付款">去領標付款</a>' : '') +
    '<button class="go go-wide' + (payUrl(it) ? ' alt' : '') + '" data-act="open-progress" data-id="' + id + '" type="button" aria-label="看「' + esc(nm(it)) + '」的進度">看進度</button></div>' +
    cardLinks(it) + '</article>';
}
// 進行中卡片下方：Pool、內審兩顆小連結（手機上一點就開該案的 Drive 資料夾）
function cardLinks(it) {
  const ls = ['pool', 'review'].map(k => linkOf(it, k)).filter(Boolean);
  return ls.length ? '<div class="card-links">' + ls.map(l => extLink(l, 'mini-link')).join('') + '</div>' : '';
}
const skel = () => '<div class="card skel"><div class="sk"></div><div class="sk"></div><div class="sk"></div></div>';

function renderBoard() {
  const lanes = $('#lanes'), board = $('#board');
  const keep = {}; lanes.querySelectorAll('.lane').forEach(l => { keep[l.dataset.l] = l.querySelector('.lbody').scrollTop; });
  const left = lanes.scrollLeft;
  let msg = $('#boardmsg'); if (!msg) { msg = document.createElement('div'); msg.id = 'boardmsg'; msg.className = 'board-msg'; msg.hidden = true; board.appendChild(msg); }
  const all = inbox(), act = activeItems(), loadingEmpty = !S.hadData && S.net === 'loading';
  const holdN = holdItems().length;
  // 整個面板的三種特殊狀態。四個待看籃都空但還有進行中時，照常畫看板，讓進度看得到。
  let m = null;
  if (S.net === 'auth') m = { ic: IC.warn, t: '金鑰失效', p: '請向管理員重新索取網址。', btn: '<button class="btn btn-primary" data-act="paste-key" type="button">貼上金鑰</button>' };
  else if (S.net === 'offline' && !S.hadData) m = { ic: IC.warn, t: '載入失敗', p: '連不到伺服器，也沒有上次的內容可以顯示。請確認網路後再試。', btn: '<button class="btn btn-primary" data-act="retry" type="button">再試一次</button>' };
  else if (S.hadData && !all.length && !act.length && S.net !== 'loading') m = { ic: IC.inbox, t: '現在沒有新的案子', p: holdN ? '待決區還有 ' + holdN + ' 筆等你決定。' + TBD.boardEmpty : TBD.boardEmpty, btn: holdN ? '<button class="btn btn-ghost" data-act="open-hold" type="button">看待決區</button>' : '' };
  msg.hidden = !m; lanes.hidden = !!m;
  if (m) msg.innerHTML = m.ic + '<h2>' + m.t + '</h2><p>' + m.p + '</p>' + m.btn;

  const mineN = act.filter(i => mineSteps(i).length).length;
  if (S.mine && !mineN) S.mine = false;
  const listOf = k => k === 'active' ? sortActive(act.slice()).filter(i => !S.mine || mineSteps(i).length) : sortList(all.filter(i => laneOf(i) === k));
  const hot = !loadingEmpty && hasHot();
  $('#tabs').innerHTML = LANES.map(b => '<button class="tab b-' + b.k + (b.k === 'active' && hot ? ' hot' : '') + '" type="button" role="tab" data-tab="' + b.k + '" aria-selected="' + (S.tab === b.k) + '"' + (b.k === 'active' && hot ? ' aria-label="進行中，有急件"' : '') + '>' +
    (loadingEmpty ? '<b class="sk-n sk"></b>' : '<b>' + listOf(b.k).length + '</b>') + b.n + '</button>').join('') +
    '<button class="tab tab-arch" type="button" data-act="open-arch" aria-haspopup="dialog">封存</button>';   // v73（Borry「封存可以放到盯案後續的右邊 我們往左滑才看得到」）
  $('#tabs').hidden = !!m;
  if (!m) lanes.innerHTML = LANES.map(b => {
    const list = listOf(b.k);
    const zero = b.k === 'active'
      ? '<div class="zero">' + IC.inbox + '<b>目前沒有進行中的案子</b><span>在完整內容按「要做」之後，進度會出現在這一籃。</span></div>'
      : '<div class="zero">' + IC.inbox + '<b>這一籃目前是空的</b><span>' + TBD.laneEmpty + '</span></div>';
    const body = loadingEmpty ? skel() + skel() + skel() : list.length ? list.map(b.k === 'active' ? acard : card).join('') : zero;
    return '<section class="lane b-' + b.k + (S.tab === b.k ? ' cur' : '') + '" data-l="' + b.k + '"><div class="lh"><h2><i class="ld"></i>' + b.n + (loadingEmpty ? '' : '<em>' + list.length + '</em>') + '</h2>' + scanBox(b.k) + (b.k === 'active' && (mineN || S.mine) ? '<div class="mine-row"><button class="mine-tog" data-act="mine-tog" type="button" aria-pressed="' + !!S.mine + '">' + (S.mine ? '看全部進行中' : '只看我的待辦（' + mineN + '）') + '</button></div>' : '') + '<p class="lh-d">' + b.d + '</p></div><div class="lbody">' + body + '</div></section>';
  }).join('');
  lanes.querySelectorAll('.lane').forEach(l => { const b = l.querySelector('.lbody'); if (keep[l.dataset.l]) b.scrollTop = keep[l.dataset.l]; });
  lanes.scrollLeft = left;
  S.fresh.clear();
  edgeFade();
}
function edgeFade() {
  const l = $('#lanes'), b = $('#board'); if (!l) return;
  b.classList.toggle('sl', l.scrollLeft > 8);
  b.classList.toggle('sr', l.scrollWidth - l.clientWidth - l.scrollLeft > 8);
}

// ---------------- 畫面：待決區（暫存中、剛完成的、剛收走的；不放進行中） ----------------
const holdItems = () => sortList(items().filter(i => i.status === 'snoozed'));
const doneItems = () => items().filter(archived).sort((a, b) => (b.progressArchiveAt || 0) - (a.progressArchiveAt || 0));
const goneItems = () => items().filter(i => i.status === 'dropped' || i.status === 'expired').sort((a, b) => (b.decidedAt || 0) - (a.decidedAt || 0)).slice(0, 50);

function pcard(it) {
  const lv = lvOf(it), id = esc(it.id);
  const rem = it.snoozeUntil;
  const remTxt = rem ? (rem > tnow() ? TBD.remindLine(rem) : TBD.remindPassed) : '';
  const acts = can('act')
    ? '<div class="pa"><button class="pd" data-act="del" data-id="' + id + '" type="button">刪掉</button><button class="pg" data-act="dive" data-id="' + id + '" type="button">深入了解</button><button class="pu" data-act="unstash" data-id="' + id + '" type="button">取消暫存</button></div>'
    : '<div class="pa"><button class="pg" data-act="dive" data-id="' + id + '" type="button">深入了解</button></div>';
  return '<article class="pc" data-id="' + id + '" data-lvl="' + lv + '">' + '<div class="dt-tags" style="margin:0">' + chip(it) + demo(it) + '</div>' +
    '<h3 class="sb">' + softBreak(it.title) + '</h3><p class="st">' + (remTxt ? remTxt + '<br>' : '') + '<span data-cd="' + id + '" data-mode="line" data-lvl="' + lv + '">' + cdLine(it) + '</span></p>' + acts + '</article>';
}
function fcard(it) {
  const id = esc(it.id);
  return '<article class="pc done" data-id="' + id + '"><div class="dt-tags" style="margin:0">' + chip(it) + '<span class="pst pst-done">已完成</span>' + demo(it) + '</div><h3 class="sb">' + softBreak(it.title) + '</h3>' +
    '<p class="st">' + (OUTCOME[it.progressOutcome] ? OUTCOME[it.progressOutcome] + '，' : '') + (it.progressArchiveAt ? fmtDay(it.progressArchiveAt) + '從看板撤下' : '已從看板撤下') + '。工作資料夾仍保留。</p>' +
    '<div class="pa"><button class="pg" data-act="open-progress" data-id="' + id + '" type="button">看進度</button></div></article>';
}
const goneWhy = it => it.dropReason === 'deleted' ? '你刪掉的' : it.dropReason === 'skipped' ? '你決定不做的' : '時間到，自動收走';
function gcard(it) {
  const id = esc(it.id);
  const dead = it.deadline && it.deadline <= tnow();   // 截止已過，後端 opp_restore 一定拒絕，不畫按鈕（D 審稿 #8）
  return '<article class="pc" data-id="' + id + '"><h3 class="sb">' + softBreak(it.title) + '</h3><p class="st">' + goneWhy(it) + (it.decidedAt ? '，' + fmtClock(it.decidedAt) : '') + (dead ? '<br>截止已過，救不回來' : '') + '</p>' +
    (can('act') && !dead ? '<div class="pa"><button data-act="restore" data-id="' + id + '" type="button">救回來</button></div>' : '') + '</article>';
}
function renderSheet() {
  const h = holdItems(), f = doneItems(), g = goneItems();
  $('#hpill').hidden = true;                 // v75：手機不再有浮動圓鈕，入口改在頁首第二列（renderSummary 的「待決 N」）
  $('#holdbtn').hidden = S.net === 'auth';   // 桌機頂列那顆不會蓋到卡片，照常顯示（D 複審：剛收走的卡要救得回來）
  renderSummary();
  $('#holdbtn').innerHTML = '待決區<b>' + h.length + '</b>';
  $('#hpill').innerHTML = '<span class="hp-l">待決</span><b>' + h.length + '</b>'; $('#hpill').setAttribute('aria-label', '待決區，' + h.length + ' 筆');
  const sh = $('#sheet'); const sc = sh.querySelector('.db') ? sh.querySelector('.db').scrollTop : 0;
  let body = '';
  if (!h.length && !f.length) body += '<div class="zero"><b>待決區是空的</b><span>' + TBD.sheetEmpty + '</span></div>';
  if (h.length) body += '<p class="grp">暫存中，' + h.length + ' 筆</p>' + h.map(pcard).join('');
  if (f.length) body += '<p class="grp">剛完成的，' + f.length + ' 筆</p>' + f.map(fcard).join('');
  if (g.length) body += '<details class="gone"><summary>剛收走的，' + g.length + ' 筆，' + CONFIG.GONE_HOURS + ' 小時內可以救回來</summary>' + g.map(gcard).join('') + '</details>';
  body += '<p class="sheet-note">' + TBD.sheetNote + '</p>';
  const wasOpen = sh.querySelector('details.gone') && sh.querySelector('details.gone').open;
  sh.innerHTML = '<div class="dh"><span>待決區</span><button class="xb" data-act="close-hold" type="button" aria-label="關閉待決區">×</button></div><div class="db">' + body + '</div>';
  if (wasOpen && sh.querySelector('details.gone')) sh.querySelector('details.gone').open = true;
  sh.querySelector('.db').scrollTop = sc;
  sh.classList.toggle('show', S.sheet);
}

// ---------------- 畫面：詳細資料抽屜 ----------------
function viewOf() {
  if (S.drawer && ['chat', 'archive', 'archived', 'followups'].includes(S.drawer.view)) return S.drawer.view;
  const it = S.drawer && get(S.drawer.id); if (!it) return null;
  return it.status === 'doing' ? 'progress' : S.drawer.view;
}
function statBlock(it) {
  const t = target(it), lv = lvOf(it);
  const lab = t.kind === 'dl' ? '距離截止' : t.kind === 'ttl' ? '沒處理就收走' : '截止日';
  // deadline_text 來自外部公告，一律跳脫（D 審稿 #1）
  const dtx = esc(it.deadlineText) || (it.deadline ? fmtDate(it.deadline) : '');
  const note = approx(it) ? '<br>' + APPROX_NOTE : '';
  const small = t.kind === 'dl' ? dtx + note : t.kind === 'ttl' ? (it.deadline ? '截止 ' + dtx + note : (dtx || '預計 ' + fmtDate(it.expiresAt) + ' 收走')) : '來源沒寫';
  return '<div class="dt-stats"><div class="dt-stat">' + amt(it) + '</div><div class="dt-stat"><em>' + lab + '</em><span class="dt-cd" data-cd="' + esc(it.id) + '" data-lvl="' + lv + '">' + cdFull(it) + '</span><small>' + small + '</small></div></div>';
}
function head(it, extra) { return '<header><div class="dt-tags">' + chip(it) + (extra || '') + demo(it) + '</div><h2 class="sb">' + softBreak(it.title) + '</h2>' + orgLine(it) + '</header>'; }
const warnBox = (w, n) => w.length ? '<section class="dt-warn"><h3>要注意</h3><ul>' + w.slice(0, n || 9).map(x => '<li class="sbp">' + softBreak(x) + '</li>').join('') + '</ul></section>' : '';
const firstBox = it => it.firstStep ? '<section class="dt-first"><h3>第一步</h3><p class="sbp">' + softBreak(it.firstStep) + '</p></section>' : '';
const metaLine = it => {
  const parts = [];
  if (it.foundBy) parts.push('由 ' + esc(it.foundBy) + ' 找到');
  if (it.sourceSite) parts.push('來源 ' + esc(it.sourceSite));
  if (it.foundAt) parts.push(fmtClock(it.foundAt) + ' 進來');
  return parts.length ? '<p class="dt-meta">' + parts.join('，') + '</p>' : '';
};
// 結構化欄（有才畫）：案號、招標方式、押標金、履約期限、資格門檻
const STRUCT = [['caseNo', '案號'], ['tenderMethod', '招標方式'], ['bidBond', '押標金'], ['performancePeriod', '履約期限'], ['qualification', '資格門檻']];
const STRUCT_TITLES = { caseNo: ['案號'], tenderMethod: ['招標方式'], bidBond: ['押標金'], performancePeriod: ['履約期限', '履約'], qualification: ['資格門檻', '資格'] };
function structBox(it, clampQual) {
  const rows = STRUCT.filter(([k]) => it[k]).map(([k, n]) => '<li' + (k === 'qualification' ? ' class="wide"' : '') + '><b>' + n + '</b><span class="sbp' + (k === 'qualification' && clampQual ? ' clamp2' : '') + '">' + softBreak(it[k]) + '</span></li>');
  return rows.length ? '<ul class="facts">' + rows.join('') + '</ul>' : '';
}

// ---------- 領標（v8；sql/29、31）：只記錄誰申請、誰付了，付款一律自己在採購網完成 ----------
const NTD = n => n == null ? '' : 'NT$' + Number(n).toLocaleString('en-US');
const VERDICT = { go: ['建議投', 'v-go'], no: ['不投', 'v-no'], maybe: ['再看', 'v-maybe'] };
const verdictOf = it => { const v = it.bidSummary && it.bidSummary.advice && it.bidSummary.advice.verdict; return VERDICT[v] || (it.bidSummary ? VERDICT.maybe : null); };
const bidOk = it => it.lane === 'tender' && ['new', 'snoozed', 'doing'].includes(it.status) &&
  (it.status !== 'doing' || it.bidState !== 'none' || (it.progressSteps || []).some(s => s.key === PAY_STEP && s.status !== 'done' && s.status !== 'skipped'));
const bidFetching = it => it.bidState === 'paid' && !!it.bidFetchStartedAt && !(it.bidFetchFailedAt && it.bidFetchFailedAt > it.bidFetchStartedAt);
function bidLine(it) {   // 卡片正面一行灰色小字（沒申請就不畫）
  if (!bidOk(it) || it.bidState === 'none') return '';
  const v = verdictOf(it);
  const t = it.bidState === 'requested' ? '領標中：' + it.bidRequestedBy + ' 申請'
    : it.bidState === 'paid' ? (bidFetching(it) ? '肉咖抓檔中' : '已付：' + it.bidPaidBy + (it.bidPaidAt ? ' ' + fmtDay(it.bidPaidAt).replace(/（.）/, '') : '') + (it.bidPaidAmount != null ? ' ' + NTD(it.bidPaidAmount) : ''))
    : (w => '已領標' + (w ? '：' + w : '') + (it.bidFetchedAt ? ' ' + fmtDay(it.bidFetchedAt).replace(/（.）/, '') : '') + (v ? '・' + v[0] : w || it.bidFetchedAt ? '' : '，重點在卡片內'))(it.bidFetchedBy || it.bidPaidBy);   // v81：寫誰、哪天領的
  return '<p class="bid-line">' + esc(t) + '</p>';
}
const bidPayLink = it => linkOf(it, 'pay') || (it.sourceUrl ? { kind: 'other', label: '開公告頁', url: it.sourceUrl, fallback: true } : null);
function sumVal(v) {   // bid_summary 的值：字串照原文換行；陣列條列；物件攤成「鍵：值」
  if (v == null || v === '' || (Array.isArray(v) && !v.length)) return '';
  if (Array.isArray(v)) return '<ul class="bs-list">' + v.map(x => '<li class="sbp">' + softBreak(typeof x === 'object' && x ? Object.entries(x).map(([a, b]) => a + '：' + b).join('；') : String(x)) + '</li>').join('') + '</ul>';
  if (typeof v === 'object') return '<ul class="bs-list">' + Object.entries(v).map(([a, b]) => '<li class="sbp">' + softBreak(a + '：' + (typeof b === 'object' ? JSON.stringify(b) : String(b))) + '</li>').join('') + '</ul>';
  return '<p class="sbp">' + softBreak(String(v)) + '</p>';
}
const SUM_KEYS = [['eligibility', '資格'], ['scoring', '評分方式'], ['budget', '預算'], ['deadline', '截止與時程'], ['presentation', '簡報'], ['bond_schedule', '押標金與期程'], ['open_questions', '還要問的']];
function bidSummaryHTML(it) {
  const s = it.bidSummary; if (!s) return '';
  const v = verdictOf(it), rs = s.advice && s.advice.reasons, open = S.bidSumOpen.has(it.id);
  const rest = SUM_KEYS.map(([k, t]) => { const h = sumVal(s[k]); return h ? '<div class="bs-sec' + (k === 'open_questions' ? ' q' : '') + '"><b>' + t + '</b>' + h + '</div>' : ''; }).join('');
  return '<div class="bs">' + (v ? '<span class="verdict ' + v[1] + '">' + v[0] + '</span>' : '') + (rs ? sumVal(rs) : '') +
    (rest ? '<button class="bs-more" type="button" data-act="bid-sum" data-id="' + esc(it.id) + '" aria-expanded="' + open + '">' + (open ? '收起重點' : '看領標文件的重點') + '</button>' + (open ? '<div class="bs-rest">' + rest + '</div>' : '') : '') + '</div>';
}
function bidBox(it) {
  if (!bidOk(it)) return '';
  const id = esc(it.id), st = it.bidState, lines = [];
  if (st === 'none') lines.push(can('pay') ? '還沒有人領標。' : '還沒有人領標。要領標請找有付款權限的同事。');
  if (it.bidRequestedBy && st !== 'none') lines.push(esc(it.bidRequestedBy) + (it.bidRequestedAt ? ' ' + fmtDay(it.bidRequestedAt).replace(/（.）/, '') : '') + ' 申請領標');
  if (st === 'paid' || st === 'fetched') lines.push(it.bidPaidBy ? '已付：' + esc(it.bidPaidBy) + (it.bidPaidAt ? ' ' + fmtDay(it.bidPaidAt).replace(/（.）/, '') : '') + (it.bidPaidAmount != null ? ' ' + NTD(it.bidPaidAmount) : '') + (it.bidHasReceipt ? '（有憑據序號）' : '') + (it.bidPaidNote ? '，' + esc(it.bidPaidNote) : '') : '免費領標');
  if (st === 'paid') lines.push(bidFetching(it) ? '<span class="spin" aria-hidden="true"></span>肉咖抓檔中，' + esc(relTime(it.bidFetchStartedAt, tnow())) + '開始' : it.bidFetchFailedAt ? '上次抓檔沒成功（' + fmtDate(it.bidFetchFailedAt) + '），肉咖會再試' : '等肉咖抓文件');
  if (st === 'fetched') lines.push('已領標：' + esc(it.bidFetchedBy || '肉咖') + (it.bidFetchedAt ? ' ' + fmtDay(it.bidFetchedAt).replace(/（.）/, '') : '') + ' 抓到文件' + (it.bidFetchNote ? '（' + esc(it.bidFetchNote) + '）' : ''));
  const btn = can('pay') && (st === 'none' || st === 'requested')
    ? '<button class="btn btn-ghost bid-go" type="button" data-act="bid-open" data-id="' + id + '">' + (st === 'none' ? '我要領標' : '打開領標頁') + '</button>' : '';
  return '<section class="dt-sec bid-box"><h3>領標</h3>' + lines.map(x => '<p class="bid-st">' + x + '</p>').join('') + bidSummaryHTML(it) + btn + '</section>';
}
// 領標彈出頁（Borry「彈出他們自己的領票頁面，讓他們自己登錄領標…你要把頁面處理好給他們包含我」）
const BID_STEPS = ['在這頁按「前往採購網領標」，會開採購網登入頁。', '選「廠商」登入：帳號、密碼、驗證碼都自己輸入。好咖的帳號是「好咖文創股份有限公司」。',
  '登入後會直接進這一案的「電子領標」。沒有的話，回卡片開原始連結，在公告頁最下面按「電子領標」。', '第 1 步「領標說明」：按「下一步」，跳出提醒就按「確認」。',
  '第 2 步「領標付費」：先看總計多少錢。', '還沒有人付過：選「是，進行付費流程」，按「下一步」。', '已經有人付過：選「否，已付費」，輸入憑據序號就好，不要再付一次。',
  '總計 0 元：免費領標，不用付錢，直接下一步。', '選付款方式：點數卡（信用卡或 ATM）、隨身碼（月帳單）或 HiNet 寬頻帳號（電信帳單），照畫面付款。',
  '第 3 步「取得領標憑據」：記下憑據序號（一長串數字），能截圖就截圖。', '第 5 步「招標文件下載」：手機能按「全部下載」就下載；下載不了也沒關係，貼了序號肉咖會幫忙抓。',
  '回這頁按「我付好了」，把憑據序號貼上。'];
const BID_NOTES = ['一張憑據只能給一家公司投標用。', '登入放太久會被登出。付款前如果發現被登出了，先重新登入。', '採購網是電腦版網頁，手機上字會很小，可以放大或把手機轉橫。', '憑據也會寄到採購網帳號登記的信箱。'];
const factOf = (it, re) => { const f = it.facts.find(x => re.test(x)); return f ? f.replace(/^[^：]{1,10}：/, '') : ''; };
function bidPage(it) {
  if (S.bidPage !== it.id) return '';
  const id = esc(it.id), st = it.bidState, pl = bidPayLink(it), f = S.bidForm;
  const info = [['案名', esc(it.title)], ['機關', esc(it.org || '沒寫')], ['截止', it.deadline ? esc(it.deadlineText || fmtDate(it.deadline)) : '沒寫'],
    ['領標費', esc(factOf(it, /^(領標費|文件費|領標)/) || '公告沒寫，進採購網第 2 步看總計')], ['電子領標', esc(factOf(it, /^(電子領標|現場領標)/) || '公告沒寫')]];
  const done = st === 'paid' || st === 'fetched';
  const form = done ? '<p class="bp-done">已經有人付過了：' + esc(it.bidPaidBy || '') + (it.bidPaidAmount != null ? ' ' + NTD(it.bidPaidAmount) : '') + '。不要再付一次。</p>'
    : '<div class="bp-form"><h4>我付好了</h4>' +
      '<label class="dlg-l" for="bid-amt">金額（選填）</label><div class="bp-amt"><span>NT$</span><input id="bid-amt" class="dlg-in" type="text" inputmode="numeric" autocomplete="off" maxlength="9" value="' + esc(f.amount) + '" placeholder="例如 20"></div>' +
      '<label class="dlg-l" for="bid-rc">憑據序號（選填，填了 Mac 可以免費重新下載）</label><input id="bid-rc" class="dlg-in" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="64" value="' + esc(f.receipt) + '">' +
      '<label class="dlg-l" for="bid-note">備註（選填）</label><input id="bid-note" class="dlg-in" type="text" maxlength="200" value="' + esc(f.note) + '" placeholder="例如：用公司卡">' +
      '<button class="btn btn-primary bp-paid" type="button" data-act="bid-paid" data-id="' + id + '"' + (f.busy ? ' disabled' : '') + '>' + (f.busy ? '送出中…' : '我付好了，送出紀錄') + '</button>' +
      '<p class="bp-note">這裡只是記錄。付款要自己按上面的「前往採購網領標」，在採購網上完成。</p></div>';
  return '<div class="cs-scrim" data-act="bid-close" aria-hidden="true"></div><div class="csheet bsheet" role="dialog" aria-modal="true" aria-label="領標">' +
    '<div class="cs-h"><b>領標</b><span class="cs-t">' + esc(nm(it)) + '</span><button class="dock-close" data-act="bid-close" type="button">關閉</button></div><div class="bp-body">' +
    '<dl class="bp-info">' + info.map(r => '<dt>' + r[0] + '</dt><dd>' + r[1] + '</dd>').join('') + '</dl>' +
    (pl ? '<a class="btn btn-primary bp-go" href="' + esc(pl.url) + '" target="_blank" rel="noopener noreferrer" data-act="bid-ext" data-id="' + id + '">' + (pl.fallback ? '開公告頁（還沒有領標入口）' : '前往採購網領標') + '</a>' : '<p class="bp-note">這張卡沒有採購網連結，請到原始公告領標。</p>') +
    '<ol class="bp-steps">' + BID_STEPS.map(x => '<li>' + esc(x) + '</li>').join('') + '</ol>' +
    '<details class="bp-notes"><summary>要注意</summary><ul>' + BID_NOTES.map(x => '<li>' + esc(x) + '</li>').join('') + '</ul></details>' + form + '</div></div>';
}
// 後端錯誤代碼 → 中文（sql/29）
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
  if (it.bidState === 'none') {   // 按「我要領標」的同時記下是誰申請的（sql/29 opp_request_bid）
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
    f.receipt = '';   // 序號不留在畫面上：送出就清掉
    if (c) put(c);
    S.bidPage = null; S.bidForm = { amount: '', receipt: '', note: '' };
    toast('已記下：' + ((S.who && S.who.role) ? nickOf(S.who.role) : '你') + ' 付了領標費' + (amount != null ? ' ' + NTD(amount) : '') + '，肉咖會去抓文件');
    renderAll(); ensureEvents(id, true);
  } catch (e) {
    f.busy = false; f.receipt = '';   // 失敗也清掉序號，要再貼一次
    if (e instanceof AdapterError && e.kind === 'perm') loadWho();
    if (e instanceof AdapterError && e.kind === 'auth') setAuth();
    if (/^already_(paid|fetched)/.test(e.message || '')) { S.bidPage = null; refreshCard(id); }
    toast(bidErr(e), { bad: true }); renderAll();
  }
}
async function refreshCard(id) { try { const c = await api.get(id); if (c) put(c); renderAll(); } catch (e) {} }
const nickOf = n => n;
function previewHTML(it) {
  const rem = it.status === 'snoozed' ? it.snoozeUntil : null;
  return '<div class="dt">' + head(it) + statBlock(it) + structBox(it, true) + bidBox(it) +
    (it.why ? '<p class="dt-why sbp">' + softBreak(it.why) + '</p>' : '') +
    (it.quick.length ? '<ul class="pv-list">' + it.quick.map(x => '<li class="sbp">' + softBreak(x) + '</li>').join('') + '</ul>' : '') +
    warnBox(it.warn, 1) + firstBox(it) +
    (rem ? '<p class="dt-meta">' + (rem > tnow() ? TBD.previewRemind(rem) : TBD.remindPassed) + '</p>' : '') + metaLine(it) + '</div>';
}
function crawlHTML(it) {
  const id = esc(it.id);
  if (it.detailText) {
    const open = S.textOpen.has(it.id);
    // 附件預設收合成一列「附件 N 個 ▸」，點了才展開（數量少也一樣收合）
    const ao = S.attOpen.has(it.id), n = it.attachments.length;
    const att = n ? '<div class="att"><button class="att-toggle" data-act="toggle-att" data-id="' + id + '" type="button" aria-expanded="' + ao + '" aria-controls="att-' + id + '">附件 ' + n + ' 個 <span aria-hidden="true">' + (ao ? '▾' : '▸') + '</span></button>' +
      '<ul id="att-' + id + '"' + (ao ? '' : ' hidden') + '>' + it.attachments.map(a => '<li><a href="' + esc(a.url) + '" target="_blank" rel="noopener noreferrer">' + esc(a.name || a.url) + '</a></li>').join('') + '</ul></div>' : '';
    return '<section class="dt-sec dt-text"><h3>公告全文</h3><div class="txt' + (open ? ' open' : '') + '">' + para(it.detailText) + '</div>' +
      '<button class="more" data-act="toggle-text" data-id="' + id + '" type="button">' + (open ? '收合全文' : '展開全文') + '</button>' + att + '</section>';
  }
  const d = S.detail.get(it.id), st = it.crawlStatus;
  if (!can('act') && !(d && d.busy) && st !== 'crawling') {
    // 唯讀金鑰不能觸發讀全文（opp_dive 要 can_act），只能看別人讀好的
    return '<section class="dt-crawl"><div><b>還沒有讀全文</b><small>你的金鑰只能看，不能讀全文。' + (it.sourceUrl ? '要看公告請開原始連結。' : '') + '</small></div>' +
      (it.sourceUrl ? '<div class="acts"><a class="btn btn-ghost" href="' + esc(it.sourceUrl) + '" target="_blank" rel="noopener noreferrer">開原始連結</a></div>' : '') + '</section>';
  }
  if (d && d.timedOut && !d.busy) {
    return '<section class="dt-crawl fail"><div><b>讀全文逾時</b><small>已經等超過 60 秒，還沒讀完。上面的條件還可以看。要全文的話，可以再讀一次' + (it.sourceUrl ? '，或開原始連結' : '') + '。</small></div><div class="acts">' +
      '<button class="btn btn-primary" data-act="retry-detail" data-id="' + id + '" type="button">再讀一次</button>' +
      (it.sourceUrl ? '<a class="btn btn-ghost" href="' + esc(it.sourceUrl) + '" target="_blank" rel="noopener noreferrer">開原始連結</a>' : '') + '</div></section>';
  }
  if (st === 'failed' && !(d && d.busy) && !it.sourceUrl) {   // 沒有來源網址：再讀也一定失敗（D 審稿 #9）
    return '<section class="dt-crawl fail"><div><b>沒有全文</b><small>' + esc(it.crawlError || '這張卡沒有來源網址') + '。這張卡沒有來源網址可以讀，上面的條件是先整理好的。</small></div></section>';
  }
  if (st === 'failed' && !(d && d.busy)) {
    return '<section class="dt-crawl fail"><div><b>抓取失敗，開原始連結</b><small>' + esc(it.crawlError || '沒有抓到全文') + (it.sourceUrl ? '。' + TBD.crawlFailHint : '。') + '</small></div><div class="acts">' +
      (it.sourceUrl ? '<a class="btn btn-primary" href="' + esc(it.sourceUrl) + '" target="_blank" rel="noopener noreferrer">開原始連結</a>' : '') +
      '<button class="btn btn-ghost" data-act="retry-detail" data-id="' + id + '" type="button">再讀一次</button></div></section>';
  }
  if (st === 'none' && !(d && d.busy)) return '';   // 進行中卡還沒讀過全文：不畫
  const t0 = d && d.t0 || tnow();
  const sec = Math.floor((tnow() - t0) / 1000);
  return '<section class="dt-crawl wait" aria-live="polite"><div class="row"><span class="spin" aria-hidden="true"></span><div><b>正在讀全文</b><small>已等 <span data-elapsed="' + id + '">' + sec + '</span> 秒，<span data-elapsed-hint="' + id + '">' + crawlHint(sec) + '</span></small></div></div><div class="crawl-sk" aria-hidden="true"><i class="sk"></i><i class="sk"></i><i class="sk"></i></div></section>';
}
function crawlHint(sec) {
  return sec > 10
    ? '比平常久，再等一下；超過 60 秒會停止。讀完會自動出現在這裡，你也可以先看上面的條件。'
    : '通常 2 到 10 秒。讀完會自動出現在這裡，你也可以先看上面的條件。';
}
function factsBox(it) {
  // 完整條件：標題已和上方結構化欄重複的條目略過，避免畫兩次
  const skip = new Set(); STRUCT.forEach(([k]) => { if (it[k]) STRUCT_TITLES[k].forEach(t => skip.add(t)); });
  const list = it.facts.map(f => { const m = f.match(/^([^：]{1,14})：([\s\S]+)$/); return m ? { t: m[1], v: m[2] } : { t: '', v: f }; }).filter(x => !skip.has(x.t));
  return list.length ? '<section class="dt-sec"><h3>完整條件</h3><ul class="dt-list">' + list.map(x => x.t ? '<li><b>' + esc(x.t) + '</b><span class="sbp">' + softBreak(x.v) + '</span></li>' : '<li><span class="sbp">' + softBreak(x.v) + '</span></li>').join('') + '</ul></section>' : '';
}
function fullHTML(it) {
  return '<div class="dt">' + head(it) + statBlock(it) +
    (it.why || it.fit ? '<div>' + (it.why ? '<p class="dt-why sbp">' + softBreak(it.why) + '</p>' : '') + (it.fit ? '<p class="dt-fit">契合度 <b>' + esc(it.fit) + '</b></p>' : '') + '</div>' : '') +
    bidBox(it) + structBox(it, false) + warnBox(it.warn) + crawlHTML(it) + firstBox(it) + factsBox(it) +
    '<section class="dt-sec dt-src"><h3>來源</h3>' + metaLine(it) + link(it) + '</section>' + '</div>';
}

// ----- 進度大區塊（進行中的進度抽屜；網頁端只讀，沒有任何寫入進度的按鈕） -----
// v72（Borry「每一條進度內容點下去都可以看到比較多的進行中的細節」）：每一步預設一行（名稱＋負責、期限、狀態），點了展開細節
const stepOpen = new Set();   // 展開中的步驟：卡片 id + '|' + 步驟 key（重畫時保留）
const ST_TXT = { done: '完成', skipped: '略過', current: '進行中', blocked: '卡住', pending: '還沒開始' };
const signOf = s => s.sign || ((String(s.note || '').match(/需簽章[：:]\s*([^。\n]+)/) || [])[1] || '').trim();
const isSealStep = s => /seal|sign/i.test(s.key) || /用印|簽章|簽名/.test(s.name);
function stepMeta(s, it) {
  const late = s.dueAt && s.dueAt < tnow() && s.status !== 'done' && s.status !== 'skipped';
  const due = s.dueAt ? '<span class="' + (late ? 'due-late' : '') + '">' + (late ? '已逾期 ' : '') + fmtDay(s.dueAt) + ' 前</span>' : '';
  const parts = [];
  if (s.status === 'current') parts.push('<b class="st-now">進行中</b>');
  if (s.status === 'blocked') parts.push('<b class="st-blk">卡住' + (noteText(s.note) ? '：' + esc(noteText(s.note)) : '') + '</b>');
  if (s.owner) parts.push(esc(s.owner));
  if (s.status === 'done') parts.push(s.doneAt ? (tnow() - s.doneAt < 24 * H ? relTime(s.doneAt, tnow()) : fmtDay(s.doneAt).replace(/（.）/, '') + ' 完成') : '完成');
  else if (s.status === 'skipped') parts.push('略過');
  else if (due) parts.push(due);
  if (it && stepOpenNow(s) && ownerIsMe(s)) parts.unshift('<b class="st-mine">等你確認</b>');
  return parts.join(' · ');
}
function stepRow(s, i, all, it) {
  const mark = s.status === 'done' ? '✓' : s.status === 'skipped' ? '–' : s.status === 'blocked' ? '!' : String(i + 1);
  const raw = noteUrl(s.note);
  const u = raw && !(it && linksOf(it).some(l => l.url === raw)) ? raw : '';   // 同一個網址已在 links（檔案區）就不重複畫
  const big = s.status === 'current' || s.status === 'blocked';
  const ok = it && it.id ? it.id + '|' + s.key : '', open = ok && stepOpen.has(ok);
  // 付款那步的按鈕一直露在外面（不用點開就能去付款）
  const btn = u && s.key === PAY_STEP && big && !bidDone(it) ? '<div class="step-acts">' + linkBtn(s.key, u, 'btn-primary') + '</div>' : '';   // v81：已付款、已領標不畫
  const meta = stepMeta(s, it);
  return '<li class="step ' + s.status + (open ? ' open' : '') + '">' +
    '<button class="step-h" data-act="step-tog" data-id="' + esc(it && it.id || '') + '" data-k="' + esc(s.key) + '" type="button" aria-expanded="' + !!open + '">' +
    '<span class="dot-s" aria-hidden="true">' + mark + '</span><span class="step-m"><span class="nm">' + esc(s.name) + '</span>' + (meta ? '<span class="sub">' + meta + '</span>' : '') + '</span>' +
    '<span class="chev" aria-hidden="true">' + (open ? '︿' : '﹀') + '</span></button>' + btn + (open ? stepDetail(s, it) : '') + '</li>';
}
function stepDetail(s, it) {
  const rows = [];
  const urls = (String(s.note || '').match(new RegExp(URL_RE.source, 'g')) || []).map(x => safeUrl(x.replace(/[.,;:!?)\]]+$/, ''))).filter(Boolean);
  const txt = noteText(String(s.note || '').replace(new RegExp(URL_RE.source, 'g'), ''));
  rows.push(['狀態', ST_TXT[s.status] || s.status]);
  rows.push(['負責', s.owner ? esc(s.owner) : '還沒指定']);
  const sg = signOf(s);
  if (sg || isSealStep(s)) rows.push(['需簽章', sg ? esc(sg) : '待 CC 確認']);
  if (s.dueAt) rows.push(['期限', fmtDate(s.dueAt) + (s.dueAt < tnow() && s.status !== 'done' && s.status !== 'skipped' ? '（已逾期）' : '')]);
  if (s.doneAt) rows.push(['完成', fmtDate(s.doneAt)]);
  const dl = '<dl class="sd-kv">' + rows.map(r => '<dt>' + r[0] + '</dt><dd>' + r[1] + '</dd>').join('') + '</dl>';
  const note = txt ? '<p class="sd-note sbp">' + softBreak(txt) + '</p>' : '';
  const links = urls.length ? '<div class="sd-links">' + urls.map(x => linkBtn(s.key, x, 'btn-ghost')).join('') + '</div>' : '';
  return '<div class="step-d">' + note + dl + links + stepFiles(s, it) + stepBtns(s, it) + stepHist(s, it) + '</div>';
}
// 步驟附檔（sql/34：links 裡 step_key 等於這一步的）：開啟、下載、分享，每次都記 opp_track
const stepLinks = (it, key) => linksOf(it).filter(l => l.stepKey && l.stepKey === key);
const dlUrl = u => { const m = String(u).match(/^https:\/\/drive\.google\.com\/file\/d\/([\w-]+)/); return m ? 'https://drive.google.com/uc?export=download&id=' + m[1] : u; };   // Drive 檔案直接下載；其他照原網址開
function stepFiles(s, it) {
  const ls = stepLinks(it, s.key); if (!ls.length) return '';
  const id = esc(it.id), k = esc(s.key);
  return '<div class="sd-files"><p class="sd-h">這一步的文件</p>' + ls.map(l => {
    const lb = esc(linkText(l)), u = esc(l.url);
    return '<div class="sf-row"><span class="sf-n">' + lb + '</span><span class="sf-a">' +
      '<a class="sf-b" href="' + u + '" target="_blank" rel="noopener noreferrer" data-act="file-open" data-id="' + id + '" data-k="' + k + '" data-label="' + lb + '">開啟</a>' +
      '<a class="sf-b" href="' + esc(dlUrl(l.url)) + '" target="_blank" rel="noopener noreferrer" download data-act="file-dl" data-id="' + id + '" data-k="' + k + '" data-label="' + lb + '">下載</a>' +
      '<button class="sf-b" type="button" data-act="file-share" data-id="' + id + '" data-k="' + k + '" data-label="' + lb + '" data-url="' + u + '">分享</button></span></div>';
  }).join('') + '</div>';
}
// 步驟按鈕（sql/32）：負責人、admin、planner 才看得到；完成的步驟只有「退回未完成」
function stepBtns(s, it) {
  if (!canMarkStep(s, it)) return '';
  const id = esc(it.id), k = esc(s.key), b = (st, t, cls) => '<button class="sd-btn' + (cls ? ' ' + cls : '') + '" type="button" data-act="step-mark" data-id="' + id + '" data-k="' + k + '" data-st="' + st + '">' + t + '</button>';
  const done = s.status === 'done' || s.status === 'skipped';
  return '<div class="sd-acts">' + (done ? b('undone', '退回未完成') : (s.status === 'current' ? '' : b('current', '進行中')) + b('done', '完成', 'pri')) + '</div>';
}
// 狀態紀錄：opp_events 裡 detail.step 等於這一步的（後端記了才有）；沒有就只寫完成時間與最後更新
function stepHist(s, it) {
  const ev = it && S.events.get(it.id), lines = [];
  (ev && ev.list || []).filter(e => /^step:/.test(e.action) && e.detail && (e.detail.step_key || e.detail.step) === s.key).forEach(e => {   // sql/32：action step:<status>，detail {step_key, step_name, from, note, as}
    const to = e.action.slice(5), f = ST_TXT[e.detail.from] || '', t = to === 'undone' ? '退回未完成' : ST_TXT[to] || ST_TXT[e.detail.to] || '';
    lines.push('<li><span>' + (e.at ? fmtDate(e.at) : '') + '</span><b>' + esc(e.actor || '不明') + '</b>' + (t ? (f ? esc(f) + ' → ' : '改成 ') + esc(t) : esc(e.action)) + (e.detail.note ? '（' + esc(String(e.detail.note)) + '）' : '') + '</li>');
  });
  const TRK = { 'track:open_file': '開啟了', 'track:download_file': '下載了', 'track:share_file': '分享了' };
  (ev && ev.list || []).filter(e => TRK[e.action] && e.detail && e.detail.step_key === s.key).slice(0, 3).forEach(e => {
    lines.push('<li class="trk"><span>' + (e.at ? fmtDate(e.at) : '') + '</span><b>' + esc(e.actor || '不明') + '</b>' + TRK[e.action] + ' ' + esc(String(e.detail.label || '文件')) + '</li>');
  });
  if (!lines.length && s.status === 'current' && it && it.progressUpdatedAt) lines.push('<li><span>' + fmtDate(it.progressUpdatedAt) + '</span><b>' + esc(it.progressUpdatedBy || '不明') + '</b>更新進度</li>');
  const busy = ev ? '' : '<p class="sd-empty">讀取紀錄中…</p>';
  return '<div class="sd-hist"><p class="sd-h">狀態紀錄</p>' + (lines.length ? '<ol>' + lines.join('') + '</ol>' : busy || '<p class="sd-empty">' + (ev && ev.err ? '紀錄讀不到，等一下會自動再試。' : '這一步還沒有變更紀錄。') + '</p>') + '</div>';
}
// 卡片紀錄（opp_events，sql/29）：打開進度抽屜時抓一次；有展開的步驟時，收到 changed 再重抓
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
  if (fs === 'failed') return '<div class="fold-row bad"><p class="fold-t"><span class="ok-ic bad" aria-hidden="true">!</span>資料夾沒建成</p><p class="fold-p">' + esc(it.folderError || '原因不明') + '</p><p class="fold-p">' + TBD.folderFailHelp + '</p></div>';
  if (folderWait(it)) return '<div class="fold-row"><p class="fold-t"><span class="spin"></span>' + folderWaitText(it) + '</p><p class="fold-p">通常 1 到 2 分鐘內建好，附件多會久一點。你可以先回到面板，不用等。</p></div>';
  const p = it.folderPath, real = /^\//.test(p);
  // 「複製本機資料夾位置」照 DESIGN 放在底欄（D 審稿 #10），這裡只寫狀態與路徑。
  // 面板不顯示 Notion（2026-11-16 定案：「面板不標明notion頁面」）；adapter 照收 notion 欄位，但畫面一律不畫。
  const notion = '';
  if (!real) return '<div class="fold-row"><p class="prog-upd">這張是示意卡，不會真的建資料夾。</p>' + (p || it.folderName ? '<div class="path">' + esc(it.folderName || p) + '</div>' : '') + notion + '</div>';
  return '<div class="fold-row"><p class="prog-upd">工作資料夾已建立' + (it.isDemo ? '（示意路徑）' : '') + '</p><div class="path">' + esc(p) + '</div>' + notion + '</div>';
}
// 「檔案」區：links 每項一顆按鈕（文字用 label，沒有就用預設），pay 用主色
function filesRow(it) {
  const keys = new Set((it.progressSteps || []).map(s => s.key));
  const ls = linksOf(it).filter(l => !(l.stepKey && keys.has(l.stepKey))); if (!ls.length) return '';
  return '<div class="fold-row files"><p class="prog-upd">檔案</p><div class="fold-acts">' + ls.map(l => extLink(l, 'btn ' + (l.kind === 'pay' && !bidDone(it) ? 'btn-primary' : 'btn-ghost') + ' file-link')).join('') + '</div></div>';
}
function progressBox(it) {
  const p = pv(it), st = it.progressSteps, busy = S.prog.get(it.id) && S.prog.get(it.id).busy;
  const steps = st && st.length ? '<ol class="steps">' + st.map((x, i, a) => stepRow(x, i, a, it)).join('') + '</ol>'
    : st ? '<p class="prog-upd">還沒有步驟清單。</p>'
    : '<div class="crawl-sk" aria-hidden="true"><i class="sk"></i><i class="sk"></i><i class="sk"></i></div>' + (busy ? '' : '');
  let warnLine = '';
  if (submitted(it)) {   // 送件後（v4）：先寫下一步與期限，下面才是已送件
    const d = it.progressDueAt, m = d ? d - tnow() : 0;
    const when = !d ? '日期未定' : (m <= 0 ? '已逾期，' : shortLeft(m) + '後，') + fmtDate(d) + ' 前';
    warnLine = '<p class="prog-alert next ' + (d ? (m < URGENT_DAYS * D ? 'hot' : 'calm') : 'warm') + '">下一步：' + esc(it.progressStage || '下一步') + '（' + esc(when) + '）</p>' +
      (p.k === 'blocked' ? '<p class="prog-alert warm">卡住：' + esc(it.progressBlocker || '原因沒寫') + '</p>' : '') +
      '<p class="prog-upd sent-line">' + esc(sentTag(it)) + (it.deadline ? '（公告截止 ' + esc(it.deadlineText || fmtDate(it.deadline)) + '）' : '') + '</p>';
  }
  else if (p.k === 'blocked') warnLine = '<p class="prog-alert warm">卡住：' + esc(it.progressBlocker || '原因沒寫') + '</p>';
  else if (p.k === 'overdue') warnLine = '<p class="prog-alert hot">這步逾期：' + esc(it.progressBlocker || '這步已過內部期限') + '</p>';
  else if (p.k === 'dlpass') warnLine = '<p class="prog-alert hot">公告截止時間已到（' + esc(it.deadlineText || fmtDate(it.deadline)) + '）。面板不會自動收走，請確認是否已送出。</p>';
  else if (p.k === 'failed' && it.folderStatus === 'failed') warnLine = '<p class="prog-alert hot">資料夾沒建成：' + esc(it.folderError || '原因不明') + '。' + TBD.progressFailHelp + '</p>';
  else if (folderWait(it)) warnLine = '<p class="prog-alert calm"><span class="spin"></span>' + folderWaitText(it) + '，通常 1 到 2 分鐘內建好。</p>';
  else if (p.k === 'failed' && it.folderStatus !== 'failed') warnLine = '<p class="prog-alert hot">流程失敗：' + esc(it.progressBlocker || it.progressNote || '原因不明') + '。' + TBD.progressFailHelp + '</p>';
  else if (p.k === 'done') warnLine = '<p class="prog-alert ok">' + (OUTCOME[it.progressOutcome] ? '已結案：' + OUTCOME[it.progressOutcome] : '已完成') + (it.progressArchiveAt ? '。' + (it.progressArchiveAt > tnow() ? fmtDay(it.progressArchiveAt) + '從看板撤下' : '已從看板撤下') : '') + '</p>';
  return '<section class="prog-box" data-pst="' + p.bar + '"><h3>進度</h3>' +
    '<div class="prog-head"><p class="ttl">' + esc(it.progressStage || '建立工作區') + '</p><span class="frac">' + fracText(it) + (it.progressStepTotal ? ' · ' : '') + pct(it) + '%</span></div>' +
    '<div class="pbar big" aria-hidden="true"><i style="width:' + pct(it) + '%"></i></div>' + warnLine +
    (it.progressNote ? '<p class="prog-note sbp">' + softBreak(it.progressNote) + '</p>' : '') +
    (it.progressUpdatedAt ? '<p class="prog-upd">最後更新：' + fmtDate(it.progressUpdatedAt) + '，由 ' + esc(it.progressUpdatedBy || '不明') + ' 更新</p>' : '') +
    steps + folderRow(it) + filesRow(it) + '</section>';
}
function progressHTML(it) {
  const p = pv(it), t = target(it);
  const sent = submitted(it);
  const dl = sent ? '' : it.deadline ? '截止 ' + esc(it.deadlineText || fmtDate(it.deadline)) + (approx(it) ? APPROX_NOTE : '') : '沒寫截止日';
  const left = t.kind === 'dl' ? '<br><span data-cd="' + esc(it.id) + '" data-lvl="' + lvOf(it) + '" class="dl-left">' + cdFull(it) + '</span>' + (it.deadline > tnow() ? ' 後截止' : '')
    : '';
  return '<div class="dt">' + head(it, '<span class="pst ' + p.cls + '">' + p.badge + '</span>') +
    '<p class="dt-line">' + esc(amtText(it)) + (dl ? ' · ' + dl : '') + left + '</p>' +
    (it.decidedBy ? '<p class="dt-meta">' + esc(it.decidedBy) + (it.decidedAt ? ' ' + fmtDay(it.decidedAt).replace(/（.）/, '') : '') + ' 按了要做</p>' : '') +
    bidBox(it) + progressBox(it) + structBox(it, false) +
    (it.why ? '<p class="dt-why sbp">' + softBreak(it.why) + '</p>' : '') + warnBox(it.warn) + crawlHTML(it) + factsBox(it) +
    '<section class="dt-sec dt-src"><h3>來源</h3>' + metaLine(it) + link(it) + '</section>' + '</div>';
}

const footMore = { open: false };
function miniFoot(id, main, more) {
  return '<div class="df mini">' + main + '<div class="fm-wrap"><button class="fbtn fm-b" data-act="foot-more" type="button" aria-haspopup="menu" aria-expanded="' + footMore.open + '" aria-label="更多動作">⋯</button>' +
    (footMore.open ? '<div class="fmenu" role="menu">' + more + '</div>' : '') + '</div></div>';
}
function renderDrawer() {
  const dr = $('#drawer');
  if (S.drawer && S.drawer.view === 'chat') return renderChatDrawer(dr);
  if (S.drawer && S.drawer.view === 'archive') return renderArchiveDrawer(dr);
  if (S.drawer && S.drawer.view === 'followups') return renderFuDrawer(dr);
  if (S.drawer && S.drawer.view === 'archived') return renderArchivedDrawer(dr);
  const it = S.drawer && get(S.drawer.id), view = viewOf();
  if (!it || !view) { dr.classList.remove('show'); return; }
  const keep = chatFocus();
  const sc = dr.querySelector('.db') && dr.dataset.key === it.id + view ? dr.querySelector('.db').scrollTop : 0;
  const id = esc(it.id); let label, body, foot = '';
  if (view === 'progress') {
    label = '進行中的進度';
    body = progressHTML(it) + fuSection(it.id);
    const canCopy = it.folderStatus === 'done' && /^\//.test(it.folderPath);
    // v72（Borry「複製本機資料夾位置等等的那些按鈕太大了」）：一列小按鈕，總高 44px 內；回到面板、徹底刪除收進「⋯」
    foot = miniFoot(id, (canCopy ? '<button class="fbtn" data-act="copy-path" data-id="' + id + '" type="button"><span aria-hidden="true">📋</span> 複製路徑</button>' : '') +
      (can('act') ? '<button class="fbtn" data-act="arch-start" data-id="' + id + '" type="button">' + (it.progressStatus === 'done' ? '改結案結果…' : '結案…') + '</button>' : ''),
      '<button class="fm-i" data-act="close-drawer" type="button" role="menuitem">回到面板</button>' + purgeBtn(it));
  } else if (view === 'full') {
    label = '完整內容'; body = fullHTML(it);
    foot = can('act') && (it.status === 'new' || it.status === 'snoozed')
      ? '<div class="df"><button class="btn btn-ghost del" data-act="no" data-id="' + id + '" type="button">不做</button>' +
        (canBuild(it) ? '<button class="btn btn-primary" data-act="yes" data-id="' + id + '" type="button">要做，建立公司工作區</button>' : '<p class="df-note">' + TENDER_ADMIN + '</p>') + purgeBtn(it) + '</div>'
      : '<div class="df"><button class="btn btn-primary" data-act="close-drawer" type="button">回到面板</button></div>';
  } else {
    label = '快速預覽'; body = previewHTML(it);
    foot = can('act')
      ? '<div class="df"><button class="btn btn-ghost del" data-act="del" data-id="' + id + '" type="button">刪掉</button>' +
        (it.status === 'snoozed' ? '' : '<button class="btn btn-ghost hold" data-act="hold" data-id="' + id + '" type="button">暫存</button>') +
        '<button class="btn btn-primary" data-act="dive" data-id="' + id + '" type="button">深入了解</button></div>'
      : '<div class="df"><button class="btn btn-primary" data-act="dive" data-id="' + id + '" type="button">深入了解</button></div>';
  }
  dr.innerHTML = '<div class="dh"><span>' + label + '</span><button class="xb" data-act="close-drawer" type="button" aria-label="關閉">×</button></div><div class="db">' + body + '</div>' + chatDock(it.id) + foot + bidPage(it);
  dr.setAttribute('aria-label', label);
  dr.dataset.key = it.id + view;
  dr.querySelector('.db').scrollTop = sc;
  dr.classList.add('show');
  dockScroll(dr);
  chatRestore(keep);
  if (dockShow.has(it.id)) markSeen(it.id);   // 對話展開時才算看過（收起時按鈕上留紅點）
}

function renderAll() {
  renderLive(); renderNotice(); renderSummary(); renderBoard(); renderSheet();
  if (S.drawer) { if (!['chat', 'archive', 'archived', 'followups'].includes(S.drawer.view) && !get(S.drawer.id)) closeDrawer(true); else renderDrawer(); }
  renderDlg();
  renderRk(); renderFuBtn();
  syncOverlay();
}

// ---------------- 疊層開關 ----------------
function syncOverlay() {
  const any = S.sheet || !!S.drawer;
  $('#scrim').classList.toggle('show', any);
  $('#app').inert = any; $('#hpill').inert = any;
  $('#app').setAttribute('aria-hidden', any ? 'true' : 'false');
  const want = (S.drawer ? 1 : 0) + (S.sheet ? 1 : 0);
  if (want && !depth) { history.pushState({ opp: 1 }, ''); }
  if (!want && depth) { ignorePop = true; history.back(); }
  depth = want ? 1 : 0;
}
function openDrawer(id, view) {
  const it = get(id); if (!it) return;
  if (!S.drawer) lastFocus = document.activeElement;
  S.drawer = { id, view: view || 'preview' }; footMore.open = false; S.bidPage = null;
  if (it.status === 'doing') { ensureProgress(id); loadItemFu(id); ensureEvents(id, true); }
  else if (view === 'full') ensureDetail(id);
  ensureMsgs(id);   // 每個卡片抽屜都有對話列（v7）
  renderDrawer(); syncOverlay();
  const dr = $('#drawer'); if (!dr.contains(document.activeElement)) dr.querySelector('.xb')?.focus({ preventScroll: true });
}
function closeDrawer(silent) {
  S.drawer = null; footMore.open = false; S.bidPage = null; S.bidForm = { amount: '', receipt: '', note: '' }; $('#drawer').classList.remove('show'); syncOverlay();
  if (!silent) restoreFocus();
}
function openSheet() { if (!S.sheet) lastFocus = document.activeElement; S.sheet = true; renderSheet(); syncOverlay(); $('#sheet .xb')?.focus({ preventScroll: true }); }
function closeSheet() { S.sheet = false; $('#sheet').classList.remove('show'); syncOverlay(); restoreFocus(); }
function restoreFocus() {
  const a = document.activeElement;   // 關掉的疊層裡不要留焦點
  if (a && ((!S.drawer && $('#drawer').contains(a)) || (!S.sheet && $('#sheet').contains(a)))) a.blur();
  if (!S.sheet && !S.drawer && lastFocus && document.contains(lastFocus) && lastFocus !== document.body) { try { lastFocus.focus({ preventScroll: true }); } catch (e) {} }
}

// ---------------- toast ----------------
let toastT;
function toast(msg, opt = {}) {
  const t = $('#toast'); clearTimeout(toastT);
  t.className = opt.bad ? 'bad' : '';
  t.innerHTML = '<span class="sbp">' + softBreak(msg) + '</span>' + (opt.undo ? '<button type="button" id="toast-undo">復原</button>' : '');
  void t.offsetWidth; t.classList.add('show');
  if (opt.undo) $('#toast-undo').onclick = () => { t.classList.remove('show'); opt.undo(); };
  toastT = setTimeout(() => t.classList.remove('show'), opt.bad ? 7000 : 6000);
}

// ---------------- 寫入：樂觀更新，失敗就還原 ----------------
const nextRemind = () => { const d = new Date(tnow() + 8 * H); d.setUTCDate(d.getUTCDate() + 1); d.setUTCHours(HOLD_HOUR, 0, 0, 0); return d.getTime() - 8 * H; };   // 明天 08:00（台北）
const reason = e => {
  if (!(e instanceof AdapterError)) return '發生錯誤';
  if (e.kind === 'state') return /deadline/i.test(e.message) ? '截止日已經過了，救不回來' : '這張卡的狀態已經變了，已重新同步';
  if (e.kind === 'perm') return /admin/i.test(e.message) ? TENDER_ADMIN : '你的金鑰沒有這個權限';
  return { timeout: '連線逾時', network: '連不上伺服器', offline: '目前沒有網路', auth: AUTH_MSG }[e.kind] || e.message;
};
const short = t => t.length > 14 ? t.slice(0, 14) + '…' : t;
const nm = it => short(it.shortTitle || it.title);
const NEXT = { stash: 'snoozed', unstash: 'new', deleted: 'dropped', skipped: 'dropped', restore: 'new', build: 'doing' };
const mergeCard = (old, res) => ({ ...res,
  detailText: res.detailText || (old ? old.detailText : ''),
  attachments: res.attachments.length ? res.attachments : (old ? old.attachments : []),
  progressSteps: res.progressSteps || (old ? old.progressSteps : null) });   // opp_list 不帶步驟，保留上次抓到的

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
  S.items.set(id, next);
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
    if (e instanceof AdapterError && e.kind === 'perm') loadWho();   // 權限可能被調低：重抓 caps，畫面改成對應的按鈕（D 審稿 #3）
    return false;
  } finally {
    locks.delete(id); renderAll();
    if (action === 'build') { kickPoll(); if (S.drawer && S.drawer.id === id && get(id) && get(id).status === 'doing') ensureProgress(id, true); }
  }
}
function leave(id, kind, then) {
  const c = document.querySelector('.card[data-id="' + CSS.escape(id) + '"]');
  if (!c) return then();
  c.classList.add('leave'); if (kind === 'hold') c.classList.add('r');
  setTimeout(then, 300);
}
// 刪掉與不做都可以復原：呼叫 opp_restore，原本是暫存的再暫存回去
const undoDrop = prev => mutate(prev.id, 'restore', '已復原').then(ok => { if (ok && prev.status === 'snoozed') mutate(prev.id, 'stash'); });
function actDrop(id, why, msg) {
  const it = get(id); if (!it) return;
  if (S.drawer && S.drawer.id === id) closeDrawer(true);
  leave(id, 'del', () => mutate(id, why, msg(it), undoDrop));
}
const actDel = id => actDrop(id, 'deleted', it => '已刪掉「' + nm(it) + '」');
const actNo = id => actDrop(id, 'skipped', it => '不做「' + nm(it) + '」，已收走');
function actHold(id) {
  const it = get(id); if (!it) return;
  if (S.drawer && S.drawer.id === id) closeDrawer(true);
  leave(id, 'hold', () => mutate(id, 'stash', TBD.stashToast(nm(it)), () => mutate(id, 'unstash', '已復原')));
}
function actUnstash(id) {
  const it = get(id); if (!it) return;
  if (S.drawer && S.drawer.id === id) closeDrawer(true);
  mutate(id, 'unstash', '「' + nm(it) + '」已取消暫存，回到待看', () => mutate(id, 'stash', '已復原'));
}
// 要做：沒有復原（一按下就會啟動公司工作區，DESIGN.md 第三節）
function actBuild(id) {
  const it = get(id); if (!it) return;
  mutate(id, 'build', '「' + nm(it) + '」改到進行中，正在建立公司工作區');
}

// ---------------- 深入了解：資料庫端讀全文，前端等結果 ----------------
const wait = ms => new Promise(r => setTimeout(r, ms));
const redrawDrawer = id => { if (S.drawer && S.drawer.id === id) renderDrawer(); };
function put(c) { if (c && S.items.has(c.id)) S.items.set(c.id, mergeCard(get(c.id), c)); }
async function ensureDetail(id, force) {
  const it = get(id); if (!it) return;
  if (it.detailText && !force) return;
  const cur = S.detail.get(id); if (cur && cur.busy) return;
  // 唯讀金鑰：不能 opp_dive，只能把別人讀好的全文抓回來
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
    if (c.crawlStatus === 'crawling') {
      S.detail.set(id, { busy: false, timedOut: true, t0: (S.detail.get(id) && S.detail.get(id).t0) || t0 });
      saveSnapshot();
      return;
    }
    if (c.crawlStatus === 'done' && !c.detailText) { c = (await api.get(id)) || c; put(c); }
    saveSnapshot();
  } catch (e) {
    if (!get(id)) return;   // 這張卡剛被徹底刪除：等全文的請求回 not found 是正常的，不要蓋掉「已徹底刪除」
    if (e instanceof AdapterError && e.kind === 'auth') setAuth();
    if (e instanceof AdapterError && e.kind === 'perm') loadWho();
    toast('讀全文沒有成功：' + reason(e), { bad: true });
  } finally {
    const d = S.detail.get(id);
    if (!(d && d.timedOut)) S.detail.delete(id);
    renderAll();
  }
}
// ---------------- 看進度：步驟清單只在 opp_get／opp_progress，opp_list 不帶 ----------------
async function ensureProgress(id, force) {
  const it = get(id); if (!it || it.status !== 'doing') return;
  const cur = S.prog.get(id);
  if (cur && cur.busy) return;
  if (!force && it.progressSteps && cur && cur.at === it.progressUpdatedAt) return;
  S.prog.set(id, { busy: true, at: cur && cur.at });
  try {
    // 已有全文就用 opp_get（全文＋步驟一次拿）；沒有全文用較輕的 opp_progress
    const c = it.hasFullText && !it.detailText ? await api.get(id) : await api.progress(id);
    put(c);
    S.prog.set(id, { busy: false, at: get(id) && get(id).progressUpdatedAt });
  } catch (e) {
    S.prog.set(id, { busy: false, at: cur && cur.at });
    if (e instanceof AdapterError && e.kind === 'auth') { setAuth(); renderAll(); }
  }
  redrawDrawer(id);
  if (get(id) && laneOf(get(id)) === 'active') renderBoard();   // 卡片上的付款鈕、已送件判斷都可能因步驟而變
}


// ---------------- 跟肉咖說（v5；後端 opp_msg_add／opp_msg_list，sql/24） ----------------
// 對話 key：卡片 id；不綁案子的對話是 ''（p_id 送 null）。
// opp_msg_list(p_id 空) 不論回「全部」或「只回不綁案子的」，前端都只把不綁案子的放進總對話，其餘拿來算頂列紅點。
const MSG_NOTE = '肉咖會處理或轉給負責的視窗；花錢、刪檔、付款要 Borry 本人同意。';
const MSG_ST = { sending: '傳送中', new: '已送出', picked: '肉咖收到了', received: '肉咖收到了', seen: '肉咖收到了', handling: '肉咖收到了', in_progress: '肉咖收到了', done: '處理完', handled: '處理完' };
const MSG_MAX = 1000;
let tmpN = 0;
const SEEN_KEY = () => 'copp.msgseen.v1:' + (api && api.mode === 'mock' ? 'mock:' + (qs.get('mock') || '') : keyTag());
function seenStore() {
  let o = null; try { o = JSON.parse(localStorage.getItem(SEEN_KEY()) || 'null'); } catch (e) {}
  if (!o || typeof o !== 'object') { o = { base: tnow(), keys: {} }; try { localStorage.setItem(SEEN_KEY(), JSON.stringify(o)); } catch (e) {} }   // 第一次開：之前的舊回覆不算新的
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
function unreadReplies() {
  const o = seenStore();
  return msgsAll().filter(m => m.author === RK && !sysMsg(m) && m.createdAt && m.createdAt > Math.max(o.base || 0, o.keys[m.itemId || ''] || 0));
}
function renderRk() {
  const b = $('#rkbtn'); if (!b) return;
  const n = unreadReplies().length;
  b.hidden = S.net === 'auth';
  b.innerHTML = '<span>肉咖</span>' + (n ? '<i class="rk-dot" aria-hidden="true"></i>' : '');
  b.setAttribute('aria-label', '跟肉咖說' + (n ? '，有 ' + n + ' 則新回覆' : ''));
}
async function ensureMsgs(key, force) {
  if (!api || !api.msgList || S.net === 'auth' || S.msgBusy.has(key)) return;
  S.msgBusy.add(key);
  try {
    const list = await api.msgList(key, CONFIG.MSG_LIMIT);
    const old = S.msgs.get(key);
    const same = old && JSON.stringify(old.list) === JSON.stringify(list);
    S.msgs.set(key, { list, at: tnow() });
    if (!same || !old) { if (chatOpenFor(key)) renderDrawer(); renderRk(); }
  } catch (e) {
    if (e instanceof AdapterError && e.kind === 'auth') { setAuth(); renderAll(); }
    else if (!S.msgs.has(key)) { S.msgs.set(key, { list: [], at: tnow(), err: true }); if (chatOpenFor(key)) renderDrawer(); }
  } finally { S.msgBusy.delete(key); }
}
function loadMsgs() {
  ensureMsgs('');
  const did = S.drawer && S.drawer.id; if (did && did.slice(0, 2) !== '__') ensureMsgs(did);
}
const chatOpenFor = key => !!S.drawer && (S.drawer.view === 'chat' ? key === '' : S.drawer.id === key && ['full', 'progress', 'preview', 'archived'].includes(viewOf()));
// 卡片抽屜的對話列（v7，Borry「卡片點下去應該也能有肉咖對話框啊」）：固定在底欄上方，上面接這張卡最近 3 則，可以展開全部
const dockOpen = new Set(), dockShow = new Set();   // dockShow：展開中的卡（v7.1 預設收起，Borry「點開卡片會被肉咖的對話卡一半」）
// v72（Borry「跟肉咖說話在彈出就好」）：抽屜裡只放浮動的小按鈕，點了跳出底部彈窗（對話＋輸入框），關掉回到卡片
function chatDock(key) {
  const th = threadOf(key), n = th ? th.length : 0, k = esc(key), d = S.draft.get(key) || '';
  const unread = unreadReplies().filter(m => (m.itemId || '') === key).length, hasDraft = !!d.trim();
  const fab = '<div class="fab-wrap"><button class="rk-fab" data-act="dock-toggle" data-key="' + k + '" type="button" aria-haspopup="dialog" aria-expanded="' + dockShow.has(key) + '" aria-label="跟肉咖說，' + n + ' 則' + (unread ? '，有 ' + unread + ' 則新回覆' : '') + (hasDraft ? '，有沒送出的草稿' : '') + '">' +
    '<span aria-hidden="true">💬</span> 跟肉咖說（' + n + '）' + (hasDraft ? '<span class="fab-d">・有草稿</span>' : '') + (unread ? '<i class="rk-dot dock-dot" aria-hidden="true"></i>' : '') + '</button></div>';
  if (!dockShow.has(key)) return fab;
  const list = !th ? '<p class="chat-empty">讀取對話中…</p>' : n ? '<ol class="msgs">' + th.map(m => msgLi(m, th)).join('') + '</ol>'
    : '<p class="chat-empty">' + (S.msgs.get(key) && S.msgs.get(key).err ? '對話讀不到，等一下會自動再試。' : '這張卡還沒有對話。有事直接跟肉咖說。') + '</p>';
  const input = can('act')
    ? '<div class="dock-in"><textarea id="chat-input" data-key="' + k + '" maxlength="' + MSG_MAX + '" rows="1" placeholder="跟肉咖說這張卡的事…" aria-label="寫給肉咖的訊息（這張卡）">' + esc(d) + '</textarea>' +
      '<button class="btn btn-primary" data-act="msg-send" data-key="' + k + '" type="button">送出</button></div><p class="dock-note">' + MSG_NOTE + '</p>'
    : '<p class="chat-ro">你的金鑰只能看對話，不能發言。</p>';
  const it = get(key) || S.archMap.get(key);
  return fab + '<div class="cs-scrim" data-act="dock-toggle" data-key="' + k + '" aria-hidden="true"></div>' +
    '<div class="csheet" role="dialog" aria-modal="true" aria-label="跟肉咖說"><div class="cs-h"><b>跟肉咖說</b>' + (it ? '<span class="cs-t">' + esc(nm(it)) + '</span>' : '') +
    '<button class="dock-close" data-act="dock-toggle" data-key="' + k + '" type="button">關閉</button></div>' +
    (canDelMsg() && n ? '<button class="cs-clear" data-act="msg-clear" data-key="' + k + '" type="button">清空這張卡的對話</button>' : '') +
    '<div class="dock-th">' + list + '</div>' + input + '</div>';
}
// 步驟按鈕（sql/32）
const STEP_ERR = [[/not_step_owner/, '這一步不是你負責的，只有負責人或管理員可以按'], [/bid_managed/, '這一步照領標狀態由系統自動處理'], [/note_too_long/, '備註最多 200 字'],
  [/no_step/, '這一步不見了，重新整理一次'], [/bad_status/, '狀態不對，重新整理一次'], [/not found/i, '這張卡不見了，重新整理一次']];
async function doStepMark() {
  const d = S.dlg; if (!d || d.busy) return;
  d.busy = true; renderDlg();
  try {
    const c = await api.stepMark(d.id, d.k, d.st, String(d.note || '').trim());
    if (c) put(c);
    S.dlg = null; renderDlg();
    toast({ done: '已標成完成', current: '已標成進行中', undone: '已退回未完成' }[d.st] || '已更新');
    renderAll(); ensureEvents(d.id, true);
  } catch (e) {
    S.dlg = null; renderDlg();
    if (e instanceof AdapterError && e.kind === 'auth') setAuth();
    if (e instanceof AdapterError && e.kind === 'perm') loadWho();
    const hit = STEP_ERR.find(([re]) => re.test(e.message || ''));
    toast((hit ? hit[1] : reason(e)), { bad: true }); ensureProgress(d.id, true);
  }
}
// 分享（手機叫出系統分享，可以傳 LINE、AirDrop、存到檔案）；不支援就複製連結
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
// 誰接進來了（sql/35，只有 admin）：頂列「肉咖」抽屜最上面一小節
async function loadPresence() {
  if (!can('admin') || !api || !api.presence || S.presOff) return;
  try { S.presence = await api.presence(); }
  catch (e) { if (/Could not find the function|PGRST202/i.test(e.message || '') || (e instanceof AdapterError && e.kind === 'perm')) S.presOff = true; else if (!S.presence) S.presence = 'err'; }
  if (S.drawer && S.drawer.view === 'chat') renderDrawer();
}
function presText(p) {
  if (p.status === 'today') return '✅ 今天 ' + (p.lastSeenAt ? hm(p.lastSeenAt) + ' ' : '') + '開過';
  if (p.status === 'recent') return '✅ ' + (p.statusText || (p.lastSeenAt ? Math.max(1, Math.floor((tnow() - p.lastSeenAt) / D)) + ' 天前開過' : '最近開過'));
  if (p.status === 'stale') return '😴 ' + (p.lastSeenAt ? Math.floor((tnow() - p.lastSeenAt) / D) + ' 天沒開' : '很久沒開');
  return '⏳ 還沒打開';
}
function presHTML() {
  if (!can('admin') || S.presOff || !S.presence) return '';
  if (S.presence === 'err') return '<section class="dt-sec pres"><h3>誰接進來了</h3><p class="sd-empty">讀不到，等一下再打開一次。</p></section>';
  return '<section class="dt-sec pres"><h3>誰接進來了</h3><ul class="pres-l">' + S.presence.map(p => {
    const o = S.presOpen.has(p.name), n = esc(p.name);
    return '<li><button class="pres-r" type="button" data-act="pres-tog" data-n="' + n + '" aria-expanded="' + o + '"><b>' + n + '</b><span class="pres-' + (p.status === 'recent' ? 'today' : p.status) + '">' + esc(presText(p)) + '</span></button>' +
      (o ? '<p class="pres-d">第一次打開：' + (p.firstSeenAt ? fmtDate(p.firstSeenAt) : '還沒') + '<br>最後一次打開：' + (p.lastSeenAt ? fmtDate(p.lastSeenAt) : '還沒') + (p.seenCount ? '（共 ' + p.seenCount + ' 次）' : '') + '<br>最後一次動作：' + (p.lastActionAt ? fmtDate(p.lastActionAt) : '還沒有') + '</p>' : '') + '</li>';
  }).join('') + '</ul></section>';
}
// 刪對話（sql/33，只有 admin）：後端沒有這兩支函式時（PGRST202）整個藏起來
const canDelMsg = () => can('admin') && !!api && !!api.msgDelete && !S.msgDelOff;
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
function closeDock(k) {
  dockShow.delete(k);
  if ((S.draft.get(k) || '').trim()) toast('有沒送出的字，已幫你留著');   // D 複審 v71：有草稿時收起要有回饋
  else S.draft.delete(k);
  renderDrawer(); $('#drawer .rk-fab')?.focus({ preventScroll: true });
}
function dockScroll(dr) { const t = dr.querySelector('.dock-th'); if (t) t.scrollTop = t.scrollHeight; }   // 最新的在最下面
function threadOf(key) {
  const st = S.msgs.get(key);
  const list = st ? st.list.filter(m => (m.itemId || '') === key) : null;
  const pend = S.pend.get(key) || [];
  return list ? list.slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)).concat(pend) : null;   // 舊的在上
}
// v81：kind 不是 msg 的（paid 付款、step 步驟、bid Pool 偵測，都是系統寫的）用系統通知樣式，不當成人講的話
const SYS_KIND = { paid: '付款紀錄', step: '進度紀錄', bid: 'Pool 偵測' };
const sysMsg = m => !!m.kind && m.kind !== 'msg';
function msgLi(m, all) {
  if (sysMsg(m)) {
    const del = canDelMsg() && m.id ? '<button class="msg-del" data-act="msg-del" data-mid="' + esc(m.id) + '" data-key="' + esc(m.itemId || '') + '" type="button" aria-label="刪掉這則紀錄">🗑</button>' : '';
    return '<li class="msg sys"><p class="msg-h"><b>' + esc(SYS_KIND[m.kind] || '系統紀錄') + '</b>' + (m.createdAt ? ' · <span data-rel="' + m.createdAt + '">' + relTime(m.createdAt, tnow()) + '</span>' : '') + del + '</p>' +
      '<div class="msg-b">' + para(m.body) + '</div></li>';
  }
  const rk = m.author === RK;
  const st = m.pending ? MSG_ST.sending : rk ? '' : (MSG_ST[m.status] || '');
  const orig = rk && m.replyTo ? all.find(x => x.id === m.replyTo) : null;
  const del = canDelMsg() && !m.pending && m.id ? '<button class="msg-del" data-act="msg-del" data-mid="' + esc(m.id) + '" data-key="' + esc(m.itemId || '') + '" type="button" aria-label="刪掉這則（連同回覆）">🗑</button>' : '';
  return '<li class="msg ' + (rk ? 'rk' : 'me') + (m.pending ? ' pending' : '') + '">' +
    '<p class="msg-h"><b>' + esc(m.author || '不明') + '</b>' + (m.createdAt ? ' · <span data-rel="' + m.createdAt + '">' + relTime(m.createdAt, tnow()) + '</span>' : '') + del + '</p>' +
    (orig ? '<p class="msg-q">回覆「' + esc(orig.body.length > 24 ? orig.body.slice(0, 24) + '…' : orig.body) + '」</p>' : '') +
    '<div class="msg-b">' + para(m.body) + '</div>' + (st ? '<p class="msg-st">' + st + '</p>' : '') + '</li>';
}
function chatHTML(key) {
  const th = threadOf(key), all = th || [];
  const list = !th ? '<p class="chat-empty">讀取對話中…</p>'
    : th.length ? '<ol class="msgs">' + th.map(m => msgLi(m, all)).join('') + '</ol>'
    : '<p class="chat-empty">' + (S.msgs.get(key) && S.msgs.get(key).err ? '對話讀不到，等一下會自動再試。' : '還沒有對話。有事直接跟肉咖說。') + '</p>';
  const k = esc(key), d = S.draft.get(key) || '';
  const box = can('act')
    ? '<div class="chat-in"><p class="chat-note">' + MSG_NOTE + '</p>' +
      '<textarea id="chat-input" data-key="' + k + '" maxlength="' + MSG_MAX + '" rows="2" placeholder="想請肉咖做什麼？" aria-label="寫給肉咖的訊息">' + esc(d) + '</textarea>' +
      '<div class="chat-acts"><span class="chat-cnt" id="chat-cnt">' + d.length + '／' + MSG_MAX + '</span><button class="btn btn-primary" data-act="msg-send" data-key="' + k + '" type="button">送出</button></div></div>'
    : '<p class="chat-ro">你的金鑰只能看對話，不能發言。</p>';
  return '<section class="dt-sec chat" aria-label="跟肉咖說"><h3>跟肉咖說</h3>' + list + box + '</section>';
}
// 不綁案子的總對話抽屜
function openChat() {
  if (!S.drawer) lastFocus = document.activeElement;
  S.drawer = { id: '__chat', view: 'chat' };
  ensureMsgs(''); loadPresence();
  renderDrawer(); syncOverlay();
  ($('#chat-input') || $('#drawer .xb'))?.focus({ preventScroll: true });
}
function renderChatDrawer(dr) {
  const keep = chatFocus();
  const sc = dr.querySelector('.db') && dr.dataset.key === '__chat' ? dr.querySelector('.db').scrollTop : 0;
  // 案子裡的新回覆（總對話只放不綁案子的，案子裡的回覆列出來，點了打開那張卡）
  // 各案最近對話（v7）：每張卡最新一則＋短案名，有肉咖新回覆的標出來，點了打開那張卡（A 驗收時發現 v5 頂列看不到綁卡的訊息）
  const unread = {}, last = new Map();
  unreadReplies().filter(m => m.itemId).forEach(m => { unread[m.itemId] = (unread[m.itemId] || 0) + 1; });
  msgsAll().filter(m => m.itemId).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).forEach(m => { if (!last.has(m.itemId)) last.set(m.itemId, m); });
  const recent = [...last.values()].slice(0, 8);
  const oth = recent.length ? '<section class="dt-sec chat-cards"><h3>各案最近對話</h3><div class="cc-list">' + recent.map(m => {
      const it = get(m.itemId), u = unread[m.itemId] || 0, body = m.body.length > 40 ? m.body.slice(0, 40) + '…' : m.body;
      return '<button class="cc-row' + (u ? ' new' : '') + '" data-act="chat-card" data-id="' + esc(m.itemId) + '" type="button"><span class="cc-h"><b>' + esc(it ? nm(it) : (m.itemShortTitle || '已不在看板的案子')) + '</b>' +
        (u ? '<i class="cc-n">' + u + ' 則新回覆</i>' : '') + '<span class="cc-t">' + relTime(m.createdAt, tnow()) + '</span></span><span class="cc-b">' + (sysMsg(m) ? '' : esc(m.author || '不明') + '：') + esc(body) + '</span></button>'; }).join('') + '</div></section>' : '';
  dr.innerHTML = '<div class="dh"><span>跟肉咖說</span><button class="xb" data-act="close-drawer" type="button" aria-label="關閉">×</button></div><div class="db"><div class="dt">' + presHTML() + oth + chatHTML('') + '</div></div>' +
    '<div class="df"><button class="btn btn-ghost" data-act="close-drawer" type="button">回到面板</button></div>';
  dr.setAttribute('aria-label', '跟肉咖說');
  dr.dataset.key = '__chat';
  const db = dr.querySelector('.db'); db.scrollTop = sc || db.scrollHeight;   // 第一次打開捲到最新
  dr.classList.add('show');
  chatRestore(keep);
  markSeen('');
}
// 重畫抽屜時保留輸入框的焦點與游標（草稿內容存在 S.draft）
const KEEP_IDS = ['chat-input', 'bid-amt', 'bid-rc', 'bid-note'];
function chatFocus() { const a = document.activeElement; return a && KEEP_IDS.includes(a.id) ? [a.selectionStart, a.selectionEnd, a.id] : null; }
function chatRestore(k) { if (!k) return; const t = document.getElementById(k[2] || 'chat-input'); if (t) { t.focus({ preventScroll: true }); try { t.setSelectionRange(k[0], k[1]); } catch (e) {} } }
async function msgSend(key) {
  const text = (S.draft.get(key) || '').trim();
  if (!text) { $('#chat-input')?.focus(); return; }
  if (text.length > MSG_MAX) { toast('訊息太長，最多 ' + MSG_MAX + ' 字', { bad: true }); return; }
  if (!can('act')) { toast(reason(new AdapterError('perm', '')), { bad: true }); return; }
  const tmp = { id: 'tmp' + (++tmpN), itemId: key, author: (S.who && S.who.role) || '我', body: text, status: 'sending', createdAt: tnow(), pending: true };
  S.pend.set(key, (S.pend.get(key) || []).concat(tmp));
  S.draft.set(key, '');
  renderDrawer();
  try {
    await api.msgAdd(key, text);
    S.pend.set(key, (S.pend.get(key) || []).filter(m => m !== tmp));
    await ensureMsgs(key, true);
    if (key) ensureMsgs('');
    renderDrawer();
  } catch (e) {
    S.pend.set(key, (S.pend.get(key) || []).filter(m => m !== tmp));   // 回滾：拿掉「傳送中」，文字放回輸入框
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
  const c = $('#chat-cnt'); if (c) c.textContent = e.target.value.length + '／' + MSG_MAX;
  if (e.target.closest('.dock-in')) { e.target.style.height = '44px'; e.target.style.height = Math.min(120, e.target.scrollHeight + 2) + 'px'; }   // 對話列的輸入框跟著字數長高，最多 120
});
document.addEventListener('keydown', e => {   // Ctrl／⌘＋Enter 送出
  if (e.target.id === 'chat-input' && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); msgSend(e.target.dataset.key || ''); }
});

// ---------------- 立即掃描（v5；後端 opp_scan_request／opp_scan_status） ----------------
// 政府標案、補助徵件、企劃提案三籃欄頭各一顆。排隊或掃描中轉圈；15 分鐘內掃過按鈕寫「剛掃過」並灰掉；viewer 只看得到上次掃描時間。
const SCAN_COOL = 15 * 60e3;
// 企劃提案跟補助徵件是同一次掃描（F）：pitch 自己沒有紀錄時，借用補助的狀態，按鈕也是去掃補助（D 審稿 #6）
const scanShared = k => k === 'pitch' && !!S.scan.grant && !(S.scan.pitch && (S.scan.pitch.status || S.scan.pitch.lastDoneAt));
const scanOf = k => scanShared(k) ? S.scan.grant : S.scan[k];
const scanning = k => { const x = scanOf(k); return !!x && (x.status === 'queued' || x.status === 'running'); };
const hm = ms => { const d = new Date(ms + 8 * H); return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0'); };
const lastScan = x => x && (x.lastDoneAt || (x.status === 'done' ? x.doneAt : null));
// 掃描進度（F 兩段式）：排隊中 → 掃描中 → 肉咖判讀中 → 送進看板中；後端還沒給 phase 時，running 一律寫「掃描中」
const scanPhase = x => !x ? '' : x.status === 'queued' ? '排隊中' : ({ judging: '肉咖判讀中', sending: '送進看板中' }[x.phase] || '掃描中');
const scanDur = k => k === 'watch' ? '3～5' : '2～5';   // 盯案後續掃描比較久
function scanBox(k) {
  if (!SCAN_LANES.includes(k)) return '';
  if (k === 'watch' && !(S.scanSeen && S.scanSeen.has('watch'))) return '';
  if (S.scanClosed && S.scanClosed.has(k)) return '';   // 舊後端沒有 lanes.watch：不畫按鈕
  const x = scanOf(k), last = lastScan(x), now = tnow(), shared = scanShared(k);
  const lastTxt = last ? '上次掃描 ' + (now - last < D ? hm(last) : fmtDate(last)) : '';
  let st = '';
  const res = x && (x.resultMain || (x.added == null ? '' : '新增 ' + x.added + ' 件'));
  const det = x && x.resultDetail ? ' · ' + esc(x.resultDetail) : '';   // v73：判讀明細接在同一行，放不下就截斷
  if (scanning(k)) st = scanPhase(x) + '，全程約 ' + scanDur(k) + ' 分鐘';
  else if (x && x.status === 'done' && x.doneAt && now - x.doneAt < SCAN_COOL) st = (lastTxt ? lastTxt + ' · ' : '') + '完成：' + esc(res || '沒有新的') + det;
  else if (x && x.status === 'failed') st = (lastTxt ? lastTxt + ' · ' : '') + '失敗：' + esc(((x.resultMain || '') + (x.resultDetail ? '（' + x.resultDetail + '）' : '')) || '沒有回報原因');
  else st = lastTxt;
  if (shared) st = (st ? st + ' · ' : '') + '跟補助徵件一起掃';
  const cool = last && now - last < SCAN_COOL;
  // v73（Borry「立即掃描按鈕用重新整理的小符號跟一行小字…放一列在上面就好了」）：左邊上次掃描（太長截斷），右邊「↻ 立即掃描」完整留著
  const btn = !can('act') ? ''
    : scanning(k) ? '<button class="scan-mini" type="button" disabled aria-disabled="true"><i class="rot spin-r" aria-hidden="true">↻</i>掃描中…</button>'
    : cool ? '<button class="scan-mini" type="button" disabled aria-disabled="true" title="15 分鐘內掃過，晚點再掃"><i class="rot" aria-hidden="true">↻</i>剛掃過</button>'
    : '<button class="scan-mini" data-act="scan" data-lane="' + (shared ? 'grant' : k) + '" type="button" aria-label="立即掃描' + (shared ? LN.grant + '和' + LN.pitch : LN[k]) + '"><i class="rot" aria-hidden="true">↻</i>立即掃描</button>';
  const plain = st.replace(/<[^>]+>/g, '');
  return '<div class="scan" data-scan="' + k + '" aria-live="polite"><span class="scan-st" title="' + plain + '">' + (st || '還沒掃過') + '</span>' + btn + '</div>';
}
function renderScan() { document.querySelectorAll('.scan[data-scan]').forEach(el => { const k = el.dataset.scan; el.outerHTML = scanBox(k); }); }
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
    if (seenChanged) renderBoard(); else if (JSON.stringify(S.scan) !== before) renderScan();   // 盯案後續的按鈕第一次出現要重畫欄頭
    if (SCAN_LANES.some(k => was[k] && !scanning(k))) ping();   // 剛掃完：馬上重抓列表，新卡才會出現
    if (SCAN_LANES.some(scanning)) kickPoll();
  } catch (e) {
    if (e instanceof AdapterError && e.kind === 'auth') { setAuth(); renderAll(); }
  } finally { S.scanBusy.delete('*'); }
}
async function scanNow(k) {
  if (!SCAN_LANES.includes(k) || scanning(k) || S.scanBusy.has(k)) return;
  if (!can('act')) { toast(reason(new AdapterError('perm', '')), { bad: true }); return; }
  const prev = S.scan[k];
  S.scanBusy.add(k);
  S.scan[k] = Object.assign({}, prev || { lane: k }, { status: 'queued', createdAt: tnow(), doneAt: null, added: null });   // 樂觀：先轉圈
  renderScan(); kickPoll();
  try {
    const res = await api.scanRequest(k);
    if (res) S.scan[k] = Object.assign({}, res, { lastDoneAt: res.lastDoneAt || (prev && prev.lastDoneAt) || null });   // 請求那筆不帶 last_done_at，沿用上次的
    toast(res && res.state === 'already' ? '「' + LN[k] + '」已經在掃描了，全程約 ' + scanDur(k) + ' 分鐘'
      : res && res.state === 'recent' ? '「' + LN[k] + '」15 分鐘內剛掃過，先看看新卡'
      : '已開始掃描「' + LN[k] + '」，掃描加肉咖判讀全程約 ' + scanDur(k) + ' 分鐘');
  } catch (e) {
    S.scan[k] = prev;   // 回滾
    if (e instanceof AdapterError && e.kind === 'auth') setAuth();
    if (e instanceof AdapterError && e.kind === 'perm') loadWho();
    if (e instanceof AdapterError && e.kind === 'state' && /lane must be/i.test(e.message)) { S.scanClosed = S.scanClosed || new Set(); S.scanClosed.add(k); toast('這欄的立即掃描還沒開通'); return; }   // 這次開頁不再畫這顆，重新整理才再試   // 雲端 26 還沒收 watch（22023）
    toast('沒有開始掃描：' + reason(e), { bad: true });
  } finally { S.scanBusy.delete(k); renderScan(); kickPoll(); }
}

// ---------------- 封存區、結案與徹底刪除（v6；後端 opp_archive／opp_unarchive／opp_archive_list／opp_purge，sql/25） ----------------
const KIND = OUTCOME;
const KIND_DESC = { won: '得標或補助核定', lost: '沒有得標或沒入選', submitted: '已經送件，後續不追了', withdrawn: '做一半不要了' };
const KIND_CLS = { won: 'k-won', lost: 'k-lost', submitted: 'k-sub', withdrawn: 'k-wd' };
const getAny = id => get(id) || S.archMap.get(id);
const shortName = it => (it.shortTitle || it.title || '').trim();
const purgeOk = (it, t) => { t = String(t || '').trim(); return !!t && (t === shortName(it) || t === (it.title || '').trim()); };
const kindBadge = it => it.archiveKind ? '<span class="kind-b ' + KIND_CLS[it.archiveKind] + '">' + KIND[it.archiveKind] + '</span>' : '<span class="kind-b k-lost">已結案</span>';
// 徹底刪除：只有 admin 才畫，放在底欄最右邊（跟待看卡的「刪掉」不同：刪掉 72 小時內救得回來，徹底刪除救不回來）
const purgeBtn = it => can('admin') ? '<button class="btn btn-ghost purge" data-act="purge-start" data-id="' + esc(it.id) + '" type="button">徹底刪除</button>' : '';

// ----- 確認框（結案、徹底刪除共用） -----
function closeDlg() { S.dlg = null; renderDlg(); const d = $('#drawer.show'); if (d) d.querySelector('.xb')?.focus({ preventScroll: true }); }
function renderDlg() {
  const wrap = $('#dlg'); if (!wrap) return;
  const msgDlg = d => d.type === 'msgdel' || d.type === 'msgclear';   // 刪對話不需要卡片：全面板的訊息 data-key 是空字串（D 複審 v73）
  const d = S.dlg, it = d && (d.type === 'fu' ? fuGet(d.id) : msgDlg(d) ? (getAny(d.id) || { title: '全面板', shortTitle: '全面板' }) : getAny(d.id));
  if (!d || !it) { wrap.hidden = true; S.dlg = null; return; }
  const box = wrap.querySelector('.dlg'), name = esc(shortName(it));
  const keepFocus = document.activeElement && box.contains(document.activeElement) ? document.activeElement.id : '';
  let html = '';
  if (d.type === 'archive' && d.step === 'pick') {
    html = '<h2 id="dlg-t">' + (d.re ? '改結案結果「' : '結案「') + name + '」</h2><p class="dlg-p">' + (d.re ? '只改結果，結案日不變。' : '選一個結果。案子會在進行中再留 14 天才從看板撤下，封存區隨時找得到；資料夾和 Drive 都保留。') + '</p>' +
      '<div class="kind-list" role="radiogroup" aria-label="結案結果">' + ['won', 'lost', 'submitted', 'withdrawn'].map(k =>
        '<label class="kind-opt' + (d.kind === k ? ' on' : '') + '"><input type="radio" name="arch-kind" value="' + k + '"' + (d.kind === k ? ' checked' : '') + '><span><b>' + KIND[k] + '</b><small>' + KIND_DESC[k] + '</small></span></label>').join('') + '</div>' +
      '<label class="dlg-l" for="arch-note">備註（選填）</label><input id="arch-note" class="dlg-in" type="text" maxlength="200" placeholder="例如：決標公告日 11/20" value="' + esc(d.note) + '">' +
      '<div class="dlg-acts"><button class="btn btn-ghost" data-act="dlg-close" type="button">取消</button><button class="btn btn-primary" data-act="arch-next" type="button"' + (d.kind ? '' : ' disabled') + '>下一步</button></div>';
  } else if (d.type === 'archive') {
    html = '<h2 id="dlg-t">確定結案？</h2><p class="dlg-p">' + (d.re ? '確定把「' + name + '」的結果改成『' + KIND[d.kind] + '』？' : '確定把「' + name + '」封存為『' + KIND[d.kind] + '』？') + '</p>' + (d.note ? '<p class="dlg-note">備註：' + esc(d.note) + '</p>' : '') +
      (d.re ? '' : '<p class="dlg-p small">' + (can('admin') ? '封存後幾秒內可以按「復原」，之後在封存區按「重新打開」。' : '封存後要找管理員才能重新打開。') + '</p>') +
      '<div class="dlg-acts"><button class="btn btn-ghost" data-act="arch-back-pick" type="button">返回</button><button class="btn btn-primary" data-act="arch-confirm" type="button">' + (d.re ? '確定修改' : '確定封存') + '</button></div>';
  } else if (d.type === 'fu') {
    const done = d.to === 'done';
    html = '<h2 id="dlg-t">' + (done ? '標成完成' : '取消這件事') + '</h2><p class="dlg-p">「' + esc(it.title) + '」' + (it.owner ? '（' + esc(it.owner) + '）' : '') + '</p>' +
      '<label class="dlg-l" for="fu-note">' + (done ? '完成的依據' : '取消的原因') + '（選填）</label><input id="fu-note" class="dlg-in" type="text" maxlength="500" placeholder="' + (done ? '例如：群組 11/16 Louis 說已回' : '例如：改外景，不用了') + '" value="' + esc(d.note) + '">' +
      '<div class="dlg-acts"><button class="btn btn-ghost" data-act="dlg-close" type="button">返回</button><button class="btn btn-primary" data-act="fu-confirm" type="button">' + (done ? '標成完成' : '確定取消') + '</button></div>';
  } else if (d.type === 'stepmark') {
    const s = (it.progressSteps || []).find(x => x.key === d.k), sn = esc(s ? s.name : d.k);
    const w = { done: '標成完成', current: '標成進行中', undone: '退回未完成' }[d.st] || '更新';
    html = '<h2 id="dlg-t">' + (d.st === 'undone' ? '把「' + sn + '」退回未完成？' : '把「' + sn + '」' + w + '？') + '</h2><p class="dlg-p">「' + name + '」。按下去會記下是你按的，大家都看得到。</p>' +
      '<label class="dlg-l" for="step-note">備註（選填，最多 200 字）</label><input id="step-note" class="dlg-in" type="text" maxlength="200" value="' + esc(d.note || '') + '" placeholder="例如：石頭已用印、寄出">' +
      '<div class="dlg-acts"><button class="btn btn-ghost" data-act="dlg-close" type="button">取消</button><button class="btn btn-primary" data-act="step-mark-confirm" type="button"' + (d.busy ? ' disabled' : '') + '>' + w + '</button></div>';
  } else if (d.type === 'msgdel' || d.type === 'msgclear') {
    const all = d.type === 'msgclear';
    html = '<h2 id="dlg-t" class="danger">' + (all ? '清空這張卡的對話' : '刪掉這則訊息') + '</h2><p class="dlg-p">' + (all ? '「' + name + '」底下的對話會全部刪掉（包含肉咖的回覆和付款、步驟通知），無法復原。卡片、進度和付款紀錄不會動。' : '這則訊息和底下的回覆會一起刪掉，無法復原。') + '</p>' +
      '<div class="dlg-acts"><button class="btn btn-ghost" data-act="dlg-close" type="button">取消</button><button class="btn btn-danger" data-act="msg-del-confirm" type="button"' + (d.busy ? ' disabled' : '') + '>' + (all ? '確定清空' : '確定刪掉') + '</button></div>';
  } else if (d.type === 'purge') {
    const ok = purgeOk(it, d.typed);
    html = '<h2 id="dlg-t" class="danger">徹底刪除</h2><p class="dlg-p">這會讓「' + name + '」從面板徹底消失，無法復原。電腦裡的資料夾和 Drive 檔案不會被刪。</p>' +
      '<label class="dlg-l" for="purge-in">請輸入短案名「' + name + '」才能刪除</label><input id="purge-in" class="dlg-in" type="text" autocomplete="off" value="' + esc(d.typed) + '">' +
      '<div class="dlg-acts"><button class="btn btn-ghost" data-act="dlg-close" type="button">取消</button><button class="btn btn-danger" data-act="purge-confirm" type="button"' + (ok ? '' : ' disabled') + '>徹底刪除</button></div>';
  }
  box.innerHTML = html; wrap.hidden = false;
  const f = (keepFocus && document.getElementById(keepFocus)) || box.querySelector('#fu-note, #step-note, #purge-in, input[name=arch-kind]:checked, input[name=arch-kind], .btn-primary');
  f && f.focus({ preventScroll: true });
}
document.addEventListener('input', e => {
  if (!S.dlg) return;
  if (e.target.name === 'arch-kind') { S.dlg.kind = e.target.value; renderDlg(); }
  else if (e.target.id === 'arch-note' || e.target.id === 'fu-note') S.dlg.note = e.target.value;
  else if (e.target.id === 'purge-in') { S.dlg.typed = e.target.value; const b = $('#dlg [data-act=purge-confirm]'), it = getAny(S.dlg.id); if (b && it) b.disabled = !purgeOk(it, S.dlg.typed); }
});
document.addEventListener('change', e => { if (S.dlg && e.target.name === 'arch-kind') { S.dlg.kind = e.target.value; renderDlg(); } });
function archNext() { if (!S.dlg || !S.dlg.kind) return; const n = $('#arch-note'); if (n) S.dlg.note = n.value.trim(); S.dlg.step = 'confirm'; renderDlg(); }
async function doArchive() {
  const d = S.dlg, it = d && get(d.id); if (!it) { closeDlg(); return; }
  if (!can('act')) { toast(reason(new AdapterError('perm', '')), { bad: true }); return; }
  const prev = { ...it }, kind = d.kind, note = d.note, re = it.progressStatus === 'done';
  S.dlg = null; renderDlg();
  // 樂觀（sql/25）：卡片仍是 doing，進度標成已結案、未完成步驟補完（作廢標略過）；結案 14 天後才從看板撤下，結案日改結果時不變
  const at = re && it.progressArchiveAt ? it.progressArchiveAt : tnow() + 14 * D;
  const fin = kind === 'withdrawn' ? 'skipped' : 'done';
  S.items.set(it.id, { ...it, progressStatus: 'done', progressState: 'done', progressOutcome: kind, archiveKind: kind, progressArchiveAt: at, archivedAt: at - 14 * D,
    progressNote: note || it.progressNote, progressPct: 100,
    progressSteps: re || !it.progressSteps ? it.progressSteps : it.progressSteps.map(s => s.status === 'done' || s.status === 'skipped' ? s : { ...s, status: fin, doneAt: fin === 'done' ? tnow() : null }) });
  locks.add(it.id); renderAll();
  toast(re ? '已把「' + nm(it) + '」改成『' + KIND[kind] + '』' : '已結案「' + nm(it) + '」：' + KIND[kind] + '。14 天後從看板撤下，封存區隨時找得到',
    { undo: can('admin') && !re ? () => doUnarchive(it.id, prev) : null });   // 復原只給 admin（opp_unarchive）；改結果不給復原
  try {
    const res = await api.archive(it.id, kind, note);
    mutDone[it.id] = tnow();
    if (res) { S.items.set(it.id, mergeCard(get(it.id), res)); S.archMap.set(it.id, get(it.id)); }
    S.arch.list = null;   // 封存區下次打開重抓
    saveSnapshot();
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
    if (S.drawer && S.drawer.view === 'archived' && S.drawer.id === id) S.drawer = { id, view: 'progress' };   // 從封存區重新打開：直接看它的進度
    toast('已重新打開，放回進行中'); renderAll(); refresh();
  } catch (e) {
    if (e instanceof AdapterError && e.kind === 'perm') loadWho();
    toast('沒有復原成功：' + reason(e), { bad: true });
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
    if (S.drawer && (S.drawer.id === it.id)) { if (S.drawer.view === 'archived') { S.drawer = { id: '__arch', view: 'archive' }; } else closeDrawer(true); }
    toast('已徹底刪除');   // 沒有復原鍵
    saveSnapshot(); renderAll();
  } catch (e) {
    if (e instanceof AdapterError && e.kind === 'auth') setAuth();
    if (e instanceof AdapterError && e.kind === 'perm') loadWho();
    toast('沒有刪除：' + (e instanceof AdapterError && /confirm|title/i.test(e.message) ? '短案名不對' : reason(e)), { bad: true });
    renderDlg();
  }
}

// ----- 封存區抽屜：搜尋（案名、機關、案號）＋年份篩選；點一列看唯讀詳細 -----
const thisYear = () => new Date(tnow() + 8 * H).getUTCFullYear();
function openArchive() {
  if (!S.drawer) lastFocus = document.activeElement;
  S.drawer = { id: '__arch', view: 'archive' };
  if (!S.arch.list) loadArchive();
  renderDrawer(); syncOverlay();
}
let archT;
async function loadArchive() {
  if (!api || !api.archiveList || S.net === 'auth') return;
  const q = S.arch.q, y = S.arch.year, ticket = (S.arch.ticket = (S.arch.ticket || 0) + 1);
  S.arch.busy = true; if (S.drawer && S.drawer.view === 'archive') renderDrawer();
  try {
    const list = await api.archiveList(q, y, 100);
    if (ticket !== S.arch.ticket) return;   // 打字很快時只用最後一次的結果
    S.arch.list = list; list.forEach(x => S.archMap.set(x.id, x)); S.arch.err = false;
  } catch (e) {
    if (e instanceof AdapterError && e.kind === 'auth') { setAuth(); renderAll(); return; }
    S.arch.err = true; if (!S.arch.list) S.arch.list = [];
  } finally { if (ticket === S.arch.ticket) { S.arch.busy = false; if (S.drawer && S.drawer.view === 'archive') renderDrawer(); } }
}
function archRow(it) {
  const id = esc(it.id), real = it.folderStatus === 'done' && /^\//.test(it.folderPath);
  const ls = ['pool', 'review'].map(k => linkOf(it, k)).filter(Boolean);
  return '<article class="arow" data-act="arch-open" data-id="' + id + '" tabindex="0" aria-label="' + esc(it.title) + '，' + (KIND[it.archiveKind] || '已結案') + '">' +
    '<div class="arow-h">' + kindBadge(it) + demo(it) + (it.archivedAt ? '<span class="arow-d">' + fmtDay(it.archivedAt) + ' 結案</span>' : '') + '</div>' +
    '<h3 class="sb">' + softBreak(it.title) + '</h3>' + (it.org ? '<p class="arow-o">' + esc(it.org) + (it.caseNo ? ' · ' + esc(it.caseNo) : '') + '</p>' : '') +
    ((ls.length || real) ? '<div class="arow-a">' + ls.map(l => extLink(l, 'mini-link')).join('') + (real ? '<button class="mini-link btn-copy" data-act="copy-path" data-id="' + id + '" type="button">複製本機資料夾位置</button>' : '') + '</div>' : '') + '</article>';
}
function renderArchiveDrawer(dr) {
  const ae = document.activeElement, kq = ae && ae.id === 'arch-q' ? [ae.selectionStart, ae.selectionEnd] : null;
  const sc = dr.querySelector('.db') && dr.dataset.key === '__arch' ? dr.querySelector('.db').scrollTop : 0;
  const y = thisYear(), years = [y, y - 1, y - 2, y - 3];
  const l = S.arch.list;
  const body = !l ? '<p class="chat-empty">讀取封存區中…</p>'
    : l.length ? '<div class="alist">' + l.map(archRow).join('') + '</div>'
    : '<p class="chat-empty">' + (S.arch.err ? '封存區讀不到，請稍後再試。' : S.arch.q || S.arch.year ? '找不到符合的結案案子。' : '還沒有結案的案子。在進行中的進度按「結案…」就會放到這裡。') + '</p>';
  dr.innerHTML = '<div class="dh"><span>封存區</span><button class="xb" data-act="close-drawer" type="button" aria-label="關閉">×</button></div>' +
    '<div class="db"><div class="dt"><div class="afilter"><input id="arch-q" class="dlg-in" type="search" placeholder="搜尋案名、機關、案號" aria-label="搜尋封存區" value="' + esc(S.arch.q) + '">' +
    '<select id="arch-year" class="dlg-in" aria-label="結案年份"><option value=""' + (S.arch.year ? '' : ' selected') + '>全部年份</option>' + years.map(v => '<option value="' + v + '"' + (String(S.arch.year) === String(v) ? ' selected' : '') + '>' + v + ' 年</option>').join('') + '</select></div>' +
    '<p class="dt-meta" aria-live="polite">' + (S.arch.busy ? '<span class="spin"></span> 搜尋中…' : l ? '共 ' + l.length + ' 筆' : '') + '</p>' + body + '</div></div>' +
    '<div class="df"><button class="btn btn-ghost" data-act="close-drawer" type="button">回到面板</button></div>';
  dr.setAttribute('aria-label', '封存區'); dr.dataset.key = '__arch';
  dr.querySelector('.db').scrollTop = sc; dr.classList.add('show');
  if (kq) { const t = $('#arch-q'); t.focus({ preventScroll: true }); try { t.setSelectionRange(kq[0], kq[1]); } catch (e) {} }
}
document.addEventListener('input', e => {
  if (e.target.id !== 'arch-q') return;
  S.arch.q = e.target.value; clearTimeout(archT); archT = setTimeout(loadArchive, 300);
});
document.addEventListener('change', e => { if (e.target.id === 'arch-year') { S.arch.year = e.target.value; loadArchive(); } });
document.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.classList && e.target.classList.contains('arow')) openArchived(e.target.dataset.id); });
// 已結案那張卡的唯讀詳細
function openArchived(id) {
  if (!S.archMap.get(id)) return;
  S.drawer = { id, view: 'archived' };
  ensureMsgs(id);
  renderDrawer(); syncOverlay();
  if (api.progress && !S.archMap.get(id).progressSteps) api.progress(id).then(c => { if (c) { const o = S.archMap.get(id) || {}; S.archMap.set(id, { ...o, ...c, archiveKind: c.archiveKind || o.archiveKind, archivedAt: o.archivedAt || c.archivedAt }); if (S.drawer && S.drawer.id === id) renderDrawer(); } }).catch(() => {});   // 卡片仍是 doing，opp_progress 拿得到完整內容與步驟
}
function renderArchivedDrawer(dr) {
  const it = S.archMap.get(S.drawer.id);
  if (!it) { S.drawer = { id: '__arch', view: 'archive' }; return renderArchiveDrawer(dr); }
  const real = it.folderStatus === 'done' && /^\//.test(it.folderPath), st = it.progressSteps;
  const body = '<div class="dt">' + head(it, kindBadge(it)) +
    '<p class="dt-line">' + esc(amtText(it)) + (it.archivedAt ? ' · ' + fmtDate(it.archivedAt) + ' 結案' : '') + '</p>' +
    '<section class="prog-box arch-box"><h3>結案</h3><p class="prog-head"><span class="ttl">' + (KIND[it.archiveKind] || '已結案') + '</span></p>' +
    (it.progressNote ? '<p class="prog-note sbp">' + softBreak(it.progressNote) + '</p>' : '') +
    (it.progressUpdatedBy ? '<p class="prog-upd">最後由 ' + esc(it.progressUpdatedBy) + ' 更新</p>' : '') +
    (st && st.length ? '<ol class="steps">' + st.map((x, i, a) => stepRow(x, i, a, it)).join('') + '</ol>' : '') +
    (real ? '<div class="fold-row"><p class="prog-upd">工作資料夾</p><div class="path">' + esc(it.folderPath) + '</div></div>' : '') + filesRow(it) + '</section>' +
    structBox(it, false) + factsBox(it) + '<section class="dt-sec dt-src"><h3>來源</h3>' + metaLine(it) + link(it) + '</section></div>';
  const keepA = chatFocus();
  dr.innerHTML = '<div class="dh"><span>封存的案子（唯讀）</span><button class="xb" data-act="close-drawer" type="button" aria-label="關閉">×</button></div><div class="db">' + body + '</div>' + chatDock(it.id) +
    miniFoot(esc(it.id), (real ? '<button class="fbtn" data-act="copy-path" data-id="' + esc(it.id) + '" type="button"><span aria-hidden="true">📋</span> 複製路徑</button>' : '') +
      '<button class="fbtn" data-act="arch-back" type="button">回到封存區</button>',
      (can('admin') ? '<button class="fm-i" data-act="arch-reopen" data-id="' + esc(it.id) + '" type="button" role="menuitem">重新打開</button>' : '') +
      '<button class="fm-i" data-act="close-drawer" type="button" role="menuitem">回到面板</button>' + purgeBtn(it));
  dr.setAttribute('aria-label', '封存的案子'); dr.dataset.key = it.id + 'archived';
  dockScroll(dr); chatRestore(keepA); if (dockShow.has(it.id)) markSeen(it.id);
  dr.classList.add('show');
}
// ---------------- 追蹤事項（v7；後端 opp_followup_list／opp_followup_update，sql/27） ----------------
// 同事在 LINE 或面板交代肉咖「幫我記得…」「幫我追蹤…」的事。大家都看得到；只有 admin（或 planner）能標完成、取消、改回未完成。
const FU_FILTERS = [['open', '未完成'], ['done', '已完成'], ['dropped', '已取消'], ['all', '全部']];
const FU_SRC = { line: 'LINE', panel: '面板', other: '其他' };
const fuCanEdit = () => can('progress') || can('admin');   // 跟後端一樣看 can_progress／can_admin（D 審稿 #3）
const tpDay = ms => Math.floor((ms + 8 * H) / D);
const fuGet = id => [S.fu.open, S.fu.list, ...S.fu.byItem.values()].reduce((a, l) => a || (l || []).find(f => f.id === id), null);
const fuOverdue = f => f.status === 'open' && !!f.dueAt && f.dueAt < tnow();
const fuToday = f => f.status === 'open' && !!f.dueAt && !fuOverdue(f) && tpDay(f.dueAt) === tpDay(tnow());
function fuDue(f) {
  if (f.status === 'done') return '<span class="fu-d ok">完成' + (f.doneAt ? ' ' + fmtDay(f.doneAt) : '') + '</span>';
  if (f.status === 'dropped') return '<span class="fu-d">已取消' + (f.doneAt ? ' ' + fmtDay(f.doneAt) : '') + '</span>';
  if (!f.dueAt) return '<span class="fu-d">沒有期限</span>';
  if (fuOverdue(f)) return '<span class="fu-d hot">逾期 · ' + esc(fmtDate(f.dueAt)) + '</span>';
  if (fuToday(f)) return '<span class="fu-d warn">今天截止 ' + esc(fmtClock(f.dueAt)) + '</span>';
  return '<span class="fu-d">期限 ' + esc(fmtDate(f.dueAt)) + '</span>';
}
function fuRow(f, inCard) {
  const id = esc(f.id), meta = [];
  if (f.requestedBy) meta.push(esc(f.requestedBy) + ' 交代');
  meta.push('來源 ' + esc(FU_SRC[f.source] || f.source || '其他'));
  const card = !inCard && f.itemId ? '<button class="mini-link fu-card" data-act="fu-card" data-id="' + esc(f.itemId) + '" type="button">' + esc(f.itemShortTitle || '相關案子') + '</button>' : '';
  const acts = !fuCanEdit() ? '' : f.status === 'open'
    ? '<div class="fu-a"><button class="btn btn-ghost sm" data-act="fu-done" data-id="' + id + '" type="button">標完成…</button><button class="btn btn-ghost sm" data-act="fu-drop" data-id="' + id + '" type="button">取消…</button></div>'
    : '<div class="fu-a"><button class="btn btn-ghost sm" data-act="fu-reopen" data-id="' + id + '" type="button">改回未完成</button></div>';
  return '<article class="fu ' + f.status + (fuOverdue(f) ? ' over' : fuToday(f) ? ' today' : '') + (S.fu.busyIds && S.fu.busyIds.has(f.id) ? ' busy' : '') + '">' +
    '<div class="fu-h"><b class="fu-o">' + esc(f.owner || '還沒指定') + '</b>' + fuDue(f) + '</div>' +
    '<p class="fu-t sbp">' + softBreak(f.title) + '</p>' +
    '<p class="fu-m">' + meta.join(' · ') + '</p>' + (card ? '<p class="fu-m">' + card + '</p>' : '') +
    (f.note ? '<p class="fu-n">補充：' + esc(f.note) + '</p>' : '') +
    (f.status !== 'open' && f.closeNote ? '<p class="fu-n">' + (f.status === 'done' ? '依據' : '原因') + '：' + esc(f.closeNote) + '</p>' : '') + acts + '</article>';
}
function renderFuBtn() {
  const b = $('#fubtn'); if (!b) return;
  b.hidden = S.net === 'auth' || !api || (!api.followupList && !api.bulletin);
  const l = S.fu.open || [], fn = l.length, over = l.filter(fuOverdue).length, today = l.filter(fuToday).length;
  const urg = bulUrgent(), n = urg + fn;   // v81：數字＝今天、明天截止的案子＋未完成追蹤
  b.classList.toggle('hot', over > 0); b.classList.toggle('warn', !over && (today > 0 || urg > 0));
  b.innerHTML = '<span>追蹤公告</span>' + (n ? '<b class="fu-cnt">' + n + '</b>' : '');
  b.setAttribute('aria-label', '追蹤公告' + (urg ? '，' + urg + ' 案今明兩天截止' : '') + (fn ? '，' + fn + ' 件追蹤未完成' + (over ? '，' + over + ' 件逾期' : '') + (today ? '，' + today + ' 件今天到期' : '') : ''));
}
// ---------------- 追蹤公告的每日報告（v81；後端 opp_bulletin_get，sql/37，C 做） ----------------
// source：daily11＝11:00 查證過的正式報告；live＝程式從看板即時組的（面板改動 1 分鐘內反映）。讀不到或還沒有就只寫「報告準備中」
const BUL_SEC = { schedule: '行程', bid: '領標', followup: '追蹤事項' };
const bulDays = s => s.deadline ? tpDay(s.deadline) - tpDay(tnow()) : s.daysLeft;   // 照截止時間重算，報告舊了倒數也對
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
  if (sig === S.bul.sig) return;   // 內容沒變不重畫
  S.bul.sig = sig; S.bul.d = d; S.bul.err = err;
  renderFuBtn();
  if (S.drawer && S.drawer.view === 'followups') renderDrawer();
}
setInterval(() => { if (S.drawer && S.drawer.view === 'followups' && !document.hidden) loadBul(true); }, 60e3);   // 分頁開著：每分鐘重抓
const bulLine = x => { const m = x.match(/^([^：:\s\d][^：:\s]{0,9})([：:])(?!\d)(.*)$/s); /* 「Louis：…」名字加粗；「11/18（三）08:00…」這種時間開頭的不算 */ return '<li>' + (m ? '<b>' + esc(m[1]) + '</b>' + m[2] + esc(m[3]) : esc(x)) + '</li>'; };
const bulList = ls => ls.length ? '<ul class="bul-ls">' + ls.map(bulLine).join('') + '</ul>' : '';
function bulDue(s) {
  const n = bulDays(s);
  const when = s.deadline ? fmtDay(s.deadline) + (s.dateOnly ? '' : hm(s.deadline)) : '';
  const lab = n == null ? '' : n < 0 ? '已過截止' : n === 0 ? '今天截止' : n === 1 ? '明天截止' : '剩 ' + n + ' 天';
  if (!lab && !when) return s.stamp ? '<p class="bul-dt">' + esc(s.stamp) + '</p>' : '';
  return '<p class="bul-dt">' + (lab ? '<span class="bul-due' + (n === 0 || n === 1 ? ' soon' : n < 0 ? ' past' : '') + '">' + lab + '</span>' : '') + (when ? '<span>' + esc(when) + '</span>' : '') + '</p>';
}
function bulCase(s) {
  const t = s.title || '（沒寫案名）';
  const name = s.itemId ? '<button class="bul-name" data-act="fu-card" data-id="' + esc(s.itemId) + '" type="button">' + softBreak(t) + '</button>' : '<b class="bul-name">' + softBreak(t) + '</b>';
  return '<article class="bul-case">' + name + bulDue(s) + bulList(s.lines) + '</article>';
}
function bulHTML() {
  const d = S.bul.d;
  const secs = d ? (d.sections.length ? d.sections : d.body.trim() ? [{ kind: '', text: d.body, lines: [] }] : []) : [];
  if (!secs.length) return '<section class="bul" aria-label="今日報告"><p class="bul-wait">報告準備中</p></section>';
  const fuShown = api && api.followupList && !S.fu.err;   // 下面就是追蹤事項列表，報告裡的 followup 段落不重複畫
  const out = [];
  let cases = [];
  const flush = () => { if (cases.length) { out.push('<div class="bul-cases">' + cases.join('') + '</div>'); cases = []; } };
  secs.forEach(s => {
    if (s.kind === 'case') { if (s.title || s.lines.length) cases.push(bulCase(s)); return; }
    flush();
    if (s.kind === 'summary') { if (s.text.trim()) out.push('<p class="bul-sum">' + para(s.text) + '</p>'); return; }
    if (s.kind === 'followup' && fuShown) return;
    const h = BUL_SEC[s.kind] || s.title || '';
    const body = s.lines.length ? bulList(s.lines) : s.text.trim() ? '<p class="bul-p">' + para(s.text) + '</p>' : '';
    if (body) out.push('<section class="bul-sec">' + (h ? '<h4>' + esc(h) + '</h4>' : '') + body + '</section>');
  });
  flush();
  const g = d.generatedAt, rt = g ? relTime(g, tnow()) : '';
  return '<section class="bul" aria-label="今日報告"><div class="bul-h"><h3>今日報告</h3><span class="bul-t">' +
    (g ? '<span data-rel="' + g + '">' + rt + '</span>更新' : '') + (d.source === 'daily11' ? '<span class="bul-src"> · 11:00 查證版</span>' : '') + '</span></div>' + out.join('') + '</section>';
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
  try {
    const l = await api.followupList('all', id, 50), old = S.fu.byItem.get(id);
    S.fu.byItem.set(id, l);
    if (JSON.stringify(old) !== JSON.stringify(l) && S.drawer && S.drawer.id === id) renderDrawer();
  } catch (e) {} finally { fuItemBusy.delete(id); }
}
function fuSection(id) {
  const l = S.fu.byItem.get(id); if (!l || !l.length) return '';
  const open = l.filter(f => f.status === 'open'), rest = l.filter(f => f.status !== 'open');
  return '<section class="dt-sec fu-sec"><h3>追蹤事項' + (open.length ? '（未完成 ' + open.length + '）' : '') + '</h3><div class="fu-list">' + open.concat(rest).map(f => fuRow(f, true)).join('') + '</div></section>';
}
function openFu() {
  if (!S.drawer) lastFocus = document.activeElement;
  S.drawer = { id: '__fu', view: 'followups' };
  if (S.fu.filter === 'open' && S.fu.open) S.fu.list = S.fu.open; else S.fu.list = null;
  loadFuList(); loadBul(true);   // v81：打開分頁一定重抓報告
  renderDrawer(); syncOverlay();
  $('#drawer .xb')?.focus({ preventScroll: true });
}
function renderFuDrawer(dr) {
  const sc = dr.querySelector('.db') && dr.dataset.key === '__fu' ? dr.querySelector('.db').scrollTop : 0;
  const l = S.fu.list, f = S.fu.filter;
  const empty = { open: '目前沒有未完成的追蹤事項。同事在 LINE 或面板交代肉咖「幫我記得…」「幫我追蹤…」，就會出現在這裡。', done: '還沒有完成的事項。', dropped: '沒有取消的事項。', all: '還沒有任何追蹤事項。' }[f];
  const body = !l ? '<p class="chat-empty">讀取追蹤事項中…</p>' : l.length ? '<div class="fu-list">' + l.map(x => fuRow(x, false)).join('') + '</div>'
    : '<p class="chat-empty">' + (S.fu.err ? '追蹤事項讀不到，請稍後再試。' : empty) + '</p>';
  const over = (S.fu.open || []).filter(fuOverdue).length;
  dr.innerHTML = '<div class="dh"><span>追蹤公告</span><button class="xb" data-act="close-drawer" type="button" aria-label="關閉">×</button></div>' +
    '<div class="db"><div class="dt">' + bulHTML() + (api && api.followupList ? '<h3 class="fu-h3">追蹤事項</h3><div class="fu-filter" role="tablist" aria-label="篩選追蹤事項">' + FU_FILTERS.map(([k, t]) =>
      '<button class="fu-f' + (k === f ? ' on' : '') + '" role="tab" aria-selected="' + (k === f) + '" data-act="fu-filter" data-f="' + k + '" type="button">' + t + (k === 'open' && S.fu.open ? ' ' + S.fu.open.length : '') + '</button>').join('') + '</div>' +
    '<p class="dt-meta" aria-live="polite">' + (S.fu.busy && l ? '<span class="spin"></span> 更新中…' : f === 'open' && over ? '<span class="fu-d hot">' + over + ' 件逾期</span>' : '') + (fuCanEdit() ? '' : (l && l.length ? ' 只有管理員能標完成或取消。' : '')) + '</p>' +
    body + '<p class="fu-tip">同事在 LINE 或面板交代肉咖的事，到期當天或逾期肉咖會另外提醒。</p>' : '') + '</div></div>' +
    '<div class="df"><button class="btn btn-ghost" data-act="close-drawer" type="button">回到面板</button></div>';
  dr.setAttribute('aria-label', '追蹤公告'); dr.dataset.key = '__fu';
  dr.querySelector('.db').scrollTop = sc; dr.classList.add('show');
}
function fuOpenCard(itemId) {
  const it = get(itemId);
  if (!it) { toast('這張卡已經不在看板上，可以到封存區找'); return; }
  openDrawer(itemId, it.status === 'doing' ? 'progress' : 'full');
}
async function fuSet(fid, patch, okMsg) {
  if (!fuCanEdit()) { toast(reason(new AdapterError('perm', '')), { bad: true }); return; }
  S.fu.busyIds = S.fu.busyIds || new Set(); S.fu.busyIds.add(fid); renderDrawer();
  try {
    const res = await api.followupUpdate(fid, patch);
    const put = l => l && l.forEach((x, i) => { if (x.id === fid && res) l[i] = res; });
    put(S.fu.list); put(S.fu.open); S.fu.byItem.forEach(put);
    toast(okMsg);
    loadFuList(); loadFu();
  } catch (e) {
    if (e instanceof AdapterError && e.kind === 'auth') setAuth();
    if (e instanceof AdapterError && e.kind === 'perm') loadWho();
    toast('沒有改成功：' + reason(e), { bad: true });
  } finally { S.fu.busyIds.delete(fid); renderAll(); }
}
// ---------------- 自動換新版（v7，監工：加到主畫面的 App 一直看到舊版，要整個滑掉才會更新） ----------------
// 部署時 version.json 寫目前版本（例如 {"version":"v8"}），跟 js 網址的 ?vN 一樣。載入、切回前景、取得焦點、每 10 分鐘抓一次（no-store）；
// 版本不同就請 SW 換新並重新整理。抽屜、待決區、確認框開著，或輸入框有字：先不整理，頂端顯示「有新版本，點一下更新」。
const APP_V = ((new URL(import.meta.url)).search.match(/v\d+/) || [''])[0];
document.documentElement.dataset.v = APP_V;
// SW 換版時會問「你是哪一版」（D 審稿 #2）：回答 v7 以上就不會被重新導覽；v6 的頁面不會回答，才會被換掉
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
    if (!/^v\d+$/.test(v) || v === APP_V) { const b = $('#updbar'); if (b) b.hidden = true; return; }
    newV = v;
    let tried = null; try { tried = JSON.parse(sessionStorage.getItem('copp.upd') || 'null'); } catch (e) {}
    // 剛為這一版重新整理過、拿到的還是舊檔（GitHub Pages 還在換）：不要一直重整，改顯示提示
    if (busyNow() || (tried && tried.v === v && Date.now() - tried.at < 120e3)) { showUpd(); return; }
    doUpdate();
  } catch (e) {}
}
function showUpd() { const b = $('#updbar'); if (!b) return; b.textContent = '有新版本，點一下更新'; b.hidden = false; }
async function doUpdate(byUser) {
  let marked = false;
  try { sessionStorage.setItem('copp.upd', JSON.stringify({ v: newV, at: Date.now() })); const r = JSON.parse(sessionStorage.getItem('copp.upd') || 'null'); marked = !!r && r.v === newV; } catch (e) {}
  // 紀錄寫不進去（儲存被封鎖、隱私模式、某些 WebView）：自動整理會變成無限重整（D 實測 24 秒 98 次），改成只出提示
  if (!marked && !byUser) { showUpd(); return; }
  try {
    const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
    if (reg) { await reg.update().catch(() => {}); if (reg.waiting) reg.waiting.postMessage('skipWaiting'); }
  } catch (e) {}
  location.reload();
}
// 手機鍵盤彈出時，把抽屜整個往上推，固定在底部的對話列不會被擋住
if (window.visualViewport) {
  const vv = window.visualViewport, kb = () => { const h = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    document.documentElement.style.setProperty('--kb', h + 'px'); document.documentElement.classList.toggle('kbopen', h > 80); };
  vv.addEventListener('resize', kb); vv.addEventListener('scroll', kb);
}
// ---------------- 讀取：快照、逾時、輪詢、即時 ----------------
// 開頁時算一次：金鑰失效後 KEY 會被清空，要靠這個值刪掉那把金鑰的快照（D 審稿 #7）
let SNAP = '';
const snapKey = () => SNAP || (SNAP = CONFIG.SNAPSHOT_KEY + ':' + (api.mode === 'mock' ? 'mock:' + (qs.get('mock') || '') : keyTag()));   // 示範模式每種 ?mock= 各存各的，不互相帶全文
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
const sig = () => JSON.stringify(items().map(i => [i.id, i.status, i.lane, i.snoozeUntil, i.deadline, i.expiresAt, i.title, i.folderStatus, i.folderPath, i.folderError, i.notionUrl, i.crawlStatus, i.crawlError, i.detailText.length, i.amountDisplay, i.why,
  i.progressStatus, i.progressStage, i.progressPct, i.progressStepN, i.progressNote, i.progressBlocker, i.progressUpdatedAt, i.progressArchiveAt, i.progressSteps ? i.progressSteps.length : -1, JSON.stringify(i.links || [])]));

let inflight = false, again = false, pollT, pingT, unsub = () => {};
// 金鑰失效：停輪詢、停 realtime、刪這把金鑰的快照（D 審稿 #6、#7）
function setAuth() {
  S.net = 'auth'; clearTimeout(pollT); clearTimeout(pingT);
  try { unsub(); } catch (e) {} unsub = () => {}; S.rt = false;
  try { localStorage.removeItem(snapKey()); } catch (e) {}
}
async function refresh() {
  if (S.net === 'auth') return;
  if (inflight) { again = true; return; }    // 列表還在路上時進來的 ping：等這次結束再抓一次（D 審稿 #2）
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
    // 讀全文在別處完成了，而且正開著這張卡的完整內容：把全文抓進來
    if (dr && viewOf() === 'full' && dr.crawlStatus === 'done' && !dr.detailText) ensureDetail(dr.id);
    // 正開著進度抽屜，而進度有更新（progress_updated_at 變了）：重抓步驟清單
    if (dr && viewOf() === 'progress') { ensureProgress(dr.id); if ([...stepOpen].some(k => k.startsWith(dr.id + '|'))) ensureEvents(dr.id, true); }
    if (S.who && can('act')) items().filter(i => laneOf(i) === 'active' && i.progressStatus !== 'done').forEach(i => ensureProgress(i.id));   // v8：等你確認要看步驟負責人
    loadMsgs();   // 跟肉咖說：不綁案子的對話（頂列紅點）＋正開著的那張卡
    loadScan();   // 立即掃描：三籃狀態
    loadFu();     // 追蹤事項：頂列數字、開著的抽屜、開著的進度（新增和更新都會發同一個 changed）
    loadBul();    // v81：追蹤公告的每日報告（最多 30 秒抓一次；打開分頁時一定重抓）
    // 停在「等待付款同意」又沒有 pay 連結的卡（備援）：opp_list 不帶步驟備註，背景補抓一次，卡片上才畫得出「去領標付款」
    items().filter(i => laneOf(i) === 'active' && i.progressStageKey === PAY_STEP && !linkOf(i, 'pay')).forEach(i => ensureProgress(i.id));
    // 公告截止已過、目前步驟又不在送件後清單的卡：要看步驟（seal_submit 是否完成）才知道是不是已送件，背景補抓一次
    items().filter(i => laneOf(i) === 'active' && i.progressStatus !== 'done' && (submitted(i) || (i.deadline && i.deadline <= tnow() && !POST_SUBMIT_KEYS.includes(i.progressStageKey)))).forEach(i => ensureProgress(i.id));   // 送件後的卡也要步驟（「已送件 11/10」的日期）
  } catch (e) {
    if (e instanceof AdapterError && e.kind === 'auth') setAuth(); else S.net = 'offline';
  } finally {
    clearTimeout(slowT); S.slow = false; inflight = false;
    if (sig() !== before || S.net !== prevNet || hadSlow) renderAll(); else { renderLive(); renderNotice(); }
    if (again) { again = false; refresh(); }
  }
}
async function loadWho() {
  try {
    const w = await api.whoami();
    S.who = w; S.caps = w.caps || {};
    saveSnapshot();
  } catch (e) {
    if (e instanceof AdapterError && e.kind === 'auth') setAuth();
    // 離線時沿用快照裡的 caps；完全不知道就維持 null（不畫寫入按鈕）
  }
  renderAll();
}
const needFast = () => items().some(i => i.crawlStatus === 'crawling' || folderWait(i)) || SCAN_LANES.some(scanning);   // 掃描中也走 3 秒快輪詢
function schedulePoll() { clearTimeout(pollT); if (S.net === 'auth') return; pollT = setTimeout(async () => { if (!document.hidden) await refresh(); schedulePoll(); }, needFast() ? CONFIG.FAST_POLL_MS : CONFIG.POLL_MS); }
function kickPoll() { schedulePoll(); }
const ping = () => { clearTimeout(pingT); pingT = setTimeout(refresh, 150); };

// ---------------- 事件 ----------------
function copyPath(id) {
  const it = getAny(id); if (!it || !it.folderPath) return;
  const ok = () => toast('已複製本機資料夾位置'), no = () => toast('這個瀏覽器不讓複製，請長按路徑自己複製', { bad: true });
  // 備援：剪貼簿 API 不能用或被拒（http、內嵌瀏覽器、舊瀏覽器）時，改用隱藏文字框複製
  const legacy = () => {
    const back = document.activeElement;
    try {
      const ta = document.createElement('textarea'); ta.value = it.folderPath; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
      (document.querySelector('#drawer.show') || document.body).appendChild(ta); ta.select(); const r = document.execCommand('copy'); ta.remove();
      try { back && back.focus({ preventScroll: true }); } catch (e) {}
      r ? ok() : no();
    } catch (e) { no(); }
  };
  if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(it.folderPath).then(ok, legacy);
  else legacy();
}
document.addEventListener('click', e => {
  const act = e.target.closest('[data-act]'), a = act && act.dataset.act, id = act && act.dataset.id;
  if (footMore.open && a !== 'foot-more' && S.drawer) { footMore.open = false; renderDrawer(); if (!act) return; }   // 「⋯」選單：點別的地方就收起
  if (e.target.id === 'scrim') { S.drawer ? closeDrawer() : closeSheet(); return; }
  const tab = e.target.closest('[data-tab]'); if (tab) { S.tab = tab.dataset.tab; renderBoard(); return; }
  if (e.target.closest('#hpill,#holdbtn')) { openSheet(); return; }
  if (e.target.closest('#rkbtn')) { openChat(); return; }
  if (e.target.closest('#archbtn')) { openArchive(); return; }
  if (e.target.closest('#fubtn')) { openFu(); return; }
  if (e.target.closest('#updbar')) { doUpdate(true); return; }
  if (e.target.id === 'dlg') { closeDlg(); return; }
  if (a) {
    switch (a) {
      case 'del': actDel(id); break;
      case 'hold': actHold(id); break;
      case 'unstash': actUnstash(id); break;
      case 'dive': openDrawer(id, 'full'); break;
      case 'no': actNo(id); break;
      case 'yes': actBuild(id); break;
      case 'open-progress': openDrawer(id, 'progress'); break;
      case 'restore': mutate(id, 'restore', '已救回來，放回待看'); break;
      case 'paste-key': pasteKey(); break;
      case 'retry': refresh(); break;
      case 'retry-detail': ensureDetail(id, true); break;
      case 'toggle-text': S.textOpen.has(id) ? S.textOpen.delete(id) : S.textOpen.add(id); renderDrawer(); break;
      case 'toggle-att': S.attOpen.has(id) ? S.attOpen.delete(id) : S.attOpen.add(id); renderDrawer(); $('#drawer [data-act=toggle-att]')?.focus({ preventScroll: true }); break;
      case 'close-drawer': closeDrawer(); break;
      case 'close-hold': closeSheet(); break;
      case 'open-hold': openSheet(); break;
      case 'tab-active': S.tab = 'active'; renderBoard(); break;
      case 'copy-path': copyPath(id); break;
      case 'arch-start': { const a = get(id), re = !!(a && a.progressStatus === 'done'); S.dlg = { type: 'archive', id, kind: re && a.archiveKind || '', note: '', step: 'pick', re }; renderDlg(); break; }
      case 'arch-reopen': doUnarchive(id, getAny(id)); break;
      case 'arch-next': archNext(); break;
      case 'arch-back-pick': S.dlg.step = 'pick'; renderDlg(); break;
      case 'arch-confirm': doArchive(); break;
      case 'arch-open': if (!e.target.closest('a[href]')) openArchived(id); break;   // 點列裡的 Pool／內審連結只開連結
      case 'arch-back': openArchive(); break;
      case 'purge-start': S.dlg = { type: 'purge', id, typed: '' }; renderDlg(); break;
      case 'purge-confirm': doPurge(); break;
      case 'msg-del': S.dlg = { type: 'msgdel', id: act.dataset.key || '', mid: act.dataset.mid }; renderDlg(); break;
      case 'msg-clear': S.dlg = { type: 'msgclear', id: act.dataset.key || '' }; renderDlg(); break;
      case 'msg-del-confirm': doMsgDel(); break;
      case 'open-arch': openArchive(); break;
      case 'bid-open': bidOpen(id); break;
      case 'bid-close': S.bidPage = null; S.bidForm = { amount: '', receipt: '', note: '' }; renderDrawer(); $('#drawer .bid-go')?.focus({ preventScroll: true }); break;
      case 'bid-paid': bidPaid(id); break;
      case 'bid-ext': break;   // 外部連結：照瀏覽器預設開新分頁（主畫面 App 會跳到 Safari／Chrome）
      case 'bid-sum': S.bidSumOpen.has(id) ? S.bidSumOpen.delete(id) : S.bidSumOpen.add(id); renderDrawer(); break;
      case 'mine-tog': S.mine = !S.mine; renderBoard(); break;
      case 'step-mark': S.dlg = { type: 'stepmark', id, k: act.dataset.k, st: act.dataset.st, note: '' }; renderDlg(); break;
      case 'step-mark-confirm': doStepMark(); break;
      case 'file-open': track(id, 'open_file', act.dataset.k, act.dataset.label); break;
      case 'file-dl': track(id, 'download_file', act.dataset.k, act.dataset.label); break;
      case 'file-share': shareFile(id, act.dataset.k, act.dataset.label, act.dataset.url); break;
      case 'pres-tog': { const n = act.dataset.n || ''; S.presOpen.has(n) ? S.presOpen.delete(n) : S.presOpen.add(n); renderDrawer(); break; }
      case 'open-hot': { const h = get(id); if (h) openDrawer(id, laneOf(h) === 'active' ? 'progress' : 'preview'); break; }
      case 'dock-toggle': { const k = act.dataset.key || ''; if (dockShow.has(k)) closeDock(k); else { dockShow.add(k); renderDrawer(); dockScroll($('#drawer')); markSeen(k); const t = $('#chat-input'); t && t.focus({ preventScroll: true }); } break; }
      case 'step-tog': { const k = id + '|' + (act.dataset.k || ''); stepOpen.has(k) ? stepOpen.delete(k) : stepOpen.add(k); if (stepOpen.has(k)) { ensureEvents(id); if (get(id)) track(id, 'open_step', act.dataset.k); } renderDrawer(); $('#drawer [data-act=step-tog][data-k="' + CSS.escape(act.dataset.k || '') + '"]')?.focus({ preventScroll: true }); break; }
      case 'foot-more': footMore.open = !footMore.open; renderDrawer(); if (footMore.open) $('#drawer .fmenu .fm-i')?.focus({ preventScroll: true }); break;
      case 'dock-more': { const k = act.dataset.key || ''; if (dockOpen.has(k)) dockOpen.delete(k); else dockOpen.add(k); renderDrawer(); break; }
      case 'chat-card': { const it = get(id); if (!it) toast('這張卡已經不在看板上，可以到封存區找'); else { dockShow.add(id); openDrawer(id, it.status === 'doing' ? 'progress' : 'preview'); } break; }
      case 'fu-filter': S.fu.filter = act.dataset.f; S.fu.list = null; loadFuList(); renderDrawer(); break;
      case 'fu-card': fuOpenCard(id); break;
      case 'fu-done': case 'fu-drop': S.dlg = { type: 'fu', id, to: act.dataset.act === 'fu-done' ? 'done' : 'dropped', note: '' }; renderDlg(); break;
      case 'fu-reopen': fuSet(id, { status: 'open' }, '已改回未完成'); break;
      case 'fu-confirm': { const d = S.dlg; if (d && d.type === 'fu') { S.dlg = null; renderDlg(); fuSet(d.id, Object.assign({ status: d.to }, d.note.trim() ? { close_note: d.note.trim() } : {}), d.to === 'done' ? '已標成完成' : '已取消這件事'); } break; }
      case 'dlg-close': closeDlg(); break;
      case 'msg-send': msgSend(act.dataset.key || ''); break;
      case 'scan': scanNow(act.dataset.lane); break;
    }
    return;
  }
  const c = e.target.closest('.card:not(.skel), .pc[data-id]');
  if (c && !e.target.closest('summary,a')) {
    const it = get(c.dataset.id); if (!it || c.closest('.gone')) return;
    openDrawer(c.dataset.id, it.status === 'doing' ? 'progress' : 'preview');   // 進行中的卡直接開進度
  }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { const dk = S.drawer && S.drawer.id; if (S.dlg) closeDlg(); else if (S.bidPage) { S.bidPage = null; renderDrawer(); } else if (dk && dockShow.has(dk) && !['chat', 'archive', 'followups'].includes(S.drawer.view)) closeDock(dk); else if (S.drawer && footMore.open) { footMore.open = false; renderDrawer(); } else if (S.drawer) closeDrawer(); else if (S.sheet) closeSheet(); return; }
  if (e.key === 'Enter' && e.target.classList && e.target.classList.contains('card')) { const it = get(e.target.dataset.id); if (it) openDrawer(it.id, it.status === 'doing' ? 'progress' : 'preview'); }
  if (e.key === 'Tab' && (S.dlg || S.drawer || S.sheet)) {         // 焦點只在最上層的疊層內打轉
    const box = S.dlg ? $('#dlg') : S.drawer ? $('#drawer') : $('#sheet');
    const f = [...box.querySelectorAll('button,a[href],summary,[tabindex="0"]')].filter(x => !x.disabled && x.offsetParent !== null);
    if (!f.length) return; const first = f[0], last = f[f.length - 1];
    if (!box.contains(document.activeElement)) { first.focus(); e.preventDefault(); }
    else if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
    else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
  }
});
window.addEventListener('popstate', () => {
  if (ignorePop) { ignorePop = false; return; }
  if (S.drawer || S.sheet) { depth = 0; S.drawer = null; S.sheet = false; $('#drawer').classList.remove('show'); $('#sheet').classList.remove('show'); syncOverlay(); renderAll(); }
});
// ---------------- 手機左右滑動切換籃子（959 以下；960 以上五欄同時顯示，不啟用） ----------------
// 規則：水平位移 > 60px 而且明顯大於垂直位移才算；抽屜、待決區、toast 開著不觸發；從螢幕左緣 24px 內開始的讓給 iOS 返回手勢。
const SW = { mq: matchMedia('(max-width: 959px)'), rm: matchMedia('(prefers-reduced-motion: reduce)'), on: false, x: 0, y: 0 };
const overlayOpen = () => !!S.drawer || !!S.dlg || S.sheet || $('#toast').classList.contains('show');
function switchTab(k, dir) {
  if (k === S.tab) return;
  S.tab = k; renderBoard();
  const lane = $('.lane.cur');
  if (!lane || SW.rm.matches) return;
  lane.classList.add(dir === 'l' ? 'swipe-l' : 'swipe-r');
  lane.addEventListener('animationend', () => lane.classList.remove('swipe-l', 'swipe-r'), { once: true });
}
$('#board').addEventListener('touchstart', e => {
  SW.on = false;
  if (!SW.mq.matches || e.touches.length !== 1 || overlayOpen() || S.net === 'auth') return;
  const t = e.touches[0];
  if (t.clientX <= 24) return;                 // 讓給 iOS 的返回手勢
  SW.on = true; SW.x = t.clientX; SW.y = t.clientY;
}, { passive: true });
$('#board').addEventListener('touchend', e => {
  if (!SW.on) return; SW.on = false;
  const t = e.changedTouches[0], dx = t.clientX - SW.x, dy = t.clientY - SW.y;
  if (Math.abs(dx) <= 60 || Math.abs(dx) < Math.abs(dy) * 1.5 || overlayOpen() || !SW.mq.matches) return;
  const i = LANES.findIndex(l => l.k === S.tab), j = i + (dx < 0 ? 1 : -1);   // 往左滑看下一籃，往右滑看上一籃
  if (i < 0 || j < 0 || j >= LANES.length) return;
  switchTab(LANES[j].k, dx < 0 ? 'l' : 'r');
}, { passive: true });
$('#board').addEventListener('touchcancel', () => { SW.on = false; }, { passive: true });
$('#lanes').addEventListener('scroll', edgeFade, { passive: true });
window.addEventListener('resize', edgeFade);
window.addEventListener('online', () => refresh());
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });

// ---------------- 啟動 ----------------
function pasteKey() {
  const v = window.prompt('貼上完整網址或金鑰（管理員給你的專屬網址）');
  const k = tokenFrom(v) || String(v || '').trim();
  if (k.length >= 20) { saveKey(k); location.reload(); } else if (v) toast('這不像金鑰，請貼完整網址', { bad: true });
}
function startUpdates() {   // 自動換新版：說明卡頁面也要（不然沒金鑰的人永遠停在舊版）
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
    navigator.serviceWorker.ready.then(reg => { if (reg.active) reg.active.postMessage({ keep: APP_V }); }).catch(() => {});
  }
  checkVersion();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkVersion(); });
  window.addEventListener('focus', () => checkVersion());
  setInterval(() => checkVersion(), 10 * 60e3);
}
function renderNoKey() {
  ['#fubtn', '#archbtn', '#rkbtn', '#holdbtn', '#hpill', '#hot'].forEach(s => { const b = $(s); if (b) b.hidden = true; });
  $('#tabs').hidden = true; $('#lanes').hidden = true; $('#notice').hidden = true; $('#sum').innerHTML = '';
  $('#live').innerHTML = '<span class="dot off"></span><span>還沒有金鑰</span>';
  let msg = $('#boardmsg'); if (!msg) { msg = document.createElement('div'); msg.id = 'boardmsg'; msg.className = 'board-msg'; $('#board').appendChild(msg); }
  msg.hidden = false;
  msg.innerHTML = IC.warn + '<h2>需要你的專屬網址</h2><p>請用大器私訊給你的專屬網址打開，或從手機主畫面的『好咖皮條客』打開。在 LINE 裡點開的話，請按右下角用 Safari 或 Chrome 開啟。</p>' +
    '<button class="btn btn-ghost" data-act="paste-key" type="button">貼上金鑰</button>';
}
(async function boot() {
  if (!hasKey() && !new URLSearchParams(location.search).has('mock')) { renderNoKey(); startUpdates(); return; }   // 不讀快照、不輪詢
  api = await createAdapter();
  loadSnapshot();                        // 先用快照立刻畫出來，不等網路
  S.net = 'loading'; renderAll();
  unsub = api.subscribe(ping, on => { S.rt = on; renderLive(); }) || (() => {});
  loadWho();                             // opp_whoami：決定畫哪些按鈕（與列表平行）
  renderRk();
  await refresh();
  schedulePoll();
  setInterval(tick, 30000);
  setInterval(() => { if (document.querySelector('[data-elapsed]')) tick(); }, 1000);
  startUpdates();
})();
// 浮動的「跟肉咖說」：往下捲時先讓開，停下來或往上捲再出現（D 複審 v72：不要一直蓋住列表右側）
(() => { let last = 0, t = 0;
  document.addEventListener('scroll', e => {
    const db = e.target; if (!db.classList || !db.classList.contains('db')) return;
    const w = db.parentElement && db.parentElement.querySelector('.fab-wrap'); if (!w) return;
    const y = db.scrollTop; if (y > last + 4) w.classList.add('fab-away'); else if (y < last - 4) w.classList.remove('fab-away');
    last = y; clearTimeout(t); t = setTimeout(() => w.classList.remove('fab-away'), 900);
  }, true);
})();
