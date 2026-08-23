// 秋田県電子入札システム(cals05)の契約結果情報を取得（県+市町村同居。判定A: 2手+ページング）。
// 使い方: node pipeline/fetch_akita.mjs [年度]
// 注意: TLS証明書チェーンが不完全なためこのホストに限り検証を緩和（KKJと同方式）。
// 法人番号は非掲載（請負者名のみ）。マナー: 直列・500ms・UA明示。
import https from 'node:https';
import { openDb } from './db.mjs';
import { classify } from './taxonomy.mjs';

const HOST = 'cals05.pref.akita.lg.jp';
const DELAY = 500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sjis = new TextDecoder('shift_jis');
let cookies = {};
let requestCount = 0;

function req(path, body = null) {
  requestCount++;
  return new Promise((resolve, reject) => {
    const data = body ? new URLSearchParams(body).toString() : null;
    const r = https.request({
      host: HOST, path, method: body ? 'POST' : 'GET', rejectUnauthorized: false, timeout: 30000,
      headers: {
        'User-Agent': 'nyusatsu-compass-bot/1.0 (+https://nyusatsu-compass.com/about/)',
        ...(Object.keys(cookies).length ? { Cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
        ...(data ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      for (const sc of res.headers['set-cookie'] ?? []) {
        const m = sc.match(/^([^=]+)=([^;]+)/);
        if (m) cookies[m[1]] = m[2];
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(sjis.decode(Buffer.concat(chunks))));
    });
    r.on('error', reject);
    r.on('timeout', () => r.destroy(new Error('timeout')));
    if (data) r.write(data);
    r.end();
  });
}

const waDate = (s) => { const m = s.match(/R(\d{2})\/(\d{2})\/(\d{2})/); return m ? `${2018 + Number(m[1])}-${m[2]}-${m[3]}` : ''; };
const strip = (h) => h.replace(/<[^>]+>/g, ' ').replace(/&nbsp;?/g, ' ').replace(/\s+/g, ' ').trim();

function parseRows(html) {
  const out = [];
  for (const tr of html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || []) {
    const cells = [...tr.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => strip(m[1]));
    // 行判定は金額列（第9列）で行う: 開札日が空の随意契約等も拾う
    if (cells.length !== 13 || !/^[\d,]+$/.test(cells[8] || '')) continue;
    const kasho = cells[11];
    const isMuni = /[市町村]$/.test(kasho);
    out.push({
      org: isMuni ? kasho : '秋田県', dept: kasho,
      name: cells[2], place: cells[3], kind: cells[5], method: cells[1],
      winner: cells[6], amount: Number(cells[8].replaceAll(',', '')) || 0,
      open_date: waDate(cells[9]) || waDate(cells[10]), category: cells[12],
    });
  }
  return out;
}
const hidden = (html, name) => (html.match(new RegExp(`name="${name}"[^>]*value="([^"]*)"`)) || [])[1] || '';

const SEARCH_BASE = {
  chotatsuKbn: '', kouhyoNo: '', nyusatsu: '', kousyu: '', koujiName: '', koujiArea: '', koujiGaiyo: '',
  kennaiCd: '', ukeoiName: '', keiyakuStartMoney: '', keiyakuEndMoney: '',
  kaisatsuStartYmd: '', kaisatsuEndYmd: '', keiyakuStartYmd: '', keiyakuEndYmd: '', sikouKasyo: '',
};

async function fetchYear(nendo) {
  // セッション: 検索画面GET → jsessionid抽出
  const top = await req('/ecydeen/do/PPI/keiyaku');
  await sleep(DELAY);
  const js = (top.match(/jsessionid=([A-F0-9]+)/) || [])[1] || '';
  const sfx = js ? `;jsessionid=${js}` : '';
  const first = await req(`/ecydeen/do/PPI/keiyakuSearch${sfx}`,
    { ...SEARCH_BASE, nendo: String(nendo), displayNum: '100', resultCnt: '0' });
  await sleep(DELAY);
  const total = Number(hidden(first, 'resultCnt')) || 0;
  const pages = Number(hidden(first, 'hiddentotalpages')) || 1;
  const rows = parseRows(first);
  if (!total && !rows.length) {
    // 0件のときは応答の素性を残す（海外IP遮断・メンテ画面・セッション不成立の切り分け用）
    console.log(`  [debug] jsessionid=${js ? 'あり' : 'なし'} top=${top.length}B first=${first.length}B`);
    console.log(`  [debug] top: ${strip(top).slice(0, 160)}`);
    console.log(`  [debug] first: ${strip(first).slice(0, 240)}`);
  }
  for (let p = 2; p <= pages; p++) {
    const html = await req(`/ecydeen/do/PPI/keiyakuTurn${sfx}`,
      { ...SEARCH_BASE, nendo: String(nendo), displayNum: '100', resultCnt: String(total), hiddentotalpages: String(pages), curPage: String(p) });
    await sleep(DELAY);
    const r = parseRows(html);
    if (!r.length) break;
    rows.push(...r);
  }
  return { total, rows };
}

const nendo = process.argv[2] || String(new Date().getFullYear());
const db = openDb();
const now = new Date().toISOString();
const ins = db.prepare(`INSERT OR IGNORE INTO local_awards
  (src, org, dept, pref, name, open_date, category, method, winner_name, corporate_no, amount, slug, fiscal_year, first_seen)
  VALUES ('akita', ?, ?, '秋田県', ?, ?, ?, ?, ?, '', ?, ?, ?, ?)`);
const { total, rows } = await fetchYear(nendo);
db.exec('BEGIN');
let n = 0;
for (const r of rows) {
  const res = ins.run(r.org, r.dept, r.name, r.open_date, r.category, r.method, r.winner, r.amount, classify(r.name), Number(nendo), now);
  n += res.changes;
}
db.exec('COMMIT');
const c = db.prepare(`SELECT COUNT(*) c FROM local_awards WHERE src='akita'`).get();
console.log(`秋田 ${nendo}年度: ヒット${total}件・取得${rows.length}行 → 新規${n}件（akita累計${c.c}件）/ リクエスト${requestCount}回`);
