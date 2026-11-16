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
//   live5        重現線上情況：進行中只有 4 張卡住＋恆春（送件後）
//   sentnodue    恆春示意卡（送件後）的目前步驟沒有期限（看「簡報日期未定」）
//   sentcustom   恆春示意卡改用自訂步驟鍵、沒有期限（測「seal_submit 已完成」那條判斷）
//   scanfail     立即掃描一律失敗（看回滾與 toast）
//   archfail     結案封存一律失敗（看回滾與 toast）
//   （封存區示意：已有 4 張已結案的卡，今年 3 張、去年 1 張；admin 才能徹底刪除與復原封存）
//   （立即掃描的三種狀態預設就有：政府標案 40 分鐘前掃過可按、補助徵件掃描中、企劃提案 5 分鐘前剛掃過）
//   msgnew       開頁 3 秒後肉咖在不綁案子的對話回一則新訊息（看頂列肉咖按鈕的小紅點）
//   msgfail      跟肉咖說的送出一律失敗（看回滾與 toast）
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
import { AdapterError, normalize, normalizeMsg, RK, normalizeScan, normalizeScans, normalizeScanReq, normalizeArchived, normalizeFollowups, normalizeFollowup, normalizeEvents, normalizeBulletin } from './adapter.js?v81';   // 網址要和 app.js 匯入的一模一樣，才是同一份模組

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
    folder_status: 'none', folder_name: null, folder_path: null, folder_error: null,
    progress_state: null, progress_steps: [], progress_note: null, progress_blocker: null, progress_outcome: null, progress_archive_at: null,
    progress_updated_at: null, progress_updated_by: null, links: [],
  };
  const row = o => Object.assign({}, base, o);
  const doing = (o, lane, n, so) => {
    const r = row(Object.assign({ status: 'doing', lane, folder_status: 'done', decided_at: ago(60) }, o));
    r.progress_steps = stepsAt(lane, n, so || {});
    return r;
  };
  const rows = [
    // ---------- 政府標案 ----------
    row({ id: 'demo-t1', lane: 'tender', title: '115 年度業務宣導影片', org: '內政部建築研究所', amount_label: '預算', amount_display: '70萬', amount_num: 700000,
      deadline: at(2, 17), created_at: ago(30), expire_at: at(2, 17), case_no: '1150807-A（示意）', tender_method: '公開招標', bid_bond: '不用', performance_period: '決標後 120 日',
      qualification: '公司登記，營業項目含一般廣告服務業；近三年有政府影片標案實績者佳。投標文件只收紙本，截止前送達機關總務室。',
      fit: '中', why: '不用押標金，上一次流標後重新招標，競爭可能比較少', quick: ['要公司登記，營業項目含一般廣告服務業', '影片支數與長度要看招標文件'],
      facts: ['案號：1150807-A（示意）', '押標金：不用', '流標：上一次流標、重新招標', '收件：只收紙本', '領標費：機關文件費 0 元＋系統使用費 20 元＝總計 20 元（示意）', '電子領標：提供電子領標，不提供現場領標'],
      links: [{ kind: 'pay', label: '去領標', url: 'https://web.pcc.gov.tw/tps/sso/init/supp/DEMO' }], warn: ['送件只收紙本，要預留用印和寄送的時間。'],
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
      progress_state: 'active', progress_note: '初稿結構已出，等你看第二段節奏。',
      links: [{ kind: 'pool', label: 'Pool 官方文件與成品', url: 'https://drive.google.com/drive/folders/DEMO-POOL-A1' }, { kind: 'review', label: '標案內審', url: 'https://drive.google.com/drive/folders/DEMO-REVIEW-A1' }, { kind: 'other', label: '示意：不是 https 的連結不會出現', url: 'http://example.org/insecure' }],
      progress_updated_at: iso(now - 22 * MIN), progress_updated_by: 'Company Claude' }, 'tender', 4, { owner: 'Company Claude' }),
    // 卡住
    doing({ id: 'demo-a2', title: '產業故事影音案', org: '臺北市產業發展局', amount_label: '預算', amount_display: '98萬', deadline: at(3, 12), created_at: ago(120),
      tender_method: '公開招標', source_site: '政府電子採購網', source_url: SRC + 'active-2', folder_name: '11-10_產業故事影音案', folder_path: '/Users/Shared/公司工作區/11-10_產業故事影音案',
      progress_state: 'blocked', progress_blocker: '等公司用印', progress_note: '企劃書與估價單都好了，只差用印。', progress_updated_at: ago(5), progress_updated_by: '企劃流程' }, 'tender', 5, { cur: 'blocked', note: '等公司用印', owner: 'CC' }),
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
      folder_name: '10-28_品牌年度形象提案', folder_path: '/Users/Shared/公司工作區/10-28_品牌年度形象提案', progress_state: 'done', progress_outcome: 'submitted', progress_archive_at: iso(now + 12 * D), progress_note: '提案已送出，等對方回覆。', progress_updated_at: ago(48), progress_updated_by: 'Company Claude' }, 'pitch', 7, {}),
    // 資料夾建立中
    doing({ id: 'demo-a6', title: '原住民族語動畫徵件', org: '原住民族委員會', amount_label: '補助上限', amount_display: '200萬', deadline: at(25, 17), created_at: ago(8),
      source_url: SRC + 'active-6', source_site: '原民會官網', folder_status: 'building', folder_name: '11-16_原住民族語動畫徵件',
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
  // 送件後（像恆春那種）：seal_submit 11/10 前後已完成、公告截止已過，目前在「評選簡報準備」，簡報期限 2 天後（v4 盯目前步驟與下一個里程碑）
  //   ?mock=sentnodue  同一張卡沒有期限（簡報日期未定）
  //   ?mock=sentcustom 目前步驟換成自訂鍵、沒有期限（只能靠 seal_submit 已完成判斷送件後）
  const qflag = String(typeof location !== 'undefined' ? location.search : '');
  const sent = doing({ id: 'demo-a10', title: '恆春半島觀光推廣影片（示意）', short_title: '恆春觀光推廣影片', org: '某縣政府交通旅遊處', amount_label: '預算', amount_display: '120萬',
    deadline: iso(now - 4 * D), created_at: ago(12 * 24), tender_method: '公開招標', source_url: SRC + 'active-10', source_site: '政府電子採購網',
    folder_name: '11-06_恆春觀光推廣影片', folder_path: '/Users/Shared/公司工作區/11-06_恆春觀光推廣影片', progress_state: 'active',
    progress_note: '資格審查通過，進入評選，要準備簡報。', progress_updated_at: ago(3), progress_updated_by: 'Company Claude' }, 'tender', 1, {});
  sent.progress_steps = [
    st('create_workspace', '建立工作區', 'done', { done_at: ago(11 * 24) }), st('read_tender_docs', '讀招標文件', 'done', { done_at: ago(10 * 24) }),
    st('write_proposal', '撰寫企劃與估價', 'done', { done_at: ago(8 * 24), owner: 'AI', note: 'AI 區產出企劃初稿與估價單，Louis 內審過。' }),
    st('seal_submit', '用印與送件', 'done', { done_at: ago(6 * 24), owner: 'CC', due_at: ago(6 * 24 - 5), note: '用印 CC 追；需簽章：張佑維（石頭）負責人章、Borry 附件三同意書簽名。依決策卡 v4' }),
    st('qualify', '資格審查', 'done', { done_at: ago(20), owner: '機關' }),
    st('pitch_prep', '評選簡報準備', 'current', { due_at: qflag.includes('sentnodue') ? null : iso(now + 2 * D + 2 * H), owner: 'AI', note: '簡報稿與分鏡要先給內審。標案說明寫「本案鼓勵運用 AI 工具」，這句是公告原文，不換字。內審資料夾：https://drive.google.com/drive/folders/demo-pitch' }),
    st('pitch_present', '評選簡報', 'pending'), st('await_opening', '等待開標', 'pending'), st('result', '決標或結案', 'pending'),
  ];
  sent.links = (sent.links || []).concat([
    { kind: 'other', label: '用印清單', url: 'https://drive.google.com/file/d/demo-seal-list/view', step_key: 'seal_submit' },
    { kind: 'other', label: '標單（含附件三同意書）', url: 'https://drive.google.com/file/d/demo-bid-form/view', step_key: 'seal_submit' },
    { kind: 'other', label: '簡報稿', url: 'https://docs.google.com/presentation/d/demo-pitch/edit', step_key: 'pitch_prep' },
  ]);
  if (qflag.includes('longname')) { sent.short_title = '台江人物故事影像紀錄計畫第二期（待 Louis 審 v2.6 並回覆決策卡 B1–B4）'; sent.title = sent.short_title; }   // v74：重現真資料的長案名
  rows.push(sent);
  if (qflag.includes('nohold')) for (let i = rows.length - 1; i >= 0; i--) if (rows[i].status === 'stashed') rows.splice(i, 1);
  // v81：?mock=a9paid／a9fetched：停在 pay_approval 的 demo-a9 已付款或已抓檔（看領標兩步不畫步驟按鈕）
  const a9 = rows.find(r => r.id === 'demo-a9');
  if (a9 && /a9(paid|fetched)/.test(qflag)) Object.assign(a9, { bid_state: /a9fetched/.test(qflag) ? 'fetched' : 'paid', bid_paid_by: 'CC', bid_paid_at: ago(1), bid_paid_amount: 200 });
  // 領標四種狀態（?mock=bidrequested／bidpaid／bidfetching／bidfetched 套在 demo-t2；預設 demo-t1 是 none）
  const t2 = rows.find(r => r.id === 'demo-t2');
  if (t2 && qflag.includes('bid')) {
    Object.assign(t2, { bid_state: 'requested', bid_requested_by: 'CC', bid_requested_at: ago(3), links: [{ kind: 'pay', label: '去領標', url: 'https://web.pcc.gov.tw/tps/sso/init/supp/DEMO2' }],
      facts: (t2.facts || []).concat(['領標費：總計 0 元（免費領標）', '電子領標：提供電子領標']) });
    if (/bid(paid|fetching|fetched)/.test(qflag)) Object.assign(t2, { bid_state: 'paid', bid_paid_by: 'CC', bid_paid_at: ago(2), bid_paid_amount: 200, bid_paid_note: '用公司卡', bid_has_receipt: true });
    if (/bidfetching/.test(qflag)) t2.bid_fetch_started_at = iso(now - 6 * 60e3);
    if (/bidfetched/.test(qflag)) Object.assign(t2, { bid_state: 'fetched', bid_fetched_by: 'mac-studio-3', bid_fetched_at: ago(1), bid_fetch_note: '文件 12 個',
      bid_summary: { advice: { verdict: 'go', reasons: ['預算 240 萬，跟我們做過的形象片規模相當', '評選看企劃 40%，我們有優勢'] },
        eligibility: '依法登記之影視相關公司，近三年有一件以上同類實績。', scoring: ['企劃 40%', '團隊 30%', '價格 30%'], budget: '240 萬（含稅）',
        deadline: '11/28 17:00 截止收件；12/3 評選', presentation: '簡報 15 分鐘、詢答 10 分鐘', bond_schedule: null, open_questions: ['簡報要不要附樣片？', '成品交件格式（4K？）'] } });
  }
  // ---------- 封存區示意：已結案的卡（sql/25：仍是 doing，progress_state=done、progress_outcome＝結果，結案 14 天後撤下看板） ----------
  const arch = (o, kind, daysAgo, note) => { const t = now - daysAgo * D;
    const r = Object.assign(doing(o, o.lane || 'tender', 7, {}), { progress_state: 'done', progress_outcome: kind, progress_archive_at: iso(t + 14 * D), progress_note: note || null, progress_updated_at: iso(t), progress_updated_by: 'operator' });
    r.progress_steps.forEach(x => { if (kind === 'withdrawn' && x.status !== 'done') { x.status = 'skipped'; delete x.done_at; } else { x.status = 'done'; x.done_at = x.done_at || iso(t); } }); derive(r); return r; };
  rows.push(
    arch({ id: 'demo-z1', lane: 'tender', title: '社區營造成果影片（示意）', short_title: '社區營造成果影片', org: '某區公所', amount_label: '預算', amount_display: '30萬', case_no: 'ZQ-115-031（示意）',
      folder_name: '10-01_社區營造成果影片', folder_path: '/Users/Shared/公司工作區/10-01_社區營造成果影片',
      links: [{ kind: 'pool', label: '', url: 'https://drive.google.com/drive/folders/DEMO-POOL-Z1' }, { kind: 'review', label: '', url: 'https://drive.google.com/drive/folders/DEMO-REVIEW-Z1' }] }, 'won', 9, '已得標，結案資料都在 Pool。'),
    arch({ id: 'demo-z2', lane: 'grant', title: '短片創作補助（上半年，示意）', short_title: '短片創作補助', org: '某市影視發展基金會', amount_label: '補助上限', amount_display: '50萬',
      folder_name: '05-02_短片創作補助', folder_path: '/Users/Shared/公司工作區/05-02_短片創作補助' }, 'lost', 200, '未入選。'),
    arch({ id: 'demo-z3', lane: 'pitch', title: '咖啡品牌短影音提案（示意）', short_title: '咖啡品牌短影音', org: '某咖啡品牌', amount_label: '報價', amount_display: '40萬',
      folder_name: '09-20_咖啡品牌短影音', folder_path: '/Users/Shared/公司工作區/09-20_咖啡品牌短影音' }, 'withdrawn', 30, '對方預算砍半，做到一半決定不做。'),
    arch({ id: 'demo-z4', lane: 'tender', title: '去年度城市形象影片（示意）', short_title: '城市形象影片', org: '某市政府新聞處', amount_label: '預算', amount_display: '180萬', case_no: 'CT-114-007（示意）',
      folder_name: '2025_城市形象影片', folder_path: '/Users/Shared/公司工作區/2025_城市形象影片' }, 'submitted', 400, null));
  // ?mock=sentcustom：同一張卡改成自訂步驟鍵、沒有內部期限，只能靠「seal_submit 已完成」判斷是已送件
  if (qflag.includes('sentcustom')) sent.progress_steps[5] = st('wait_agency', '等機關通知', 'current', { owner: '機關' });
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
    source_site: XP, source_url: 'javascript:window.__xss=98',
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
  if (flags.has('live5')) {   // 重現線上 2026-11-16 的情況：進行中 5 張＝4 張卡住＋恆春（送件後，評選簡報準備）
    rows = rows.filter(r => r.status !== 'doing' || r.id === 'demo-a2' || r.id === 'demo-a10');
    const base = rows.find(r => r.id === 'demo-a2');
    [['demo-b1', '城市行銷短片（示意）', '等機關回覆修改意見'], ['demo-b2', '文化節紀錄片（示意）', '等合作單位提供素材'], ['demo-b3', '博物館導覽影片（示意）', '等公司用印']].forEach(([id, title, why]) =>
      rows.push(Object.assign(JSON.parse(JSON.stringify(base)), { id, title, short_title: null, progress_blocker: why, source_url: SRC + id })));
  }
  if (flags.has('live1116')) {   // 重現線上 11/16 的進行中，驗急迫排序：恆春（送件後，下一步 26 小時後）→ 台江 → 傳藝 → 公視 → 故宮，再來沒日期的、最後已結案的
    const sentR = rows.find(r => r.id === 'demo-a10'), base = rows.find(r => r.id === 'demo-a2');
    const cur = sentR.progress_steps.find(x => x.status === 'current'); if (cur) cur.due_at = iso(Date.now() + 26 * H); derive(sentR);
    const mk = (id, title, h, extra) => { const r = Object.assign(JSON.parse(JSON.stringify(base)), { id, title, short_title: null, deadline: h == null ? null : iso(Date.now() + h * H), deadline_text: null,
      source_url: SRC + id, progress_blocker: null, progress_state: 'active' }, extra || {}); r.progress_steps.forEach(x => { x.due_at = null; }); derive(r); return r; };
    rows = rows.filter(r => r.status !== 'doing' || r.id === 'demo-a10');
    rows.push(mk('demo-l7', '已結案的案子（示意）', null, { progress_state: 'done', progress_outcome: 'won', progress_archive_at: iso(Date.now() + 10 * D) }),
      mk('demo-l5', '故宮數位展影片（示意）', 7 * 24), mk('demo-l2', '台江國家公園影片（示意）', 52), mk('demo-l6', '沒有日期的提案（示意）', null),
      mk('demo-l4', '公視合製短片（示意）', 82), mk('demo-l3', '傳藝中心推廣影片（示意）', 59, { progress_state: 'blocked', progress_blocker: '等合作單位提供素材' }));
    rows.filter(r => r.id === 'demo-l7').forEach(r => { r.progress_steps.forEach(x => { x.status = 'done'; }); derive(r); });
  }
  { const w = rows.find(r => r.id === 'demo-w1'), t = rows.find(r => r.lane === 'tender' && r.status === 'new');   // 盯案與正式公告接上（F 的 why 開頭格式）
    if (w && t) { w.why = '正式公告已上看板（政府標案：' + t.title + '）。' + (w.why || ''); t.why = '（之前在盯案後續：' + w.title + '）' + (t.why || ''); } }
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
  // ---------- 跟肉咖說：示意對話（opp_msg_* 的欄位格式） ----------
  const tAgo = m => iso(Date.now() - m * 60e3);
  const me = () => viewer ? '示範唯讀' : flags.has('cc') ? 'CC' : flags.has('admin') ? '示範管理員' : '示範操作';
  const evs = [];   // 領標、步驟按鈕、點擊紀錄（新到舊排序在 events 裡做）
  let msgs = flags.has('empty') ? [] : [
    { id: 'm1', item_id: null, author: '同事 A', body: '這週可以先幫忙整理各案的截止日嗎？', reply_to: null, status: 'done', handled_by: RK, created_at: tAgo(180) },
    { id: 'm2', item_id: null, author: RK, body: '好，各案截止日已經整理好，最近的是內政部那案，2 天後。（示意）', reply_to: 'm1', status: 'done', handled_by: RK, created_at: tAgo(150) },
    { id: 'm3', item_id: 'demo-a10', author: '示範操作', body: '簡報日期確定了嗎？要提早排分鏡。', reply_to: null, status: 'done', handled_by: RK, created_at: tAgo(50) },
    { id: 'm4', item_id: 'demo-a10', author: RK, body: '還沒確定，機關說這週五前通知。我先把分鏡初稿排進明天。（示意）', reply_to: 'm3', status: 'done', handled_by: RK, created_at: tAgo(30) },
    { id: 'm6', item_id: 'demo-a10', author: '示範操作', body: '機關回了：簡報 11/18 早上 8 點，20 分鐘。', reply_to: null, status: 'done', handled_by: RK, created_at: tAgo(12) },
    { id: 'm7', item_id: 'demo-a10', author: RK, body: '收到，簡報稿改成 20 分鐘版本，明天中午前放內審。（示意）', reply_to: 'm6', status: 'done', handled_by: RK, created_at: tAgo(8) },
    // v81：系統寫的紀錄（sql/29 paid、sql/32 step、sql/37 bid），畫面用系統通知樣式
    { id: 'm8', item_id: 'demo-a10', author: 'CC', kind: 'paid', body: 'CC 已付領標費 NT$200，請領標並把重點整理到卡片（用公司卡）', reply_to: null, status: 'received', handled_by: null, created_at: tAgo(6) },
    { id: 'm9', item_id: 'demo-a10', author: 'Pool 偵測', kind: 'bid', body: '📥 Pool 偵測到已領標（CC）：AI 建議投，題目跟我們做過的觀光片很像，預算也夠。（示意）', reply_to: null, status: 'done', handled_by: null, created_at: tAgo(5) },
    { id: 'm10', item_id: 'demo-a10', author: '示範操作', kind: 'step', body: '示範操作 把『用印送件』標成目前這一步（示意）', reply_to: null, status: 'done', handled_by: null, created_at: tAgo(4) },
    { id: 'm5', item_id: 'demo-a1', author: '同事 A', body: '第二段節奏我看過了，可以。', reply_to: null, status: 'received', handled_by: null, created_at: tAgo(20) },
  ];
  if (flags.has('xss')) msgs.push({ id: 'mx', item_id: null, author: XP, body: XP + '\n第二行' + XP, reply_to: null, status: XP, handled_by: XP, created_at: tAgo(5) },
                                  { id: 'mx2', item_id: 'xss-doing', author: RK, body: XP, reply_to: 'mx', status: 'done', handled_by: RK, created_at: tAgo(4) });
  let msgN = 0;
  const bulT0 = Date.now();   // v81：示意報告的產生時間固定，內容沒變就不會重畫（真後端 generated_at 也是重組才變）
  // ---------- 追蹤事項示意（opp_followups 的欄位格式） ----------
  const fuAt = h => iso(Date.now() + h * H);
  let fus = flags.has('empty') ? [] : [
    { id: 'f1', item_id: 'demo-a10', title: '回覆機關簡報時間，順便問可不可以帶樣片', owner: 'Louis', requested_by: 'Borry', due_at: fuAt(3), remind_rule: 'day_before', status: 'open', source: 'line', note: null, close_note: null, created_at: fuAt(-20), updated_at: fuAt(-20), done_at: null },
    { id: 'f2', item_id: null, title: '寄用印文件正本給機關（掛號）', owner: 'CC', requested_by: 'Borry', due_at: fuAt(-26), remind_rule: 'daily', status: 'open', source: 'line', note: '地址在招標文件第 3 頁', close_note: null, created_at: fuAt(-50), updated_at: fuAt(-50), done_at: null },
    { id: 'f3', item_id: null, title: '查文化部補助核定公告有沒有出來', owner: null, requested_by: '同事 A', due_at: null, remind_rule: null, status: 'open', source: 'panel', note: null, close_note: null, created_at: fuAt(-5), updated_at: fuAt(-5), done_at: null },
    { id: 'f4', item_id: 'demo-a10', title: '跟對方確認場勘時間', owner: 'Borry', requested_by: 'Louis', due_at: fuAt(-30), remind_rule: null, status: 'done', source: 'line', note: null, close_note: '群組 11/15 Louis 說已回', created_at: fuAt(-80), updated_at: fuAt(-24), done_at: fuAt(-24) },
    { id: 'f5', item_id: null, title: '訂下週的棚', owner: 'CC', requested_by: 'Borry', due_at: fuAt(48), remind_rule: null, status: 'dropped', source: 'line', note: null, close_note: '改外景，不用棚', created_at: fuAt(-40), updated_at: fuAt(-10), done_at: fuAt(-10) },
  ];
  if (flags.has('xss')) fus.push({ id: 'fx', item_id: 'xss-doing', title: XP, owner: XP, requested_by: XP, due_at: fuAt(-1), remind_rule: XP, status: 'open', source: XP, note: XP, close_note: XP, created_at: fuAt(-2), updated_at: fuAt(-2), done_at: null });
  const fuOut = f => Object.assign({}, f, { item_short_title: f.item_id ? ((rows.find(r => r.id === f.item_id) || {}).short_title || (rows.find(r => r.id === f.item_id) || {}).title || null) : null,
    overdue: f.status === 'open' && !!f.due_at && Date.parse(f.due_at) < Date.now(), duplicate: false });
  // ---------- 立即掃描：三種狀態示意 ----------
  const scanSt = {
    tender: { lane: 'tender', status: 'done', result: '新增 2 件、重複 5 件（肉咖判讀：推薦 4、可視人力加投 1、不推薦 12）（掃描 total=19 new=2 errors=0）', created_at: tAgo(42), done_at: tAgo(40), last_done_at: tAgo(40) },
    grant: { lane: 'grant', status: 'running', phase: 'judging', result: null, created_at: tAgo(1), done_at: null, last_done_at: tAgo(180) },
    ...(flags.has('nowatch') ? {} : { watch: { lane: 'watch', status: 'done', result: '新增 7 件、重複 0 件（肉咖判讀：值得盯 7 件、不盯 1 件；1 張正式公告接上盯案；來源：採購網公開徵求、公開閱覽、無法決標）', created_at: tAgo(30), done_at: tAgo(26), last_done_at: tAgo(26) } }),   // ?mock=nowatch：舊後端沒有 lanes.watch
    pitch: flags.has('pitchnull') ? { lane: 'pitch', status: null } : { lane: 'pitch', status: 'done', result: '新增 0 件、重複 4 件（肉咖判讀：推薦 0、可視人力加投 0、不推薦 9）', created_at: tAgo(6), done_at: tAgo(5), last_done_at: tAgo(5) },
  };
  // 補助徵件那筆「掃描中」：開頁 9 秒後掃完、新增 1 張卡
  const finishScan = (lane, n) => {
    const st = scanSt[lane]; if (!st || (st.status !== 'running' && st.status !== 'queued')) return;
    for (let i = 0; i < n; i++) {
      const src = rows.find(r => r.lane === lane && r.status === 'new') || rows.find(r => r.status === 'new');
      if (src) { const c = Object.assign(JSON.parse(JSON.stringify(src)), { id: 'scan-' + lane + '-' + (++nextN), title: '掃描新進：' + ({ tender: '宣傳影片標案', grant: '影像補助', pitch: '品牌合作', watch: '公開徵求（預計 12/7 前後公告）' }[lane]) + '（示意）', short_title: null, created_at: iso(Date.now()), status: 'new', crawl_status: 'none', full_text: '', why: '掃描新進的示意卡。' }); rows.unshift(c); }
    }
    Object.assign(st, { status: 'done', phase: null, result: '新增 ' + n + ' 件、重複 3 件（肉咖判讀：推薦 ' + (n + 2) + '、可視人力加投 1、不推薦 15）（掃描 total=' + (n + 18) + ' new=' + n + ' errors=0）', done_at: iso(Date.now()), last_done_at: iso(Date.now()) }); ping();
  };
  if (!flags.has('empty')) setTimeout(() => finishScan('grant', 1), 9000);
  if (flags.has('cardmsgnew')) setTimeout(() => { msgs.push({ id: 'mnew2', item_id: 'demo-a10', author: RK, body: '簡報稿第一版放內審了。（示意）', reply_to: 'm6', status: 'done', handled_by: RK, created_at: iso(Date.now()) }); ping(); }, 3000);   // ?mock=cardmsgnew：恆春卡 3 秒後來一則肉咖新回覆
  if (flags.has('msgnew')) setTimeout(() => { msgs.push({ id: 'mnew', item_id: null, author: RK, body: '補充：截止日表已更新，新增一筆補助。（示意）', reply_to: 'm1', status: 'done', handled_by: RK, created_at: iso(Date.now()) }); ping(); }, 3000);

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
      if (flags.has('cc')) return { role: 'CC', kind: 'operator', aliases: ['CC', '行政'], caps: { read: true, act: true, add: false, edit: false, fulltext: false, remind: false, progress: false, notion: false, mac: false, admin: false, pay: true } };   // ?mock=cc：負責用印那步的同事，有領標付款權限
      if (demoted) return { role: '示範降權', kind: 'viewer', caps: { read: true, act: false, add: false, edit: false, fulltext: false, remind: false, progress: false, notion: false, mac: false, admin: false } };
      return viewer
        ? { role: '示範唯讀', kind: 'viewer', caps: { read: true, act: false, add: false, edit: false, fulltext: false, remind: false, progress: false, notion: false, mac: false, admin: false } }
        : { role: flags.has('admin') ? '示範管理員' : '示範操作', kind: flags.has('admin') ? 'admin' : 'operator', aliases: [flags.has('admin') ? '示範管理員' : '示範操作'], caps: Object.assign({ pay: flags.has('admin') || flags.has('pay') }, { read: true, act: true, add: false, edit: false, fulltext: false, remind: false, progress: false, notion: false, mac: false, admin: flags.has('admin') }, flags.has('buildtender') ? { build_tender: true } : {}, flags.has('progress') ? { progress: true } : {}) };   // ?mock=progress：有 can_progress 的 operator（追蹤事項可寫）   // ?mock=buildtender：有 build_tender 的 operator（sql/28）
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
          if (r.lane === 'tender' && !flags.has('admin') && !flags.has('buildtender')) throw new AdapterError('perm', 'only an admin key can build tender cards', 403);   // sql/21、28
          const d = new Date(now + 8 * H), pad = n => String(n).padStart(2, '0');
          Object.assign(r, { status: 'doing', decided_at: iso(now), stash_due_at: null, remind_at: null,
            folder_name: pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) + '_' + (r.short_title || r.title).replace(/（[^）]*）/g, '').slice(0, 40),
            progress_steps: stepsAt(r.lane || 'pitch', 1), progress_state: null, progress_updated_at: iso(now), progress_updated_by: 'system' });
          derive(r);
          if (!realBuild) {
            // 後端 opp_build：示意卡不真的建資料夾，直接 folder_status = done
            Object.assign(r, { folder_status: 'done', folder_path: '（示意資料，沒有建資料夾）' });
          } else {
            Object.assign(r, { folder_status: 'queued', folder_path: null });
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
    async archive(id, kind, note) {
      await wait(400); needAct();
      if (flags.has('archfail')) throw new AdapterError('server', '伺服器沒有回應');
      const r = find(id);
      if (!['won', 'lost', 'submitted', 'withdrawn'].includes(kind)) throw new AdapterError('state', 'kind must be won, lost, submitted or withdrawn', 400);
      if (r.status !== 'doing') throw new AdapterError('state', 'card is not in progress', 400);
      const re = r.progress_state === 'done', full = () => normalize(Object.assign(card(r), { progress_steps: r.progress_steps }));
      if (re && r.progress_outcome === kind && note == null) return full();
      if (!re) {
        r.progress_steps.forEach(x => { if (x.status === 'done' || x.status === 'skipped') return; if (kind === 'withdrawn') { x.status = 'skipped'; delete x.done_at; } else { x.status = 'done'; x.done_at = iso(Date.now()); } });
        r.progress_archive_at = r.progress_archive_at || iso(Date.now() + 14 * D);
      }
      Object.assign(r, { progress_state: 'done', progress_outcome: kind, progress_note: (note && note.trim()) || r.progress_note, progress_updated_at: iso(Date.now()), progress_updated_by: flags.has('admin') ? 'admin' : 'operator' });
      derive(r); ping();
      return full();
    },
    async unarchive(id) {
      await wait(400);
      if (!flags.has('admin')) throw new AdapterError('perm', 'only an admin key can unarchive', 403);
      const r = find(id);
      if (r.progress_state === 'done' || r.progress_state === 'failed') {
        const st = r.progress_steps; if (st.length && !st.some(x => x.status === 'current' || x.status === 'blocked')) st[st.length - 1].status = 'current';
        Object.assign(r, { progress_state: 'active', progress_archive_at: null, progress_updated_at: iso(Date.now()) }); derive(r); ping();
      }
      return normalize(Object.assign(card(r), { progress_steps: r.progress_steps }));
    },
    async archiveList(q, year, limit) {
      await wait(200);
      const t = String(q || '').trim().toLowerCase(), y = year ? Number(year) : null;
      const closedAt = r => (Date.parse(r.progress_archive_at) || Date.parse(r.progress_updated_at) + 14 * D) - 14 * D;
      // 照 opp_archive_list 的精簡列回（沒有 status、progress_*、folder_status）；is_demo 只有示範用
      return rows.filter(r => r.status === 'doing' && r.progress_state === 'done')
        .filter(r => !t || [r.title, r.short_title, r.org, r.case_no].some(v => String(v || '').toLowerCase().includes(t)))
        .filter(r => !y || new Date(closedAt(r) + 8 * H).getUTCFullYear() === y)
        .sort((a, b) => closedAt(b) - closedAt(a)).slice(0, limit || 100)
        .map(r => normalizeArchived({ id: r.id, title: r.title, short_title: r.short_title, org: r.org, case_no: r.case_no, lane: r.lane, basket: r.basket, outcome: r.progress_outcome,
          closed_at: iso(closedAt(r)), links: r.links || [], folder_path: r.folder_path, folder_name: r.folder_name, source_url: r.source_url, amount_display: r.amount_display,
          deadline_text: r.deadline_text, progress_note: r.progress_note, is_demo: r.is_demo }));
    },
    async purge(id, title) {
      await wait(400);
      if (!flags.has('admin')) throw new AdapterError('perm', 'only an admin key can purge', 403);
      const r = find(id);
      const t = String(title || '').trim();
      if (!t || (t !== String(r.short_title || '').trim() && t !== String(r.title || '').trim())) throw new AdapterError('state', 'confirm title does not match the card title', 400);
      rows = rows.filter(x => x.id !== id); ping();
      return { purged: true, id, title: r.title, by: 'admin', note: '只刪資料庫，電腦與 Drive 的檔案沒動' };
    },
    async scanStatus() { await wait(100); if (flags.has('offline')) throw new AdapterError('network', '連不上伺服器'); return normalizeScans({ server_time: iso(Date.now()), lanes: Object.fromEntries(Object.entries(scanSt).map(([l, x]) => [l, { latest: x.status ? Object.assign({}, x, { last_done_at: undefined }) : null, last_done_at: x.last_done_at || null }])) }); },
    async scanRequest(lane) {
      await wait(400); needAct();
      if (flags.has('scanfail')) throw new AdapterError('server', '伺服器沒有回應');
      if (lane === 'watch' && flags.has('watchclosed')) throw new AdapterError('state', 'lane must be tender, grant or pitch', 400);   // ?mock=watchclosed：狀態有 watch 但請求還不收
      if (!scanSt[lane]) throw new AdapterError('state', 'lane must be tender, grant, pitch' + (flags.has('nowatch') ? '' : ' or watch'), 400);
      const st = scanSt[lane];
      const req = () => Object.assign({}, st, { last_done_at: undefined });
      if (st.status === 'queued' || st.status === 'running') return normalizeScanReq({ state: 'already', request: req() });
      if (st.status === 'done' && st.done_at && Date.now() - Date.parse(st.done_at) < 15 * 60e3) return normalizeScanReq({ state: 'recent', request: req() });
      Object.assign(st, { status: 'queued', phase: null, result: null, created_at: iso(Date.now()), done_at: null });
      setTimeout(() => { Object.assign(st, { status: 'running', phase: 'scanning' }); ping(); }, 1500);   // 示意把 2～5 分鐘壓成幾秒
      setTimeout(() => { st.phase = 'judging'; ping(); }, 3500);
      setTimeout(() => { st.phase = 'sending'; ping(); }, 5500);
      if (flags.has('scanfailed')) setTimeout(() => { Object.assign(st, { status: 'failed', phase: null, result: '肉咖判讀逾時（示意）', done_at: iso(Date.now()) }); ping(); }, 6500);
      else setTimeout(() => finishScan(lane, 2), 7000);
      return normalizeScanReq({ state: 'queued', request: req() });
    },
    async followupList(status, itemId, limit) {
      await wait(120);
      if (flags.has('offline')) throw new AdapterError('network', '連不上伺服器');
      if (flags.has('fufail')) throw new AdapterError('server', '伺服器沒有回應');
      const st = status || 'open';
      if (!['open', 'done', 'dropped', 'all'].includes(st)) throw new AdapterError('state', 'status must be open, done, dropped or all', 400);
      const t = f => Date.parse(f.done_at || f.created_at);
      return normalizeFollowups(fus.filter(f => (st === 'all' || f.status === st) && (!itemId || f.item_id === itemId))
        .sort((a, b) => st === 'open' ? ((a.due_at ? Date.parse(a.due_at) : Infinity) - (b.due_at ? Date.parse(b.due_at) : Infinity)) : t(b) - t(a))
        .slice(0, limit || 200).map(fuOut));
    },
    async followupUpdate(fid, patch) {
      await wait(300);
      if (!flags.has('admin') && !flags.has('progress')) throw new AdapterError('perm', 'only planner or admin can update follow-ups', 403);
      const f = fus.find(x => x.id === fid); if (!f) throw new AdapterError('state', 'not found', 404);
      const ok = ['title', 'owner', 'requested_by', 'due_at', 'item_id', 'remind_rule', 'note', 'status', 'close_note'];
      Object.keys(patch || {}).forEach(k => { if (!ok.includes(k)) throw new AdapterError('state', 'patch key not allowed: ' + k, 400); });
      Object.assign(f, patch, { updated_at: iso(Date.now()) });
      if (patch.status === 'open') f.done_at = null; else if (patch.status) f.done_at = iso(Date.now());
      ping();
      return normalizeFollowup(fuOut(f));
    },
    async events(id, limit) {   // 示意紀錄（opp_events，新到舊）。step:* 是給步驟細節用的格式草案（後端還沒寫，見回報 v72）
      await wait(120);
      if (flags.has('offline')) throw new AdapterError('network', '連不上伺服器');
      if (flags.has('evfail')) throw new AdapterError('server', '伺服器沒有回應');
      const t = Date.now(), h = 3600e3, at = x => iso(t - x * h);
      const ev = evs.filter(e => e.item_id === id).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).concat(id !== 'demo-a10' ? [{ at: at(30), item_id: id, actor: 'Company Claude', action: 'added', detail: {} }] : [
        { at: at(2), item_id: id, actor: 'CC', action: 'track:download_file', detail: { step_key: 'seal_submit', label: '標單' } },
        { at: at(3), item_id: id, actor: 'AI', action: 'step:current', detail: { step_key: 'pitch_prep', step_name: '評選簡報準備', from: 'pending', note: null, as: 'planner' } },
        { at: at(20), item_id: id, actor: '企劃流程', action: 'step:done', detail: { step_key: 'qualify', step_name: '資格審查', from: 'current', note: null, as: 'planner' } },
        { at: at(6 * 24), item_id: id, actor: 'CC', action: 'step:done', detail: { step_key: 'seal_submit', step_name: '用印與送件', from: 'current', note: '石頭用印完成、已寄出', as: 'owner' } },
        { at: at(6 * 24 + 20), item_id: id, actor: 'CC', action: 'step:undone', detail: { step_key: 'seal_submit', step_name: '用印與送件', from: 'done', note: '附件三少簽名，退回', as: 'owner' } },
        { at: at(11 * 24), item_id: id, actor: 'mac-studio-3', action: 'folder:done', detail: {} },
        { at: at(11 * 24 + 1), item_id: id, actor: 'Borry', action: 'status:doing', detail: {} },
      ]);
      return normalizeEvents(ev.slice(0, limit || 100));
    },
    async msgList(itemId, limit) {
      await wait(120);
      if (flags.has('offline')) throw new AdapterError('network', '連不上伺服器');
      const l = msgs.filter(m => !itemId || m.item_id === itemId).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));   // 示意：p_id 空時回全部（前端自己分不綁案子的）
      return l.slice(0, limit || 50).map(normalizeMsg);
    },
    // ---------- 領標（sql/29）：只記錄，不付款 ----------
    async requestBid(id) {
      await wait(250);
      if (!(flags.has('admin') || flags.has('pay') || flags.has('cc'))) throw new AdapterError('perm', 'this key cannot pay bids', 403);
      const r = find(id); if (!r) throw new AdapterError('state', 'not found', 404);
      if (r.lane !== 'tender') throw new AdapterError('state', 'not_tender: only tender cards', 400);
      if (r.bid_state === 'paid' || r.bid_state === 'fetched') throw new AdapterError('state', 'already_paid: bid is already ' + r.bid_state, 409);
      if (r.bid_state !== 'requested') { Object.assign(r, { bid_state: 'requested', bid_requested_by: me(), bid_requested_at: iso(Date.now()) }); evs.push({ at: iso(Date.now()), item_id: id, actor: me(), action: 'bid:requested', detail: {} }); ping(); }
      return normalize(card(r));
    },
    async markPaid(id, amount, note, receipt) {
      await wait(400);
      if (!(flags.has('admin') || flags.has('pay') || flags.has('cc'))) throw new AdapterError('perm', 'this key cannot pay bids', 403);
      const r = find(id); if (!r) throw new AdapterError('state', 'not found', 404);
      if (amount != null && (amount < 0 || amount > 10000000)) throw new AdapterError('state', 'bad_amount: amount must be 0-10000000', 400);
      if (note && note.length > 200) throw new AdapterError('state', 'note_too_long: note max 200 characters', 400);
      if (receipt && receipt.length > 64) throw new AdapterError('state', 'receipt_too_long: receipt max 64 characters', 400);
      if (flags.has('alreadypaid') && r.bid_state !== 'paid') Object.assign(r, { bid_state: 'paid', bid_paid_by: '巴西', bid_paid_at: iso(Date.now() - 60e3), bid_paid_amount: 20 });   // 模擬另一個人剛好先付了
      if (r.bid_state === 'paid' || r.bid_state === 'fetched') { ping(); throw new AdapterError('state', 'already_paid: bid is already ' + r.bid_state, 409); }
      Object.assign(r, { bid_state: 'paid', bid_paid_by: me(), bid_paid_at: iso(Date.now()), bid_paid_amount: amount, bid_paid_note: note || null, bid_has_receipt: !!receipt,
        bid_requested_by: r.bid_requested_by || me(), bid_requested_at: r.bid_requested_at || iso(Date.now()) });
      evs.push({ at: iso(Date.now()), item_id: id, actor: me(), action: 'paid', detail: { amount, note: note || null, has_receipt: !!receipt } });
      msgs.push({ id: 'mp' + (++msgN), item_id: id, author: me(), body: me() + ' 已付領標費' + (amount != null ? ' NT$' + amount : '') + '，請領標並把重點整理到卡片' + (receipt ? '（有憑據序號）' : ''), reply_to: null, status: 'new', handled_by: null, created_at: iso(Date.now()) });
      ping(); return normalize(Object.assign(card(r), { progress_steps: r.progress_steps }));
    },
    // ---------- 步驟按鈕（sql/32） ----------
    async stepMark(id, key, status, note) {
      await wait(300);
      const r = find(id); if (!r) throw new AdapterError('state', 'not found', 404);
      const s = (r.progress_steps || []).find(x => x.key === key); if (!s) throw new AdapterError('state', 'no_step: step not found', 400);
      const mine = String(s.owner || '').split(/[、，,／\/;；&＋+]/).map(x => x.replace(/\s/g, '').toLowerCase()).some(x => x && [me(), flags.has('cc') ? '行政' : ''].map(y => y.toLowerCase()).includes(x));
      if (!(flags.has('admin') || flags.has('progress') || mine)) throw new AdapterError('perm', 'not_step_owner: only the step owner, admin or planner can mark this step', 403);
      if (note && note.length > 200) throw new AdapterError('state', 'note_too_long: note max 200 characters', 400);
      const was = s.status;
      if (status === 'done') { s.status = 'done'; s.done_at = iso(Date.now()); const nx = r.progress_steps.find(x => x.status === 'pending'); if ((was === 'current' || was === 'blocked') && nx) nx.status = 'current'; }
      else if (status === 'current') { r.progress_steps.forEach(x => { if (x !== s && (x.status === 'current' || x.status === 'blocked')) x.status = 'pending'; }); s.status = 'current'; }
      else if (status === 'undone') { if (was !== 'done' && was !== 'skipped') return normalize(Object.assign(card(r), { progress_steps: r.progress_steps })); r.progress_steps.forEach(x => { if (x !== s && (x.status === 'current' || x.status === 'blocked')) x.status = 'pending'; }); s.status = 'current'; delete s.done_at; }
      if (note) s.note = note;
      if (was === 'blocked') { r.progress_state = 'active'; r.progress_blocker = null; }
      r.progress_updated_at = iso(Date.now()); r.progress_updated_by = me(); derive(r);
      evs.push({ at: iso(Date.now()), item_id: id, actor: me(), action: 'step:' + status, detail: { step_key: key, step_name: s.name, from: was, note: note || null, as: mine ? 'owner' : 'admin' } });
      ping(); return normalize(Object.assign(card(r), { progress_steps: r.progress_steps }));
    },
    // v81：追蹤公告的每日報告（sql/37）。?mock=nobulletin 模擬 RPC 還沒上線；?mock=bulletinnull 模擬還沒有任何一筆；?mock=bul11 看 11:00 查證版
    async bulletin() {
      await wait(140);
      if (flags.has('offline')) throw new AdapterError('network', '連不上伺服器');
      if (flags.has('nobulletin')) throw new AdapterError('server', 'Could not find the function public.opp_bulletin_get(p_key) in the schema cache', 404);
      if (flags.has('bulletinnull') || flags.has('empty')) return normalizeBulletin(null);
      const t = bulT0, tw = ms => new Date(ms + 8 * H).toISOString().slice(0, 16), day = ms => Math.floor((ms + 8 * H) / D);
      const cs = rows.filter(r => r.status === 'doing' && r.id !== 'demo-a2' && r.progress_state !== 'done' && r.deadline && Date.parse(r.deadline) > t)
        .sort((a, b) => Date.parse(a.deadline) - Date.parse(b.deadline)).slice(0, 3).map(r => {
          const st = (r.progress_steps || []).find(s => s.status === 'current' || s.status === 'blocked'), ls = [];
          if (r.progress_blocker) ls.push((st && st.owner || 'CC') + '：' + r.progress_blocker);
          if (st) ls.push((st.owner || '肉咖') + '：' + st.name + (st.status === 'blocked' ? '（卡住）' : ''));
          if (!ls.length) ls.push('肉咖：照進度走，目前沒有卡住（示意）');
          return { kind: 'case', item_id: r.id, title: r.short_title || r.title, deadline: tw(Date.parse(r.deadline)), days_left: day(Date.parse(r.deadline)) - day(t), lines: ls, stamp: '⏰ 示意' };
        });
      const soon = t + 2 * H, next = t + 26 * H;
      cs.unshift({ kind: 'case', item_id: null, title: '某市府形象短片（示意，不在看板上）', deadline: tw(soon), days_left: day(soon) - day(t), lines: ['巴西：報價單下班前給 CC 用印', 'CC：用印後掃描上傳內審'], stamp: '' },
                 { kind: 'case', item_id: 'demo-a2', title: '產業故事影音案', deadline: tw(next), days_left: day(next) - day(t), lines: ['Louis：企劃書第三章補拍攝時程', 'CC：等公司用印'], stamp: '' });
      return normalizeBulletin({
        body: '（純文字版，給 LINE 用）', generated_at: iso(t - 4 * 60e3), source: flags.has('bul11') ? 'daily11' : 'live',
        sections: [
          { kind: 'summary', text: '今明兩天有 2 案截止，用印要先排；其他案子照進度走。（示意）' },
          ...cs,
          { kind: 'schedule', lines: ['11/18（三）08:00 恆春觀光推廣影片 簡報 20 分鐘（示意）', '11/20（五）14:00 跟機關開協調會（示意）'] },
          { kind: 'bid', lines: ['產業故事影音案：CC 已領標，肉咖判讀建議投（示意）'] },
          { kind: 'followup', lines: ['Louis：回覆機關簡報時間（3 小時後到期）'] },
          ...(flags.has('bulweird') ? [{ kind: 'note', lines: ['不認得的段落照行顯示（示意）'] }, { kind: 'memo', text: '只有 text 的不認得段落整段顯示（示意）' }, { kind: 'case', title: '', lines: [] }] : []),
        ] });
    },
    async track(id, action, detail) { await wait(60); evs.push({ at: iso(Date.now()), item_id: id, actor: me(), action: 'track:' + action, detail: detail || {} }); return { recorded: true }; },
    async presence() {
      await wait(150);
      if (!flags.has('admin')) throw new AdapterError('perm', 'only an admin key can see presence', 403);
      const t = Date.now(), h = 3600e3;
      return [
        { name: 'Bosen', kind: 'operator', firstSeenAt: null, lastSeenAt: null, seenCount: 0, lastActionAt: null, status: 'never', statusText: '從沒打開過' },
        { name: '阿包', kind: 'operator', firstSeenAt: t - 9 * 24 * h, lastSeenAt: t - 5 * 24 * h, seenCount: 3, lastActionAt: t - 5 * 24 * h, status: 'stale', statusText: '5 天沒開' },
        { name: '石頭', kind: 'operator', firstSeenAt: t - 4 * 24 * h, lastSeenAt: t - 2 * 24 * h, seenCount: 4, lastActionAt: null, status: 'recent', statusText: '2 天前開過' },
        { name: 'CC', kind: 'operator', firstSeenAt: t - 3 * 24 * h, lastSeenAt: t - 2 * h, seenCount: 12, lastActionAt: t - 2 * h, status: 'today', statusText: '今天開過' },
        { name: '巴西', kind: 'operator', firstSeenAt: t - 6 * 24 * h, lastSeenAt: t - 40 * 60e3, seenCount: 20, lastActionAt: t - 45 * 60e3, status: 'today', statusText: '今天開過' },
      ];
    },
    async msgDelete(msgId) {   // sql/33：刪一則連同底下所有回覆
      await wait(250);
      if (!flags.has('admin')) throw new AdapterError('perm', 'only an admin key can delete messages', 403);
      const one = msgs.find(m => m.id === msgId); if (!one) throw new AdapterError('state', 'not found', 404);
      const kill = new Set([msgId]); let grew = true;
      while (grew) { grew = false; msgs.forEach(m => { if (m.reply_to && kill.has(m.reply_to) && !kill.has(m.id)) { kill.add(m.id); grew = true; } }); }
      for (let i = msgs.length - 1; i >= 0; i--) if (kill.has(msgs[i].id)) msgs.splice(i, 1);
      ping(); return { deleted: kill.size, item_id: one.item_id };
    },
    async msgClear(itemId) {
      await wait(250);
      if (!flags.has('admin')) throw new AdapterError('perm', 'only an admin key can delete messages', 403);
      let n = 0; for (let i = msgs.length - 1; i >= 0; i--) if ((msgs[i].item_id || null) === (itemId || null)) { msgs.splice(i, 1); n++; }
      ping(); return { deleted: n, item_id: itemId || null, scope: itemId ? 'item' : 'board' };
    },
    async msgAdd(itemId, body) {
      await wait(500); needAct();
      if (flags.has('msgfail')) throw new AdapterError('server', '伺服器沒有回應');
      body = String(body || '').trim();
      if (!body || body.length > 1000) throw new AdapterError('state', 'body must be 1 to 1000 characters', 400);
      const m = { id: 'mm' + (++msgN), item_id: itemId || null, author: me(), body, reply_to: null, status: 'new', handled_by: null, created_at: iso(Date.now()) };
      msgs.push(m);
      setTimeout(() => { m.status = 'received'; m.handled_by = RK; ping(); }, 1200);   // 示意：肉咖收到
      setTimeout(() => { m.status = 'done'; msgs.push({ id: m.id + 'r', item_id: m.item_id, author: RK, body: '收到，我先記下來，處理好會在這裡回你。（示意回覆）', reply_to: m.id, status: 'done', handled_by: RK, created_at: iso(Date.now()) }); ping(); }, 3200);
      return normalizeMsg(m);
    },
    subscribe(onPing, onState) { listeners.add(onPing); onState(false); return () => listeners.delete(onPing); },
    setKey() {},
  };
}
