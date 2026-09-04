// 電子入札コアシステム型「入札情報公開システム」の**年度・日付区分世代**から入札・契約結果を取得する。
// 埼玉（pipeline/fetch_core_koukai.mjs）と同じ製品だが画面が別世代で、検索フォームも一覧の中身も違う。
//
// 第1弾: 共有ASP www.epi-cloud.fwd.ne.jp（`?name1=<16桁>` でテナントを固定する相乗りホスト）。
//
// 使い方: node pipeline/fetch_epi_koukai.mjs <slug> [--nendo=CSV] [--supply=CSV] [--kind=030,040]
//                                            [--max=N] [--percap=N] [--recon]
//   例（偵察）:       node pipeline/fetch_epi_koukai.mjs iwate --recon
//   例（バックフィル）: node pipeline/fetch_epi_koukai.mjs iwate --max=1500
//   例（日次）:       node pipeline/fetch_epi_koukai.mjs iwate --nendo=2026 --max=300
//   --kikan=1030,1032 で機関番号（4桁16進）を直接指定できる
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
// 表示種別 A094: 030=入札・見積結果 / 040=契約結果（随意契約等）。
// 040 は岩手県・大津市の全年度で0件だったため既定は 030 のみ（必要なら --kind=030,040）。
import { openDb } from './db.mjs';
import { classify } from './taxonomy.mjs';

const ORIGIN = 'https://www.epi-cloud.fwd.ne.jp';
const BASE = '/koukai';

// **name1 の正体**（本セッションで解読）:
//   調達機関コードは `<4桁16進>ZZZZZZ`（岩手県=1030ZZZZZZ・盛岡市=1032ZZZZZZ）。
//   name1 は「その4桁16進を2倍した値」の各桁を固定骨格に1桁ずつ埋めたもの:
//     name1 = "06" + h0 + "006" + h1 + "006" + h2 + "006" + h3 + "0"   （h = hex(kikan*2)）
//   例) 岩手県 0x1030*2=0x2060 → 0620060006600600 ／ 盛岡市 0x1032*2=0x2064 → 0620060006600640
//   → 機関番号を数えるだけで同居テナントを全数走査できる（--discover）。
//   機関番号は 0x1000 + <JIS都道府県コード>*0x10 + 連番 の配置になっている。
export const name1Of = (hex4) => {
  const h = (parseInt(hex4, 16) * 2).toString(16).toUpperCase().padStart(4, '0');
  return `06${h[0]}006${h[1]}006${h[2]}006${h[3]}0`;
};

// **機関番号の配置**: `1` + <JIS都道府県コード2桁> + <連番1桁(0-F)>。
// 例) 1030=岩手県・1032=盛岡市・1037=一関市 ／ 1250=滋賀県・1257=長浜市。
// 2026-09-04 に 101X〜147X（47県×16スロット）を全数走査して、下の72テナントを確定した（走査完了）。
//
// 1 src = 1県。kikans は機関番号（4桁16進）の配列。団体名は入口画面の select から読むので持たない。
// 別システムで既に収録している県は `<県>_epi` として src を分けてある（収録範囲が混ざらないように）。
export const INSTANCES = {
  aomori: { pref: '青森県', kikans: ['1020', '1022', '1024', '1026'] },
  iwate: { pref: '岩手県', kikans: ['1030', '1032', '1034', '1036', '1037'] },
  miyagi: { pref: '宮城県', kikans: ['1042', '1044'] },
  yamagata: { pref: '山形県', kikans: ['1060', '1062', '1064', '1066'] },
  fukushima: { pref: '福島県', kikans: ['1070', '1071', '1072', '1074', '1076'] },
  shiga: { pref: '滋賀県', kikans: ['1250', '1251', '1252', '1253', '1254', '1255', '1256', '1257'] },
  wakayama: { pref: '和歌山県', kikans: ['1304', '1306'] },
  tottori: { pref: '鳥取県', kikans: ['1312', '1314'] },
  yamaguchi: { pref: '山口県', kikans: ['1351', '1352', '1353', '1354', '1355', '1356', '1357'] },
  saga: { pref: '佐賀県', kikans: ['1410', '1411', '1412', '1413', '1414', '1415', '1416', '1417'] },
  nagasaki: { pref: '長崎県', kikans: ['1420', '1422', '1424', '1426'] },
  // 以下は別システムで県本体・他市町村を収録済みの県。この共有ASPにいる団体だけを足す
  niigata_epi: { pref: '新潟県', kikans: ['1152', '1154'] },
  mie_epi: { pref: '三重県', kikans: ['1242', '1244', '1246'] },
  kyoto_epi: { pref: '京都府', kikans: ['1262', '1264', '1266'] },
  fukuoka_epi: { pref: '福岡県', kikans: ['1401', '1402', '1403', '1404', '1405', '1406', '1407'] },
  miyazaki_epi: { pref: '宮崎県', kikans: ['1452', '1454'] },
  okinawa_epi: { pref: '沖縄県', kikans: ['1471', '1472', '1473', '1476'] },
};

const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter((a) => a.startsWith('--'))
  .map((a) => { const [k, v] = a.slice(2).split('='); return [k, v ?? '1']; }));
const slug = args.filter((a) => !a.startsWith('--'))[0] || 'iwate';
const INST = INSTANCES[slug];
if (!INST) { console.error(`未知のインスタンス: ${slug}（候補: ${Object.keys(INSTANCES).join(', ')}）`); process.exit(1); }
const PREF = INST.pref;
const KIKANS = flags.kikan ? flags.kikan.split(',') : INST.kikans;

const SUPPLY = (flags.supply || '00,01,11').split(',');
const KINDS = (flags.kind || '030').split(',');
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
async function enter(hex4) {
  cookies = {}; jsid = '';
  const r = await raw(`${BASE}/do/KF001ShowAction?name1=${name1Of(hex4)}`, { method: 'GET' });
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

console.log(`[${slug}] ${PREF} / 機関${KIKANS.length} / 上限${MAXREQ}req`);
let grand = 0; let dropped = 0;
outer:
for (const hex4 of KIKANS) {
  if (budgetLeft() < 10) { console.log('リクエスト上限に到達'); break; }
  const { kikan, kinds } = await enter(hex4);
  if (!kikan) { console.error(`  ${hex4}: 調達機関が取れない（運用時間外・番号無効）。飛ばす`); continue; }
  const ORG = kikan.name;
  // 入口に出ている業務区分だけを回る（工事/コンサルしか無い団体が多い）
  const supplyName = Object.fromEntries(kinds.map((k) => [{ 1: '00', 2: '01', 3: '11' }[k.i], k.name]));
  console.log(` ■ ${ORG}（${kikan.code}）: ${kinds.map((k) => k.name).join('/') || '区分なし'}`);
  for (const sup of SUPPLY) {
    if (!(sup in supplyName)) continue;
    if (budgetLeft() < 8) { console.log('リクエスト上限に到達'); break outer; }
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
          await enter(hex4);
          await openSearch(kikan, sup);
          r = await post(`${scr(sup)}401SearchAction`, searchBody(nendo, kind));
        }
        const total = recCount(r.html);
        const label = `${supplyName[sup]} ${nendo}年度${kind === '040' ? '(契約結果)' : ''}`;
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
            // 開札日が非公開のとき「*********」でマスクされる。日付として使えない行は落とす
            if (!/^\d{4}-\d{2}-\d{2}$/.test(row.open_date) || !row.name) { dropped++; continue; }
            // 不調・不落・取り止め（落札者が空か「-」で金額も0）
            if (!row.winner || /^[-－ー―]+$/.test(row.winner)) { dropped++; continue; }
            // 品目別の単価契約・見積合せは落札者が複数いるため一覧が「※詳細参照」になる。
            // 個々の落札者が分からない行は載せない
            if (/詳細参照/.test(row.winner)) { dropped++; continue; }
            // 自治体が公開している模擬入札（練習用）データを除く
            if (/^テスト/.test(row.winner) || /模擬入札/.test(row.name)) { dropped++; continue; }
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
}
const c = db.prepare('SELECT COUNT(*) c, COUNT(DISTINCT org) o FROM local_awards WHERE src = ?').get(slug);
console.log(`合計[${slug}]: 新規${grand}件 / 累計${c.c}件・${c.o}機関 / 落札者なしで除外${dropped} / リクエスト${reqCount}回`);
