// DENCHO系（東芝＝現CyberCom製「入札情報サービス(PPI)」の Staveware 4 世代）から入札結果を取得する。
// 第1弾: 岡山県電子入札共同利用システム（www.ppi04.t-elbs.jp・県+29団体）。
//
// 使い方: node pipeline/fetch_dencho.mjs <slug> [年度CSV] [--gyoshu=00,01,11] [--max=N] [--percap=N]
//         [--dantai=CSV] [--recon]
//   例: node pipeline/fetch_dencho.mjs okayama 2026,2025 --percap=40 --max=4000
//
// 既存の東芝2系統とは別世代（URLもパラメータも別物）:
//   - fetch_dentyo.mjs     … かながわ /DENTYO/ + Spring Security（_csrf・tabId）
//   - fetch_dentyo_ppi.mjs … 大分 /DENTYO/ + hdn_action のフレーム版
//   - 本ファイル           … 岡山 /DENCHO/ + Staveware 4。画面遷移は「フォームのaction属性を
//     '<画面ID>_<イベント>' に差し替えてPOST」する方式（js/Global.js の pf_BlnExec_ActionByTarget、
//     stvVersionFlg="4"）。POSTは302を返し、実体は Location のGETで取る
//
// 到達手順:
//   1. GET /DENCHO/PpiJGyomuStart.do?kinouid=GP5910_10 → GET /DENCHO/GP5910_1010
//        … 業者検索画面の shiteiDantaiCd セレクトが「団体コード→団体名」の一次情報（推測不要）
//   2. GET /DENCHO/PpiJGyomuStart.do?kinouid=GP5000_Top&dantaiCd=<団体> … セッションに団体を載せる
//   3. GET /DENCHO/GP5515_1010?gyoshuKbnCd=<00工事|01コンサル|11物品・役務> … 検索条件画面
//   4. POST /DENCHO/GP5515_1010_search（条件画面の全フィールド＋keisaiNen・pageSize=500）→ 302
//      → GET /DENCHO/GP5515_1015 … 一覧
//   5. ページ送りは POST /DENCHO/GP5515_1015_page（結果画面の全フィールド＋destinationPage=N）→ 302 → GET
//   6. 詳細は GET /DENCHO/GP9505_5515.action?kanriNo=<管理番号>（単発GET）
//
// コスト構造: 一覧に落札者名・落札金額が無く詳細1件＝1リクエスト（大分・埼玉・群馬と同じ）。
//   ただし一覧に「開札日時」と「状態」があるので、状態が「落札」でない行は詳細を取らずに捨てられる。
//   既知行（src+org+案件名+開札日）もDB照合で飛ばす。--max / --percap で必ず縛ること。
import { openDb } from './db.mjs';
import { classify, isMockCase } from './taxonomy.mjs';

export const INSTANCES = {
  okayama: { origin: 'https://www.ppi04.t-elbs.jp', pref: '岡山県', skipDantai: new Set(['3999']) },
};

const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter((a) => a.startsWith('--'))
  .map((a) => { const [k, v] = a.slice(2).split('='); return [k, v ?? '1']; }));
const pos = args.filter((a) => !a.startsWith('--'));
const slug = pos[0] || 'okayama';
const INST = INSTANCES[slug];
if (!INST) { console.error(`未知のインスタンス: ${slug}（候補: ${Object.keys(INSTANCES).join(', ')}）`); process.exit(1); }
const ORIGIN = INST.origin;
const now0 = new Date();
const YEARS = (pos[1] || String(now0.getMonth() >= 3 ? now0.getFullYear() : now0.getFullYear() - 1)).split(',');
const GYOSHU = (flags.gyoshu || '00,01,11').split(',');
const MAXREQ = Number(flags.max || 3000);
const PERCAP = Number(flags.percap || Infinity); // 1団体1業種1年度あたりの詳細取得上限
const ONLY = flags.dantai ? new Set(flags.dantai.split(',')) : null;

const DELAY = 550;
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
      signal: AbortSignal.timeout(60000), // 応答が返らないままハングする事故を防ぐ（長野で実害）
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
  return { status: res.status, loc: res.headers.get('location'), html: sjis.decode(buf) };
}
const get = (path) => raw(path, { method: 'GET' });
// 画面はShift_JISだが、こちらから送るのは数値・コードだけなのでASCIIで足りる
const post = (path, body) => raw(path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: Object.entries(body).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&'),
});

const ENT = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"' };
const strip = (h) => (h || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ')
  .replace(/&(nbsp|amp|lt|gt|quot);?/g, (_, k) => ENT[k])
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  .replace(/[\s　]+/g, ' ').trim();
const Z2H = (s) => (s || '').replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
const p2 = (x) => String(x).padStart(2, '0');
// 一覧「R08.09.04 10:00」/ 詳細「令和　８年　９月　４日 １０時００分」の双方を受ける
const waDate = (s0) => {
  const s = Z2H(s0).replace(/[\s　]+/g, '');
  let m = s.match(/^([RH])(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{1,2})/);
  if (m) return `${(m[1] === 'H' ? 1988 : 2018) + Number(m[2])}-${p2(m[3])}-${p2(m[4])}`;
  m = s.match(/(令和|平成)(\d{1,2})年(\d{1,2})月(\d{1,2})日/);
  if (m) return `${(m[1] === '平成' ? 1988 : 2018) + Number(m[2])}-${p2(m[3])}-${p2(m[4])}`;
  return '';
};
const yen = (s) => {
  const v = Z2H(s || '').replace(/[^\d]/g, '');
  return v ? Number(v) : null;
};
// 画面のフォーム項目を丸ごと拾う（Stavewareは項目が欠けるとサーバ側で「処理を停止しました」になる）
function formFields(html) {
  const f = {};
  const i = html.indexOf('<form');
  const seg = i >= 0 ? html.slice(i) : html;
  for (const m of seg.matchAll(/<input\b[^>]*>/gi)) {
    const t = m[0];
    const type = ((t.match(/type="([^"]*)"/i) || [])[1] || 'text').toLowerCase();
    const name = (t.match(/name="([^"]*)"/i) || [])[1];
    if (!name || type === 'button' || type === 'submit') continue;
    if ((type === 'checkbox' || type === 'radio') && !/\bchecked\b/i.test(t)) continue;
    f[name] = (t.match(/value="([^"]*)"/i) || [])[1] || '';
  }
  for (const m of seg.matchAll(/<select\b[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/select>/gi)) {
    const sel = m[2].match(/<option value="([^"]*)"[^>]*selected/i);
    f[m[1]] = sel ? sel[1] : ((m[2].match(/<option value="([^"]*)"/i) || [])[1] || '');
  }
  return f;
}

// ---- 団体一覧（業者検索画面のセレクトが一次情報。団体名の推測をしない） ----
async function dantaiList() {
  await get('/DENCHO/PpiJGyomuStart.do?kinouid=GP5910_10');
  await get('/DENCHO/GP5910_10.action?requestEvent=init'); // これを踏まないと画面が空で返る
  const r = await get('/DENCHO/GP5910_1010');
  const sel = r.html.match(/<select name="shiteiDantaiCd"[^>]*>([\s\S]*?)<\/select>/i);
  if (!sel) return [];
  return [...sel[1].matchAll(/<option value="(\d+)">([^<]+)<\/option>/g)]
    .map((m) => ({ code: m[1], name: strip(m[2]) }))
    .filter((d) => !(INST.skipDantai || new Set()).has(d.code));
}

// ---- 一覧行 ----
// TD: [0]添付btn [1]発注部局名/発注所属名 [2]電子・紙 [3]入札方式 [4]業種 [5]開札日時 [6]状態 [7]案件名 [8]場所
function parseRows(html) {
  const rows = [];
  for (const tr of html.match(/<TR>[\s\S]*?<\/TR>/gi) || []) {
    const kanri = (tr.match(/pf_VidDsp_btnKokokuClick\('\d+','([^']+)'\)/) || [])[1];
    if (!kanri) continue;
    const td = [...tr.matchAll(/<TD[^>]*>([\s\S]*?)<\/TD>/gi)].map((m) => m[1]);
    if (td.length < 9) continue;
    // 案件名セルは「案件番号<BR>案件番号　案件名」。番号は別項目なので先頭の重複を落とす
    const lines = td[7].split(/<br\s*\/?>/i).map((s) => strip(s)).filter(Boolean);
    let name = lines[lines.length - 1] || '';
    if (lines.length > 1 && name.startsWith(lines[0])) name = name.slice(lines[0].length).trim();
    rows.push({
      kanri,
      dept: strip(td[1]),
      method: strip(td[3]),
      category: strip(td[4]),
      open_date: waDate(strip(td[5])),
      state: strip(td[6]),
      name,
    });
  }
  return rows;
}

// ---- 詳細 ----
// 見出しは <th>文字</th> か <th><div class="label" id="…Label"></div></th>（JSが後から埋める）。
// 予定価格・最低制限価格は後者なので div の id を見出しとして使う
function parseDetail(html) {
  const kv = {};
  // 行ごとに切ってから見出しと値を取る（XYZ行のように値がTEXT_ALIGN_LEFTでない行を跨ぐと
  // 「結果」が前の見出しにくっつくため、<tr>単位に閉じ込める）
  for (const tr of html.match(/<tr>[\s\S]*?<\/tr>/gi) || []) {
    const th = tr.match(/<th[^>]*>([\s\S]*?)<\/th>/i);
    const td = tr.match(/<td class="TEXT_ALIGN_LEFT"[^>]*>([\s\S]*?)<\/td>/i);
    if (!th || !td) continue;
    const id = (th[1].match(/id="([^"]+)"/) || [])[1];
    const k = id || strip(th[1]);
    if (k && !(k in kv)) kv[k] = strip(td[1]);
  }
  const dash = (s) => (!s || s === '－' || s === '-' ? '' : s);
  const nameKey = ['工事名', '業務名', '件名', '物件名', '調達案件名'].find((k) => kv[k]);
  let name = nameKey ? kv[nameKey] : '';
  const no = dash(kv.kojiNoNmLabel || '');
  if (no && name.startsWith(no)) name = name.slice(no.length).trim();
  // 入札経過表から落札者を取る。摘要は「落札」と「落札（くじ）」の2種（同額でくじ引きになった案件）。
  // 岡山県の工事は3割がくじ決着なので「落札」の完全一致だけでは落札者を取りこぼす。
  // 一方で「先順位案件落札のため無効扱い」のように落札者でない行にも落札の字が入りうる
  // （群馬で誤認した前例）ので、先頭一致かつ無効系の語を含まない行に限る
  const bidders = [];
  const tbl = html.slice(html.indexOf('id="tbl_result"'));
  for (const tr of tbl.match(/<tr>[\s\S]*?<\/tr>/gi) || []) {
    const td = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)];
    if (td.length < 4) continue;
    const money = td.filter((m) => /TEXT_ALIGN_RIGHT/i.test(m[0])).map((m) => strip(m[1]));
    if (!money.length) continue;
    const who = strip(td[0][1].split(/<br\s*\/?>/i)[0]); // 「商号<br>代表者名」の商号だけ
    const note = strip(td[td.length - 1][1]);
    const last = [...money].reverse().find((v) => dash(v));
    bidders.push({ who, note, amount: yen(last) });
  }
  const win = bidders.find((b) => /^落札/.test(b.note) && !/無効|失格|辞退|棄権|取消/.test(b.note));
  return {
    result: dash(kv['結果'] || ''),
    dept: kv['発注部局名／発注所属名'] || '',
    category: dash(kv['業種'] || ''),
    method: dash(kv['入札方式'] || ''),
    open_date: waDate(kv['開札日時'] || ''),
    name,
    winner: win ? win.who : '',
    amount: win ? win.amount : null,
    planned_price: yen(dash(kv.shosaiYoteiKakakuLabel || '')),
    floor_price: yen(dash(kv.shosaiSaiteiseigenKakakuLabel || '')),
    bidders: bidders.length,
  };
}

// ---- main ----
const db = openDb();
const seen = db.prepare('SELECT 1 FROM local_awards WHERE src=? AND org=? AND name=? AND open_date=?');
const ins = db.prepare(`INSERT OR IGNORE INTO local_awards
  (src, org, dept, pref, name, open_date, category, method, winner_name, corporate_no, amount, slug, fiscal_year,
   first_seen, planned_price, floor_price, bidders)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const nowIso = new Date().toISOString();

let dantais = await dantaiList();
// 運用時間外（入札情報公開システムは6:00〜23:00 JST・毎月第1日曜は終日停止）や仕様変更で
// 団体一覧が取れない場合は、日次ジョブを落とさないよう0件で正常終了する
if (!dantais.length) { console.log('団体一覧を取得できなかった（運用時間外・仕様変更の可能性）。0件で終了'); process.exit(0); }
if (ONLY) dantais = dantais.filter((d) => ONLY.has(d.code));
console.log(`[${slug}] ${YEARS.join('/')}年度 / 業種${GYOSHU.join(',')} / 団体${dantais.length} / リクエスト上限${MAXREQ}`);

let grand = 0; let details = 0; let skipped = 0; let notWon = 0; let dropped = 0;
outer:
for (const dan of dantais) {
  if (budgetLeft() < 8) { console.log('リクエスト上限に到達'); break; }
  await get(`/DENCHO/PpiJGyomuStart.do?kinouid=GP5000_Top&dantaiCd=${dan.code}`);
  await get('/DENCHO/GP5000_Top.action?requestEvent=init'); // 業務画面の初期化。踏まないと以降が空になる
  for (const g of GYOSHU) {
    if (budgetLeft() < 6) break outer;
    const cond = await get(`/DENCHO/GP5515_1010?gyoshuKbnCd=${g}`);
    const base = formFields(cond.html);
    if (!('keisaiNen' in base)) { console.log(`  ${dan.name} 業種${g}: 検索条件画面を取得できず`); continue; }
    for (const nendo of YEARS) {
      if (budgetLeft() < 4) break outer;
      await post('/DENCHO/GP5515_1010_search', { ...base, keisaiNen: nendo, pageSize: '500' });
      let list = await get('/DENCHO/GP5515_1015');
      const total = Number((list.html.match(/id="ankenSize"[^>]*value="(\d+)"/) || [])[1] || 0);
      if (!total) { if (flags.recon) console.log(`  ${dan.name} 業種${g} ${nendo}: 0件`); continue; }
      if (flags.recon) { console.log(`  ${dan.name} 業種${g} ${nendo}: ${total}件`); continue; }
      const maxPage = Number((list.html.match(/id="maxPage"[^>]*value="(\d+)"/) || [])[1] || 1);
      const rows = parseRows(list.html);
      // ページ送りだけは302を返さず、POSTのレスポンスが一覧そのもの
      for (let p = 2; p <= maxPage && budgetLeft() > 4; p++) {
        const pf = formFields(list.html);
        list = await post('/DENCHO/GP5515_1015_page', { ...pf, destinationPage: String(p) });
        rows.push(...parseRows(list.html));
      }
      // 詳細を取る対象を絞る（状態が落札でない＝不調・中止 / 開札日なし / 既知行）
      const todo = [];
      for (const row of rows) {
        if (!row.name || !row.open_date) { notWon++; continue; }
        if (!/落札/.test(row.state)) { notWon++; continue; }
        if (isMockCase(row.name)) { dropped++; continue; }
        if (seen.get(slug, dan.name, row.name, row.open_date)) { skipped++; continue; }
        todo.push(row);
      }
      let n = 0; let got = 0;
      for (const row of todo) {
        if (budgetLeft() < 2 || got >= PERCAP) break;
        const det = await get(`/DENCHO/GP9505_5515.action?kanriNo=${encodeURIComponent(row.kanri)}`);
        details++; got++;
        const d = parseDetail(det.html);
        if (!d.winner || !/落札/.test(d.result)) { dropped++; continue; }
        const name = d.name || row.name;
        if (isMockCase(name)) { dropped++; continue; }
        n += ins.run(slug, dan.name, d.dept || row.dept, INST.pref, name, d.open_date || row.open_date,
          d.category || row.category, d.method || row.method, d.winner, '', d.amount,
          classify(name), Number(nendo), nowIso, d.planned_price, d.floor_price, d.bidders).changes;
      }
      grand += n;
      console.log(`  ${dan.name} 業種${g} ${nendo}: 全${total}件 / 詳細対象${todo.length} → 新規${n}件（残${budgetLeft()}）`);
    }
  }
}
const c = db.prepare('SELECT COUNT(*) c, COUNT(DISTINCT org) o FROM local_awards WHERE src = ?').get(slug);
console.log(`合計[${slug}]: 新規${grand}件 / 累計${c.c}件・${c.o}団体 / 詳細${details}回 / 既知で省略${skipped} / 落札以外で省略${notWon} / 除外${dropped} / リクエスト${reqCount}回`);
