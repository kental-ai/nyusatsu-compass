// DENTYO系（電子入札共同システムの入札情報サービス）から入札結果を取得する汎用フェッチャー。
// 第1弾: かながわ電子入札共同システム（神奈川県+28市町村+県内広域水道企業団）。
//
// 使い方: node pipeline/fetch_dentyo.mjs <slug> [年度CSV] [--gyoshu=1,2,3] [--max=N] [--recon]
//   例: node pipeline/fetch_dentyo.mjs kanagawa 2026,2025 --gyoshu=1 --max=2000
//
// SuperCALS系と違い一覧に落札者名が載らない。落札者名・法人番号は詳細HTML（JSON API）にあるため
// 「一覧1回/100件 + 詳細1回/件」のコストがかかる。--max で1セッションのリクエスト数を必ず縛ること。
// 詳細には全応札者・各回入札額・予定価格まで載るが、いまは落札者名と法人番号だけを取り込む。
import { openDb } from './db.mjs';
import { classify } from './taxonomy.mjs';

const MENU = { 1: 'P5515_10', 2: 'P6015_10', 3: 'P6515_10' }; // 工事 / コンサル / 物品・一般委託

export const INSTANCES = {
  kanagawa: { origin: 'https://ebid-joho.e-kanagawa.lg.jp', pref: '神奈川県' },
};

const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter((a) => a.startsWith('--'))
  .map((a) => { const [k, v] = a.slice(2).split('='); return [k, v ?? '1']; }));
const pos = args.filter((a) => !a.startsWith('--'));
const slug = pos[0] || 'kanagawa';
const INST = INSTANCES[slug];
if (!INST) { console.error(`未知のインスタンス: ${slug}（候補: ${Object.keys(INSTANCES).join(', ')}）`); process.exit(1); }
const ORIGIN = INST.origin;
const NENDO = pos[1] || String(new Date().getMonth() >= 3 ? new Date().getFullYear() : new Date().getFullYear() - 1);
const GYOSHU = (flags.gyoshu || '1,2,3').split(',').map(Number);
const MAXREQ = Number(flags.max || 3000); // 1セッションのリクエスト上限（マナー: 数千件まで）

const DELAY = 500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = 'nyusatsu-compass-bot/1.0 (+https://nyusatsu-compass.com/about/)';
let cookies = {};
let reqCount = 0;
const cookieHeader = () => Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
const budgetLeft = () => MAXREQ - reqCount;

async function raw(path, opt, tries = 3) {
  reqCount++;
  let res;
  try {
    res = await fetch(ORIGIN + path, {
      ...opt,
      headers: { 'User-Agent': UA, ...(Object.keys(cookies).length ? { Cookie: cookieHeader() } : {}), ...(opt.headers || {}) },
      redirect: 'manual',
    });
  } catch (e) {
    if (tries <= 1) throw e;
    console.error(`  再試行(残${tries - 1}): ${e.cause?.code || e.message}`);
    await sleep(5000);
    return raw(path, opt, tries - 1);
  }
  for (const sc of res.headers.getSetCookie?.() ?? []) {
    const m = sc.match(/^([^=]+)=([^;]+)/);
    if (m) cookies[m[1]] = m[2];
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await sleep(DELAY);
  return { status: res.status, loc: res.headers.get('location'), buf };
}
const utf8 = (r) => ({ ...r, text: r.buf.toString('utf8') });
async function get(path) { return utf8(await raw(path, { method: 'GET' })); }
async function post(path, body) {
  return utf8(await raw(path, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  }));
}
async function postJson(path, obj, csrf) { // 詳細HTMLはShift_JISで返る
  const r = await raw(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-TOKEN': csrf },
    body: JSON.stringify(obj),
  });
  return { status: r.status, text: new TextDecoder('shift_jis').decode(r.buf) };
}
const rel = (u) => (u || '').replace(/^https?:\/\/[^/]+/, '');
const csrfOf = (h) => (h.match(/name="_csrf"\s+value="([^"]+)"/) || [])[1] || '';
const tabOf = (h) => (h.match(/name="tabId"\s+value="([^"]+)"/) || [])[1] || '';
const ENT = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"' };
const strip = (h) => h.replace(/<[^>]+>/g, ' ')
  .replace(/&(nbsp|amp|lt|gt|quot);?/g, (_, k) => ENT[k])
  .replace(/&#(\d+);/g, (_, n) => (Number(n) === 65293 ? '-' : String.fromCharCode(Number(n))))
  .replace(/\s+/g, ' ').trim();

// 和暦（令和７年　８月１８日 / 令和7年8月18日）→ ISO。全角数字も受ける
const Z2H = (s) => s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
const waDate = (s0) => {
  const s = Z2H(s0);
  const m = s.match(/(?:令和|R)\s*(\d{1,2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/)
    || s.match(/(?:平成|H)\s*(\d{1,2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (!m) return '';
  const base = /平成|H/.test(s) ? 1988 : 2018;
  const p2 = (x) => String(x).padStart(2, '0');
  return `${base + Number(m[1])}-${p2(m[2])}-${p2(m[3])}`;
};

// ---- 団体一覧（GPPI_MENU のボタンから取る。推測では足さない） ----
async function menuPage() {
  const r = await get('/DENTYO/GPPI_MENU');
  const dantais = [];
  for (const m of r.text.matchAll(/data-code="(\d+)"\s*>([^<]+)</g)) dantais.push({ code: m[1], name: strip(m[2]) });
  return { ...r, dantais };
}

// ---- 団体+業種の検索画面まで進む（団体選択 → インフォメーション → 業種メニュー → 検索条件画面） ----
async function openSearch(dantai, dantaiNm, gyoshu) {
  const a = await menuPage();
  const tab = tabOf(a.text);
  await post('/DENTYO/P5000_10', { _csrf: csrfOf(a.text), hdn_dantai: dantai, tabId: tab });
  const info = await get(`/DENTYO/P5000_10/Information?tabId=${tab}`);
  const menu = MENU[gyoshu];
  const d = await post(`/DENTYO/${menu}?hdn_gyoshu=${gyoshu}`, {
    _csrf: csrfOf(info.text), hdn_dantai: dantai, hdn_dantaiNm: dantaiNm,
    menuCd: menu, menuName: '入札結果', tabId: tabOf(info.text), action: 'disp',
  });
  if (d.status !== 302) return null;
  const cond = await get(rel(d.loc));
  return { menu, dantai, dantaiNm, gyoshu, page: cond };
}

async function search(st, nendo) {
  const f = await post(`/DENTYO/${st.menu}/Search`, {
    _csrf: csrfOf(st.page.text), hdn_dantai: st.dantai, hdn_dantaiNm: st.dantaiNm, hdn_gyoshu: String(st.gyoshu),
    orderGroup: '', action: 'search', tabId: tabOf(st.page.text),
    denshiNyusatsuDiv: '', keisaiNen: String(nendo), hacchuBuCd: '', hacchuJimuCd: '', ankenNo: '',
    nyusatsuType: '', eigyouShumokuCd: '', nameSearch: '', minRakusatuKingaku: '', maxRakusatuKingaku: '',
    kokokuStartDateYear: '', kokokuStartDateDay: '', kokokuEndDateYear: '', kokokuEndDateDay: '', pageSize: '100',
  });
  if (f.status !== 302) { st.page = f; return { total: 0, first: null }; }
  const r = await get(rel(f.loc));
  st.page = r;
  const total = Number((r.text.match(/([\d,]+)件が該当しました/) || [])[1]?.replaceAll(',', '') ?? 0);
  return { total, first: r, tabId: tabOf(r.text) };
}

// 一覧行を <td class="..."> のクラス名で拾う（列順ではなくクラス名で引くので列追加に強い）
function parseRows(html) {
  const rows = [];
  const tbody = html.slice(html.indexOf('pager-table'));
  for (const tr of tbody.match(/<tr>[\s\S]*?<\/tr>/gi) || []) {
    const cell = {};
    for (const m of tr.matchAll(/<td\s+class="([^"]+)"[^>]*>([\s\S]*?)<\/td>/gi)) {
      cell[m[1].split(/\s+/)[0]] = m[2];
    }
    if (!cell['procurement-case-number']) continue;
    const attach = tr.match(/pf_VidDsp_btnHtml\(&#39;(\d+)&#39;,\s*&#39;(\d+)&#39;\)/) || [];
    rows.push({
      caseNo: strip(cell['procurement-case-number']),
      org: strip(cell['group-name'] || ''),
      dept: strip(cell['name-of-the-bidding-department'] || ''),
      method: strip(cell['bidding-method'] || ''),
      category: strip(cell['type-of-work'] || ''),
      open_date: waDate(strip(cell['bid-opening-date'] || '')),
      name: strip(cell['construction-name'] || ''),
      amount: Number(strip(cell['successful-bid-amount'] || '').replace(/[^\d]/g, '') || 0),
      kinouId: attach[1] || '', attachNo: attach[2] || '',
    });
  }
  return rows;
}

// 詳細HTML（全応札者表）から落札者名と法人番号を取る。摘要が「落札」の行が落札者
function parseDetail(html) {
  for (const tr of html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || []) {
    const tds = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => strip(m[1]));
    if (tds.length < 4) continue;
    if (!/^(落札|くじ落札)$/.test(tds[tds.length - 1])) continue;
    const corp = /^\d{13}$/.test(tds[0]) ? tds[0] : '';
    const name = corp ? tds[1] : tds[0];
    if (!name || /入札参加業者/.test(name)) continue;
    return { corp_no: corp, winner: name };
  }
  return null;
}

// ---- main ----
const db = openDb();
db.exec(`
  CREATE TABLE IF NOT EXISTS local_awards (
    src TEXT NOT NULL, org TEXT NOT NULL, dept TEXT, pref TEXT NOT NULL, name TEXT NOT NULL,
    open_date TEXT, category TEXT, method TEXT, winner_name TEXT, corporate_no TEXT,
    amount INTEGER, slug TEXT, fiscal_year INTEGER, first_seen TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS uq_local ON local_awards (src, org, name, open_date, corporate_no, amount);
  CREATE INDEX IF NOT EXISTS idx_local_corp ON local_awards (corporate_no);
`);
// 詳細を取る前に「既に持っている行か」を一覧の情報だけで判定する（詳細1件=1リクエストなので必須）
const seen = db.prepare('SELECT 1 FROM local_awards WHERE src=? AND org=? AND name=? AND open_date=? AND amount=?');
const ins = db.prepare(`INSERT OR IGNORE INTO local_awards
  (src, org, dept, pref, name, open_date, category, method, winner_name, corporate_no, amount, slug, fiscal_year, first_seen)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const now = new Date().toISOString();

// 入札結果の検索は団体をまたいで全団体を返す（団体選択は発注部局プルダウンの中身を変えるだけ）。
// 実測: どの団体を選んでも同じ件数が返り、一覧の「団体名」列に31団体が混在する。
// → 団体ごとに回さず1回の検索で県内全団体を取り、発注機関は一覧の団体名列から取る。
const top = await menuPage();
// 運用時間外は団体一覧が取れない。日次ワークフローを落とさないよう正常終了する（0件で無害）
if (!top.dantais.length) { console.log('団体一覧を取得できなかった（運用時間外・仕様変更の可能性）。0件で終了'); process.exit(0); }
const ANCHOR = top.dantais[0]; // 検索画面に入るための足がかり（結果の範囲には影響しない）
const YEARS = (pos[1] || NENDO).split(',');
console.log(`[${slug}] ${YEARS.join('/')}年度 / 業種${GYOSHU.join(',')} / リクエスト上限${MAXREQ} / 団体${top.dantais.length}（横断検索）`);

let grand = 0; let detailCount = 0; let noDetail = 0;
outer:
for (const g of GYOSHU) {
  const st = await openSearch(ANCHOR.code, ANCHOR.name, g);
  if (!st) { console.error(`  業種${g}: 検索画面に到達できず`); continue; }
  for (const nendo of YEARS) {
    if (budgetLeft() < 30) { console.log('リクエスト上限に到達。ここで打ち切る'); break outer; }
    const { total, first, tabId } = await search(st, nendo);
    if (!total || !first) { console.log(`  ${nendo}年度 業種${g}: 0件`); continue; }
    if (flags.recon) { console.log(`  ${nendo}年度 業種${g}: ${total}件`); continue; }
    const pages = Math.ceil(total / 100);
    let n = 0;
    for (let p = 1; p <= pages; p++) {
      const page = p === 1 ? first : await get(`/DENTYO/${st.menu}/Result?page=${p}&tabId=${tabId}`);
      const csrf = csrfOf(page.text);
      for (const r of parseRows(page.text)) {
        if (!r.open_date || !r.name) continue;
        const org = r.org || INST.pref;
        if (seen.get(slug, org, r.name, r.open_date, r.amount)) continue;
        if (budgetLeft() < 5) { console.log('  リクエスト上限に到達（詳細取得の途中）'); break; }
        let w = null;
        if (r.kinouId && r.attachNo) {
          const det = await postJson('/DENTYO/api/attached-file/detail-download',
            { kinouId: r.kinouId, attachNo: r.attachNo, tabId }, csrf);
          detailCount++;
          if (det.status === 200) w = parseDetail(det.text);
        }
        if (!w) { noDetail++; continue; } // 落札者が確定できない行（中止・不調等）は載せない
        n += ins.run(slug, org, r.dept, INST.pref, r.name, r.open_date,
          r.category, r.method, w.winner, w.corp_no, r.amount, classify(r.name), Number(nendo), now).changes;
      }
      if (budgetLeft() < 5) break;
    }
    grand += n;
    console.log(`  ${nendo}年度 業種${g}: 全${total}件 → 新規${n}件（残リクエスト${budgetLeft()}）`);
  }
}
const c = db.prepare('SELECT COUNT(*) c, COUNT(DISTINCT corporate_no) k FROM local_awards WHERE src = ?').get(slug);
console.log(`合計[${slug}]: 新規${grand}件 / 累計${c.c}件・法人番号ユニーク${c.k} / 詳細${detailCount}回 / 落札者不明で除外${noDetail}件 / リクエスト${reqCount}回`);
