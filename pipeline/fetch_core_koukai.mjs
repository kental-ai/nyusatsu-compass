// 電子入札コアシステム型の「入札情報公開システム」（/koukai/do/KF000ShowAction 系）から入札・見積結果を取得する。
// 第1弾: 埼玉県共同利用（ebidjk2.ebid2.pref.saitama.lg.jp・県＋市町村＋一部事務組合の71機関）。
//
// 使い方: node pipeline/fetch_core_koukai.mjs <slug> [--from=YYYY-MM-DD] [--to=YYYY-MM-DD]
//                                            [--supply=00,01,10] [--kikan=CSV] [--max=N] [--percap=N] [--recon]
//   例（バックフィル・薄く広く）: node pipeline/fetch_core_koukai.mjs saitama --from=2025-04-01 --percap=12 --max=2600
//   例（日次）:                  node pipeline/fetch_core_koukai.mjs saitama --percap=6 --max=1400
//
// 到達手順（docs/p2-municipal-data.md 第8次で特定した手順に、今回の実測を足したもの）:
//   1. GET  /koukai/do/KF000ShowAction … フレームセット。JSESSIONIDはCookieに乗る
//   2. GET  /koukai/do/koukai_title → koukai_menu → koukai_main（3フレームを踏まないと以降が「タイムアウト」になる）
//   3. POST /koukai/do/KK401ShowAction {auth:'', gyosyu_type:'', chotatsuType:'1'} … 入札・見積結果の検索条件画面
//      → 調達機関（hachukikan）・調達区分（supplytype）の選択肢はここから読む
//   4. POST /koukai/do/KK401SearchAction {…条件} … 件数と総ページ数だけが返る（明細は入っていない）
//   5. GET  /koukai/do/KFK401FrameShow … 明細行（iframeの中身）。ここに案件名・開札日・課所名がある
//   6. GET  /koukai/do/KK401SearchAction?curPage=N → 5 を再取得、でページ送り
//   7. POST /koukai/do/KK402ShowAction {control_no} … 詳細。**Refererヘッダが無いと INVALID_URL で弾かれる**
//
// 注意点（実測）:
//   - 開札日の絞り込みは hidden の nyusatsubi_kaishi / nyusatsubi_owari（YYYY/MM/DD）が効く。
//     年月日のセレクト（kaishi_nen / nyusatsubi_kaishi_tsuki / …）だけを送っても「条件なし＝全件」になる
//     （月日の選択肢はゼロ埋めなしの "8" "1" 形式）
//   - 一覧は開札日の降順。日次は --percap を小さくして全機関に薄く回せば新着から埋まる
//   - 一覧に落札者・金額が無く、詳細1件＝1リクエスト（DENTYO系と同じコスト構造）。--max / --percap で必ず縛る
//   - 詳細には全応札者の法人番号・各回入札額・予定価格まで載る。落札者は赤字（FONT COLOR='#CC0033'）の行
//   - 金額は税抜き
import { openDb } from './db.mjs';
import { classify } from './taxonomy.mjs';

export const INSTANCES = {
  saitama: { origin: 'https://ebidjk2.ebid2.pref.saitama.lg.jp', base: '/koukai', pref: '埼玉県' },
};

const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter((a) => a.startsWith('--'))
  .map((a) => { const [k, v] = a.slice(2).split('='); return [k, v ?? '1']; }));
const pos = args.filter((a) => !a.startsWith('--'));
const slug = pos[0] || 'saitama';
const INST = INSTANCES[slug];
if (!INST) { console.error(`未知のインスタンス: ${slug}（候補: ${Object.keys(INSTANCES).join(', ')}）`); process.exit(1); }
const { origin: ORIGIN, base: BASE, pref: PREF } = INST;

const p2 = (x) => String(x).padStart(2, '0');
const now0 = new Date();
const iso = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const fyStart = () => `${now0.getMonth() >= 3 ? now0.getFullYear() : now0.getFullYear() - 1}-04-01`;
const FROM = flags.from || fyStart();
const TO = flags.to || iso(now0);
const SUPPLY = (flags.supply || '00,01,10').split(',');
const ONLY = flags.kikan ? new Set(flags.kikan.split(',')) : null;
const MAXREQ = Number(flags.max || 2000);
const PERCAP = Number(flags.percap || Infinity); // 1機関1区分あたりの詳細取得上限（薄く広く撒くため）

const DELAY = 500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = 'nyusatsu-compass-bot/1.0 (+https://nyusatsu-compass.com/about/)';
const sjis = new TextDecoder('shift_jis');
let cookies = {};
let reqCount = 0;
const cookieHeader = () => Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
const budgetLeft = () => MAXREQ - reqCount;

async function raw(path, opt = {}, tries = 3) {
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
const get = (path) => raw(`${BASE}${path}`, { method: 'GET' });
const post = (path, body, headers = {}) => raw(`${BASE}${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
  body: Object.entries(body).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&'),
});

const ENT = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"' };
const strip = (h) => (h || '').replace(/<[^>]+>/g, ' ')
  .replace(/&(nbsp|amp|lt|gt|quot);?/g, (_, k) => ENT[k])
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  .replace(/\s+/g, ' ').trim();
const yen = (s) => Number((s || '').replace(/[^\d]/g, '') || 0);
const mask = (s) => (/^\*+$/.test(s || '') ? '' : (s || ''));
const recCount = (h) => Number((h.match(/parseInt\("(\d+)"\)/) || [])[1] ?? 0);
const totalPages = (h) => Number((h.match(/name="hiddentotalpages" value="(\d+)"/) || [])[1] || 1);

// ---- 検索条件画面（機関・区分の選択肢はここが一次情報） ----
async function openSearch() {
  await get('/do/KF000ShowAction');
  for (const f of ['koukai_title', 'koukai_menu', 'koukai_main']) await get(`/do/${f}`);
  return post('/do/KK401ShowAction', { auth: '', gyosyu_type: '', chotatsuType: '1' });
}
function selectOptions(html, name) {
  const m = html.match(new RegExp(`<select\\b[^>]*name="${name}"[^>]*>([\\s\\S]*?)</select>`));
  if (!m) return [];
  return [...m[1].matchAll(/<option[^>]*value="([^"]*)"[^>]*>([^<]*)/g)]
    .map((o) => ({ code: o[1], name: strip(o[2]) })).filter((o) => o.code);
}

const searchBody = (kikan, supply) => {
  const [fy, fm, fd] = FROM.split('-');
  const [ty, tm, td] = TO.split('-');
  return {
    supplytype: supply, hachukikan: kikan, bukyoku: '', kakakari: '', A303: '', shubetsu1: '', kakudzuke: '',
    koujimei: '', koujibangou: '',
    kaishi_nen: fy, nyusatsubi_kaishi_tsuki: String(Number(fm)), nyusatsubi_kaishi_nichi: String(Number(fd)),
    owari_nen: ty, nyusatsubi_owari_tsuki: String(Number(tm)), nyusatsubi_owari_nichi: String(Number(td)),
    // ここが本体。セレクトだけでは絞り込まれない
    nyusatsubi_kaishi: FROM.replaceAll('-', '/'), nyusatsubi_owari: TO.replaceAll('-', '/'),
    A300: '040', searchflg: '1', postconv_flg: '1',
  };
};

// 明細行: [入札方式, 案件番号, 調達案件名称(a href=doEdit(control_no)), 開札日, 課所名]
function parseRows(html) {
  const rows = [];
  for (const tr of html.match(/<tr>[\s\S]*?<\/tr>/gi) || []) {
    const cno = (tr.match(/doEdit\('(\d+)'\)/) || [])[1];
    if (!cno) continue;
    const t = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => strip(m[1]));
    if (t.length < 5) continue;
    rows.push({ cno, method: t[0], case_no: t[1], name: t[2], open_date: (t[3] || '').replaceAll('/', '-'), kasho: t[4] });
  }
  return rows;
}

// 詳細（ラベル/値の2列表 ＋ 入札経過表。落札者は赤字 FONT COLOR='#CC0033' の行）
function parseDetail(html) {
  const kv = {};
  for (const m of html.matchAll(/<TD[^>]*class='TableTitle'[^>]*>([\s\S]*?)<\/TD>\s*<TD[^>]*>([\s\S]*?)<\/TD>/gi)) {
    const k = strip(m[1]);
    if (k && !(k in kv)) kv[k] = strip(m[2]);
  }
  let winner = ''; let corp = ''; let amount = 0;
  for (const tr of html.match(/<TR>[\s\S]*?<\/TR>/gi) || []) {
    if (!/FONT COLOR='#CC0033'/i.test(tr)) continue;
    const t = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => strip(m[1]));
    if (t.length < 3) continue;
    corp = /^\d{13}$/.test(t[0]) ? t[0] : '';
    // 業者名は「商号　営業所名」の形。「本店」は商号そのものなので落とし、支店・営業所名は残す
    winner = t[1].replace(/[\s　]*本店$/, '');
    // 第1回・第2回・最終回・随意契約の4列のうち、金額が入っている最後の列が落札額
    for (const c of t.slice(2, 6)) { const v = yen(c); if (v) amount = v; }
    break;
  }
  return {
    winner,
    corp,
    amount,
    result: kv['結果'] || '',
    // 業種／業務・格付は非公開のとき「********」で埋められる（値なし扱いにして調達区分名にフォールバック）
    category: mask(kv['業種／業務']),
    method: kv['入札方式'] || '',
    name: kv['調達案件名称'] || '',
    kasho: kv['課所名'] || '',
    open_date: (kv['開札日'] || '').slice(0, 10).replaceAll('/', '-'),
  };
}

// 課所名「埼玉県　県土整備部　西関東連絡道路建設事務所」から団体名を落として部局名にする。
// 課がない団体は「さいたま市　環境局施設部　（環境局施設部）」のように部名が括弧つきで重複するので畳む
const deptOf = (kasho, org) => {
  const parts = (kasho || '')
    .replace(new RegExp(`^${org.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s　]*`), '')
    .split(/[\s　]+/).filter(Boolean);
  const out = [];
  for (const p of parts) {
    // 括弧を外すのは「（環境局施設部）」のように全体が括弧で括られた重複表記だけ。
    // 「経営課（水道）」のような語中の括弧は残す
    const bare = /^[（(][^（(]*[）)]$/.test(p) ? p.slice(1, -1) : p;
    if (out.includes(bare)) continue;
    out.push(bare);
  }
  return out.join(' ');
};

// ---- main ----
const db = openDb();
const seen = db.prepare('SELECT 1 FROM local_awards WHERE src=? AND org=? AND name=? AND open_date=?');
const ins = db.prepare(`INSERT OR IGNORE INTO local_awards
  (src, org, dept, pref, name, open_date, category, method, winner_name, corporate_no, amount, slug, fiscal_year, first_seen)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const nowIso = new Date().toISOString();
const fyOf = (d) => { const [y, m] = d.split('-').map(Number); return m >= 4 ? y : y - 1; };

let top = await openSearch();
// セッションが張れないことがある（長時間のバックフィル中にも起きる）。一度だけ張り直す
if (!selectOptions(top.html, 'hachukikan').length) { await sleep(5000); top = await openSearch(); }
let kikans = selectOptions(top.html, 'hachukikan');
// 運用時間外・仕様変更で選択肢が取れない場合は日次ジョブを落とさず0件で正常終了する
if (!kikans.length) { console.log('調達機関の選択肢が取れなかった（運用時間外・仕様変更の可能性）。0件で終了'); process.exit(0); }
// 「（旧）○○市」は合併等で消滅した団体。実在しない発注機関のページを作らないため対象外にする
const retired = kikans.filter((k) => k.name.startsWith('（旧）'));
kikans = kikans.filter((k) => !k.name.startsWith('（旧）'));
if (ONLY) kikans = kikans.filter((k) => ONLY.has(k.code) || ONLY.has(k.name));
const supplyNames = Object.fromEntries(selectOptions(top.html, 'supplytype').map((o) => [o.code, o.name]));
console.log(`[${slug}] 開札日 ${FROM}〜${TO} / 機関${kikans.length}（旧団体${retired.length}件は除外） / 区分${SUPPLY.join(',')} / 上限${MAXREQ}req・機関区分あたり${PERCAP}件`);

let grand = 0; let details = 0; let skipped = 0; let dropped = 0;
outer:
for (const k of kikans) {
  for (const sup of SUPPLY) {
    if (budgetLeft() < 4) { console.log('リクエスト上限に到達'); break outer; }
    let r = await post('/do/KK401SearchAction', searchBody(k.code, sup));
    // セッションが切れると検索画面ごと返らなくなり、以降すべて0件に見える。張り直して1度だけやり直す
    if (!r.html.includes('hachukikan')) {
      console.error('  セッションを張り直す');
      await openSearch();
      r = await post('/do/KK401SearchAction', searchBody(k.code, sup));
    }
    const total = recCount(r.html);
    if (!total) { if (flags.recon) console.log(`  ${k.name} ${supplyNames[sup] || sup}: 0件`); continue; }
    if (flags.recon) { console.log(`  ${k.name} ${supplyNames[sup] || sup}: ${total}件`); continue; }
    const pages = totalPages(r.html);
    let f = await get('/do/KFK401FrameShow');
    const rows = parseRows(f.html);
    // 一覧は開札日の降順。未取得分が --percap に届くまでだけページを送る
    for (let p = 2; p <= pages && budgetLeft() > 6; p++) {
      const todoNow = rows.filter((x) => x.open_date && x.name && !seen.get(slug, k.name, x.name, x.open_date)).length;
      if (todoNow >= PERCAP) break;
      await get(`/do/KK401SearchAction?curPage=${p}`);
      f = await get('/do/KFK401FrameShow');
      rows.push(...parseRows(f.html));
    }
    const todo = [];
    for (const row of rows) {
      if (!row.open_date || !row.name) continue;
      if (seen.get(slug, k.name, row.name, row.open_date)) { skipped++; continue; }
      todo.push(row);
    }
    let n = 0; let got = 0;
    for (const row of todo) {
      if (budgetLeft() < 2 || got >= PERCAP) break;
      const d = await raw(`${BASE}/do/KK402ShowAction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: `${ORIGIN}${BASE}/do/KK401SearchAction` },
        body: `control_no=${encodeURIComponent(row.cno)}`,
      });
      details++; got++;
      const det = parseDetail(d.html);
      if (!det.winner) { dropped++; continue; } // 不調・不落・中止（赤字の落札業者が無い）
      const openDate = det.open_date || row.open_date;
      const name = det.name || row.name;
      n += ins.run(slug, k.name, deptOf(det.kasho || row.kasho, k.name), PREF, name, openDate,
        det.category || supplyNames[sup] || '', det.method || row.method, det.winner, det.corp, det.amount,
        classify(name), fyOf(openDate), nowIso).changes;
    }
    grand += n;
    console.log(`  ${k.name} ${supplyNames[sup] || sup}: 全${total}件 / 未取得${todo.length} → 新規${n}件（残${budgetLeft()}req）`);
  }
}
const c = db.prepare('SELECT COUNT(*) c, COUNT(DISTINCT org) o FROM local_awards WHERE src = ?').get(slug);
console.log(`合計[${slug}]: 新規${grand}件 / 累計${c.c}件・${c.o}機関 / 詳細${details}回 / 既知で省略${skipped} / 落札者なしで除外${dropped} / リクエスト${reqCount}回`);
