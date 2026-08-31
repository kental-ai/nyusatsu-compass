// PPI_P系（NEC製 e-GOV PPI「調達情報公開システム」）の一般公開機能から入札結果を取得する。
// 第1弾: 広島市 調達情報公開システム（ppi.keiyaku.city.hiroshima.lg.jp/PPI_P/）。
//
// 使い方: node pipeline/fetch_ppi_p.mjs <slug> [年度CSV|all] [--max=N] [--recon] [--discover]
//   バックフィル: node pipeline/fetch_ppi_p.mjs hiroshima all
//   日次増分:     node pipeline/fetch_ppi_p.mjs hiroshima
//   偵察:         node pipeline/fetch_ppi_p.mjs <slug> --discover   （発注機関・調達区分の選択肢を出すだけ）
//
// この系統の性質（SuperCALS・DENTYO系との違い）:
//   - **一覧に落札業者名と落札金額が載る**（詳細ページ不要）。DENTYO系のような1件1リクエストが要らず、
//     1検索=1リクエストで全件返る。表示件数の指定はあるが結果には効かず、全件が1ページに出る
//   - 「ダイレクト検索・結果情報」の入口 PiCtBrFi02start.vm → POST PiCtBrFi02Start.do で
//     検索条件画面が返り、URLパスに jsessionid が埋まる。以降はこれを引き回す
//   - 調達区分（pPI_SPLYNM）の値は先頭1桁が遷移先画面を表す:
//     0=工事系(PiCtBrFi02GetList.do) / 1=物品系(PiAtBrFi01GetList.do) / 2=その他(PiOtBrFi01GetList.do)
//     どの画面も一覧の列構成は同じ9列（No./契約担当課/開札日/案件名/場所/落札業者名/落札金額/添付/詳細）
//   - 検索は開札日の範囲（pPI_BIDDATE_S / _E・YYYY/MM/DD）。年度の概念は無い
//   - 落札業者名が空で金額欄が「不調」の行がある（＝不落・不調）。取り込まない
//   - こちらから日本語を送る項目は使わないので Shift_JIS エンコーダは不要
import { openDb } from './db.mjs';
import { classify } from './taxonomy.mjs';

export const INSTANCES = {
  hiroshima: {
    origin: 'https://ppi.keiyaku.city.hiroshima.lg.jp',
    pref: '広島県',
    // 発注機関プルダウン（pPI_ORGNAME）の値→ local_awards.org に入れる団体名。
    // 実測では水道局・病院事業局は結果情報を公開していない（全期間0件）が、将来出た場合に備えて残す
    orgMap: { PPIORG001: '広島市', PPIORG002: '広島市水道局', PPIORG003: '広島市病院事業局' },
  },
  // 香川（かがわ電子入札システム）は同じ PPI_P。運用時間が 8:00〜22:00 JST で、
  // それ以外は県の案内ページへ302される。orgMap 未定のため既定では --discover のみ動く
  kagawa: { origin: 'https://dennyu.pref.kagawa.lg.jp', pref: '香川県' },
};

// 調達区分の先頭1桁 → 一覧画面（アクションURLとパラメータグループID）
const SCREENS = {
  0: { action: 'PiCtBrFi02GetList.do', group: 'jp.co.nec.ome.egov.ppi.pi.ct.br.fi.PiCtBrFi02E01.FindList' },
  1: { action: 'PiAtBrFi01GetList.do', group: 'jp.co.nec.ome.egov.ppi.pi.at.br.fi.PiAtBrFi01E01.FindList' },
  2: { action: 'PiOtBrFi01GetList.do', group: 'jp.co.nec.ome.egov.ppi.pi.ot.br.fi.PiOtBrFi01E01.FindList' },
};
const START_GROUP = 'jp.co.nec.ome.egov.ppi.pi.ct.br.fi.PiCtBrFi02E01.Start';

const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter((a) => a.startsWith('--'))
  .map((a) => { const [k, v] = a.slice(2).split('='); return [k, v ?? '1']; }));
const pos = args.filter((a) => !a.startsWith('--'));
const slug = pos[0] || 'hiroshima';
const INST = INSTANCES[slug];
if (!INST) { console.error(`未知のインスタンス: ${slug}（候補: ${Object.keys(INSTANCES).join(', ')}）`); process.exit(1); }
const ORIGIN = INST.origin;
// アプリの設置パス。単独ホストは '' だが、共有ホスト（efftis系）は団体コードを挟む
// 例: kyoto.efftis.jp/26000/CALS/PPI_P/…
const BASE = INST.base || '';
const now0 = new Date();
const CUR_FY = now0.getMonth() >= 3 ? now0.getFullYear() : now0.getFullYear() - 1;
const YEARS = (pos[1] === 'all')
  ? Array.from({ length: CUR_FY - 2004 }, (_, i) => 2005 + i)   // 保持期間は未知なので初回は全部見る
  : (pos[1] || String(CUR_FY)).split(',').map(Number);
const MAXREQ = Number(flags.max || 2000);

const DELAY = 500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = 'nyusatsu-compass-bot/1.0 (+https://nyusatsu-compass.com/about/)';
const sjis = new TextDecoder('shift_jis');
let cookies = {};
let reqCount = 0;
const cookieHeader = () => Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');

async function raw(path, opt, tries = 3) {
  reqCount++;
  let res;
  try {
    res = await fetch(ORIGIN + path, {
      ...opt,
      headers: {
        'User-Agent': UA, 'Accept-Language': 'ja',
        ...(Object.keys(cookies).length ? { Cookie: cookieHeader() } : {}), ...(opt.headers || {}),
      },
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
  const html = sjis.decode(Buffer.from(await res.arrayBuffer()));
  await sleep(DELAY);
  return { status: res.status, location: res.headers.get('location'), html };
}
const get = (path) => raw(path, { method: 'GET' });
const post = (path, body) => raw(path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: Object.entries(body).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&'),
});

const ENT = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"' };
const strip = (h) => h.replace(/<[^>]+>/g, ' ')
  .replace(/&(nbsp|amp|lt|gt|quot);?/g, (_, k) => ENT[k])
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  .replace(/　/g, ' ').replace(/\s+/g, ' ').trim();
const Z2H = (s) => s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
const p2 = (x) => String(x).padStart(2, '0');
// この系統の開札日は「R8.08.25」形式（元号1文字+年.月.日）
const waDate = (s0) => {
  const s = Z2H(s0 || '').replace(/\s+/g, '');
  const m = s.match(/^([RHrh令平])(?:和|成)?(\d{1,2})[.\-/年](\d{1,2})[.\-/月](\d{1,2})/);
  if (!m) return '';
  const base = /[Hh平]/.test(m[1]) ? 1988 : 2018;
  return `${base + Number(m[2])}-${p2(m[3])}-${p2(m[4])}`;
};
const fyOf = (iso) => { const [y, m] = iso.split('-').map(Number); return m >= 4 ? y : y - 1; };

// 選択肢（発注機関・調達区分）を検索条件画面から読む
const options = (html, name) => {
  const sel = html.match(new RegExp(`<select[^>]*name="${name}"[^>]*>([\\s\\S]*?)</select>`, 'i'));
  if (!sel) return [];
  return [...sel[1].matchAll(/<option[^>]*value="([^"]*)"[^>]*>([^<]*)/g)]
    .map((m) => ({ value: m[1], label: strip(m[2]) })).filter((o) => o.value);
};

// 一覧テーブル: ヘッダ行の見出しから列位置を引く（画面ごとに案件名・場所の見出し語が違うだけ）
const NAME_LABELS = ['工事名', '件名', '業務名', '案件名', '委託名'];
function parseRows(html) {
  const trs = html.match(/<tr>[\s\S]*?<\/tr>/gi) || [];
  let cols = null;
  const rows = [];
  for (const tr of trs) {
    const ths = [...tr.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map((m) => strip(m[1]));
    if (ths.length > 5 && ths.includes('落札業者名')) { cols = ths; continue; }
    if (!cols) continue;
    const tds = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => strip(m[1]));
    if (tds.length !== cols.length) continue;
    const at = (label) => { const i = cols.indexOf(label); return i < 0 ? '' : (tds[i] ?? ''); };
    const amountAt = cols.findIndex((c) => c.startsWith('落札金額'));
    rows.push({
      dept: at('契約担当課'),
      open_date: waDate(at('開札日')),
      name: NAME_LABELS.map((l) => at(l)).find((v) => v) || '',
      winner: at('落札業者名'),
      amount: amountAt < 0 ? '' : (tds[amountAt] ?? ''),
    });
  }
  return rows;
}

// ---- main ----
// 入口を踏んで検索条件画面を出す（jsessionid はURLパスに埋まる）
await get(`${BASE}/PPI_P/pages/PPI_P/PiCtBrFi02/PiCtBrFi02start.vm`);
const start = await post(`${BASE}/PPI_P/PiCtBrFi02Start.do`, { omeProcessName: 'start', omeParameterGroupID: START_GROUP });
const jsid = (start.html.match(/jsessionid=([^"']+)"/) || [])[1];
if (!jsid || !/結果ダイレクト検索/.test(start.html)) {
  console.log(`検索条件画面が取得できなかった（運用時間外・仕様変更の可能性。status=${start.status} ${start.location || ''}）。0件で終了`);
  process.exit(0);
}
const orgOpts = options(start.html, 'pPI_ORGNAME');
const splyOpts = options(start.html, 'pPI_SPLYNM');
if (flags.discover || !INST.orgMap) {
  console.log(`[${slug}] 発注機関: ${orgOpts.map((o) => `${o.value}=${o.label}`).join(' / ')}`);
  console.log(`[${slug}] 調達区分: ${splyOpts.map((o) => `${o.value}=${o.label}`).join(' / ')}`);
  if (!INST.orgMap) console.log('※ orgMap が未定義のため取り込みは行わない（団体名を確定してから INSTANCES に追加すること）');
  process.exit(0);
}

const db = openDb();
const ins = db.prepare(`INSERT OR IGNORE INTO local_awards
  (src, org, dept, pref, name, open_date, category, method, winner_name, corporate_no, amount, slug, fiscal_year, first_seen)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const nowIso = new Date().toISOString();

console.log(`[${slug}] 年度: ${YEARS[0]}〜${YEARS[YEARS.length - 1]} / 機関${orgOpts.length} / 区分${splyOpts.length} / リクエスト上限${MAXREQ}`);
let grand = 0; let seenRows = 0; let dropped = 0;
outer:
for (const o of orgOpts) {
  const org = INST.orgMap[o.value];
  if (!org) { console.log(`  機関 ${o.value}(${o.label}) は orgMap に無いので飛ばす`); continue; }
  for (const sp of splyOpts) {
    const scr = SCREENS[Number(sp.value[0])];
    if (!scr) { console.error(`  未知の画面区分: ${sp.value}`); continue; }
    for (const fy of YEARS) {
      if (reqCount >= MAXREQ) { console.log('リクエスト上限に到達'); break outer; }
      const body = {
        omeProcessName: 'findList', omeParameterGroupID: scr.group,
        pPI_ORGNAME: o.value, pPI_SPLYNM: sp.value, pPI_BUKYOKU: '',
        pPI_TITLE: '', pPI_PLACE: '', pPI_BIDNO: '',
        pPI_BIDDATE_S: `${fy}/04/01`, pPI_BIDDATE_E: `${fy + 1}/03/31`,
        rowCount: '100', ppi_backflag: 'direct',
        omeStartPosition: '0', omeEndPosition: '0', omeRecordCount: '0',
      };
      const r = await post(`${BASE}/PPI_P/${scr.action};jsessionid=${jsid}`, body);
      const total = Number((r.html.match(/\/全([\d,]+)件/) || [])[1]?.replaceAll(',', '') ?? 0);
      if (!total) continue;
      const rows = parseRows(r.html);
      seenRows += rows.length;
      if (flags.recon) { console.log(`  ${org} ${sp.label} ${fy}年度: 全${total}件 / 一覧${rows.length}行`); continue; }
      let n = 0;
      for (const row of rows) {
        const amount = Number(Z2H(row.amount).replace(/[^\d]/g, ''));
        // 落札業者名が空 or 金額が数値でない行は不調・不落
        if (!row.name || !row.open_date || !row.winner || !amount) { dropped++; continue; }
        n += ins.run(slug, org, row.dept, INST.pref, row.name, row.open_date,
          sp.label, '', row.winner, '', amount, classify(row.name), fyOf(row.open_date), nowIso).changes;
      }
      grand += n;
      console.log(`  ${org} ${sp.label} ${fy}年度: 全${total}件 / 一覧${rows.length}行 → 新規${n}件`);
    }
  }
}
const c = db.prepare('SELECT COUNT(*) c FROM local_awards WHERE src = ?').get(slug);
console.log(`合計[${slug}]: 新規${grand}件 / 累計${c.c}件 / 一覧${seenRows}行 / 不調等で除外${dropped} / リクエスト${reqCount}回`);
