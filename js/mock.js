// 示範模式：沒有後端設定或沒有金鑰時才會載入。全部是「示意資料」（is_demo），時間一律相對於「現在」。
// 資料先寫成後端 opp_list／opp_get 的欄位格式（sql/02_rpcs.sql、sql/10_progress.sql），再交給 adapter 的 normalize，
// 所以示範與真後端走同一條路。真後端上線後，這個檔案不會被載入。
//
// 偵錯參數（只在示範模式有效），可用逗號串接，例如 ?mock=slow,crawlfail
//   empty        整個面板沒有資料
//   emptylane    「企劃提案」籃是空的
//   noactive     沒有進行中的案子
//   viewer       唯讀金鑰（opp_whoami 只給 read），看沒有任何操作按鈕的畫面
//   admin        管理員金鑰（caps.admin），政府標案才有「要做」（sql/21）
//   demote       第一次 opp_whoami 是 operator，之後變 viewer，寫入一律回權限不足（模擬金鑰被降權）
//   authlater    第一次列表成功，之後一律金鑰失效（看失效後停輪詢、清快照）
//   debug        在 window 上放 __mockListCalls（列表被呼叫幾次）、__mockPing()（模擬 realtime ping）、__mockListeners（訂閱數）
//   xss          多放幾張每個文字欄都塞 HTML、網址是 javascript: 的測試卡，確認畫面全部當文字顯示
//   slow         列表 6 秒後才回來（看「載入比較久」）
//   hang         列表一直不回來（看載入中與逾時）
//   offline      列表一律失敗（先正常開過一次，再用這個看離線，會顯示上次快照）
//   auth         模擬金鑰失效
//   crawlfail    深入了解的讀全文一律失敗
//   crawlslow    讀全文 16 秒後才完成（看「正在讀全文」，含超過 10 秒的說明）
//   crawlhang    讀全文一直不回來（看 60 秒逾時）
//   setfail      刪掉、暫存、不做、要做一律失敗（看回滾）
//   realbuild    要做之後照真卡流程：排隊 → 建立中 → 建好（看 3 秒快輪詢與第 1 步自動完成）
//   folderslow   同 realbuild，但 12 秒後才建好
//   live         9 秒後進來一張新卡（看新進光暈與 toast）
import { AdapterError, normalize } from './adapter.js?v2';   // 網址要和 app.js 匯入的一模一樣，才是同一份模組

const H = 3600e3, D = 24 * H, MIN = 60e3;
const wait = ms => new Promise(r => setTimeout(r, ms));
const iso = ms => new Date(ms).toISOString();

// 與 sql/10_progress.sql 的 _opp_default_steps 相同的鍵與名稱
const DEFAULT_STEPS = {
  tender: [['create_workspace', '建立工作區'], ['read_tender_docs', '讀招標文件'], ['assess_quote', '評估資格與報價'], ['write_proposal', '撰寫企劃與估價'], ['seal_and_bid', '用印與投標'], ['await_opening', '等待開標'], ['result', '決標或結案']],
  grant: [['create_workspace', '建立工作區'], ['read_guidelines', '讀徵件須知'], ['write_plan', '撰寫計畫書'], ['prepare_attachments', '備齊附件與用印'], ['submit', '送件'], ['under_review', '審查中'], ['result', '核定或結案']],
  pitch: [['create_workspace', '建立工作區'], ['align_needs', '對需求'], ['write_pitch', '撰寫企劃'], ['internal_review', '內部審稿'], ['deliver', '提交'], ['revise', '來回修改'], ['confirm', '確認或結案']],
};
DEFAULT_STEPS.watch = DEFAULT_STEPS.pitch;

// 依當前步驟 n（1 起）造一份步驟清單：前面完成、第 n 步 current（或 blocked）、後面 pending
function stepsAt(lane, n, o = {}) {
  const now = Date.now();
  return DEFAULT_STEPS[lane].map(([key, name], i) => {
    const s = { key, name, status: i + 1 < n ? 'done' : i + 1 === n ? (o.cur || 'current') : 'pending', due_at: null, done_at: null, owner: null, note: null };
    if (s.status === 'done') s.done_at = iso(now - (n - 1 - i) * 26 * H - 2 * H);
    if (i + 1 === n) { s.owner = o.owner || null; s.note = o.note || null; s.due_at = o.due || null; }
    if (o.skip && o.skip.includes(i + 1)) s.status = 'skipped';
    return s;
  });
}
// 與後端 _opp_steps_derive 同規則：階段＝current/blocked 那步（沒有就最後一步），百分比＝(完成＋略過)÷總數，結案 done 為 100
function derive(r) {
  const st = r.progress_steps || [];
  if (!st.length) return;
  let i = st.findIndex(s => s.status === 'current' || s.status === 'blocked');
  if (i < 0) { i = st.findIndex(s => s.status === 'pending'); if (i < 0) i = st.length - 1; }
  r.progress_stage = st[i].name; r.progress_stage_key = st[i].key;
  r.progress_step_n = i + 1; r.progress_step_total = st.length;
  r.progress_pct = r.progress_state === 'done' ? 100 : Math.round(st.filter(s => s.status === 'done' || s.status === 'skipped').length * 100 / st.length);
  r.progress_due_at = st[i].due_at || null;
}
// 與後端 _opp_card 同規則
function progressStatus(r) {
  if (r.status !== 'doing') return 'none';
  if (r.folder_status === 'failed' || r.progress_state === 'failed') return 'failed';
  if (r.progress_state === 'done') return 'done';
  if (r.progress_state === 'blocked') return 'blocked';
  if (['none', 'queued', 'building'].includes(r.folder_status)) return 'queued';
  if (r.progress_due_at && Date.parse(r.progress_due_at) < Date.now()) return 'overdue';
  return 'active';
}

const SRC = 'https://example.org/demo/';   // 示意來源網址，不連任何真的公告

function build() {
  const now = Date.now();
  const at = (days, hh, mm = 0) => { const d = new Date(now + days * D); d.setHours(hh, mm, 0, 0); return iso(d.getTime()); };
  const ago = h => iso(now - h * H);
  const exp = (h, days = 7) => iso(now - h * H + days * D);
  const base = {
    basket: 'company', status: 'new', is_demo: true, currency: 'NT$', amount_label: '', amount_display: '', warn: [], quick: [], facts: [], why: '', first_step: '', fit: '',
    source_url: '', source_site: '', found_by: 'Company Claude', remind_at: null, stash_due_at: null, decided_at: null, drop_reason: null,
    case_no: null, tender_method: null, bid_bond: null, performance_period: null, qualification: null,
    crawl_status: 'none', crawl_error: null, full_text: '', attachments: [],
    folder_status: 'none', folder_name: null, folder_path: null, folder_error: null, notion_status: null, notion_url: null,
    progress_state: null, progress_steps: [], progress_note: null, progress_blocker: null, progress_outcome: null, progress_archive_at: null,
    progress_updated_at: null, progress_updated_by: null, links: [],
  };
  const row = o => Object.assign({}, base, o);
  const doing = (o, lane, n, so) => {
    const r = row(Object.assign({ status: 'doing', lane, folder_status: 'done', notion_status: 'skipped', decided_at: ago(60) }, o));
    r.progress_steps = stepsAt(lane, n, so || {});
    return r;
  };
  const rows = [
    // ---------- 政府標案 ----------
    row({ id: 'demo-t1', lane: 'tender', title: '115 年度業務宣導影片', org: '內政部建築研究所', amount_label: '預算', amount_display: '70萬', amount_num: 700000,
      deadline: at(2, 17), created_at: ago(30), expire_at: at(2, 17), case_no: '1150807-A（示意）', tender_method: '公開招標', bid_bond: '不用', performance_period: '決標後 120 日',
      qualification: '公司登記，營業項目含一般廣告服務業；近三年有政府影片標案實績者佳。投標文件只收紙本，截止前送達機關總務室。',
      fit: '中', why: '不用押標金，上一次流標後重新招標，競爭可能比較少', quick: ['要公司登記，營業項目含一般廣告服務業', '影片支數與長度要看招標文件'],
      facts: ['案號：1150807-A（示意）', '押標金：不用', '流標：上一次流標、重新招標', '收件：只收紙本'], warn: ['送件只收紙本，要預留用印和寄送的時間。'],
      first_step: '電子領標，拿到需求規範書與評審須知。', source_site: '政府電子採購網', source_url: SRC + 'tender-1' }),
    row({ id: 'demo-t2', lane: 'tender', title: '臺灣故事館形象影片', org: '文化部影視及流行音樂產業局', amount_label: '預算', amount_display: '240萬', amount_num: 2400000,
      deadline: at(12, 17), created_at: ago(20), expire_at: at(12, 17), case_no: 'BAMID-115-021（示意）', tender_method: '最有利標', bid_bond: '12萬', performance_period: '決標後 180 日',
      qualification: '公司登記，近三年有單案 100 萬以上影片製作實績。', fit: '高', why: '規模和公司過去的形象片接近，評選看企劃', quick: ['最有利標，評選佔比看企劃與團隊', '押標金 12 萬'],
      facts: ['評選：企劃 40%、團隊 30%、價格 30%（示意）'], first_step: '先排內部企劃會議，決定主軸。', source_site: '政府電子採購網', source_url: SRC + 'tender-2', found_by: 'system' }),
    row({ id: 'demo-t3', lane: 'tender', status: 'stashed', title: '藝文季宣傳影片', org: '某縣政府文化局', amount_label: '預算', amount_display: '34.4萬', amount_num: 344000,
      deadline: at(5, 17), created_at: ago(40), stash_due_at: at(5, 17), remind_at: at(1, 8), decided_at: ago(3), tender_method: '公開取得報價', bid_bond: '不用',
      why: '規模剛好，可以讓新人練手', quick: ['服務建議書 6 份', '不用押標金'], first_step: '領標，看影片支數和評選配分。', source_site: '政府電子採購網', source_url: SRC + 'tender-3' }),
    // ---------- 補助徵件 ----------
    row({ id: 'demo-g1', lane: 'grant', title: '115 年內容開發補助（紀實影像）', org: '文化內容策進院', amount_label: '補助上限', amount_display: '80萬', amount_num: 800000,
      deadline: at(29, 17), created_at: ago(26), expire_at: at(29, 17), fit: '高', why: '公司名義可申請，紀實類是公司強項', quick: ['自籌款至少 20%', '要附前導片或企劃書'],
      facts: ['金額：每案補助上限 80 萬，不超過總經費 80%', '資格：依法登記之影視公司'], warn: ['結案要交成果報告與經費核銷，前期要自己墊款。'], first_step: '下載徵件須知，確認自籌款比例。', source_site: '文策院官網', source_url: SRC + 'grant-1' }),
    row({ id: 'demo-g2', lane: 'grant', title: '紀錄片創作補助', org: '文化部影視及流行音樂產業局', amount_label: '補助上限', amount_display: '120萬', amount_num: 1200000,
      deadline: at(21, 17), deadline_approx: true, deadline_text: '12 月上旬（徵件須知還沒定稿）', created_at: ago(50), expire_at: at(21, 17), fit: '中', why: '要有導演與題目，公司可當申請單位', quick: ['公司為申請單位，導演具名'], first_step: '先挑題目與導演。', source_site: '影視局官網', source_url: SRC + 'grant-2' }),
    // ---------- 企劃提案 ----------
    row({ id: 'demo-p1', lane: 'pitch', title: '2027 春季旅遊宣傳合作企劃', org: '某縣市觀光處', amount_label: '報價', amount_display: '沒寫金額', currency: null,
      created_at: ago(26), expire_at: exp(26), fit: '中', why: '對方主動來詢問，可提一版短影音系列', quick: ['還沒有採購程序，先提企劃', '對方希望 12 月中前看到方向'], first_step: '約一次需求訪談。' }),
    // ---------- 盯案後續 ----------
    row({ id: 'demo-w1', lane: 'watch', title: '簡介影片，公開徵求參考資料', org: '明潭發電廠', amount_display: '沒寫金額', currency: null, tender_method: '尚未正式招標',
      created_at: ago(6 * 24), expire_at: exp(6 * 24, 30), why: '現在只是徵求參考資料，正式招標值得盯', quick: ['內容有執導、空拍、動畫、配音'], first_step: '看徵求內容，決定要不要提供參考資料。', source_site: '政府電子採購網', source_url: SRC + 'watch-1' }),

    // ---------- 進行中（status = doing） ----------
    // 進行中：一般狀態
    doing({ id: 'demo-a1', title: '地方創生紀錄短片', org: '農業部農村發展及水土保持署', amount_label: '預算', amount_display: '150萬', deadline: at(16, 17), created_at: ago(70),
      case_no: '1150807（示意）', tender_method: '公開招標', bid_bond: '不用', performance_period: '決標後 90 天', qualification: '公司登記，營業項目含廣告與影片製作。',
      source_site: '政府電子採購網', source_url: SRC + 'active-1', folder_name: '11-14_地方創生紀錄短片', folder_path: '/Users/Shared/公司工作區/11-14_地方創生紀錄短片',
      notion_status: 'done', notion_url: SRC + 'notion-page', progress_state: 'active', progress_note: '初稿結構已出，等你看第二段節奏。',
      links: [{ kind: 'pool', label: 'Pool 官方文件與成品', url: 'https://drive.google.com/drive/folders/DEMO-POOL-A1' }, { kind: 'review', label: '標案內審', url: 'https://drive.google.com/drive/folders/DEMO-REVIEW-A1' }, { kind: 'other', label: '示意：不是 https 的連結不會出現', url: 'http://example.org/insecure' }],
      progress_updated_at: iso(now - 22 * MIN), progress_updated_by: 'Company Claude' }, 'tender', 4, { owner: 'Company Claude' }),
    // 卡住
    doing({ id: 'demo-a2', title: '產業故事影音案', org: '臺北市產業發展局', amount_label: '預算', amount_display: '98萬', deadline: at(3, 12), created_at: ago(120),
      tender_method: '公開招標', source_site: '政府電子採購網', source_url: SRC + 'active-2', folder_name: '11-10_產業故事影音案', folder_path: '/Users/Shared/公司工作區/11-10_產業故事影音案',
      progress_state: 'blocked', progress_blocker: '等公司用印', progress_note: '企劃書與估價單都好了，只差用印。', progress_updated_at: ago(5), progress_updated_by: '企劃流程' }, 'tender', 5, { cur: 'blocked', note: '等公司用印', owner: '行政' }),
    // 這步逾期（當前步驟的內部期限過了）
    doing({ id: 'demo-a3', title: '地方文化影像徵件', org: '某文化基金會', amount_label: '補助上限', amount_display: '60萬', deadline: at(10, 17), created_at: ago(200),
      source_url: SRC + 'active-3', source_site: '基金會官網', folder_name: '11-05_地方文化影像徵件', folder_path: '/Users/Shared/公司工作區/11-05_地方文化影像徵件',
      progress_state: 'active', progress_note: '計畫書第三章還沒寫完。', progress_updated_at: ago(30), progress_updated_by: 'Company Claude' }, 'grant', 3, { due: iso(now - 5 * H), owner: 'Company Claude' }),
    // 截止已到（公告截止日過了，後端不收走，只警示）
    doing({ id: 'demo-a4', title: '城市觀光短影音標案', org: '某市政府觀光傳播局', amount_label: '預算', amount_display: '45萬', deadline: iso(now - 2 * H), created_at: ago(300),
      tender_method: '公開取得報價', source_url: SRC + 'active-4', source_site: '政府電子採購網', folder_name: '11-02_城市觀光短影音', folder_path: '/Users/Shared/公司工作區/11-02_城市觀光短影音',
      progress_state: 'active', progress_note: '還沒確認有沒有送出，請確認。', progress_updated_at: ago(26), progress_updated_by: 'Company Claude' }, 'tender', 5, {}),
    // 已完成（留在進行中 14 天）
    doing({ id: 'demo-a5', title: '品牌年度形象提案', org: '某食品公司', amount_label: '報價', amount_display: '68萬', created_at: ago(500),
      folder_name: '10-28_品牌年度形象提案', folder_path: '/Users/Shared/公司工作區/10-28_品牌年度形象提案', notion_status: 'done', notion_url: SRC + 'notion-page-2',
      progress_state: 'done', progress_outcome: 'submitted', progress_archive_at: iso(now + 12 * D), progress_note: '提案已送出，等對方回覆。', progress_updated_at: ago(48), progress_updated_by: 'Company Claude' }, 'pitch', 7, {}),
    // 資料夾建立中
    doing({ id: 'demo-a6', title: '原住民族語動畫徵件', org: '原住民族委員會', amount_label: '補助上限', amount_display: '200萬', deadline: at(25, 17), created_at: ago(8),
      source_url: SRC + 'active-6', source_site: '原民會官網', folder_status: 'building', folder_name: '11-16_原住民族語動畫徵件', notion_status: 'queued',
      decided_at: iso(now - 2 * MIN), progress_updated_at: iso(now - 2 * MIN), progress_updated_by: 'system' }, 'grant', 1, {}),
    // 資料夾失敗
    doing({ id: 'demo-a7', title: '防災教育宣導影片', org: '某縣消防局', amount_label: '預算', amount_display: '52萬', deadline: at(8, 17), created_at: ago(30),
      tender_method: '公開招標', source_url: SRC + 'active-7', source_site: '政府電子採購網', folder_status: 'failed', folder_name: '11-15_防災教育宣導影片',
      folder_error: '附件下載失敗：來源網站要驗證碼，已重試 5 次', progress_updated_at: ago(10), progress_updated_by: 'system' }, 'tender', 1, {}),
    // 剛完成的（結案 14 天後撤下看板，進待決區）
    doing({ id: 'demo-a8', title: '社區營造成果影片', org: '某區公所', amount_label: '預算', amount_display: '30萬', created_at: ago(40 * 24),
      folder_name: '10-01_社區營造成果影片', folder_path: '/Users/Shared/公司工作區/10-01_社區營造成果影片', progress_state: 'done', progress_outcome: 'won',
      progress_archive_at: iso(now - 3 * D), progress_note: '已得標並結案。', progress_updated_at: iso(now - 17 * D), progress_updated_by: 'Company Claude' }, 'tender', 7, {}),

    // ---------- 剛收走的（72 小時內） ----------
    row({ id: 'demo-x1', lane: 'tender', status: 'dropped', drop_reason: 'deleted', title: '節慶活動直播標案', org: '某市政府民政局', amount_label: '預算', amount_display: '18萬',
      deadline: at(6, 17), created_at: ago(60), decided_at: ago(5), source_url: SRC + 'gone-1' }),
    row({ id: 'demo-x2', lane: 'grant', status: 'expired', title: '短片輔導金（上半年）', org: '某市影視發展基金會', amount_label: '補助上限', amount_display: '50萬',
      deadline: iso(now - 20 * H), created_at: ago(9 * 24), decided_at: ago(20) }),
  ];
  // 停在「等待付款同意」（pay_approval）：步驟備註帶採購網網址 → 畫成「去領標付款」；也示範 claude.ai 網址（進領標對話）與一般網址（開啟連結）
  const pay = doing({ id: 'demo-a9', title: '觀光導覽影片製作', org: '某縣政府觀光處', amount_label: '預算', amount_display: '88萬', deadline: at(9, 17), created_at: ago(30),
    tender_method: '公開招標', source_url: SRC + 'active-9', source_site: '政府電子採購網', folder_name: '11-15_觀光導覽影片製作', folder_path: '/Users/Shared/公司工作區/11-15_觀光導覽影片製作',
    progress_state: 'active', progress_note: '領標要先付款，等管理員同意。', progress_updated_at: iso(now - 8 * MIN), progress_updated_by: 'Company Claude',
    links: [
      { kind: 'pay', label: '去領標付款', url: 'https://web.pcc.gov.tw/tps/QueryTender/query/searchTenderDetail?pkPmsMain=DEMO' },   // 與步驟備註同一個網址：步驟那顆不重複畫
      { kind: 'pool', label: '', url: 'https://drive.google.com/drive/folders/DEMO-POOL-A9' },
      { kind: 'review', label: '', url: 'https://drive.google.com/drive/folders/DEMO-REVIEW-A9' } ] }, 'tender', 1, {});
  const st = (key, name, status, o = {}) => Object.assign({ key, name, status, due_at: null, done_at: null, owner: null, note: null }, o);
  pay.progress_steps = [
    st('create_workspace', '建立工作區', 'done', { done_at: ago(20) }),
    st('open_session', '開領標對話', 'done', { done_at: ago(1), owner: 'Company Claude', note: '領標對話在這裡：https://claude.ai/chat/demo-tender-session' }),
    st('pay_approval', '等待付款同意', 'current', { owner: '管理員', note: '採購網領標要付費，按按鈕去付款：https://web.pcc.gov.tw/tps/QueryTender/query/searchTenderDetail?pkPmsMain=DEMO' }),
    st('read_tender_docs', '讀招標文件', 'pending', { note: '招標文件清單：https://example.org/demo/tender-docs' }),
    st('write_proposal', '撰寫企劃與估價', 'pending'), st('seal_and_bid', '用印與投標', 'pending'), st('result', '決標或結案', 'pending'),
  ];
  rows.push(pay);
  rows.filter(r => r.status === 'doing').forEach(r => {
    const st = r.progress_steps;
    if (r.progress_state === 'done') st.forEach(s => { if (s.status !== 'skipped') { s.status = 'done'; s.done_at = s.done_at || r.progress_updated_at; } });
    if (r.folder_status !== 'done') r.progress_steps[0].status = 'current';
    derive(r);
  });
  return rows;
}

// ?mock=xss：每個文字欄都塞 HTML、網址都是 javascript:。畫面上應該全部當成文字，window.__xss 不會出現。
const XP = '<img src=x onerror="window.__xss=(window.__xss||0)+1"><b>粗</b>';
function xssRows() {
  const now = Date.now(), iso = ms => new Date(ms).toISOString();
  const common = {
    basket: 'company', is_demo: true, title: 'XSS 測試' + XP, short_title: XP, org: XP, amount_label: XP, currency: XP, amount_display: '12' + XP,
    deadline: iso(now + 3 * D), deadline_text: XP, deadline_approx: true, created_at: iso(now - 2 * H), expire_at: iso(now + 3 * D),
    why: XP, quick: [XP, XP], facts: ['案號：' + XP, XP + '：' + XP, XP], warn: [XP], first_step: XP, fit: XP, found_by: XP,
    case_no: XP, tender_method: XP, bid_bond: XP, performance_period: XP, qualification: XP,
    source_site: XP, source_url: 'javascript:window.__xss=98', notion_url: 'javascript:window.__xss=97', notion_status: 'done',
    crawl_status: 'none', crawl_error: XP, xss_error: XP, full_text: '', attachments: [{ name: XP, url: 'javascript:window.__xss=99' }, { name: '正常附件', url: 'https://example.org/ok.pdf' }],
    remind_at: null, stash_due_at: null, decided_at: null, drop_reason: null,
    folder_status: 'none', folder_name: null, folder_path: null, folder_error: null,
    progress_state: null, progress_steps: [], progress_note: null, progress_blocker: null, progress_outcome: null, progress_archive_at: null, progress_updated_at: null, progress_updated_by: null,
    links: [{ kind: 'pool', label: XP, url: 'javascript:window.__xss=96' }, { kind: 'review', label: XP, url: 'https://example.org/review' }, { kind: XP, label: '', url: 'https://example.org/other"><img src=x onerror=window.__xss=95>' }],
  };
  return [
    Object.assign({}, common, { id: 'xss-new', lane: 'pitch', status: 'new' }),
    Object.assign({}, common, { id: 'xss-stash', lane: 'grant', status: 'stashed', remind_at: iso(now + 5 * H), stash_due_at: iso(now + 3 * D), decided_at: iso(now - H) }),
    Object.assign({}, common, { id: 'xss-doing', lane: 'pitch', status: 'doing', decided_at: iso(now - 30 * H),
      crawl_status: 'done', full_text: XP + '\n\n第二段' + XP,
      folder_status: 'done', folder_name: XP, folder_path: '/Users/Shared/公司工作區/' + XP,
      progress_state: 'blocked', progress_blocker: XP, progress_note: XP, progress_updated_at: iso(now - 10 * 60e3), progress_updated_by: XP,
      progress_steps: [
        { key: 'create_workspace', name: XP, status: 'done', done_at: iso(now - 20 * H), owner: XP, note: XP },
        { key: 'align_needs', name: XP, status: 'blocked', due_at: iso(now + 5 * H), owner: XP, note: XP },
        { key: 'write_pitch', name: XP, status: 'pending' } ] }),
    Object.assign({}, common, { id: 'xss-fail', lane: 'tender', status: 'doing', decided_at: iso(now - 3 * H), folder_status: 'failed', folder_error: XP,
      progress_steps: [{ key: 'create_workspace', name: XP, status: 'current' }], progress_updated_at: iso(now - H), progress_updated_by: XP }),
    Object.assign({}, common, { id: 'xss-gone', lane: 'tender', status: 'expired', deadline: iso(now - H), decided_at: iso(now - H) }),
  ];
}

const fmtTxt = s => { if (!s) return null; const d = new Date(Date.parse(s) + 8 * H), w = '日一二三四五六'[d.getUTCDay()], p = n => String(n).padStart(2, '0'); return (d.getUTCMonth() + 1) + '/' + d.getUTCDate() + '（' + w + '）' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()); };

export function mockAdapter(modeStr) {
  const flags = new Set(String(modeStr).split(',').map(s => s.trim()).filter(Boolean));
  let rows = flags.has('empty') ? [] : build();
  if (flags.has('emptylane')) rows = rows.filter(r => r.lane !== 'pitch' || r.status === 'doing');
  if (flags.has('noactive')) rows = rows.filter(r => r.status !== 'doing');
  if (flags.has('xss')) rows = rows.concat(xssRows().map(r => { if (r.status === 'doing') derive(r); return r; }));
  rows.forEach(r => { r.deadline_text = r.deadline_text || fmtTxt(r.deadline); r.deadline_approx = !!r.deadline_approx; });
  const listeners = new Set();
  const ping = () => listeners.forEach(f => f());
  const find = id => { const r = rows.find(x => x.id === id); if (!r) throw new AdapterError('state', 'not found', 404); return r; };
  // opp_list 的卡：不含 full_text 與 progress_steps；progress_status 現算
  const card = r => { const o = Object.assign({}, r); delete o.full_text; delete o.progress_steps; o.has_full_text = !!r.full_text; o.full_text_len = (r.full_text || '').length; o.progress_status = progressStatus(r); return o; };
  const sorry = () => { if (flags.has('setfail')) throw new AdapterError('server', '伺服器沒有回應'); };
  const viewer = flags.has('viewer');
  let whoN = 0, listN = 0;
  if (flags.has('debug')) { window.__mockListCalls = 0; window.__mockPing = () => ping(); Object.defineProperty(window, '__mockListeners', { get: () => listeners.size, configurable: true }); }
  const needAct = () => { if (viewer || (flags.has('demote') && whoN > 0)) throw new AdapterError('perm', 'missing capability can_act', 403); };
  const realBuild = flags.has('realbuild') || flags.has('folderslow');
  let nextN = 0;

  if (flags.has('live')) setTimeout(() => {
    const n = Object.assign({}, build()[1], { id: 'demo-new-' + (++nextN), title: '觀光宣傳短片', org: '某縣市觀光處', created_at: iso(Date.now()), deadline: iso(Date.now() + 9 * D), expire_at: iso(Date.now() + 9 * D) });
    n.deadline_text = fmtTxt(n.deadline); rows.unshift(n); ping();
  }, 9000);

  return {
    mode: 'mock',
    async whoami() {
      await wait(80);
      if (flags.has('auth')) throw new AdapterError('auth', 'invalid key', 401);
      const demoted = flags.has('demote') && whoN++ > 0;
      if (demoted) return { role: '示範降權', kind: 'viewer', caps: { read: true, act: false, add: false, edit: false, fulltext: false, remind: false, progress: false, notion: false, mac: false, admin: false } };
      return viewer
        ? { role: '示範唯讀', kind: 'viewer', caps: { read: true, act: false, add: false, edit: false, fulltext: false, remind: false, progress: false, notion: false, mac: false, admin: false } }
        : { role: flags.has('admin') ? '示範管理員' : '示範操作', kind: flags.has('admin') ? 'admin' : 'operator', caps: { read: true, act: true, add: false, edit: false, fulltext: false, remind: false, progress: false, notion: false, mac: false, admin: flags.has('admin') } };
    },
    async list() {
      if (flags.has('hang')) await new Promise(() => {});
      if (flags.has('slow')) await wait(6000);
      await wait(150);
      if (flags.has('offline')) throw new AdapterError('network', '連不上伺服器');
      if (flags.has('debug')) window.__mockListCalls++;
      if (flags.has('auth') || (flags.has('authlater') && listN++ > 0)) throw new AdapterError('auth', '金鑰不對', 401);
      const now = Date.now();
      const items = rows.filter(r => r.status === 'new' || r.status === 'stashed');
      const doing = rows.filter(r => r.status === 'doing' && !(r.progress_state === 'done' && r.progress_archive_at && Date.parse(r.progress_archive_at) + 14 * D < now));
      const gone = rows.filter(r => (r.status === 'dropped' || r.status === 'expired') && r.decided_at && Date.parse(r.decided_at) > now - 72 * H).slice(0, 50);
      return { items: [].concat(items, doing, gone).map(card).map(normalize), serverTime: now };
    },
    async get(id) { await wait(200); const r = find(id); return normalize(Object.assign(card(r), { full_text: r.full_text, progress_steps: r.progress_steps })); },
    async progress(id) { await wait(160); const r = find(id); return normalize(Object.assign(card(r), { progress_steps: r.status === 'doing' ? r.progress_steps : [] })); },
    async act(id, action, o = {}) {
      await wait(450); needAct(); sorry();
      const r = find(id), now = Date.now();
      switch (action) {
        case 'stash': {
          if (r.status === 'stashed') break;
          if (r.status !== 'new') throw new AdapterError('state', 'card is ' + r.status, 400);
          const due = r.deadline || iso(now + (r.lane === 'watch' ? 30 : 7) * D);
          const t = new Date(now + 8 * H); t.setUTCDate(t.getUTCDate() + 1); t.setUTCHours(8, 0, 0, 0);   // 明天 08:00（台北）
          let remind = t.getTime() - 8 * H; if (remind >= Date.parse(due)) remind = Date.parse(due) - H;
          Object.assign(r, { status: 'stashed', stash_due_at: due, remind_at: remind > now ? iso(remind) : null, decided_at: iso(now) });
          break;
        }
        case 'unstash': if (r.status !== 'stashed') throw new AdapterError('state', 'card is not stashed', 400); Object.assign(r, { status: 'new', stash_due_at: null, remind_at: null, decided_at: null }); break;
        case 'deleted': case 'skipped':
          if (r.status === 'dropped' || r.status === 'expired') break;
          if (r.status !== 'new' && r.status !== 'stashed') throw new AdapterError('state', 'card is ' + r.status, 400);
          Object.assign(r, { status: 'dropped', drop_reason: action, decided_at: iso(now), stash_due_at: null, remind_at: null }); break;
        case 'restore':
          if (r.status === 'new') break;
          if (r.deadline && Date.parse(r.deadline) < now) throw new AdapterError('state', 'deadline already passed', 400);
          Object.assign(r, { status: 'new', drop_reason: null, decided_at: null, expire_at: r.expire_at || iso(now + 7 * D) }); break;
        case 'build': {
          if (r.status === 'doing') break;
          if (r.status !== 'new' && r.status !== 'stashed') throw new AdapterError('state', 'card is ' + r.status, 400);
          if (r.lane === 'tender' && !flags.has('admin')) throw new AdapterError('perm', 'only an admin key can build tender cards', 403);   // sql/21
          const d = new Date(now + 8 * H), pad = n => String(n).padStart(2, '0');
          Object.assign(r, { status: 'doing', decided_at: iso(now), stash_due_at: null, remind_at: null,
            folder_name: pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) + '_' + (r.short_title || r.title).replace(/（[^）]*）/g, '').slice(0, 40),
            progress_steps: stepsAt(r.lane || 'pitch', 1), progress_state: null, progress_updated_at: iso(now), progress_updated_by: 'system' });
          derive(r);
          if (!realBuild) {
            // 後端 opp_build：示意卡不真的建資料夾，直接 folder_status = done
            Object.assign(r, { folder_status: 'done', folder_path: '（示意資料，沒有建資料夾）', notion_status: 'skipped' });
          } else {
            Object.assign(r, { folder_status: 'queued', folder_path: null, notion_status: 'queued' });
            const slow = flags.has('folderslow');
            setTimeout(() => { if (r.status === 'doing') { r.folder_status = 'building'; ping(); } }, slow ? 4000 : 1500);
            setTimeout(() => {
              if (r.status !== 'doing') return;
              // 後端 opp_mac_done ＋ _opp_prog_after_folder：資料夾建好，第 1 步完成，下一步變進行中
              Object.assign(r, { folder_status: 'done', folder_path: '/Users/Shared/公司工作區/' + r.folder_name, folder_done_at: iso(Date.now()) });
              r.progress_steps[0].status = 'done'; r.progress_steps[0].done_at = iso(Date.now());
              if (r.progress_steps[1]) r.progress_steps[1].status = 'current';
              r.progress_updated_at = iso(Date.now()); r.progress_updated_by = 'system'; derive(r); ping();
            }, slow ? 12000 : 4500);
          }
          break;
        }
        case 'dive': {
          if (r.crawl_status === 'crawling' || (r.crawl_status === 'done' && !o.force)) break;
          if (!/^https?:\/\//.test(r.source_url || '')) { Object.assign(r, { crawl_status: 'failed', crawl_error: r.xss_error || '這張卡沒有來源網址' }); break; }
          r.crawl_status = 'crawling'; r.crawl_error = null;
          setTimeout(() => {
            if (flags.has('crawlfail')) { r.crawl_status = 'failed'; r.crawl_error = '來源網站要驗證碼，讀不到全文'; }
            else {
              r.crawl_status = 'done';
              r.full_text = r.title + '\n機關：' + (r.org || '') + '\n來源：' + (r.source_site || '') + '\n\n' + (r.facts || []).join('\n') + '\n\n' + (r.warn.length ? '注意事項\n' + r.warn.join('\n') + '\n\n' : '') + '（示意全文。真後端上線後，這裡會是從公告頁讀回來的原文。）';
              r.attachments = [{ name: '需求規範書（示意）.pdf', url: SRC + 'attachment.pdf', type: 'pdf' }];
            }
            ping();
          }, flags.has('crawlhang') ? 24 * H : flags.has('crawlslow') ? 16000 : flags.has('crawlfail') ? 1200 : 2200);
          break;
        }
      }
      return normalize(card(r));
    },
    subscribe(onPing, onState) { listeners.add(onPing); onState(false); return () => listeners.delete(onPing); },
    setKey() {},
  };
}
