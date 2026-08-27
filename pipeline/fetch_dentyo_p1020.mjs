// DENTYO旧型（東芝ソリューション製PPI）の P1020 画面系から入札結果を取得する。
// 第1弾: 福岡県 電子調達システム 入札情報サービス（www.choutatsu-ppi.pref.fukuoka.lg.jp）。
//
// 使い方: node pipeline/fetch_dentyo_p1020.mjs <slug> [年度CSV] [--screen=10,15] [--max=N] [--percap=N] [--days=N] [--recon] [--dump=N]
//   バックフィル: node pipeline/fetch_dentyo_p1020.mjs fukuoka 2026 --max=4000
//   日次増分:     node pipeline/fetch_dentyo_p1020.mjs fukuoka --days=30 --max=600
//   （--days は年度ではなく「直近N日の入札日」で検索する。年度全体だと一覧のページ送りだけで
//     700リクエスト級になり、新規行が数十件でも毎日それを払うことになるため）
//
// 大分（fetch_dentyo_ppi.mjs）と同じ東芝PPIだが、福岡は別カスタマイズで画面系が違う:
//   - 団体選択が無い（＝福岡県のみ。県内市町村は別システム）。GPPI_MENU は404
//   - 入口は GET /DENTYO/P1005_05（フレーム）→ 検索条件は P1020_10（工事）/ P1020_15（委託）
//   - 年度指定ではなく入札日の範囲検索。年の選択肢は3年分しかない（＝保持期間3年）
//   - 結果表区分はラジオ kekkaKbn だがサーバに効くのは hidden の ddl_kekkaKbn。
//     ddl_kekkaKbn=1 で「入札結果表」になり、日付欄の意味が指名通知日→入札日に変わる
//   - 件数が多いと「最大表示件数を越えました…」の確認応答になる。hdn_action=btn_reference_done で続行
//   - 表示行数の指定が無く1ページ10行固定。一覧に落札者・金額は無く、詳細は
//     GET /DENTYO/Com_P9505_1055Servlet?…&ID=TK3&key1=<管理番号> で1件1リクエスト
import { openDb } from './db.mjs';
import { classify } from './taxonomy.mjs';

export const INSTANCES = {
  fukuoka: { origin: 'https://www.choutatsu-ppi.pref.fukuoka.lg.jp', pref: '福岡県', org: '福岡県' },
};

// 工事と委託で画面IDだけが違う（項目名は同一）
const SCREENS = {
  10: { path: 'P1020_10', displayId: 'GP1020_1010', label: '工事' },
  15: { path: 'P1020_15', displayId: 'GP1020_1510', label: '委託' },
};

const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter((a) => a.startsWith('--'))
  .map((a) => { const [k, v] = a.slice(2).split('='); return [k, v ?? '1']; }));
const pos = args.filter((a) => !a.startsWith('--'));
const slug = pos[0] || 'fukuoka';
const INST = INSTANCES[slug];
if (!INST) { console.error(`未知のインスタンス: ${slug}（候補: ${Object.keys(INSTANCES).join(', ')}）`); process.exit(1); }
const ORIGIN = INST.origin;
const now0 = new Date();
const YEARS = (pos[1] || String(now0.getMonth() >= 3 ? now0.getFullYear() : now0.getFullYear() - 1)).split(',');
const SCRS = (flags.screen || '10,15').split(',');
const MAXREQ = Number(flags.max || 3000);
const PERCAP = Number(flags.percap || Infinity); // 1画面1期間あたりの詳細取得上限
const DAYS = Number(flags.days || 0);
const DUMP = Number(flags.dump || 0);

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
  const html = sjis.decode(Buffer.from(await res.arrayBuffer()));
  await sleep(DELAY);
  return { status: res.status, html };
}
const get = (path) => raw(path, { method: 'GET' });
// 送信する日本語項目は無い（案件名検索は使わない）のでShift_JISエンコーダは不要
const post = (path, body) => raw(path, {
  method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: Object.entries(body).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&'),
});

const ENT = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', times: '×' };
const strip = (h) => h.replace(/<[^>]+>/g, ' ')
  .replace(/&(nbsp|amp|lt|gt|quot|times);?/g, (_, k) => ENT[k])
  .replace(/&#(\d+);/g, (_, n) => (Number(n) === 65293 ? '-' : String.fromCharCode(Number(n))))
  .replace(/　/g, ' ').replace(/\s+/g, ' ').trim();
const Z2H = (s) => s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
const p2 = (x) => String(x).padStart(2, '0');
const waDate = (s0) => {
  const s = Z2H(s0 || '').replace(/\s+/g, '');
  const m = s.match(/(令和|平成)(\d{1,2})年(\d{1,2})月(\d{1,2})日/);
  return m ? `${(m[1] === '平成' ? 1988 : 2018) + Number(m[2])}-${p2(m[3])}-${p2(m[4])}` : '';
};
const yen = (s) => Number(Z2H(s || '').replace(/（[\s\S]*$/, '').replace(/[^\d]/g, '') || 0);
const fyOf = (iso) => { const [y, m] = iso.split('-').map(Number); return m >= 4 ? y : y - 1; };
const ymd = (d) => [d.getFullYear(), d.getMonth() + 1, d.getDate()];
// 検索する入札日の範囲。既定は年度（4/1〜翌3/31）、--days=N なら直近N日
const RANGES = DAYS
  ? [{ label: `直近${DAYS}日`, a: ymd(new Date(Date.now() - DAYS * 86400000)), b: ymd(new Date()) }]
  : YEARS.map((fy) => { const y = Number(fy); return { label: `${fy}年度`, a: [y, 4, 1], b: [y + 1, 3, 31] }; });
const hiddens = (html) => Object.fromEntries(
  [...html.matchAll(/<INPUT type="hidden" name="([^"]+)" value="([^"]*)"/gi)].map((m) => [m[1], m[2]]));

const searchForm = (scr, y0, m0, d0, y1, m1, d1) => ({
  hdn_statusMessage: '', hdn_modifyFlag: '', hdn_displayId: scr.displayId, hdn_action: 'btn_reference', hdn_confirm: 'false',
  ddl_kekkaKbn: '1',            // 1=入札結果表（既定の3=指名結果表では落札者が出ない）
  ddl_denshiNyusatsuDiv: '',
  ddl_nyusatsuYearStart: String(y0), txt_nyusatsuMonthStart: String(m0), txt_nyusatsuDayStart: String(d0),
  ddl_nyusatsuYearEnd: String(y1), txt_nyusatsuMonthEnd: String(m1), txt_nyusatsuDayEnd: String(d1),
  ddl_hacchuBuCd: '', ddl_hacchuJimuCd: '', ddl_keiyakuBuCd: '', ddl_keiyakuJimuCd: '',
  ddl_koshuGyomuCd: '', ddl_nyusatsuType: '', txt_ankenNm: '',
});

// 一覧: ヘッダ行の見出しから列位置を引く（データ行は No. が TH、残りが TD）
function parseRows(html) {
  const trs = html.match(/<TR>[\s\S]*?<\/TR>/gi) || [];
  let cols = null;
  const rows = [];
  for (const tr of trs) {
    const ths = [...tr.matchAll(/<TH[^>]*>([\s\S]*?)<\/TH>/gi)].map((m) => strip(m[1]));
    if (!cols && ths.length > 5 && ths.includes('入札日')) { cols = ths; continue; }
    const kanri = (tr.match(/name="hdn_kanriNo\d+" value="(\d+)"/) || [])[1];
    if (!kanri || !cols) continue;
    const cells = [...ths.slice(0, 1), ...[...tr.matchAll(/<TD[^>]*>([\s\S]*?)<\/TD>/gi)].map((m) => strip(m[1]))];
    const at = (label, nth = 0) => {
      let hit = -1;
      for (let i = 0; i < cols.length; i++) if (cols[i] === label && ++hit === nth) return cells[i] ?? '';
      return '';
    };
    const nameCol = ['工事名', '委託名', '業務名', '案件名'].map((l) => at(l)).find((v) => v) || '';
    rows.push({
      kanri,
      dept: [at('発注部'), at('事務所名', 0)].filter(Boolean).join(' '),
      category: at('工事の種類') || at('委託の種類') || at('業務の種類') || '',
      method: at('入札契約方式'),
      open_date: waDate(at('入札日')),
      name: nameCol,
    });
  }
  return rows;
}

// 詳細（「Ｎ． 見出し」行のあとに値行が続く縦並び）→ 見出し→値配列
function parseDetail(html) {
  const kv = {};
  let cur = null;
  for (const chunk of html.split(/<tr[^>]*>/i)) {
    const t = strip(chunk);
    if (!t) continue;
    const m = t.match(/^[０-９\d]+\s*[．.]\s*(.+)$/);
    if (m) { cur = m[1].trim(); if (!(cur in kv)) kv[cur] = []; continue; }
    if (cur) kv[cur].push(t);
  }
  const first = (...labels) => {
    for (const l of labels) if (kv[l]?.length) return kv[l][0];
    return '';
  };
  return {
    labels: Object.keys(kv),
    winner: first('落札者名', '落札者', '契約の相手方', '契約の相手方の名称', '落札者の名称', '見積者名'),
    amount: yen(first('落札金額', '契約金額', '落札価格', '見積金額')),
    open_date: waDate(first('入札年月日', '開札年月日', '入札日', '契約年月日')),
    name: first('工事の名称', '委託の名称', '業務の名称', '委託業務名', '件名', '調達案件名'),
  };
}

// ---- main ----
const db = openDb();
const seen = db.prepare('SELECT 1 FROM local_awards WHERE src=? AND org=? AND name=? AND open_date=?');
const ins = db.prepare(`INSERT OR IGNORE INTO local_awards
  (src, org, dept, pref, name, open_date, category, method, winner_name, corporate_no, amount, slug, fiscal_year, first_seen)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const nowIso = new Date().toISOString();

// フレーム入口を踏んでセッションを張る。取れない場合は日次ジョブを落とさず0件で正常終了する
const top = await get('/DENTYO/P1005_05');
if (!/FRAMESET/i.test(top.html)) { console.log('入口画面が取得できなかった（運用時間外・仕様変更の可能性）。0件で終了'); process.exit(0); }

console.log(`[${slug}] ${RANGES.map((r) => r.label).join('/')} / 画面${SCRS.join(',')} / リクエスト上限${MAXREQ}`);
let grand = 0; let details = 0; let skipped = 0; let dropped = 0; let noDate = 0;
const labelSeen = new Map();

outer:
for (const s of SCRS) {
  const scr = SCREENS[s];
  if (!scr) { console.error(`未知の画面: ${s}`); continue; }
  for (const range of RANGES) {
    if (budgetLeft() < 10) { console.log('リクエスト上限に到達'); break outer; }
    await get(`/DENTYO/${scr.path}`);           // 検索条件画面（セッションに画面を乗せる）
    const form = searchForm(scr, ...range.a, ...range.b);
    let r = await post(`/DENTYO/${scr.path}`, form);
    // 「最大表示件数を越えました。…しますか？」の確認応答（条件画面が返ってきたら続行を送る）
    if (/hdn_confirm" value="true"/i.test(r.html)) {
      r = await post(`/DENTYO/${scr.path}`, { ...form, hdn_action: 'btn_reference_done', hdn_confirm: 'true' });
    }
    const total = Number((r.html.match(/([\d,]+)件が該当しました/) || [])[1]?.replaceAll(',', '') ?? 0);
    if (!total) { console.log(`  ${scr.label} ${range.label}: 0件`); continue; }
    if (flags.recon) { console.log(`  ${scr.label} ${range.label}: ${total}件（${Math.ceil(total / 10)}ページ）`); continue; }
    // 一覧を全ページ集めてから詳細に入る（詳細はサーブレット直叩きなので一覧のセッション状態を壊さない）
    const hid = hiddens(r.html);
    const pages = Math.ceil(total / 10);
    const rows = parseRows(r.html);
    for (let p = 2; p <= pages && budgetLeft() > 6; p++) {
      const pr = await post(`/DENTYO/${scr.path}`, { ...hid, hdn_action: 'btn_movePage', hdn_destinationPageNum: String(p) });
      rows.push(...parseRows(pr.html));
    }
    const todo = [];
    for (const row of rows) {
      if (!row.open_date) { noDate++; continue; }
      if (!row.name) continue;
      if (seen.get(slug, INST.org, row.name, row.open_date)) { skipped++; continue; }
      todo.push(row);
    }
    let n = 0; let got = 0;
    for (const row of todo) {
      if (budgetLeft() < 3 || got >= PERCAP) break;
      const det = await get(`/DENTYO/Com_P9505_1055Servlet?&GamenInfNm=DisplayFile&ID=TK3&key1=${row.kanri}&key2=0&key3=0`);
      details++; got++;
      const d = parseDetail(det.html);
      if (DUMP && labelSeen.size < DUMP) labelSeen.set(row.kanri, `${scr.label}/${row.method}: ${d.labels.join(' | ')}`);
      if (!d.winner || d.winner === '-' || d.winner === '－') { dropped++; continue; }
      // 保存する案件名・入札日は一覧側を正とする（既知判定 seen() と同じ値でないと
      // 毎回「未取得」と見なして詳細を取り直してしまうため）。空のときだけ詳細で補う
      const name = row.name || d.name;
      const openDate = row.open_date || d.open_date;
      n += ins.run(slug, INST.org, row.dept, INST.pref, name, openDate,
        row.category, row.method, d.winner, '', d.amount, classify(name), fyOf(openDate), nowIso).changes;
    }
    grand += n;
    console.log(`  ${scr.label} ${range.label}: 全${total}件 / 一覧${rows.length}行 / 詳細対象${todo.length} → 新規${n}件（残リクエスト${budgetLeft()}）`);
  }
}
for (const [k, v] of labelSeen) console.log(`  [dump] ${k} ${v}`);
const c = db.prepare('SELECT COUNT(*) c FROM local_awards WHERE src = ?').get(slug);
console.log(`合計[${slug}]: 新規${grand}件 / 累計${c.c}件 / 詳細${details}回 / 既知で省略${skipped} / 入札日なしで省略${noDate} / 落札者なしで除外${dropped} / リクエスト${reqCount}回`);
