// SuperCALS（富士通 入札情報公開サービス）から入札結果を取得する汎用フェッチャー。
// 使い方: node pipeline/fetch_supercals.mjs <インスタンスslug> [年度] [KikanNOカンマ区切り|all]
//   例: node pipeline/fetch_supercals.mjs chiba 2025 all
// 一覧HTMLに落札者名(+多くは法人番号)+金額が直接載るため、詳細ページ巡回が不要。
// 直列・500ms間隔。700件制限は開札日範囲の二分割(total<=500)で回避。
import { openDb } from './db.mjs';
import { classify } from './taxonomy.mjs';

// 採用県のインスタンス表（偵察で3手プロトコル実証済みのものだけ追加する）
export const INSTANCES = {
  chiba: { base: 'https://www.chiba-ep-bis.supercals.jp/ebidPPIPublish/EjPPIj', pref: '千葉県' },
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

const waDate = (s) => { // 'R07-07-01' → '2025-07-01'
  const m = s.match(/R(\d{2})-(\d{2})-(\d{2})/);
  return m ? `${2018 + Number(m[1])}-${m[2]}-${m[3]}` : '';
};
const strip = (h) => h.replace(/<[^>]+>/g, ' ').replace(/&nbsp;?/g, ' ').replace(/\s+/g, ' ').trim();

function parseList(html) {
  const total = Number((html.match(/条件に合致したものを([\d,]+)件/) || [])[1]?.replaceAll(',', '') ?? -1);
  const over = /700件以内|条件を設定/.test(html) && total < 0;
  const rows = [];
  let currentOrg = '';
  for (const tr of html.match(/<TR[^>]*>[\s\S]*?<\/TR>/gi) || []) {
    const cells = [...tr.matchAll(/<T[DH][^>]*>([\s\S]*?)<\/T[DH]>/gi)].map((m) => strip(m[1]));
    if (cells.length === 1 && /令和|平成/.test(cells[0])) { currentOrg = cells[0].replace(/令和\d+年度|平成\d+年度/, '').trim(); continue; }
    if (cells.length < 7 || cells[0] === 'No' || !/^\d+$/.test(cells[0])) continue;
    const corpNo = (cells[5].match(/法人番号\s*(\d{13})/) || [])[1] || '';
    rows.push({
      org: currentOrg.split(/\s+/)[0] || '', dept: currentOrg,
      open_date: waDate(cells[1]), name: cells[2].replace(/※添付有/, '').trim(),
      category: cells[3], method: cells[4],
      winner: cells[5].replace(/法人番号\s*(\d{13}|[－ー-])?/, '').trim(), corp_no: corpNo,
      amount: Number((cells[6].match(/([\d,]+)円/) || [])[1]?.replaceAll(',', '') ?? 0),
    });
  }
  return { total, over, rows };
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

async function collectKikan(nendo, kikan, range = null) {
  const first = await search(nendo, kikan, range || {});
  if (first.over || first.total > 500) {
    // 開札日範囲の二分割（年度: 4/1〜翌3/31）
    const y = Number(nendo);
    const lo = range?.from || `${y}/04/01`, hi = range?.to || `${y + 1}/03/31`;
    const [ld, hd] = [new Date(lo.replaceAll('/', '-')), new Date(hi.replaceAll('/', '-'))];
    if (hd - ld < 86400000 * 20) { console.error(`  分割限界: ${kikan} ${lo}〜${hi}`); return first.rows; }
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
const kikansArg = process.argv[4] ?? 'all'; // 'all'=全機関横断（KikanNO空。機関名は見出し行から取得）

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
await req({ ejParameterID: 'StartPage', KikanNO: 'null' });

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
console.log(`合計[${slug}]: 新規${grand}件 / 累計${c.c}件・法人番号ユニーク${c.k} / リクエスト${requestCount}回`);
