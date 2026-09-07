// ぐんま電子入札共同システム（G-CALS）の入札情報公開システムから入札・契約結果を取得する。
// SuperCALS(富士通) / DENTYO(東芝) / PPI_P(NEC) / 電子入札コアシステム のどれとも違う独立系統。
// URLは素直なクエリ文字列型（/ebia/servlet/p?job=…）で、セッションを張らずに直接POSTできる。
//
// 使い方: node pipeline/fetch_gcals.mjs <slug> [--nendo=CSV] [--shubetsu=00,01,02] [--dantai=CSV]
//                                       [--from=YYYY-MM-DD] [--to=YYYY-MM-DD]
//                                       [--max=N] [--percap=N] [--recon]
//   例（偵察）:       node pipeline/fetch_gcals.mjs gunma --recon
//   例（バックフィル）: node pipeline/fetch_gcals.mjs gunma --percap=120 --max=4000
//   例（日次）:       node pipeline/fetch_gcals.mjs gunma --nendo=2026 --max=800
//
// 到達手順:
//   1. GET  ?job=AcDantaiZIndex … 調達機関（団体）一覧。`?job=AcDantaiZTop&kikan_no=NNNN` のリンクに
//      **団体名がテキストで並ぶ**ので、団体名の推測は一切不要
//   2. POST /ebia/servlet/p {job:'AcKekka<K|C|B>List', kikan_no, shubetsucd, selDantai, selDantaiFlg:'true',
//      selNendo, selHyojikensu:'100', mode:'normal', …} … 一覧（**検索画面を踏まずに直接通る**）
//      業種: 00=工事(K) / 01=コンサル(C) / 02=物品・委託(B)。画面IDの文字が業種ごとに変わる
//   3. ページ送りは同じPOSTに `pagecount=N`（1始まり）。表示件数の上限は100（selHyojikensu）
//   4. POST {job:'AcKekka<K|C|B>Detail', anken_no:<調達案件番号>, subWin:'true'} … 詳細
//
// コスト構造: **一覧に落札者・落札金額が無く、詳細1件＝1リクエスト**（DENTYO系・埼玉世代と同じ）。
//   その代わり詳細は情報量が多く、**全応札者の法人番号つき**・各回入札額・予定価格・最低制限価格まで載る。
//   → `--max`（1セッションの総リクエスト上限）と `--percap`（1団体1業種1年度あたりの詳細取得上限）で縛る。
//   既知行は `src+org+案件名+開札日` でDB照合して詳細を取らずに飛ばす。
//
// 実測（2026-09-08 の全数偵察）: 37団体 × 3業種 × 3年度 = 13,900件。
//   年度の選択肢は 2025・2026・2027 の3つだけ＝**保持期間が短い**（取り続けた者だけが持てる）。
//   実績が1件も無い団体が5つある（富岡市・甘楽町・太田市・榛東村・吾妻環境施設組合）。
//
// 一覧に「***」で伏せられた行がある＝公表前の案件。詳細を取っても全項目が「***」なので取得前に捨てる。
// 金額はすべて**税抜**（詳細に「上記の金額に、消費税および地方消費税に相当する額を加算した金額が
// 契約に係る金額である」と明記）。
import { openDb } from './db.mjs';
import { classify, isMockCase } from './taxonomy.mjs';

export const INSTANCES = {
  gunma: { pref: '群馬県', origin: 'https://portal.g-cals.e-gunma.lg.jp', path: '/ebia/servlet/p' },
};

// 業種: 画面IDの1文字・shubetsucd・表示名
const SHUBETSU = [
  { c: 'K', cd: '00', name: '工事' },
  { c: 'C', cd: '01', name: 'コンサル' },
  { c: 'B', cd: '02', name: '物品・委託' },
];

const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter((a) => a.startsWith('--'))
  .map((a) => { const [k, v] = a.slice(2).split('='); return [k, v ?? '1']; }));
const slug = args.filter((a) => !a.startsWith('--'))[0] || 'gunma';
const INST = INSTANCES[slug];
if (!INST) { console.error(`未知のインスタンス: ${slug}（候補: ${Object.keys(INSTANCES).join(', ')}）`); process.exit(1); }
const { pref: PREF, origin: ORIGIN, path: PATH } = INST;

const ONLY_NENDO = flags.nendo ? new Set(flags.nendo.split(',')) : null;
const ONLY_DANTAI = flags.dantai ? new Set(flags.dantai.split(',')) : null;
const SHUB = (flags.shubetsu || '00,01,02').split(',');
const MAXREQ = Number(flags.max || 3000);
const PERCAP = Number(flags.percap || Infinity);
const NENDOS = ['2025', '2026', '2027'];

const DELAY = 550;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = 'nyusatsu-compass-bot/1.0 (+https://nyusatsu-compass.com/about/)';
const sjis = new TextDecoder('shift_jis');
let cookies = {};
let reqCount = 0;
const budgetLeft = () => MAXREQ - reqCount;
const cookieHeader = () => Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');

async function raw(url, opt = {}, tries = 3) {
  reqCount++;
  let res;
  try {
    res = await fetch(ORIGIN + url, {
      ...opt,
      headers: { 'User-Agent': UA, ...(Object.keys(cookies).length ? { Cookie: cookieHeader() } : {}), ...(opt.headers || {}) },
      redirect: 'manual',
      signal: AbortSignal.timeout(60000), // 応答が返らないままソケットを握られるのを防ぐ（長野で実害あり）
    });
  } catch (e) {
    if (tries <= 1) throw e;
    console.error(`  再試行(残${tries - 1}): ${e.cause?.code || e.message}`);
    await sleep(5000);
    return raw(url, opt, tries - 1);
  }
  for (const sc of res.headers.getSetCookie?.() ?? []) {
    const m = sc.match(/^([^=]+)=([^;]+)/);
    if (m) cookies[m[1]] = m[2];
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await sleep(DELAY);
  return { status: res.status, html: sjis.decode(buf) };
}
const get = (q) => raw(PATH + q, { method: 'GET' });
const post = (body) => raw(PATH, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: Object.entries(body).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&'),
});

const ENT = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"' };
const strip = (h) => (h || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ')
  .replace(/&(nbsp|amp|lt|gt|quot);?/g, (_, k) => ENT[k])
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  .replace(/\s+/g, ' ').trim();
// 全角英数字を半角に（予定価格「３，８００，０００円」・開札日「２０２６年０４月１６日」用）
const han = (s) => (s || '').replace(/[０-９Ａ-Ｚａ-ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
  .replaceAll('，', ',').replaceAll('．', '.');
const yen = (s) => { const m = han(s).replace(/,/g, '').match(/(\d+)\s*円/); return m ? Number(m[1]) : null; };

// 一覧の検索・ページ送りのボディ（検索画面を踏まずに直接通る）
const listBody = (dantai, sh, nendo, page, range) => ({
  job: `AcKekka${sh.c}List`,
  kikan_no: dantai, shubetsucd: sh.cd, selDantai: dantai, selDantaiFlg: 'true', selectDantai: '',
  prevTitle: '', mode: 'normal',
  selBukyoku: '', selKasho: '', selHyojiShubetsu: '', selNendo: nendo, selGyoshu: '', selEigyoHinmoku: '',
  textKenmei: '', textNonyuBasho: '',
  // 開札日の絞り込み（年・月・日の6項目に分割。ゼロ埋めの有無はどちらでも効く）
  textKaisatsubiFromYear: range?.f?.[0] ?? '', textKaisatsubiFromMonth: range?.f?.[1] ?? '', textKaisatsubiFromDay: range?.f?.[2] ?? '',
  textKaisatsubiToYear: range?.t?.[0] ?? '', textKaisatsubiToMonth: range?.t?.[1] ?? '', textKaisatsubiToDay: range?.t?.[2] ?? '',
  selHyojikensu: '100', pagecount: String(page), startkensu: '', endkensu: '',
});

const totalOf = (html) => Number(((html.match(/([0-9,]+)件中/) || [])[1] || '0').replaceAll(',', ''));

// 一覧行。列は業種で入れ替わる（工事=工事名/工事場所/工種、物品=件名/資格区分/営業品目）ので
// クラス名で引ける項目だけを使い、案件名は openDetail を含むセルから取る。
function parseList(html) {
  const out = [];
  for (const tr of html.match(/<tr class="inputArea[\s\S]*?<\/tr>/gi) || []) {
    const id = (tr.match(/openDetail\('(\d+)'\)/) || [])[1];
    if (!id) continue;
    const cell = (cls) => strip((tr.match(new RegExp(`class="${cls}"[^>]*>([\\s\\S]*?)</td>`, 'i')) || [])[1] || '');
    const nameTd = (tr.match(/<a href="javascript:openDetail\('\d+'\)">([\s\S]*?)<\/a>/i) || [])[1];
    const d = han(cell('koukaibi')).match(/(\d{4})年(\d{2})月(\d{2})日/);
    out.push({
      id,
      name: strip(nameTd || ''),
      method: cell('nyusatsu-housiki'),
      kasho: cell('kashomei'),
      open_date: d ? `${d[1]}-${d[2]}-${d[3]}` : '',
    });
  }
  return out;
}

// 詳細。th→td の対応表と、入札経過表（落札者＝赤字 or 金額欄に「落札」の行）を読む。
function parseDetail(html) {
  const info = {};
  for (const m of html.matchAll(/<tr>\s*<th[^>]*>([\s\S]*?)<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/gi)) {
    const k = strip(m[1]).replace(/\s/g, '');
    if (k && !(k in info)) info[k] = strip(m[2]);
  }
  const keika = (html.match(/<table id="nyusatsu-keika-table"[\s\S]*?<\/table>/i) || [''])[0];
  const rows = keika.match(/<tr class="inputArea[\s\S]*?<\/tr>/gi) || [];
  let winner = null;
  for (const tr of rows) {
    const tds = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
    if (!tds.length) continue;
    const isWinner = /color:\s*red/i.test(tds[0]) || tds.slice(1).some((t) => /落\s*札/.test(strip(t)));
    if (!isWinner) continue;
    const t = strip(tds[0]); // 業者名<br>法人番号（13桁）
    const cn = (han(t).match(/(\d{13})/) || [])[1] || '';
    // 金額は 第1回/第2回/第3回/随意契約 のうち値が入っている最後の列（最終回が落札額）
    let amt = 0;
    for (const cell of tds.slice(1, 5)) {
      const v = han(strip(cell)).replace(/,/g, '').match(/^(\d+)/);
      if (v) amt = Number(v[1]);
    }
    winner = { name: t.replace(/\s*\d{13}\s*$/, '').trim(), corporate_no: cn, amount: amt };
    break;
  }
  // 入札経過が無い（随意契約で経過非公表）ときは「契約の相手方」にフォールバックする
  if (!winner && info['商号又は名称／法人番号']) {
    const t = info['商号又は名称／法人番号'];
    winner = {
      name: t.replace(/\s*\d{13}\s*$/, '').trim(),
      corporate_no: (han(t).match(/(\d{13})/) || [])[1] || '',
      amount: yen(info['契約金額']) ?? 0,
    };
  }
  const od = han(info['開札日'] || '').match(/(\d{4})年(\d{2})月(\d{2})日/);
  return {
    winner,
    open_date: od ? `${od[1]}-${od[2]}-${od[3]}` : '',
    kasho: info['課所名'] || '',
    method: info['入札方式'] || '',
    planned: yen(info['予定価格']),
    floor: yen(info['調査基準価格/最低制限価格']),
    bidders: rows.length || null,
  };
}

// 課所名「高崎市財務部契約課」から団体名を落として部局名にする
const deptOf = (kasho, org) => (kasho || '')
  .replace(new RegExp(`^${org.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s　]*`), '').trim();

// ---- main ----
const db = openDb();
const ins = db.prepare(`INSERT OR IGNORE INTO local_awards
  (src, org, dept, pref, name, open_date, category, method, winner_name, corporate_no, amount, slug, fiscal_year,
   first_seen, planned_price, floor_price, bidders)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const seen = db.prepare('SELECT 1 FROM local_awards WHERE src=? AND org=? AND name=? AND open_date=?');
const nowIso = new Date().toISOString();
const fyOf = (d) => { const [y, m] = d.split('-').map(Number); return m >= 4 ? y : y - 1; };
const ymd = (s) => (s ? s.split('-') : null);
const RANGE = (flags.from || flags.to) ? { f: ymd(flags.from), t: ymd(flags.to) } : null;

// 団体一覧（kikan_no=0000 はメニューのテンプレートリンクなので除く）
const idx = await get('?job=AcDantaiZIndex');
const found = [...idx.html.matchAll(/href="[^"]*job=AcDantaiZTop&(?:amp;)?kikan_no=(\d+)"[^>]*>([\s\S]*?)<\/a>/gi)]
  .map((m) => ({ no: m[1], name: strip(m[2]) })).filter((d) => d.no !== '0000');
const uniq = new Set();
let DANTAI = found.filter((d) => !uniq.has(d.no) && uniq.add(d.no));
if (ONLY_DANTAI) DANTAI = DANTAI.filter((d) => ONLY_DANTAI.has(d.no));
if (!DANTAI.length) { console.error('団体一覧が取れない（運用時間外の可能性）。0件で終了'); process.exit(0); }

console.log(`[${slug}] ${PREF} / 団体${DANTAI.length} / 上限${MAXREQ}req / percap=${PERCAP}`);
let grand = 0; let skipped = 0; let dropped = 0;
outer:
for (const dan of DANTAI) {
  for (const cd of SHUB) {
    const sh = SHUBETSU.find((s) => s.cd === cd);
    if (!sh) continue;
    for (const nendo of (ONLY_NENDO ? NENDOS.filter((n) => ONLY_NENDO.has(n)) : NENDOS)) {
      if (budgetLeft() < 3) { console.log('リクエスト上限に到達'); break outer; }
      const first = await post(listBody(dan.no, sh, nendo, 1, RANGE));
      const n = totalOf(first.html);
      if (!n) continue;
      if (flags.recon) { console.log(`  ${dan.name} ${sh.name} ${nendo}: ${n}件`); continue; }
      const pages = Math.ceil(n / 100);
      let got = 0; let read = 0;
      // **一覧は調達案件番号の昇順＝古い順**。新着は最終ページの末尾にある。
      // percap で薄く撒くときも日次で新着を拾うときも、新しい方から欲しいのでページを逆順に回る
      for (let p = pages; p >= 1; p--) {
        if (budgetLeft() < 2 || got >= PERCAP) break;
        const page = p === 1 && pages === 1 ? first : await post(listBody(dan.no, sh, nendo, p, RANGE));
        for (const row of parseList(page.html).reverse()) { // ページ内も新しい順に見る
          read++;
          // 公表前の案件は一覧が「***」で伏せられている。詳細も全項目「***」なので取りに行かない
          if (!row.open_date || !row.name || row.name === '***') { dropped++; continue; }
          if (isMockCase(row.name)) { dropped++; continue; }
          if (seen.get(slug, dan.name, row.name, row.open_date)) { skipped++; continue; }
          if (budgetLeft() < 1 || got >= PERCAP) break;
          const d = await post({ ...listBody(dan.no, sh, nendo, p, RANGE), job: `AcKekka${sh.c}Detail`,
            anken_no: row.id, subWin: 'true', mapLinkPushFlg: 'false' });
          got++;
          const det = parseDetail(d.html);
          // 不調・不落・中止（落札者が出ない）
          if (!det.winner || !det.winner.name || /^[-－ー―*＊]+$/.test(det.winner.name)) { dropped++; continue; }
          const kasho = det.kasho && det.kasho !== '***' ? det.kasho : row.kasho;
          const open = det.open_date || row.open_date;
          grand += ins.run(slug, dan.name, deptOf(kasho, dan.name), PREF, row.name, open,
            sh.name, det.method || row.method, det.winner.name, det.winner.corporate_no,
            det.winner.amount, classify(row.name), fyOf(open), nowIso,
            det.planned, det.floor, det.bidders).changes;
        }
      }
      if (got) console.log(`  ${dan.name} ${sh.name} ${nendo}: 全${n}件 / 読${read} / 詳細${got} → 累計新規${grand}（残${budgetLeft()}req）`);
    }
  }
}
const c = db.prepare('SELECT COUNT(*) c, COUNT(DISTINCT org) o FROM local_awards WHERE src=?').get(slug);
console.log(`合計[${slug}]: 新規${grand}件 / 累計${c.c}件・${c.o}団体 / 既知で飛ばした${skipped} / 除外${dropped} / リクエスト${reqCount}回`);
