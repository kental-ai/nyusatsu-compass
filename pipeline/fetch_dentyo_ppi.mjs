// DENTYO旧型（東芝ソリューション製「入札情報サービスシステム(PPI)」フレーム版）から入札結果を取得する。
// 第1弾: 大分県共同利用型（www.t-elis.pref.oita.lg.jp・県+18市町村）。
//
// 使い方: node pipeline/fetch_dentyo_ppi.mjs <slug> [年度CSV] [--gyoshu=1,2,3] [--max=N] [--percap=N] [--dantai=CSV] [--recon]
//   例: node pipeline/fetch_dentyo_ppi.mjs oita 2025 --max=4000 --percap=200
//
// fetch_dentyo.mjs（かながわ＝同じ東芝系の新版・Spring Security）とはURLも画面も別物:
//   - Shift_JIS・フレーム構成・CSRFトークンなし。画面遷移はすべて POST /DENTYO/P5515_10 に hdn_action を載せる
//   - 入札結果は3業種（1:工事 2:コンサル 3:物品・一般委託）とも同じ画面 P5515_10（hdn_gyoshu で切替）
//   - 検索は団体をまたがない（団体ごとに検索する。かながわは全団体横断だった）
//   - 一覧に落札者名・金額が無い（開札日はある）。落札者・金額・開札日時は詳細画面にしかなく1件1リクエスト
//     → 一覧の「開札日」が空（－）の行は不調・未開札なので詳細を取らずに捨てる（実測で確認）
//     → 既にDBにある行（src+org+案件名+開札日）は詳細を取らずに飛ばす。--max で1セッションを必ず縛る
import { openDb } from './db.mjs';
import { classify } from './taxonomy.mjs';

export const INSTANCES = {
  oita: { origin: 'https://www.t-elis.pref.oita.lg.jp', pref: '大分県' },
};

const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter((a) => a.startsWith('--'))
  .map((a) => { const [k, v] = a.slice(2).split('='); return [k, v ?? '1']; }));
const pos = args.filter((a) => !a.startsWith('--'));
const slug = pos[0] || 'oita';
const INST = INSTANCES[slug];
if (!INST) { console.error(`未知のインスタンス: ${slug}（候補: ${Object.keys(INSTANCES).join(', ')}）`); process.exit(1); }
const ORIGIN = INST.origin;
const now0 = new Date();
const YEARS = (pos[1] || String(now0.getMonth() >= 3 ? now0.getFullYear() : now0.getFullYear() - 1)).split(',');
const GYOSHU = (flags.gyoshu || '1,2,3').split(',');
const MAXREQ = Number(flags.max || 3000);
const PERCAP = Number(flags.percap || Infinity); // 1団体1業種1年度あたりの詳細取得上限（初回は薄く広く撒くため）
const ONLY = flags.dantai ? new Set(flags.dantai.split(',')) : null;

const SCREEN = 'P5515_10';
const DELAY = 500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = 'nyusatsu-compass-bot/1.0 (+https://nyusatsu-compass.com/about/)';
const sjis = new TextDecoder('shift_jis');
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
  return { status: res.status, html: sjis.decode(buf) };
}
const get = (path) => raw(path, { method: 'GET' });
// 画面は Shift_JIS だが、こちらから日本語を送る項目は無い（団体名は空で通る）ので ASCII だけを送る
const post = (path, body) => raw(path, {
  method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: Object.entries(body).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&'),
});

const ENT = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"' };
const strip = (h) => h.replace(/<[^>]+>/g, ' ')
  .replace(/&(nbsp|amp|lt|gt|quot);?/g, (_, k) => ENT[k])
  .replace(/&#(\d+);/g, (_, n) => (Number(n) === 65293 ? '-' : String.fromCharCode(Number(n))))
  .replace(/\s+/g, ' ').trim();
const Z2H = (s) => s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
const p2 = (x) => String(x).padStart(2, '0');
// 一覧「R08.03.25」/ 詳細「令和 ８年 ３月２５日 １０時３３分」の双方を受ける
const waDate = (s0) => {
  const s = Z2H(s0 || '').replace(/\s+/g, '');
  let m = s.match(/^([RH])(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{1,2})/);
  if (m) return `${(m[1] === 'H' ? 1988 : 2018) + Number(m[2])}-${p2(m[3])}-${p2(m[4])}`;
  m = s.match(/(令和|平成)(\d{1,2})年(\d{1,2})月(\d{1,2})日/);
  if (m) return `${(m[1] === '平成' ? 1988 : 2018) + Number(m[2])}-${p2(m[3])}-${p2(m[4])}`;
  return '';
};
// 部を持たない団体は発注部局名が「＊」というプレースホルダになる（例「＊ 契約検査課」）
const cleanDept = (s) => (s || '').replace(/^＊\s*/, '').trim();
const body0 = (html) => html.slice(html.indexOf('<BODY'));
const hiddens = (html) => Object.fromEntries(
  [...html.matchAll(/<INPUT type="hidden" name="([^"]+)" value="([^"]*)"/gi)].map((m) => [m[1], m[2]]));

// ---- 団体一覧（トップの選択画面から取る。コメントアウトされた廃止団体は除く） ----
async function dantaiList() {
  const r = await get('/DENTYO/GPPI_MENU');
  const html = r.html.replace(/<!--[\s\S]*?-->/g, '');
  const seen = new Set();
  const out = [];
  for (const m of html.matchAll(/hdn_dantai=(\d+)"><B>([^<]+)</g)) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push({ code: m[1], name: strip(m[2]) });
  }
  return out;
}

const searchForm = (dantai, gyoshu, nendo) => ({
  hdn_statusMessage: '', hdn_modifyFlag: '', hdn_displayId: 'GP5515_1010', hdn_action: 'btn_reference',
  hdn_defaultKeisaiNen: String(now0.getFullYear()), hdn_dantai: dantai, hdn_dantaiNm: '', hdn_gyoshu: gyoshu,
  hdn_confirm: 'false', ddl_denshiNyusatsuDiv: '1', ddl_keisaiNen: nendo,
  ddl_hacchuBuCd: '', ddl_hacchuJimuCd: '', ddl_nyusatsuType: '', ddl_koshuGyomuCd: '',
  ddl_kokokuYearStart: '', txt_kokokuMonthStart: '', txt_kokokuDayStart: '',
  ddl_kokokuYearEnd: '', txt_kokokuMonthEnd: '', txt_kokokuDayEnd: '',
  txt_ankenNm: '', txt_ankenJusho: '', ddl_pageSize: '500',
});

// 一覧行: [詳細btn, 添付btn, 発注部局名/所属名, 入札方式, 業種, 開札日, 案件名, 場所]
function parseRows(html) {
  const b = body0(html);
  const rows = [];
  for (const tr of b.match(/<TR>[\s\S]*?<\/TR>/gi) || []) {
    const kanri = (tr.match(/pf_VidDsp_btnKokokuClick\('(\d+)'\)/) || [])[1];
    if (!kanri) continue;
    const t = [...tr.matchAll(/<TD[^>]*>([\s\S]*?)<\/TD>/gi)].map((m) => strip(m[1]));
    rows.push({ kanri, dept: t[2] || '', method: t[3] || '', category: t[4] || '', open_date: waDate(t[5]), name: t[6] || '' });
  }
  return rows;
}

// 詳細（3列の「N． ラベル 値」表）→ ラベル→値のマップ
function parseDetail(html) {
  const kv = {};
  for (const m of html.matchAll(/<td[^>]*>([^<]*)<\/td>\s*<td[^>]*text-align:left[^>]*>([\s\S]*?)<\/td>/gi)) {
    const k = strip(m[1]);
    if (k) kv[k] = strip(m[2]);
  }
  const yen = (s) => Number(Z2H(s || '').replace(/（[\s\S]*$/, '').replace(/[^\d]/g, '') || 0);
  const nameKey = ['工事名', '業務名', '物件名', '件名', '調達案件名'].find((k) => kv[k]);
  return {
    result: kv['結果'] || '',
    winner: (kv['落札者'] || '').replace(/^－$/, ''),
    amount: yen(kv['落札金額（税込み）'] ?? kv['落札金額']),
    open_date: waDate(kv['開札日時'] || ''),
    name: nameKey ? kv[nameKey] : '',
    dept: kv['発注部局名／発注所属名'] || '',
    category: kv['業種'] || '',
    method: kv['入札方式'] || '',
  };
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
// 詳細を取る前の既知判定（金額は詳細にしか無いので金額抜きで引く）
const seen = db.prepare('SELECT 1 FROM local_awards WHERE src=? AND org=? AND name=? AND open_date=?');
const ins = db.prepare(`INSERT OR IGNORE INTO local_awards
  (src, org, dept, pref, name, open_date, category, method, winner_name, corporate_no, amount, slug, fiscal_year, first_seen)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const nowIso = new Date().toISOString();

let dantais = await dantaiList();
// 運用時間外・仕様変更で団体一覧が取れない場合は日次ジョブを落とさず0件で正常終了する
if (!dantais.length) { console.log('団体一覧を取得できなかった（運用時間外・仕様変更の可能性）。0件で終了'); process.exit(0); }
if (ONLY) dantais = dantais.filter((d) => ONLY.has(d.code));
console.log(`[${slug}] ${YEARS.join('/')}年度 / 業種${GYOSHU.join(',')} / 団体${dantais.length} / リクエスト上限${MAXREQ}`);

let grand = 0; let details = 0; let skipped = 0; let noDate = 0; let dropped = 0;
outer:
for (const dan of dantais) {
  for (const g of GYOSHU) {
    if (budgetLeft() < 10) { console.log('リクエスト上限に到達'); break outer; }
    // 検索条件画面を開く（この POST でセッションに団体・業種が乗る）
    await post(`/DENTYO/${SCREEN}?hdn_gyoshu=${g}`, { hdn_dantai: dan.code, hdn_dantaiNm: '', hdn_action: 'INITIAL' });
    for (const nendo of YEARS) {
      if (budgetLeft() < 6) break outer;
      const r = await post(`/DENTYO/${SCREEN}`, searchForm(dan.code, g, nendo));
      const b = body0(r.html);
      const total = Number((b.match(/([\d,]+)件が該当しました/) || [])[1]?.replaceAll(',', '') ?? 0);
      if (!total) { if (flags.recon) console.log(`  ${dan.name} 業種${g} ${nendo}: 0件`); continue; }
      if (flags.recon) { console.log(`  ${dan.name} 業種${g} ${nendo}: ${total}件`); continue; }
      // 一覧を先に全ページ集める（詳細を挟むとページ遷移のセッション状態が壊れうるため）
      const hid = hiddens(b);
      const pages = Math.min(Number(hid.hdn_maxPageNo || 1), Math.ceil(total / 500));
      const rows = parseRows(r.html);
      for (let p = 2; p <= pages && budgetLeft() > 6; p++) {
        const pr = await post(`/DENTYO/${SCREEN}`, { ...hid, hdn_action: 'btn_movePage', hdn_destinationPageNum: String(p) });
        rows.push(...parseRows(pr.html));
      }
      // 詳細を取る対象を絞る（開札日なし＝不調・未開札 / 既知行）
      const todo = [];
      for (const row of rows) {
        if (!row.open_date) { noDate++; continue; }
        if (!row.name) continue;
        if (seen.get(slug, dan.name, row.name, row.open_date)) { skipped++; continue; }
        todo.push(row);
      }
      let n = 0; let got = 0;
      for (const row of todo) {
        if (budgetLeft() < 3 || got >= PERCAP) break;
        const det = await post(`/DENTYO/${SCREEN}`, { ...hid, hdn_action: 'btn_kokoku', hdn_selectKanriNo: row.kanri });
        details++; got++;
        const d = parseDetail(det.html);
        if (!d.winner || !/落札/.test(d.result)) { dropped++; continue; }
        const openDate = d.open_date || row.open_date;
        const name = d.name || row.name;
        n += ins.run(slug, dan.name, cleanDept(d.dept || row.dept), INST.pref, name, openDate,
          d.category || row.category, d.method || row.method, d.winner, '', d.amount,
          classify(name), Number(nendo), nowIso).changes;
      }
      grand += n;
      console.log(`  ${dan.name} 業種${g} ${nendo}: 全${total}件 / 詳細対象${todo.length} → 新規${n}件（残リクエスト${budgetLeft()}）`);
    }
  }
}
const c = db.prepare('SELECT COUNT(*) c, COUNT(DISTINCT org) o FROM local_awards WHERE src = ?').get(slug);
console.log(`合計[${slug}]: 新規${grand}件 / 累計${c.c}件・${c.o}団体 / 詳細${details}回 / 既知で省略${skipped} / 開札日なしで省略${noDate} / 落札者なしで除外${dropped} / リクエスト${reqCount}回`);
