// 好咖皮條客：私訊通道＋問答卡（sql/38）。由 app.js 呼叫 makeDm(X) 建立；X 帶 app 的狀態 S、api() 取用器與畫面工具。
// 寫成獨立模組是為了之後要移植到別的版面（例如退回 v81）時，只要換 X 裡的工具和 dmView／dmSendView 的外框。
export function makeDm(X) {
  const { S, $, esc, para, relTime, tnow, can, myName, rkFace, toast, renderDrawer, syncOverlay, closeDrawer, setAuth, renderAll, reason, AdapterError, keyTag, qs } = X;
  const API = () => X.api();
  let dmTmp = 0;
// ---------------- 私訊通道＋問答卡（後端 sql/38，D 做；設計 06_紀錄/派工單/20261123_Claude_私訊通道/設計.md） ----------------
// 每人一條跟肉咖的串，只有本人看得到。管理員只能：讀自己那串、發單獨公告／問答卡、看自己發出去的有沒有讀（opp_dm_sent）；
// 這裡刻意沒有任何「看別人私訊串」的入口（opp_dm_pending／opp_dm_mark 只給 planner，前端不呼叫）。
// 問答卡：一次一題、上面顯示第幾題；選項外加「其他」「不知道」、可補一句；中途關掉存草稿（localStorage），送出後變唯讀摘要。
const DM_MAX = 2000, ASK_TEXT_MAX = 300, ASK_NOTE_MAX = 200, ASK_PAYLOAD_MAX = 8000;
const dmMissing = e => e instanceof AdapterError && (e.kind === 'missing' || e.status === 404 || /PGRST202|Could not find the function|schema cache/i.test(e.message || ''));
const dmOn = () => !!API() && !!API().dmList && !S.dm.off && S.net !== 'auth';
const dmIsMine = m => !!m && (m.mine != null ? m.mine : m.authorRaw === m.owner);   // sql/38 回 mine（author＝owner）；只讀得到自己那串，所以 mine＝我寫的
function renderDmBtn() {
  const b = $('#dmbtn'); if (!b) return;
  b.hidden = !dmOn();
  const n = S.dm.unread;
  b.innerHTML = '私訊' + (n ? '<b class="bdg">' + n + '</b>' : '');
  b.setAttribute('aria-label', '私訊，只有你看得到' + (n ? '，' + n + ' 則未讀' : ''));
}
function dmGone(e) { S.dm.off = true; renderDmBtn(); if (S.drawer && /^dm/.test(S.drawer.view)) closeDrawer(true); }
async function loadDm() {   // 面板重新整理、收到即時 ping：重抓未讀數；私訊開著就重抓整串
  if (!API() || !API().dmUnread || S.dm.off || S.net === 'auth') return;
  try { const n = await API().dmUnread(); if (n !== S.dm.unread) { S.dm.unread = n; renderDmBtn(); } }
  catch (e) { if (dmMissing(e)) { dmGone(e); return; } if (e instanceof AdapterError && e.kind === 'auth') { setAuth(); renderAll(); return; } }
  if (S.drawer && S.drawer.view === 'dm') loadDmList();
}
async function loadDmList() {
  if (!API() || !API().dmList || S.dm.off) return;
  const ticket = ++S.dm.ticket;
  try {
    const l = await API().dmList(100);
    if (ticket !== S.dm.ticket) return;
    S.dm.err = false;
    const unread = l.filter(m => !dmIsMine(m) && !m.readAt);
    unread.forEach(m => S.dm.fresh.add(m.id));
    const sig = JSON.stringify(l);
    if (sig !== S.dm.sig || !S.dm.list) { S.dm.sig = sig; S.dm.list = l; if (S.drawer && S.drawer.view === 'dm') renderDrawer(); }
    if (unread.length && S.drawer && S.drawer.view === 'dm') { try { await API().dmMarkRead(); } catch (e) {} S.dm.unread = 0; renderDmBtn(); }
  } catch (e) {
    if (ticket !== S.dm.ticket) return;
    if (e instanceof AdapterError && e.kind === 'auth') { setAuth(); renderAll(); return; }
    if (dmMissing(e)) { dmGone(e); return; }
    S.dm.err = true; if (!S.dm.list) S.dm.list = [];
    if (S.drawer && S.drawer.view === 'dm') renderDrawer();
  }
}
function openDm() {
  X.setLastFocus();
  S.drawer = { id: '__dm', view: 'dm' }; S.dm.fresh.clear();
  loadDmList(); renderDrawer(); syncOverlay(); $('#drawer .xb')?.focus({ preventScroll: true });
}
const dmWhen = m => m.createdAt ? ' · <span data-rel="' + m.createdAt + '">' + relTime(m.createdAt, tnow()) + '</span>' : '';
const dmNew = m => S.dm.fresh.has(m.id) ? '<i class="dm-new">新</i>' : '';
function dmItem(m, ans) {
  if (m.kind === 'notice') return '<div class="dmn"><small>單獨公告｜只有你看得到 · ' + esc(m.author || '肉咖') + dmWhen(m) + dmNew(m) + '</small>' + para(m.body) + '</div>';
  if (m.kind === 'ask') return askCard(m, ans);
  const mine = dmIsMine(m);
  return '<div class="msg ' + (mine ? 'me' : '') + (m.pending ? ' pending' : '') + '"><small>' + (mine ? '我' : esc(m.author || '肉咖')) + dmWhen(m) + dmNew(m) + '</small>' + para(m.body) +
    (m.pending ? '<span class="msg-st">傳送中…</span>' : mine && m.status === 'new' ? '<span class="msg-st">送到了，等肉咖看</span>' : '') + '</div>';
}
function dmView() {
  const l = S.dm.list, ans = new Map();
  (l || []).filter(m => m.kind === 'answer' && m.replyTo).forEach(m => ans.set(m.replyTo, m));
  const th = l ? l.filter(m => m.kind !== 'answer').sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)).concat(S.dm.pend) : null;
  const list = !th ? '<div class="msg sys">讀取私訊中…</div>' : th.length ? th.map(m => dmItem(m, ans.get(m.id))).join('')
    : '<div class="msg sys">' + (S.dm.err ? '私訊讀不到，等一下會自動再試。' : '還沒有私訊。想單獨跟肉咖講的事寫在下面。') + '</div>';
  const head = '<div class="chhead dmhead">' + rkFace() + '<p><b class="dm-lock">只有你看得到</b>這是你跟肉咖的私訊，其他同事和管理員都看不到。不要在這裡傳密碼、帳號或證件號碼。</p></div>';
  const adm = can('admin') && API().dmSend ? '<p class="adm"><button class="bq" type="button" data-act="dm-compose">發單獨公告／問答卡</button></p>' : '';
  return { t: '私訊', b: head + adm + '<div class="msgs" aria-live="polite">' + list + '</div>', f: dmComposer() };
}
function dmComposer() {
  return '<div class="cmp"><label class="vh" for="dm-input">要私下跟肉咖說的話</label><textarea id="dm-input" maxlength="' + DM_MAX + '" rows="1" placeholder="只有你和肉咖看得到">' + esc(S.dm.draft) + '</textarea><button class="bm" type="button" data-act="dm-send">傳給肉咖</button></div>';
}
async function dmSendMine() {
  const text = S.dm.draft.trim();
  if (!text) { toast('還沒打字。先寫一句再傳。', { bad: true }); $('#dm-input')?.focus(); return; }
  if (text.length > DM_MAX) { toast('訊息太長，最多 ' + DM_MAX + ' 字', { bad: true }); return; }
  const tmp = { id: 'dmtmp' + (++dmTmp), mine: true, owner: myName(), authorRaw: myName(), author: myName(), kind: 'msg', body: text, createdAt: tnow(), pending: true };
  S.dm.pend.push(tmp); S.dm.draft = ''; renderDrawer();
  try { await API().dmAdd(text); S.dm.pend = S.dm.pend.filter(x => x !== tmp); await loadDmList(); renderDrawer(); }
  catch (e) {
    S.dm.pend = S.dm.pend.filter(x => x !== tmp); if (!S.dm.draft) S.dm.draft = text;
    if (e instanceof AdapterError && e.kind === 'auth') setAuth();
    toast('沒有送出：' + reason(e), { bad: true }); renderDrawer();
  }
}
// ---- 問答卡（作答） ----
const ASK_KEY = id => 'copp.dmask.v1:' + (API() && API().mode === 'mock' ? 'mock:' + (qs.get('mock') || '') : keyTag()) + ':' + id;
function askSt(id) {
  let st = S.dm.ask.get(id);
  if (!st) {
    let d = null; try { d = JSON.parse(localStorage.getItem(ASK_KEY(id)) || 'null'); } catch (e) {}
    st = { cur: d && Number.isInteger(d.cur) ? d.cur : 0, ans: d && d.ans && typeof d.ans === 'object' ? d.ans : {}, review: !!(d && d.review), bg: false, busy: false };
    S.dm.ask.set(id, st);
  }
  return st;
}
const askSave = id => { const st = S.dm.ask.get(id); if (st) try { localStorage.setItem(ASK_KEY(id), JSON.stringify({ cur: st.cur, ans: st.ans, review: st.review })); } catch (e) {} };
const askDrop = id => { try { localStorage.removeItem(ASK_KEY(id)); } catch (e) {} };
const ansOf = (st, q) => { const a = st.ans[q.id] || (st.ans[q.id] = {}); a.choice = Array.isArray(a.choice) ? a.choice : []; ['other', 'comment', 'text'].forEach(k => { if (typeof a[k] !== 'string') a[k] = ''; }); return a; };
const askDone = (q, a) => !!a && (!!a.unknown || (q.type === 'text' ? !!String(a.text || '').trim() : ((a.choice || []).length > 0 || (!!a.otherOn && !!String(a.other || '').trim()))));
function ansText(q, a) {   // 摘要用：一題一行
  if (!a) return '（沒有答）';
  if (a.unknown) return '不知道' + (a.comment ? '（' + a.comment + '）' : '');
  if (q.type === 'text') return a.text || '（沒有答）';
  const parts = (a.choice || []).slice(); if ((a.otherOn || a.other) && a.other) parts.push('其他：' + a.other);
  return (parts.join('、') || '（沒有答）') + (a.comment ? '（補充：' + a.comment + '）' : '');
}
function askSummary(k, answers, at) {
  return '<ol class="ask-sum">' + k.questions.map((q, i) => '<li><span>' + (i + 1) + '. ' + esc(q.text) + '</span><b>' + esc(ansText(q, answers && answers[q.id])) + '</b></li>').join('') + '</ol>' +
    (at ? '<p class="lg">已送出 · ' + esc(relTime(at, tnow())) + '，肉咖收到會轉給發問的人。</p>' : '');
}
function askCard(m, ar) {
  const k = m.ask;
  const head = '<div class="ask-h"><small>問答卡｜只有你看得到 · ' + esc(m.author || '肉咖') + dmWhen(m) + dmNew(m) + '</small><b>' + esc(k ? k.title : '問答卡') + '</b>' + (k && k.intro ? '<p>' + esc(k.intro) + '</p>' : '') + '</div>';
  if (!k) return '<div class="ask">' + head + '<p class="lg">這張卡的內容讀不出來，跟肉咖說一聲就好。</p></div>';
  const done = S.dm.done.get(m.id);
  if (ar || m.answeredAt || done) return '<div class="ask done">' + head + askSummary(k, ar ? ar.answers : done && done.answers, m.answeredAt || (ar && ar.createdAt) || (done && done.at)) + '</div>';
  const st = askSt(m.id), n = k.questions.length, aid = esc(m.id);
  if (st.review) {
    return '<div class="ask">' + head + '<p class="ask-p"><span>全部答完了，送出前看一下</span></p><ol class="ask-sum">' + k.questions.map((q, i) =>
      '<li><span>' + (i + 1) + '. ' + esc(q.text) + '</span><b>' + esc(ansText(q, st.ans[q.id])) + '</b><button class="bl" type="button" data-act="ask-goto" data-ask="' + aid + '" data-i="' + i + '">改</button></li>').join('') + '</ol>' +
      '<div class="ask-nav"><button class="bq" type="button" data-act="ask-goto" data-ask="' + aid + '" data-i="' + (n - 1) + '">‹ 回去改</button><button class="bm" type="button" data-act="ask-submit" data-ask="' + aid + '"' + (st.busy ? ' disabled' : '') + '>' + (st.busy ? '送出中…' : '送出答案') + '</button></div></div>';
  }
  const i = Math.max(0, Math.min(st.cur, n - 1)), q = k.questions[i], a = ansOf(st, q), qa = ' data-ask="' + aid + '" data-q="' + esc(q.id) + '"';
  const bar = '<div class="ask-p"><span>第 ' + (i + 1) + '／' + n + ' 題</span><span class="ask-dots" aria-hidden="true">' + k.questions.map((x, j) => '<i class="' + (j === i ? 'cur' : askDone(x, st.ans[x.id]) ? 'ok' : '') + '"></i>').join('') + '</span></div>';
  const note = q.note ? '<button class="ask-bg" type="button" data-act="ask-bg" data-ask="' + aid + '" aria-expanded="' + st.bg + '">' + (st.bg ? '收起背景' : '看背景') + '</button>' + (st.bg ? '<p class="ask-note">' + esc(q.note) + '</p>' : '') : '';
  let opts = '';
  if (q.type === 'text') {
    opts = '<label class="vh" for="ask-t-' + aid + '">你的回答</label><textarea class="ask-in" id="ask-t-' + aid + '" data-keep="1"' + qa + ' maxlength="' + ASK_TEXT_MAX + '" rows="3" placeholder="簡單寫就好（300 字內）">' + esc(a.text) + '</textarea>';
  } else {
    const multi = q.type === 'multi';
    opts = '<div class="opts" role="group" aria-label="' + (multi ? '可以選好幾個' : '選一個') + '">' + q.options.map((o, j) => { const on = !a.unknown && a.choice.includes(o);
      return '<button class="opt' + (on ? ' on' : '') + (multi ? ' multi' : '') + '" type="button" data-act="ask-opt"' + qa + ' data-v="' + j + '" aria-pressed="' + on + '">' + esc(o) + '</button>'; }).join('') +
      (q.other ? '<button class="opt' + (a.otherOn && !a.unknown ? ' on' : '') + (multi ? ' multi' : '') + '" type="button" data-act="ask-other"' + qa + ' aria-pressed="' + !!(a.otherOn && !a.unknown) + '">其他…</button>' : '') + '</div>' +
      (q.other && a.otherOn && !a.unknown ? '<label class="vh" for="ask-o-' + aid + '">其他</label><input class="ask-in" id="ask-o-' + aid + '" data-keep="1"' + qa + ' maxlength="' + ASK_NOTE_MAX + '" placeholder="其他：寫你的答案" value="' + esc(a.other) + '">' : '');
  }
  const unk = q.unknown ? '<button class="opt unk' + (a.unknown ? ' on' : '') + '" type="button" data-act="ask-unk"' + qa + ' aria-pressed="' + !!a.unknown + '">不知道</button>' : '';
  const cmt = q.comment && q.type !== 'text' ? '<label class="vh" for="ask-c-' + aid + '">補一句</label><input class="ask-in sm" id="ask-c-' + aid + '" data-keep="1"' + qa + ' maxlength="' + ASK_NOTE_MAX + '" placeholder="想補一句可以寫這裡（選填）" value="' + esc(a.comment) + '">' : '';
  const last = i === n - 1;
  const nav = '<div class="ask-nav">' + (i ? '<button class="bq" type="button" data-act="ask-prev" data-ask="' + aid + '">‹ 上一題</button>' : '<span></span>') +
    '<button class="bm" type="button" data-act="ask-next" data-ask="' + aid + '">' + (last ? '看一下再送出' : '下一題 ›') + '</button></div>';
  return '<div class="ask">' + head + bar + '<p class="ask-q">' + esc(q.text) + (q.type === 'multi' ? '<small>（可以選好幾個）</small>' : '') + '</p>' + note + opts + unk + cmt + nav + '</div>';
}
function askFind(id) { const m = (S.dm.list || []).find(x => x.id === id && x.kind === 'ask'); return m && m.ask ? m : null; }
function askAct(act) {
  const id = act.dataset.ask, m = askFind(id); if (!m) return;
  const st = askSt(id), k = m.ask, n = k.questions.length, i = Math.max(0, Math.min(st.cur, n - 1)), q = k.questions[i], a = ansOf(st, q);
  switch (act.dataset.act) {
    case 'ask-opt': { const o = q.options[Number(act.dataset.v)]; if (o == null) return; a.unknown = false;
      if (q.type === 'multi') a.choice = a.choice.includes(o) ? a.choice.filter(x => x !== o) : a.choice.concat(o); else { a.choice = a.choice[0] === o ? [] : [o]; a.otherOn = false; } break; }
    case 'ask-other': a.unknown = false; a.otherOn = !a.otherOn; if (a.otherOn && q.type !== 'multi') a.choice = []; break;
    case 'ask-unk': a.unknown = !a.unknown; if (a.unknown) { a.choice = []; a.otherOn = false; } break;
    case 'ask-bg': st.bg = !st.bg; break;
    case 'ask-prev': st.cur = Math.max(0, i - 1); st.bg = false; break;
    case 'ask-next': if (!askDone(q, a)) { toast(q.type === 'text' ? '寫一句，或按「不知道」' : '選一個，或按「不知道」', { bad: true }); return; }
      if (i < n - 1) { st.cur = i + 1; st.bg = false; } else st.review = true; break;
    case 'ask-goto': st.review = false; st.cur = Math.max(0, Math.min(n - 1, Number(act.dataset.i) || 0)); st.bg = false; break;
    case 'ask-submit': askSubmit(id); return;
  }
  askSave(id); renderDrawer();
  if (/^ask-(next|prev|goto)$/.test(act.dataset.act)) $('#drawer [data-act=ask-next][data-ask="' + CSS.escape(id) + '"], #drawer [data-act=ask-submit][data-ask="' + CSS.escape(id) + '"]')?.closest('.ask')?.scrollIntoView({ block: 'nearest' });
  if (act.dataset.act === 'ask-other') $('#ask-o-' + CSS.escape(id))?.focus({ preventScroll: true });
}
async function askSubmit(id) {
  const m = askFind(id); if (!m) return;
  const st = askSt(id), k = m.ask;
  const miss = k.questions.findIndex(q => !askDone(q, st.ans[q.id]));
  if (miss >= 0) { st.review = false; st.cur = miss; askSave(id); renderDrawer(); toast('第 ' + (miss + 1) + ' 題還沒答', { bad: true }); return; }
  const out = {};
  k.questions.forEach(q => { const a = st.ans[q.id];
    out[q.id] = q.type === 'text' ? (a.unknown ? { text: '', unknown: true } : { text: a.text.trim().slice(0, ASK_TEXT_MAX) })
      : { choice: a.unknown ? [] : a.choice.slice(), other: !a.unknown && a.otherOn ? a.other.trim().slice(0, ASK_NOTE_MAX) : '', comment: a.comment.trim().slice(0, ASK_NOTE_MAX), ...(a.unknown ? { unknown: true } : {}) }; });
  st.busy = true; renderDrawer();
  try {
    await API().dmAnswer(id, out);
    askDrop(id); S.dm.done.set(id, { answers: out, at: tnow() }); toast('送出了，肉咖收到會轉給發問的人');
    loadDmList();
  } catch (e) {
    if (/already_answered/.test(e.message || '')) { askDrop(id); toast('這張卡已經答過了', { bad: true }); loadDmList(); }
    else { if (e instanceof AdapterError && e.kind === 'auth') setAuth(); toast('沒有送出：' + (/bad_answers|answers_too_large/.test(e.message || '') ? '有題目的答案格式不對，回去看一下' : reason(e)), { bad: true }); }
  } finally { st.busy = false; renderDrawer(); }
}
// ---- 管理員：發單獨公告／出問答卡、看已讀（沒有看別人私訊串的入口） ----
const newQ = () => ({ text: '', note: '', type: 'single', opts: '', other: true, unknown: true, comment: true });
const cmpNew = () => ({ to: [], mode: 'notice', body: '', title: '', intro: '', qs: [newQ()], preview: false, busy: false });
function openDmCompose() {
  if (!can('admin') || !API().dmSend) return;
  S.drawer = { id: '__dmsend', view: 'dmsend' }; if (!S.dm.cmp) S.dm.cmp = cmpNew();
  loadDmRcp(); loadDmSent(); renderDrawer(); syncOverlay();
}
async function loadDmRcp() { try { S.dm.rcp = await API().dmRecipients(); } catch (e) { S.dm.rcp = 'err'; } if (S.drawer && S.drawer.view === 'dmsend') renderDrawer(); }
async function loadDmSent() { try { S.dm.sent = await API().dmSent(50); } catch (e) { S.dm.sent = 'err'; } if (S.drawer && S.drawer.view === 'dmsend') renderDrawer(); }
const qOpts = q => q.type === 'text' ? [] : [...new Set(String(q.opts || '').split('\n').map(x => x.trim()).filter(Boolean))];
function cmpPayload(c) {
  return { title: c.title.trim(), intro: c.intro.trim(), questions: c.qs.map((q, i) => ({ id: 'q' + i, text: q.text.trim(), ...(q.note.trim() ? { note: q.note.trim() } : {}), type: q.type, options: qOpts(q),
    other: q.type !== 'text' && q.other, unknown: q.unknown, comment: q.type !== 'text' && q.comment })) };
}
function cmpCheck(c) {
  if (!c.to.length) return '先勾收件人';
  if (c.to.length > 20) return '一次最多 20 人';
  if (c.mode === 'notice') { if (!c.body.trim()) return '公告還沒寫內容'; if (c.body.length > DM_MAX) return '公告最多 ' + DM_MAX + ' 字'; return ''; }
  if (!c.title.trim()) return '問答卡要有標題';
  if (!c.qs.length || c.qs.length > 10) return '題目要 1～10 題';
  for (let i = 0; i < c.qs.length; i++) { const q = c.qs[i];
    if (!q.text.trim()) return '第 ' + (i + 1) + ' 題還沒寫題目';
    if (q.text.trim().length > 60) return '第 ' + (i + 1) + ' 題題目超過 60 字';
    if (q.type !== 'text' && qOpts(q).length < 2) return '第 ' + (i + 1) + ' 題至少要兩個選項（一行一個）';
    if (qOpts(q).length > 12) return '第 ' + (i + 1) + ' 題最多 12 個選項';
    if (qOpts(q).some(o => o.length > 60)) return '第 ' + (i + 1) + ' 題有選項超過 60 字'; }
  if (new Blob([JSON.stringify(cmpPayload(c))]).size > ASK_PAYLOAD_MAX) return '問答卡內容太長，請刪短一點';
  return '';
}
const QTYPE = [['single', '單選'], ['multi', '多選'], ['text', '問答']];
function cmpEditor(c) {
  const rcp = S.dm.rcp;
  const to = !rcp ? '<p class="lg">讀取收件人中…</p>' : rcp === 'err' ? '<p class="lg">收件人讀不到，等一下再試。</p>' :
    '<div class="chips">' + rcp.map(n => { const on = c.to.includes(n); return '<button class="chip' + (on ? ' on' : '') + '" type="button" data-act="dm-to" data-n="' + esc(n) + '" aria-pressed="' + on + '">' + esc(n) + '</button>'; }).join('') +
    (rcp.length > 1 ? '<button class="bl" type="button" data-act="dm-to-all">' + (c.to.length === rcp.length ? '全部取消' : '全選') + '</button>' : '') + '</div>';
  const seg = (act, cur, list, extra) => '<div class="seg" role="group">' + list.map(([k, t]) => '<button class="' + (cur === k ? 'on' : '') + '" type="button" data-act="' + act + '" data-v="' + k + '"' + (extra || '') + ' aria-pressed="' + (cur === k) + '">' + t + '</button>').join('') + '</div>';
  let body;
  if (c.mode === 'notice') body = '<label class="fl" for="dm-nb">公告內容</label><textarea class="ask-in" id="dm-nb" data-keep="1" maxlength="' + DM_MAX + '" rows="5" placeholder="例：下週一 10:00 開提案會議">' + esc(c.body) + '</textarea>';
  else body = '<label class="fl" for="dm-at">標題</label><input class="ask-in" id="dm-at" data-keep="1" maxlength="60" placeholder="例：故宮 142 改稿判斷" value="' + esc(c.title) + '">' +
    '<label class="fl" for="dm-ai">一句話說明（選填）</label><input class="ask-in" id="dm-ai" data-keep="1" maxlength="80" placeholder="例：5 題，大約 2 分鐘" value="' + esc(c.intro) + '">' +
    c.qs.map((q, i) => '<div class="qe"><div class="qe-h"><b>第 ' + (i + 1) + ' 題</b>' + (c.qs.length > 1 ? '<button class="bl" type="button" data-act="dm-qdel" data-i="' + i + '">刪掉這題</button>' : '') + '</div>' +
      '<label class="vh" for="dm-q' + i + '-t">題目</label><input class="ask-in" id="dm-q' + i + '-t" data-keep="1" data-i="' + i + '" data-f="text" maxlength="60" placeholder="題目（60 字內）" value="' + esc(q.text) + '">' +
      seg('dm-qtype', q.type, QTYPE, ' data-i="' + i + '"') +
      (q.type !== 'text' ? '<label class="vh" for="dm-q' + i + '-o">選項</label><textarea class="ask-in" id="dm-q' + i + '-o" data-keep="1" data-i="' + i + '" data-f="opts" rows="3" placeholder="選項，一行一個">' + esc(q.opts) + '</textarea>' : '') +
      '<label class="vh" for="dm-q' + i + '-n">背景</label><input class="ask-in sm" id="dm-q' + i + '-n" data-keep="1" data-i="' + i + '" data-f="note" maxlength="200" placeholder="背景小字（選填，預設收起來）" value="' + esc(q.note) + '">' +
      '<div class="qe-f">' + (q.type !== 'text' ? [['other', '加「其他」'], ['comment', '可以補一句']] : []).concat([['unknown', '加「不知道」']]).map(([f, t]) =>
        '<button class="chip sm' + (q[f] ? ' on' : '') + '" type="button" data-act="dm-qflag" data-i="' + i + '" data-f="' + f + '" aria-pressed="' + !!q[f] + '">' + (q[f] ? '✓ ' : '') + t + '</button>').join('') + '</div></div>').join('') +
    (c.qs.length < 10 ? '<button class="bq wide" type="button" data-act="dm-qadd">＋ 加一題</button>' : '<p class="lg">最多 10 題。</p>');
  return '<div class="blk"><h3>收件人（可以多選；每人各一份，互相看不到）</h3>' + to + '</div>' +
    '<div class="blk"><h3>要發什麼</h3>' + seg('dm-mode', c.mode, [['notice', '單獨公告'], ['ask', '問答卡']]) + body + '</div>';
}
function cmpPreview(c) {
  const who = '<p class="lg">收件人：' + c.to.map(esc).join('、') + '（每人各一份）</p>';
  if (c.mode === 'notice') return who + '<div class="msgs"><div class="dmn"><small>單獨公告｜只有你看得到 · ' + esc(myName() || '管理員') + '</small>' + para(c.body.trim()) + '</div></div>';
  const k = cmpPayload(c);
  return who + '<div class="ask"><div class="ask-h"><small>問答卡｜只有你看得到 · ' + esc(myName() || '管理員') + '</small><b>' + esc(k.title) + '</b>' + (k.intro ? '<p>' + esc(k.intro) + '</p>' : '') + '</div>' +
    '<ol class="ask-sum">' + k.questions.map((q, i) => '<li><span>' + (i + 1) + '. ' + esc(q.text) + '</span><b>' + (q.type === 'text' ? '問答（300 字內）' : (q.type === 'multi' ? '多選：' : '單選：') + esc(q.options.join('、'))) +
      (q.other ? '、其他' : '') + (q.unknown ? '、不知道' : '') + (q.comment ? '；可補一句' : '') + '</b>' + (q.note ? '<small>背景：' + esc(q.note) + '</small>' : '') + '</li>').join('') + '</ol>' +
    '<p class="lg">對方會一次看到一題，上面有第幾題，答完才送出。</p></div>';
}
function sentHTML() {
  const l = S.dm.sent;
  const rows = !l ? '<p class="lg">讀取中…</p>' : l === 'err' ? '<p class="lg">讀不到，等一下再試。</p>' : !l.length ? '<p class="lg">還沒發過。</p>' :
    l.map(x => '<div class="arow"><b>' + esc(x.to) + '・' + (x.kind === 'ask' ? '問答卡' : '單獨公告') + '</b><span>' + esc((x.kind === 'ask' && x.title ? x.title : x.body).slice(0, 40)) + '・' + esc(relTime(x.createdAt, tnow())) + '</span>' +
      '<span class="rd ' + (x.answeredAt ? 'ok' : x.readAt ? 'ok' : '') + '">' + (x.answeredAt ? '已答 ' + esc(relTime(x.answeredAt, tnow())) : x.readAt ? '已讀 ' + esc(relTime(x.readAt, tnow())) : '還沒讀') + '</span></div>').join('');
  return '<div class="blk"><h3>你發出去的（只看得到有沒有讀，看不到對方的私訊）</h3>' + rows + '</div>';
}
function dmSendView() {
  const c = S.dm.cmp || (S.dm.cmp = cmpNew());
  const b = '<p class="lg dmtip">單獨公告和問答卡只會出現在對方自己的私訊裡。你看得到有沒有讀、有沒有答，看不到對方跟肉咖說了什麼。</p>' + (c.preview ? cmpPreview(c) : cmpEditor(c)) + sentHTML();
  const f = c.preview ? '<button class="bq" type="button" data-act="dm-edit">‹ 回去改</button><button class="bm gr" type="button" data-act="dm-go"' + (c.busy ? ' disabled' : '') + '>' + (c.busy ? '送出中…' : '送給 ' + c.to.length + ' 人') + '</button>'
    : '<button class="bm gr" type="button" data-act="dm-preview">預覽</button>';
  return { t: c.mode === 'ask' ? '出問答卡' : '發單獨公告', back: 'dm-back', b, f };
}
function dmCmpAct(act) {
  const c = S.dm.cmp; if (!c) return;
  const i = Number(act.dataset.i);
  switch (act.dataset.act) {
    case 'dm-to': { const n = act.dataset.n; c.to = c.to.includes(n) ? c.to.filter(x => x !== n) : c.to.concat(n); break; }
    case 'dm-to-all': c.to = Array.isArray(S.dm.rcp) && c.to.length !== S.dm.rcp.length ? S.dm.rcp.slice() : []; break;
    case 'dm-mode': c.mode = act.dataset.v === 'ask' ? 'ask' : 'notice'; break;
    case 'dm-qtype': if (c.qs[i]) c.qs[i].type = act.dataset.v; break;
    case 'dm-qflag': if (c.qs[i]) c.qs[i][act.dataset.f] = !c.qs[i][act.dataset.f]; break;
    case 'dm-qadd': if (c.qs.length < 10) c.qs.push(newQ()); renderDrawer(); $('#dm-q' + (c.qs.length - 1) + '-t')?.focus(); return;
    case 'dm-qdel': if (c.qs.length > 1) c.qs.splice(i, 1); break;
    case 'dm-preview': { const err = cmpCheck(c); if (err) { toast(err, { bad: true }); return; } c.preview = true; break; }
    case 'dm-edit': c.preview = false; break;
    case 'dm-go': dmCmpSend(); return;
  }
  renderDrawer();
}
const DM_ERR = [[/bad_recipient|bad_to|inactive/, '有收件人不存在或已停用，重新勾一次'], [/too_many_recipients/, '一次最多 20 人'], [/bad_payload|bad_question|bad_options|payload_too_large/, '問答卡格式不對，回去檢查題目和選項'], [/bad_body|body/, '內容不能空白，最多 2000 字']];   // sql/38 的錯誤碼
async function dmCmpSend() {
  const c = S.dm.cmp, err = cmpCheck(c); if (err) { c.preview = false; renderDrawer(); toast(err, { bad: true }); return; }
  c.busy = true; renderDrawer();
  try {
    if (c.mode === 'ask') { const p = cmpPayload(c); await API().dmSend(c.to.slice(), '問答卡：' + p.title, 'ask', p); }
    else await API().dmSend(c.to.slice(), c.body.trim(), 'notice');
    toast('已發給 ' + c.to.length + ' 人，各自只看得到自己那份');
    S.dm.cmp = cmpNew(); loadDmSent(); loadDm();
  } catch (e) {
    c.busy = false;
    if (e instanceof AdapterError && e.kind === 'auth') setAuth();
    const hit = DM_ERR.find(([re]) => re.test(e.message || ''));
    toast('沒有發出：' + (hit ? hit[1] : reason(e)), { bad: true });
  }
  renderDrawer();
}
function dmInput(t) {   // 私訊、問答卡、出卡編輯器的輸入：只更新狀態不重畫（重畫會讓手機鍵盤跳掉）
  const id = t.id || '';
  if (id === 'dm-input') { S.dm.draft = t.value; t.style.height = '48px'; t.style.height = Math.min(120, t.scrollHeight + 2) + 'px'; return true; }
  if (/^ask-[otc]-/.test(id)) {
    const m = askFind(t.dataset.ask); if (!m) return true;
    const q = m.ask.questions.find(x => x.id === t.dataset.q); if (!q) return true;
    const st = askSt(m.id), a = ansOf(st, q), f = { o: 'other', t: 'text', c: 'comment' }[id[4]];
    a[f] = t.value;
    if (f !== 'comment' && t.value.trim() && a.unknown) { a.unknown = false; document.querySelector('#drawer [data-act=ask-unk][data-ask="' + CSS.escape(m.id) + '"]')?.classList.remove('on'); }
    askSave(m.id); return true;
  }
  const c = S.dm.cmp; if (!c || !/^dm-/.test(id)) return false;
  if (id === 'dm-nb') c.body = t.value; else if (id === 'dm-at') c.title = t.value; else if (id === 'dm-ai') c.intro = t.value;
  else if (/^dm-q\d+-/.test(id) && c.qs[Number(t.dataset.i)]) c.qs[Number(t.dataset.i)][t.dataset.f] = t.value;
  else return false;
  return true;
}
  return { renderDmBtn, loadDm, loadDmList, openDm, dmView, dmSendView, dmSendMine, openDmCompose, askAct, dmCmpAct, dmInput };
}
