// 好咖皮條客主程式：狀態、畫面、事件。只透過 adapter.js 取得與寫入資料。版面規格見交接包 DESIGN.md。
import { createAdapter, CONFIG, AdapterError, hasKey, keyTag, tokenFrom, saveKey, safeUrl, RK, SCAN_LANES } from './adapter.js?v5';   // ?v 跟 sw.js 的 CACHE 一起換（GitHub Pages 會快取 10 分鐘，不帶版本號會新舊混搭）
import { esc, H, D, URGENT_DAYS, fmtDate, fmtDay, fmtClock, relTime, fmtLeft, shortLeft, softBreak, splitAmount } from './util.js?v5';

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
const OUTCOME = { submitted: '已送件', won: '得標或核定', lost: '未得標', withdrawn: '撤件放棄' };
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
function payUrl(it) {
  if (it.status !== 'doing') return '';
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
  scan: {}, scanBusy: new Set(),   // 立即掃描：三籃最新狀態
  msgs: new Map(), msgBusy: new Set(), pend: new Map(), draft: new Map(),   // 跟肉咖說：key＝卡片 id（不綁案子是 ''）   // attOpen：附件清單展開中的卡（重畫時保留）
};
let api, lastFocus = null, depth = 0, ignorePop = false;
const locks = new Set(), mutDone = {};
let OFF = 0;                                   // 伺服器時間與本機時間的差，倒數用校正後的時間
const tnow = () => Date.now() + OFF;
const can = k => !!(S.caps && S.caps[k]);      // 依 opp_whoami 決定畫不畫按鈕；viewer 只有 read
const canBuild = it => can('act') && (it.lane !== 'tender' || can('admin'));   // 政府標案的「要做」只給 admin（sql/21）

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
const demo = it => it.isDemo ? '<span class="demo-badge">示意資料</span>' : '';
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
  else { dot = S.rt ? '' : 'idle'; txt = (mock ? '示範資料，' : S.rt ? '即時更新，' : '每 15 秒更新，') + fmtClock(S.lastOk) + ' 更新'; }
  if (S.caps && !can('act') && S.net !== 'auth') txt += '（唯讀）';
  el.innerHTML = '<span class="dot ' + dot + '"></span><span>' + txt + '</span>';
}
function renderSummary() {
  const now = tnow();
  const live = items().filter(i => i.status === 'new').length;
  const act = activeItems().length;
  const hot = items().filter(i => (i.status === 'new' || i.status === 'snoozed') && i.deadline && i.deadline > now && i.deadline - now < URGENT_DAYS * D).length;
  $('#sum').innerHTML = S.hadData ? '<b>' + live + '</b> 筆待看' + (act ? '<span class="sep"> · </span><b>' + act + '</b> 筆進行中' : '') + (hot ? '<br><span class="hotn">' + hot + ' 筆</span> ' + URGENT_DAYS + ' 天內截止' : '') : '';
}
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
  } else if (anom) {
    cls += ' warn';
    html = '<span class="txt">' + (mockNoKey ? '示範資料。' : '') + anom + '</span>' + (mockNoKey ? '<button type="button" data-act="paste-key">貼上金鑰</button>' : '<button type="button" data-act="tab-active">看進行中</button>');
  } else if (mockNoKey) {
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
const activeItems = () => items().filter(i => laneOf(i) === 'active');
// 進行中排序：先卡住與逾期，再依進度最後更新新到舊
const sortActive = l => l.sort((a, b) => (pv(a).alert ? 0 : 1) - (pv(b).alert ? 0 : 1) || (b.progressUpdatedAt || b.decidedAt || 0) - (a.progressUpdatedAt || a.decidedAt || 0));

function card(it) {
  const lv = lvOf(it), id = esc(it.id), t = esc(nm(it));
  const btns = can('act')
    ? '<div class="ca"><button class="del" data-act="del" data-id="' + id + '" type="button" aria-label="刪掉「' + t + '」">' + IC.trash + '<span>刪掉</span></button>' +
      '<button data-act="hold" data-id="' + id + '" type="button" aria-label="暫存「' + t + '」">' + IC.bm + '<span>暫存</span></button>' +
      '<button class="go" data-act="dive" data-id="' + id + '" type="button" aria-label="深入了解「' + t + '」">' + IC.dive + '<span>深入了解</span></button></div>'
    : '<div class="ca"><button class="go go-wide" data-act="dive" data-id="' + id + '" type="button" aria-label="深入了解「' + t + '」">' + IC.dive + '<span>深入了解</span></button></div>';
  return '<article class="card b-' + homeLane(it) + (S.fresh.has(it.id) ? ' fresh' : '') + '" data-id="' + id + '" data-lvl="' + lv + '" tabindex="0" aria-label="' + esc(it.title) + '">' +
    '<div class="c1"><span class="tm" data-cd="' + id + '" data-mode="short" data-lvl="' + lv + '">' + cdShort(it) + '</span>' + demo(it) + '</div>' +
    cardOrg(it) + '<h3 class="sb">' + softBreak(it.title) + '</h3><div class="c3">' + amt(it) + method(it) + '</div>' + btns + '</article>';
}
function acard(it) {
  const lv = lvOf(it), id = esc(it.id), p = pv(it);
  let meta;
  if (p.k === 'blocked') meta = '<p class="meta-line block-reason">卡住：' + esc(it.progressBlocker || '原因沒寫') + '</p>';
  else if (p.k === 'failed') meta = '<p class="meta-line fail-reason">' + (it.folderStatus === 'failed' ? '資料夾沒建成：' + esc(it.folderError || '原因不明') : '失敗：' + esc(it.progressBlocker || it.progressNote || '原因不明')) + '</p>';
  else if (p.k === 'overdue') meta = '<p class="meta-line fail-reason">' + esc(it.progressBlocker || '這步已過內部期限') + '</p>';
  else if (p.k === 'dlpass') meta = '<p class="meta-line fail-reason">公告截止時間已到，請確認是否已送出</p>';
  else if (folderWait(it)) meta = '<p class="meta-line"><span class="spin"></span>' + folderWaitText(it) + '</p>';
  else if (p.k === 'done') meta = '<p class="meta-line">已完成' + (OUTCOME[it.progressOutcome] ? '：<b>' + OUTCOME[it.progressOutcome] + '</b>' : '') + (it.progressUpdatedAt ? '，<span data-rel="' + it.progressUpdatedAt + '">' + relTime(it.progressUpdatedAt, tnow()) + '</span>' : '') + '</p>';
  else meta = '<p class="meta-line">' + byLine(it.progressUpdatedAt, it.progressUpdatedBy) + '</p>';
  const sent = submitted(it);
  // 送件後（v4）：左上大字是目前步驟、旁邊狀態徽章；下一行倒數盯下一個里程碑，「已送件 11/10」縮成小標籤
  const top = sent
    ? '<div class="c1 sent-top"><span class="step-big sb">' + softBreak(it.progressStage || '下一步') + '</span><span class="pst ' + p.cls + '">' + p.badge + '</span>' + demo(it) + '</div>' +
      '<p class="stage sent-row"><span class="tm" data-cd="' + id + '" data-mode="short" data-lvl="' + lv + '">' + cdShort(it) + '</span><span class="sent-tag">' + esc(sentTag(it)) + '</span></p>'
    : '<div class="c1"><span class="tm" data-cd="' + id + '" data-mode="short" data-lvl="' + lv + '">' + cdShort(it) + '</span>' + demo(it) + '</div>' +
      '<p class="stage"><b>' + esc(it.progressStage || '建立工作區') + '</b><span class="pst ' + p.cls + '">' + p.badge + '</span></p>';
  return '<article class="card b-active' + (S.fresh.has(it.id) ? ' fresh' : '') + '" data-id="' + id + '" data-pst="' + p.bar + '" data-lvl="' + lv + '" tabindex="0" aria-label="' + esc(it.title) + '，' + p.badge + '">' + top +
    cardOrg(it) + '<h3 class="sb">' + softBreak(it.title) + '</h3>' +
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

  const listOf = k => k === 'active' ? sortActive(act.slice()) : sortList(all.filter(i => laneOf(i) === k));
  $('#tabs').innerHTML = LANES.map(b => '<button class="tab b-' + b.k + '" type="button" role="tab" data-tab="' + b.k + '" aria-selected="' + (S.tab === b.k) + '">' +
    (loadingEmpty ? '<b class="sk-n sk"></b>' : '<b>' + listOf(b.k).length + '</b>') + b.n + '</button>').join('');
  $('#tabs').hidden = !!m;
  if (!m) lanes.innerHTML = LANES.map(b => {
    const list = listOf(b.k);
    const zero = b.k === 'active'
      ? '<div class="zero">' + IC.inbox + '<b>目前沒有進行中的案子</b><span>在完整內容按「要做」之後，進度會出現在這一籃。</span></div>'
      : '<div class="zero">' + IC.inbox + '<b>這一籃目前是空的</b><span>' + TBD.laneEmpty + '</span></div>';
    const body = loadingEmpty ? skel() + skel() + skel() : list.length ? list.map(b.k === 'active' ? acard : card).join('') : zero;
    return '<section class="lane b-' + b.k + (S.tab === b.k ? ' cur' : '') + '" data-l="' + b.k + '"><div class="lh"><h2><i class="ld"></i>' + b.n + (loadingEmpty ? '' : '<em>' + list.length + '</em>') + '</h2><div class="lh-row"><p>' + b.d + '</p>' + scanBox(b.k) + '</div></div><div class="lbody">' + body + '</div></section>';
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
  $('#hpill').hidden = $('#holdbtn').hidden = S.net === 'auth';
  $('#holdbtn').innerHTML = '待決區<b>' + h.length + '</b>';
  $('#hpill').innerHTML = '待決區<b>' + h.length + '</b>';
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
  if (S.drawer && S.drawer.view === 'chat') return 'chat';
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

function previewHTML(it) {
  const rem = it.status === 'snoozed' ? it.snoozeUntil : null;
  return '<div class="dt">' + head(it) + statBlock(it) + structBox(it, true) +
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
    structBox(it, false) + warnBox(it.warn) + crawlHTML(it) + firstBox(it) + factsBox(it) +
    '<section class="dt-sec dt-src"><h3>來源</h3>' + metaLine(it) + link(it) + '</section>' + chatHTML(it.id) + '</div>';
}

// ----- 進度大區塊（進行中的進度抽屜；網頁端只讀，沒有任何寫入進度的按鈕） -----
function stepRow(s, i, all, it) {
  const mark = s.status === 'done' ? '✓' : s.status === 'skipped' ? '–' : s.status === 'blocked' ? '!' : String(i + 1);
  let sub = '';
  if (s.status === 'done') sub = s.doneAt ? relTime(s.doneAt, tnow()) : '完成';
  else if (s.status === 'skipped') sub = '略過';
  else if (s.status === 'current') sub = '進行中' + (s.owner ? ' · ' + esc(s.owner) + ' 負責' : '') + (s.dueAt ? '<br><span class="' + (s.dueAt < tnow() ? 'due-late' : '') + '">這步要在 ' + fmtDate(s.dueAt) + ' 前完成' + (s.dueAt < tnow() ? '（已逾期）' : '') + '</span>' : '');
  const raw = noteUrl(s.note), txt = raw ? noteText(s.note) : s.note;   // 備註有網址：文字照樣跳脫，網址另外畫成按鈕
  const u = raw && !(it && linksOf(it).some(l => l.url === raw)) ? raw : '';   // 同一個網址已在 links（檔案區）就不重複畫
  if (s.status === 'blocked') sub = '卡住' + (txt ? '：' + esc(txt) : '') + (s.owner ? ' · ' + esc(s.owner) : '');
  const big = s.status === 'current' || s.status === 'blocked';
  const btn = u ? '<div class="step-acts">' + linkBtn(s.key, u, s.key === PAY_STEP && big ? 'btn-primary' : 'btn-ghost') + '</div>' : '';
  return '<li class="step ' + s.status + (u ? ' has-link' : '') + '"><span class="dot-s" aria-hidden="true">' + mark + '</span>' +
    (big ? '<div><p class="nm">' + esc(s.name) + '</p><p class="sub">' + sub + '</p>' + (txt && s.status === 'current' ? '<p class="sub">' + esc(txt) + '</p>' : '') + btn + '</div>'
         : '<p class="nm">' + esc(s.name) + '</p>' + (sub ? '<p class="sub">' + sub + '</p>' : '') + btn) + '</li>';
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
  const ls = linksOf(it); if (!ls.length) return '';
  return '<div class="fold-row files"><p class="prog-upd">檔案</p><div class="fold-acts">' + ls.map(l => extLink(l, 'btn ' + (l.kind === 'pay' ? 'btn-primary' : 'btn-ghost') + ' file-link')).join('') + '</div></div>';
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
  else if (p.k === 'done') warnLine = '<p class="prog-alert ok">已完成' + (OUTCOME[it.progressOutcome] ? '：' + OUTCOME[it.progressOutcome] : '') + (it.progressArchiveAt ? '。' + (it.progressArchiveAt > tnow() ? fmtDay(it.progressArchiveAt) + '從看板撤下' : '已從看板撤下') : '') + '</p>';
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
    progressBox(it) + structBox(it, false) +
    (it.why ? '<p class="dt-why sbp">' + softBreak(it.why) + '</p>' : '') + warnBox(it.warn) + crawlHTML(it) + factsBox(it) +
    '<section class="dt-sec dt-src"><h3>來源</h3>' + metaLine(it) + link(it) + '</section>' + chatHTML(it.id) + '</div>';
}

function renderDrawer() {
  const dr = $('#drawer');
  if (S.drawer && S.drawer.view === 'chat') return renderChatDrawer(dr);
  const it = S.drawer && get(S.drawer.id), view = viewOf();
  if (!it || !view) { dr.classList.remove('show'); return; }
  const keep = chatFocus();
  const sc = dr.querySelector('.db') && dr.dataset.key === it.id + view ? dr.querySelector('.db').scrollTop : 0;
  const id = esc(it.id); let label, body, foot = '';
  if (view === 'progress') {
    label = '進行中的進度';
    body = progressHTML(it);
    const canCopy = it.folderStatus === 'done' && /^\//.test(it.folderPath);
    const btns = (canCopy ? '<button class="btn btn-primary" data-act="copy-path" data-id="' + id + '" type="button">複製本機資料夾位置</button>' : '') +
      '<button class="btn ' + (canCopy ? 'btn-ghost' : 'btn-primary') + '" data-act="close-drawer" type="button">回到面板</button>';
    foot = '<div class="df prog-foot">' + btns + '</div>';
  } else if (view === 'full') {
    label = '完整內容'; body = fullHTML(it);
    foot = can('act') && (it.status === 'new' || it.status === 'snoozed')
      ? '<div class="df"><button class="btn btn-ghost del" data-act="no" data-id="' + id + '" type="button">不做</button>' +
        (canBuild(it) ? '<button class="btn btn-primary" data-act="yes" data-id="' + id + '" type="button">要做，建立公司工作區</button>' : '<p class="df-note">' + TENDER_ADMIN + '</p>') + '</div>'
      : '<div class="df"><button class="btn btn-primary" data-act="close-drawer" type="button">回到面板</button></div>';
  } else {
    label = '快速預覽'; body = previewHTML(it);
    foot = can('act')
      ? '<div class="df"><button class="btn btn-ghost del" data-act="del" data-id="' + id + '" type="button">刪掉</button>' +
        (it.status === 'snoozed' ? '' : '<button class="btn btn-ghost hold" data-act="hold" data-id="' + id + '" type="button">暫存</button>') +
        '<button class="btn btn-primary" data-act="dive" data-id="' + id + '" type="button">深入了解</button></div>'
      : '<div class="df"><button class="btn btn-primary" data-act="dive" data-id="' + id + '" type="button">深入了解</button></div>';
  }
  dr.innerHTML = '<div class="dh"><span>' + label + '</span><button class="xb" data-act="close-drawer" type="button" aria-label="關閉">×</button></div><div class="db">' + body + '</div>' + foot;
  dr.setAttribute('aria-label', label);
  dr.dataset.key = it.id + view;
  dr.querySelector('.db').scrollTop = sc;
  dr.classList.add('show');
  chatRestore(keep);
  if (view === 'full' || view === 'progress') markSeen(it.id);
}

function renderAll() {
  renderLive(); renderNotice(); renderSummary(); renderBoard(); renderSheet();
  if (S.drawer) { if (S.drawer.view !== 'chat' && !get(S.drawer.id)) closeDrawer(true); else renderDrawer(); }
  renderRk();
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
  S.drawer = { id, view: view || 'preview' };
  if (it.status === 'doing') ensureProgress(id);
  else if (view === 'full') ensureDetail(id);
  if (it.status === 'doing' || view === 'full') ensureMsgs(id);
  renderDrawer(); syncOverlay();
  const dr = $('#drawer'); if (!dr.contains(document.activeElement)) dr.querySelector('.xb')?.focus({ preventScroll: true });
}
function closeDrawer(silent) {
  S.drawer = null; $('#drawer').classList.remove('show'); syncOverlay();
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
    while (c.crawlStatus === 'crawling' && tnow() - t0 < 60000) { await wait(2000); c = (await api.get(id)) || c; put(c); redrawDrawer(id); }
    if (c.crawlStatus === 'crawling') {
      S.detail.set(id, { busy: false, timedOut: true, t0: (S.detail.get(id) && S.detail.get(id).t0) || t0 });
      saveSnapshot();
      return;
    }
    if (c.crawlStatus === 'done' && !c.detailText) { c = (await api.get(id)) || c; put(c); }
    saveSnapshot();
  } catch (e) {
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
  const o = seenStore(), all = msgsAll().filter(m => m.author === RK && (m.itemId || '') === key);
  const t = Math.max(tnow(), ...all.map(m => m.createdAt || 0));
  if ((o.keys[key] || 0) >= t) return;
  o.keys[key] = t; try { localStorage.setItem(SEEN_KEY(), JSON.stringify(o)); } catch (e) {}
  renderRk();
}
const msgsAll = () => { const seen = new Set(), out = []; S.msgs.forEach(v => v.list.forEach(m => { if (!seen.has(m.id)) { seen.add(m.id); out.push(m); } })); return out; };
function unreadReplies() {
  const o = seenStore();
  return msgsAll().filter(m => m.author === RK && m.createdAt && m.createdAt > Math.max(o.base || 0, o.keys[m.itemId || ''] || 0));
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
  if (S.drawer && S.drawer.view !== 'chat' && get(S.drawer.id) && (viewOf() === 'full' || viewOf() === 'progress')) ensureMsgs(S.drawer.id);
}
const chatOpenFor = key => !!S.drawer && (S.drawer.view === 'chat' ? key === '' : S.drawer.id === key && (viewOf() === 'full' || viewOf() === 'progress'));
function threadOf(key) {
  const st = S.msgs.get(key);
  const list = st ? st.list.filter(m => (m.itemId || '') === key) : null;
  const pend = S.pend.get(key) || [];
  return list ? list.slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)).concat(pend) : null;   // 舊的在上
}
function msgLi(m, all) {
  const rk = m.author === RK;
  const st = m.pending ? MSG_ST.sending : rk ? '' : (MSG_ST[m.status] || '');
  const orig = rk && m.replyTo ? all.find(x => x.id === m.replyTo) : null;
  return '<li class="msg ' + (rk ? 'rk' : 'me') + (m.pending ? ' pending' : '') + '">' +
    '<p class="msg-h"><b>' + esc(m.author || '不明') + '</b>' + (m.createdAt ? ' · <span data-rel="' + m.createdAt + '">' + relTime(m.createdAt, tnow()) + '</span>' : '') + '</p>' +
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
  ensureMsgs('');
  renderDrawer(); syncOverlay();
  ($('#chat-input') || $('#drawer .xb'))?.focus({ preventScroll: true });
}
function renderChatDrawer(dr) {
  const keep = chatFocus();
  const sc = dr.querySelector('.db') && dr.dataset.key === '__chat' ? dr.querySelector('.db').scrollTop : 0;
  // 案子裡的新回覆（總對話只放不綁案子的，案子裡的回覆列出來，點了打開那張卡）
  const o = seenStore(), other = {};
  unreadReplies().filter(m => m.itemId && get(m.itemId)).forEach(m => { other[m.itemId] = (other[m.itemId] || 0) + 1; });
  const oth = Object.keys(other).length ? '<section class="dt-sec chat-other"><h3>案子裡的新回覆</h3>' + Object.keys(other).map(id => { const it = get(id);
      return '<button class="btn btn-ghost" data-act="' + (it.status === 'doing' ? 'open-progress' : 'dive') + '" data-id="' + esc(id) + '" type="button">' + esc(nm(it)) + '（' + other[id] + '）</button>'; }).join('') + '</section>' : '';
  dr.innerHTML = '<div class="dh"><span>跟肉咖說</span><button class="xb" data-act="close-drawer" type="button" aria-label="關閉">×</button></div><div class="db"><div class="dt">' + oth + chatHTML('') + '</div></div>' +
    '<div class="df"><button class="btn btn-ghost" data-act="close-drawer" type="button">回到面板</button></div>';
  dr.setAttribute('aria-label', '跟肉咖說');
  dr.dataset.key = '__chat';
  const db = dr.querySelector('.db'); db.scrollTop = sc || db.scrollHeight;   // 第一次打開捲到最新
  dr.classList.add('show');
  chatRestore(keep);
  markSeen('');
}
// 重畫抽屜時保留輸入框的焦點與游標（草稿內容存在 S.draft）
function chatFocus() { const a = document.activeElement; return a && a.id === 'chat-input' ? [a.selectionStart, a.selectionEnd] : null; }
function chatRestore(k) { if (!k) return; const t = $('#chat-input'); if (t) { t.focus({ preventScroll: true }); try { t.setSelectionRange(k[0], k[1]); } catch (e) {} } }
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
  if (e.target.id !== 'chat-input') return;
  S.draft.set(e.target.dataset.key || '', e.target.value);
  const c = $('#chat-cnt'); if (c) c.textContent = e.target.value.length + '／' + MSG_MAX;
});
document.addEventListener('keydown', e => {   // Ctrl／⌘＋Enter 送出
  if (e.target.id === 'chat-input' && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); msgSend(e.target.dataset.key || ''); }
});

// ---------------- 立即掃描（v5；後端 opp_scan_request／opp_scan_status） ----------------
// 政府標案、補助徵件、企劃提案三籃欄頭各一顆。排隊或掃描中轉圈；15 分鐘內掃過按鈕寫「剛掃過」並灰掉；viewer 只看得到上次掃描時間。
const SCAN_COOL = 15 * 60e3;
const scanning = k => { const x = S.scan[k]; return !!x && (x.status === 'queued' || x.status === 'running'); };
const hm = ms => { const d = new Date(ms + 8 * H); return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0'); };
const lastScan = x => x && (x.lastDoneAt || (x.status === 'done' ? x.doneAt : null));
function scanBox(k) {
  if (!SCAN_LANES.includes(k)) return '';
  const x = S.scan[k], last = lastScan(x), now = tnow();
  const lastTxt = last ? '上次掃描 ' + (now - last < D ? hm(last) : fmtDate(last)) : '';
  let st = '';
  if (scanning(k)) st = '<span class="spin" aria-hidden="true"></span>掃描中，約 1～5 分鐘';
  else if (x && x.status === 'done' && x.doneAt && now - x.doneAt < SCAN_COOL) st = '剛掃完：' + (x.added == null ? '完成' : '新增 ' + x.added + ' 張') + (lastTxt ? ' · ' + lastTxt : '');
  else if (x && x.status === 'failed') st = '上次掃描沒有成功' + (lastTxt ? ' · ' + lastTxt : '');
  else st = lastTxt;
  const cool = last && now - last < SCAN_COOL;
  const btn = !can('act') ? ''
    : scanning(k) ? '<button class="scan-btn" type="button" disabled aria-disabled="true">掃描中</button>'
    : cool ? '<button class="scan-btn" type="button" disabled aria-disabled="true" title="15 分鐘內掃過，晚點再掃">剛掃過</button>'
    : '<button class="scan-btn" data-act="scan" data-lane="' + k + '" type="button" aria-label="立即掃描' + LN[k] + '">立即掃描</button>';
  return '<div class="scan" data-scan="' + k + '" aria-live="polite">' + btn + (st ? '<span class="scan-st">' + st + '</span>' : '') + '</div>';
}
function renderScan() { document.querySelectorAll('.scan[data-scan]').forEach(el => { const k = el.dataset.scan; el.outerHTML = scanBox(k); }); }
async function loadScan() {
  if (!api || !api.scanStatus || S.net === 'auth' || S.scanBusy.has('*')) return;
  S.scanBusy.add('*');
  try {
    const list = await api.scanStatus(), was = {};
    SCAN_LANES.forEach(k => { was[k] = scanning(k); });
    const before = JSON.stringify(S.scan);
    list.forEach(x => { if (!S.scanBusy.has(x.lane)) S.scan[x.lane] = x; });
    if (JSON.stringify(S.scan) !== before) renderScan();
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
    toast(res && res.state === 'already' ? '「' + LN[k] + '」已經在掃描了，約 1～5 分鐘'
      : res && res.state === 'recent' ? '「' + LN[k] + '」15 分鐘內剛掃過，先看看新卡'
      : '已開始掃描「' + LN[k] + '」，約 1～5 分鐘');
  } catch (e) {
    S.scan[k] = prev;   // 回滾
    if (e instanceof AdapterError && e.kind === 'auth') setAuth();
    if (e instanceof AdapterError && e.kind === 'perm') loadWho();
    toast('沒有開始掃描：' + reason(e), { bad: true });
  } finally { S.scanBusy.delete(k); renderScan(); kickPoll(); }
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
    if (dr && viewOf() === 'progress') ensureProgress(dr.id);
    loadMsgs();   // 跟肉咖說：不綁案子的對話（頂列紅點）＋正開著的那張卡
    loadScan();   // 立即掃描：三籃狀態
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
  const it = get(id); if (!it || !it.folderPath) return;
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
  if (e.target.id === 'scrim') { S.drawer ? closeDrawer() : closeSheet(); return; }
  const tab = e.target.closest('[data-tab]'); if (tab) { S.tab = tab.dataset.tab; renderBoard(); return; }
  if (e.target.closest('#hpill,#holdbtn')) { openSheet(); return; }
  if (e.target.closest('#rkbtn')) { openChat(); return; }
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
  if (e.key === 'Escape') { if (S.drawer) closeDrawer(); else if (S.sheet) closeSheet(); return; }
  if (e.key === 'Enter' && e.target.classList && e.target.classList.contains('card')) { const it = get(e.target.dataset.id); if (it) openDrawer(it.id, it.status === 'doing' ? 'progress' : 'preview'); }
  if (e.key === 'Tab' && (S.drawer || S.sheet)) {         // 焦點只在最上層的疊層內打轉
    const box = S.drawer ? $('#drawer') : $('#sheet');
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
const overlayOpen = () => !!S.drawer || S.sheet || $('#toast').classList.contains('show');
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
(async function boot() {
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
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
