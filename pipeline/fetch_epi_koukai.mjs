// 電子入札コアシステム型「入札情報公開システム」の**年度・日付区分世代**から入札・契約結果を取得する。
// 埼玉（pipeline/fetch_core_koukai.mjs）と同じ製品だが画面が別世代で、検索フォームも一覧の中身も違う。
//
// 第1弾: 共有ASP www.epi-cloud.fwd.ne.jp（`?name1=<16桁>` でテナントを固定する相乗りホスト）。
//
// 使い方: node pipeline/fetch_epi_koukai.mjs <slug> [--nendo=CSV] [--supply=CSV] [--kind=030,040]
//                                            [--max=N] [--percap=N] [--recon]
//   例（偵察）:       node pipeline/fetch_epi_koukai.mjs iwate --recon
//   例（バックフィル）: node pipeline/fetch_epi_koukai.mjs iwate --max=1500
//   例（日次）:       node pipeline/fetch_epi_koukai.mjs iwate --nendo=2026 --max=200
//
// 到達手順:
//   1. GET  /koukai/do/KF001ShowAction?name1=<16桁> … 団体が固定された入口。
//      **jsessionid はURLパスに埋まる**ので以降 `;jsessionid=…` を付けて回す。
//      調達機関コード（hachukikan）と団体名はこの画面の select から読める＝name1 だけで自走できる
//   2. POST /koukai/do/KK000ShowAction;jsessionid=… {hachukikan, hachukikan_hidden, hachukikan_name, supplytype}
//      supplytype は入口の jsLink2() が入れる値: 00=工事 / 01=コンサル / 11=物品・役務
//   3. GET  koukai_title → koukai_menu → koukai_main（埼玉と同じく3フレームを踏まないと以降が通らない）
//   4. POST /koukai/do/<KK|KB>401ShowAction {auth:'', gyosyu_type:'', chotatsuType:'1'} … 検索条件画面
//      （年度 nendo の選択肢はここが一次情報）
//      **工事・コンサルは KK 画面、物品・役務は KB 画面**（メニューの jskfkLink / jskfbLink が正）。
//      supplytype=11 のまま KK401 を叩くと本文0バイトが返るだけで理由が分からない
//   5. POST /koukai/do/<KK|KB>401SearchAction {A094, nendo, hizukeKubun, orderKey1/2, A300:'040'(=100件), …}
//   6. GET  /koukai/do/KF<K|B>401FrameShow … 明細行（iframeの中身）
//   7. GET  /koukai/do/<KK|KB>401SearchAction?page=N → 6 を再取得、でページ送り（埼玉の curPage ではなく page）
//
// 埼玉世代との決定的な違い（コスト構造）:
//   **一覧に落札者名と落札金額（税抜）が載る**ので、詳細1件＝1リクエストが要らない。
//   100件表示で1ページ2リクエスト＝1件あたり0.02リクエスト。埼玉世代の50分の1で済む。
//
// 表示種別 A094: 030=入札・見積結果 / 040=契約結果（随意契約等）。両方取る。
import { openDb } from './db.mjs';
import { classify } from './taxonomy.mjs';

export const INSTANCES = {
  // name1 は各自治体サイトの入札情報リンクから拾う（16桁でブルートフォース不可）
  iwate: { origin: 'https://www.epi-cloud.fwd.ne.jp', base: '/koukai', name1: '0620060006600600', pref: '岩手県' },
};

const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter((a) => a.startsWith('--'))
  .map((a) => { const [k, v] = a.slice(2).split('='); return [k, v ?? '1']; }));
const slug = args.filter((a) => !a.startsWith('--'))[0] || 'iwate';
const INST = INSTANCES[slug];
if (!INST) { console.error(`未知のインスタンス: ${slug}（候補: ${Object.keys(INSTANCES).join(', ')}）`); process.exit(1); }
const { origin: ORIGIN, base: BASE, name1: NAME1, pref: PREF } = INST;

const SUPPLY = (flags.supply || '00,01,11').split(',');
const KINDS = (flags.kind || '030,040').split(',');
const ONLY_NENDO = flags.nendo ? new Set(flags.nendo.split(',')) : null;
const MAXREQ = Number(flags.max || 2000);
const PERCAP = Number(flags.percap || Infinity); // 1検索あたりのページ数上限

const DELAY = 500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = 'nyusatsu-compass-bot/1.0 (+https://nyusatsu-compass.com/about/)';
const sjis = new TextDecoder('shift_jis');
let cookies = {};
let jsid = '';
let reqCount = 0;
const budgetLeft = () => MAXREQ - reqCount;
const cookieHeader = () => Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');

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
// jsessionid はURLパスに埋める（Cookieだけでは通らない画面がある）
const J = () => (jsid ? `;jsessionid=${jsid}` : '');
const get = (p, q = '') => raw(`${BASE}/do/${p}${J()}${q}`, { method: 'GET' });
const post = (p, body) => raw(`${BASE}/do/${p}${J()}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: Object.entries(body).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&'),
});

const ENT = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"' };
const strip = (h) => (h || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ')
  .replace(/&(nbsp|amp|lt|gt|quot);?/g, (_, k) => ENT[k])
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  .replace(/\s+/g, ' ').trim();
function selectOptions(html, name) {
  const m = html.match(new RegExp(`<select\\b[^>]*name="${name}"[^>]*>([\\s\\S]*?)</select>`, 'i'));
  if (!m) return [];
  return [...m[1].matchAll(/<option[^>]*value="([^"]*)"[^>]*>([^<]*)/g)]
    .map((o) => ({ code: o[1], name: strip(o[2]) })).filter((o) => o.code);
}
const recCount = (h) => Number((h.match(/name="recCount" value="(\d+)"/) || [])[1] ?? 0);

// ---- 入口（name1で団体が固定される。調達機関コードと団体名もここから読む） ----
async function enter() {
  cookies = {}; jsid = '';
  const r = await raw(`${BASE}/do/KF001ShowAction?name1=${NAME1}`, { method: 'GET' });
  jsid = (r.html.match(/;jsessionid=([^"'?&/]+)/i) || [])[1] || '';
  const kikan = selectOptions(r.html, 'hachukikan')[0];
  // jsLink2(i) が入れる supplytype（工事00 / コンサル01 / 物品・役務11）
  const kinds = [...r.html.matchAll(/onClick='jsLink2\((\d)\);'>([^<]+)</g)].map((m) => ({ i: m[1], name: strip(m[2]) }));
  return { kikan, kinds };
}
// 業務区分を選ぶ＝以降のセッションの対象が決まる。フレーム3枚を踏んでから検索条件画面へ
async function openSearch(kikan, supply) {
  await post('KK000ShowAction', {
    hachukikan: kikan.code, hachukikan_hidden: kikan.code, hachukikan_name: kikan.name,
    kasho_name: '', supplytype: supply, bukyoku: '', kakakari: '',
  });
  for (const f of ['koukai_title', 'koukai_menu', 'koukai_main']) await get(f);
  return post(`${scr(supply)}401ShowAction`, { auth: '', gyosyu_type: '', chotatsuType: '1' });
}
// 物品・役務（supplytype=11）だけ画面系が KB。一覧の列構成は KK と同じ
const scr = (supply) => (supply === '11' ? 'KB' : 'KK');
const frameOf = (supply) => (supply === '11' ? 'KFB401FrameShow' : 'KFK401FrameShow');
const searchBody = (nendo, kind) => ({
  // 案件名の項目名は画面で違う（工事=koujimei / 物品=kenmei）。どちらも空で送る
  A094: kind, nendo, A046: '', gyosyu: '', koujimei: '', kenmei: '', koujiNo: '', koujibangou: '', ITEM_1_CONTENT: '',
  hizukeKubun: '020', date_start: '', date_end: '', // 020=開札日（絞り込みはしないが基準にする）
  orderKey1: '020', orderKey2: '020', // 開札日の降順＝新着から埋まる
  A300: '040', perPage: '100', curPage: '1', recCount: '',
});

// 明細行は class="… listColN" で位置が決まる（ヘッダ行は親ページ側にあり iframe には無い）:
//   1=表示種別 2=開札日／契約日 3=工事名 4=契約管理番号 5=入札方式 6=落札者／契約者 7=落札金額(税抜) 8=課所名
function parseRows(html) {
  const rows = [];
  for (const tr of html.match(/<tr[\s\S]*?<\/tr>/gi) || []) {
    const c = {};
    for (const m of tr.matchAll(/<t[dh][^>]*class="[^"]*listCol(\d)[^"]*"[^>]*>([\s\S]*?)<\/t[dh]>/gi)) c[m[1]] = m[2];
    if (!c['3']) continue;
    // 金額は document.write(tagFormatMoney('18800000')) の形でスクリプトの中に入っている
    const money = (c['7'] || '').match(/sMoney\s*=\s*'(\d+)'/);
    rows.push({
      open_date: (strip(c['2']) || '').replaceAll('/', '-'),
      name: strip(c['3']),
      method: strip(c['5']),
      winner: strip(c['6']),
      amount: money ? Number(money[1]) : 0,
      kasho: strip(c['8']),
    });
  }
  return rows;
}

// 課所名「知事部局 沿岸広域振興局 釜石審査指導監」から団体名を落として部局名にする
const deptOf = (kasho, org) => (kasho || '')
  .replace(new RegExp(`^${org.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s　]*`), '').trim();

// ---- main ----
const db = openDb();
const ins = db.prepare(`INSERT OR IGNORE INTO local_awards
  (src, org, dept, pref, name, open_date, category, method, winner_name, corporate_no, amount, slug, fiscal_year, first_seen)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const nowIso = new Date().toISOString();
const fyOf = (d) => { const [y, m] = d.split('-').map(Number); return m >= 4 ? y : y - 1; };

const { kikan, kinds } = await enter();
if (!kikan) { console.log('調達機関が取れなかった（運用時間外・name1無効の可能性）。0件で終了'); process.exit(0); }
const ORG = kikan.name;
const supplyName = Object.fromEntries(kinds.map((k) => [{ 1: '00', 2: '01', 3: '11' }[k.i], k.name]));
console.log(`[${slug}] ${ORG}（${kikan.code}） 区分: ${kinds.map((k) => k.name).join('/')} / 上限${MAXREQ}req`);

let grand = 0; let dropped = 0;
outer:
for (const sup of SUPPLY) {
  if (!(sup in supplyName)) continue;
  if (budgetLeft() < 8) { console.log('リクエスト上限に到達'); break; }
  const top = await openSearch(kikan, sup);
  let nendos = selectOptions(top.html, 'nendo').map((o) => o.code);
  if (!nendos.length) { console.error(`  ${supplyName[sup]}: 年度の選択肢が取れない。飛ばす`); continue; }
  if (ONLY_NENDO) nendos = nendos.filter((n) => ONLY_NENDO.has(n));
  for (const nendo of nendos) {
    for (const kind of KINDS) {
      if (budgetLeft() < 3) { console.log('リクエスト上限に到達'); break outer; }
      let r = await post(`${scr(sup)}401SearchAction`, searchBody(nendo, kind));
      // セッションが切れると検索条件画面ごと返らなくなる。張り直して1度だけやり直す
      if (!/name="recCount"/.test(r.html)) {
        console.error('  セッションを張り直す');
        await enter();
        await openSearch(kikan, sup);
        r = await post(`${scr(sup)}401SearchAction`, searchBody(nendo, kind));
      }
      const total = recCount(r.html);
      const label = `${supplyName[sup]} ${nendo}年度 ${kind === '030' ? '入札結果' : '契約結果'}`;
      if (!total) { if (flags.recon) console.log(`  ${label}: 0件`); continue; }
      if (flags.recon) { console.log(`  ${label}: ${total}件`); continue; }
      const pages = Math.min(Math.ceil(total / 100), PERCAP);
      let n = 0; let seen = 0;
      for (let p = 1; p <= pages; p++) {
        if (budgetLeft() < 2) { console.log('リクエスト上限に到達'); break outer; }
        if (p > 1) await get(`${scr(sup)}401SearchAction`, `?page=${p}`);
        const f = await get(frameOf(sup));
        const rows = parseRows(f.html);
        seen += rows.length;
        for (const row of rows) {
          if (!row.open_date || !row.name) continue;
          if (!row.winner) { dropped++; continue; } // 不調・不落・中止
          n += ins.run(slug, ORG, deptOf(row.kasho, ORG), PREF, row.name, row.open_date,
            supplyName[sup] || '', row.method, row.winner, '', row.amount,
            classify(row.name), fyOf(row.open_date), nowIso).changes;
        }
      }
      grand += n;
      console.log(`  ${label}: 全${total}件 / 読${seen} → 新規${n}件（残${budgetLeft()}req）`);
    }
  }
}
const c = db.prepare('SELECT COUNT(*) c, COUNT(DISTINCT org) o FROM local_awards WHERE src = ?').get(slug);
console.log(`合計[${slug}]: 新規${grand}件 / 累計${c.c}件・${c.o}機関 / 落札者なしで除外${dropped} / リクエスト${reqCount}回`);
