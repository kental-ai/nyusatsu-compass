// SuperCALS（富士通 入札情報公開サービス）から入札結果を取得する汎用フェッチャー。
// 使い方: node pipeline/fetch_supercals.mjs <インスタンスslug> [年度] [KikanNOカンマ区切り|all]
//   例: node pipeline/fetch_supercals.mjs chiba 2025 all
// 一覧HTMLに落札者名(+多くは法人番号)+金額が直接載るため、詳細ページ巡回が不要。
// 直列・500ms間隔。700件制限は開札日範囲の二分割(total<=500)で回避。
import { openDb } from './db.mjs';
import { classify } from './taxonomy.mjs';

// 採用県のインスタンス表（偵察で3手プロトコル実証済みのものだけ追加する）
// kikan を持つものは富士通の共有ホスト（ep-bis.supercals.jp）に相乗りしており、
// KikanNO（先頭2桁=JIS都道府県コード）でテナントを指定しないと検索できない。
export const INSTANCES = {
  chiba: { base: 'https://www.chiba-ep-bis.supercals.jp/ebidPPIPublish/EjPPIj', pref: '千葉県' },
  shizuoka: { base: 'https://www.ppi.cals-shiz.jp/ebidPPIPublish/EjPPIj', pref: '静岡県' }, // 2024年度〜・法人番号あり・県+市町村
  miyazaki: { base: 'https://www.e-nyusatsu-joho.pref.miyazaki.lg.jp/ebidPPIPublish/EjPPIj', pref: '宮崎県' }, // 法人番号あり・14機関
  // 2026-08-24 に平日プローブで実証（いずれも法人番号なし・2025年度〜の保持）
  niigata: { base: 'https://www.ep-bis.pref.niigata.jp/ebidPPIPublish/EjPPIj', pref: '新潟県' },
  tochigi: { base: 'https://www.ep-bis.supercals.jp/ebidPPIPublish/EjPPIj', pref: '栃木県', kikan: '0900000' },
  ishikawa: { base: 'https://www.ep-bis.supercals.jp/ebidPPIPublish/EjPPIj', pref: '石川県', kikan: '1700000' },
  okinawa: { base: 'https://www.ep-bis.supercals.jp/ebidPPIPublish/EjPPIj', pref: '沖縄県', kikan: '4700000' },
  // 愛媛: 2026-08-23時点で保留。8列型だが一部の行で案件名セルが分割され列がずれる（原因未特定）。
  //       2026-08-24: ヘッダー列数ガードで検証中。 
  ehime: { base: 'https://www.ebid-ppi.pref.ehime.jp/ebidPPIPublish/EjPPIj', pref: '愛媛県', caseNoOrg: true },
};

// 愛媛は一覧の見出しに団体名が出ず部局名から始まるため、案件名の先頭にある
// 調達案件番号の上5桁（JIS X 0402の団体コード）から発注機関を復元する。
// 20コードすべてが愛媛県の11市9町と一致し、見出しに団体名が出る4町（砥部・伊方・松野・鬼北）で照合済み。
const EHIME_JIS = {
  38000: '愛媛県', 38201: '松山市', 38202: '今治市', 38203: '宇和島市', 38204: '八幡浜市',
  38205: '新居浜市', 38206: '西条市', 38207: '大洲市', 38210: '伊予市', 38213: '四国中央市',
  38214: '西予市', 38215: '東温市', 38356: '上島町', 38386: '久万高原町', 38401: '松前町',
  38402: '砥部町', 38422: '内子町', 38442: '伊方町', 38484: '松野町', 38488: '鬼北町', 38506: '愛南町',
};

const slug = process.argv[2] || 'chiba';
const INST = INSTANCES[slug];
if (!INST) { console.error(`未知のインスタンス: ${slug}（候補: ${Object.keys(INSTANCES).join(', ')}）`); process.exit(1); }
const BASE = INST.base;
const DELAY = 500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sjis = new TextDecoder('shift_jis');
let cookies = {};
let requestCount = 0;

function cookieHeader() {
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
}
async function req(body = null) {
  requestCount++;
  const res = await fetch(BASE, {
    method: body ? 'POST' : 'GET',
    headers: {
      'User-Agent': 'nyusatsu-compass-bot/1.0 (+https://nyusatsu-compass.com/about/)',
      ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      ...(Object.keys(cookies).length ? { Cookie: cookieHeader() } : {}),
    },
    body: body ? new URLSearchParams(body).toString() : undefined,
    redirect: 'manual',
  });
  for (const sc of res.headers.getSetCookie?.() ?? []) {
    const m = sc.match(/^([^=]+)=([^;]+)/);
    if (m) cookies[m[1]] = m[2];
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await sleep(DELAY);
  return { status: res.status, text: sjis.decode(buf) };
}

const waDate = (s) => { // 'R07-07-01' / '令和07/06/05' / 'R07/06/05' / 'R08.07.15' → '2025-07-01'
  const m = s.match(/(?:R|令和)\s?(\d{1,2})[-/.年]\s?(\d{1,2})[-/.月]\s?(\d{1,2})/);
  if (!m) return '';
  const p2 = (x) => String(x).padStart(2, '0');
  return `${2018 + Number(m[1])}-${p2(m[2])}-${p2(m[3])}`;
};
const strip = (h) => h.replace(/<[^>]+>/g, ' ').replace(/&nbsp;?/g, ' ').replace(/\s+/g, ' ').trim();

// 一覧のヘッダー行から列位置を決める。列数だけで判別すると、9列でも
// 「入札方法」が中間に挟まる型（静岡）と「更新日」が末尾に付く型（石川・沖縄）を取り違える。
function headerMap(cells) {
  const at = (re) => cells.findIndex((c) => re.test(c));
  const m = {
    date: at(/開札/), name: at(/名称|案件名/), winner: at(/落札者|受注者|契約者/),
    amount: at(/落札決定金額|落札金額|契約金額|金額/), method: at(/入札方式|契約方式/), category: at(/調達|区分/),
  };
  if (m.date < 0 || m.name < 0 || m.winner < 0 || m.amount < 0) return null;
  m.n = cells.length;
  return m;
}
const FALLBACK = (n) => { // ヘッダー行を出さないインスタンス（宮崎）向けの従来ヒューリスティック
  const off = n >= 9 ? 1 : 0;
  return { date: 1, name: 2, category: 3, method: 4, winner: 5 + off, amount: 6 + off, n };
};

function parseList(html) {
  const total = Number((html.match(/条件に合致したものを([\d,]+)件/) || [])[1]?.replaceAll(',', '') ?? -1);
  const over = /700件以内|条件を設定/.test(html) && total < 0;
  const rows = [];
  let currentOrg = '';
  let map = null;
  let skipped = 0;
  for (const tr of html.match(/<TR[^>]*>[\s\S]*?<\/TR>/gi) || []) {
    const cells = [...tr.matchAll(/<T[DH][^>]*>([\s\S]*?)<\/T[DH]>/gi)].map((m) => strip(m[1]));
    if (cells.length === 1 && /令和|平成/.test(cells[0])) { currentOrg = cells[0].replace(/令和\d+年度|平成\d+年度/, '').trim(); continue; }
    if (cells[0] === 'No') { map = headerMap(cells) || map; continue; }
    if (cells.length < 7 || !/^\d+$/.test(cells[0] || '')) continue;
    const m = map && map.n === cells.length ? map : (map ? null : FALLBACK(cells.length));
    if (!m) { skipped++; continue; } // ヘッダーと列数が違う行＝セル分割による列ズレ。載せない
    const wcell = cells[m.winner] || '';
    const corpNo = (wcell.match(/法人番号\s*(\d{13})/) || [])[1] || '';
    // 栃木等は落札者名が固定長26字に全角空白でパディングされ、末尾に表示用の「…」が付く（実名は完全）
    const winner = wcell.replace(/法人番号\s*(\d{13}|[－ー-])?/, '').replace(/[\s　]*…+\s*$/, '').trim();
    const amount = Number(((cells[m.amount] || '').match(/([\d,]+)円/) || [])[1]?.replaceAll(',', '') ?? 0);
    if (!winner && !amount) continue; // 入札中止・結果未確定の行
    // 見出しの先頭語が団体名でない（部局名から始まる=単一機関スコープ）なら県名を機関名にする
    const head = currentOrg.split(/\s+/)[0] || '';
    let org = /(?:都|道|府|県|市|町|村|区|組合|広域|企業団|事務組合|機構|公社)$/.test(head) ? head : INST.pref;
    let name = (cells[m.name] || '').replace(/※添付有/, '').trim();
    if (INST.caseNoOrg) { // 案件名の先頭の調達案件番号（20桁以上）＝上5桁が団体コード
      const cm = name.match(/^(\d{5})\d{15,}\s*/);
      if (cm) { org = EHIME_JIS[Number(cm[1])] || org; name = name.slice(cm[0].length); }
    }
    rows.push({
      org, dept: currentOrg,
      open_date: waDate(cells[m.date]), name,
      category: m.category >= 0 ? cells[m.category] : '', method: m.method >= 0 ? cells[m.method] : '',
      winner, corp_no: corpNo, amount,
    });
  }
  return { total, over, rows, skipped };
}

async function search(nendo, kikan, extra = {}, stpos = 0) {
  const { text } = await req({
    ejParameterID: 'EjPRJ01', ejProcessName: 'findList',
    Nendo: String(nendo), KikanNO: kikan, BukyokuNO: '', ChoutatsuCD: '', KoujiSyubetu: '',
    kkselect: 'AND', mojisel1: '', mojisel2: '', BidStDate: extra.from || '', BidEnDate: extra.to || '',
    ejDisplaySort: '050045', ejMaxDisplayRowCount: '500', getStpos: '0',
    AllhitSize: '', ejShousaiDispFlag: '', chiikisentaku: '', chiiki_dataList: '',
  });
  return parseList(text);
}

let skippedRows = 0;

async function collectKikan(nendo, kikan, range = null) {
  const first = await search(nendo, kikan, range || {});
  skippedRows += first.skipped || 0;
  if (first.over || first.total > 500) {
    // 開札日範囲の二分割（年度: 4/1〜翌3/31）
    const y = Number(nendo);
    const lo = range?.from || `${y}/04/01`, hi = range?.to || `${y + 1}/03/31`;
    const [ld, hd] = [new Date(lo.replaceAll('/', '-')), new Date(hi.replaceAll('/', '-'))];
    if (hd - ld < 86400000 * 1.5) { console.error(`  分割限界(1日で500件超): ${kikan} ${lo}〜${hi}`); return first.rows; }
    const mid = new Date((ld.getTime() + hd.getTime()) / 2);
    const midS = mid.toISOString().slice(0, 10).replaceAll('-', '/');
    const midN = new Date(mid.getTime() + 86400000).toISOString().slice(0, 10).replaceAll('-', '/');
    return [...await collectKikan(nendo, kikan, { from: lo, to: midS }),
            ...await collectKikan(nendo, kikan, { from: midN, to: hi })];
  }
  return first.rows; // total<=500かつ表示上限500なので1回で全行取得できる
}

// ---- main ----
const nendo = process.argv[3] || String(new Date().getMonth() >= 3 ? new Date().getFullYear() : new Date().getFullYear() - 1);
// 'all'=全機関横断（KikanNO空。機関名は見出し行から取得）。共有ホスト勢は INSTANCES.kikan が既定値
const kikansArg = process.argv[4] ?? (INST.kikan ? INST.kikan : 'all');

const db = openDb();
db.exec(`
  CREATE TABLE IF NOT EXISTS local_awards (         -- 自治体の入札結果（P2。第1弾: ちば）
    src         TEXT NOT NULL,                      -- chiba等のシステムslug
    org         TEXT NOT NULL,                      -- 機関名（千葉県/船橋市等）
    dept        TEXT,                               -- 部局・課
    pref        TEXT NOT NULL,
    name        TEXT NOT NULL,
    open_date   TEXT,                               -- 開札執行日
    category    TEXT,
    method      TEXT,
    winner_name TEXT,
    corporate_no TEXT,                              -- 法人番号（一覧に直接掲載!）
    amount      INTEGER,
    slug        TEXT,
    fiscal_year INTEGER,
    first_seen  TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS uq_local ON local_awards (src, org, name, open_date, corporate_no, amount);
  CREATE INDEX IF NOT EXISTS idx_local_corp ON local_awards (corporate_no);
`);

// セッション確立（GET → StartPage）
await req();
await req({ ejParameterID: 'StartPage', KikanNO: INST.kikan || 'null' });

const kikans = kikansArg === 'all' ? [''] : kikansArg.split(',');
const now = new Date().toISOString();
const ins = db.prepare(`INSERT OR IGNORE INTO local_awards
  (src, org, dept, pref, name, open_date, category, method, winner_name, corporate_no, amount, slug, fiscal_year, first_seen)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
let grand = 0;
for (const k of kikans) {
  const rows = await collectKikan(nendo, k);
  db.exec('BEGIN');
  let n = 0;
  for (const r of rows) {
    const res = ins.run(slug, r.org, r.dept, INST.pref, r.name, r.open_date, r.category, r.method,
      r.winner, r.corp_no, r.amount, classify(r.name), Number(nendo), now);
    n += res.changes;
  }
  db.exec('COMMIT');
  grand += n;
  console.log(`KikanNO=${k}: 取得${rows.length}行 → 新規${n}件`);
}
const c = db.prepare(`SELECT COUNT(*) c, COUNT(DISTINCT corporate_no) k FROM local_awards WHERE src = '${slug}'`).get();
console.log(`合計[${slug}]: 新規${grand}件 / 累計${c.c}件・法人番号ユニーク${c.k} / リクエスト${requestCount}回 / 列ズレ除外${skippedRows}行`);
