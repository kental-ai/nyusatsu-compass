// 入札コンパス 静的サイト生成（外部依存ゼロ）
// 使い方: node site/build.mjs  → site/dist に出力
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync, rmSync, cpSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { TAXONOMY } from '../pipeline/taxonomy.mjs';
import { MINISTRIES, BIDDING_METHODS } from '../pipeline/codes.mjs';
import { GUIDES } from './guides.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'site', 'dist');
const ORIGIN = process.env.SITE_ORIGIN || 'https://nyusatsu-compass.com';
const SITE = '入札コンパス';
const MIN_COMPANY_AWARDS = 2;   // 品質フィルタ: 落札2件未満の企業ページは作らない
const MIN_PRICE_AWARDS = 50;    // 品質フィルタ: 事例50件未満の相場ページは作らない
const RECENT_LIMIT = 30;

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const yen = (n) => {
  if (n == null) return '—';
  if (n >= 1e8) return (n / 1e8).toFixed(n >= 1e10 ? 0 : 1) + '億円';
  if (n >= 1e4) return Math.round(n / 1e4).toLocaleString() + '万円';
  return n.toLocaleString() + '円';
};
const median = (arr) => { const a = [...arr].sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : null; };

// ---------- 3層ゲート ----------
// gM(): 無料会員（メール登録）で開く値。HTMLには伏字を出し、実値はbase64で持たせてcookie(nc_member)があればJSで復元。
// gP(): 有料（ウォッチ会員）限定。実値は出さず、桁だけ見せる伏字（teaseYen）で「答えの存在」を示す。
const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
const gM = (html, plain) => `<span class="g g-m" data-v="${b64(html)}" title="無料会員登録して続きを見る">${plain ?? '●●●'}</span>`;
const ymLabel = (d) => { const m = /^(\d{4})-(\d{2})/.exec(d || ''); return m ? `${m[1]}年${Number(m[2])}月` : '最新'; };
const teaseYen = (n) => { // 591万円→5●●万円 / 1,234万円→1,●●●万円 / 2.3億円→2.●億円
  if (!(n > 0)) return '●●●万円';
  if (n >= 1e8) { const v = (n / 1e8).toFixed(1); return `${v[0]}${v.length > 3 ? '●' : ''}.●億円`; }
  const man = String(Math.round(n / 1e4));
  const head = man[0], rest = man.length - 1;
  const body = rest > 0 ? (rest >= 4 ? `${head}●,●●●` : `${head}${'●'.repeat(rest)}`) : head;
  return `${body}万円`;
};
const gP = (tease) => `<span class="g g-p" title="ウォッチ会員限定">${tease} <span class="lk">🔒</span></span>`;
const CTA_LABEL = '無料会員登録して続きを見る';
// 全サイト唯一の出口。文脈（戻り先・ウォッチ対象）はパラメータで持たせるだけで、ボタンと行き先は常に同じ
const cta = (path, extra = '') => `<a class="btn" href="/alert/?back=${encodeURIComponent(path || '/')}${extra}">${CTA_LABEL}</a>`;
const unlockBtn = (path) => cta(path);
// 勝てる札の推定レンジ（参考値）: 前回額を中心に前回比トレンドを半分織り込み、-8%〜+4%
const estimateRange = (arr) => {
  const s = arr.filter((a) => a.amount > 0);
  if (s.length < 2) return null;
  const last = s[0].amount, prev = s[1].amount;
  const trend = prev > 0 ? (last / prev - 1) : 0;
  const center = last * (1 + Math.max(-0.15, Math.min(0.15, trend)) / 2);
  return { lo: center * 0.92, hi: center * 1.04, trend };
};

// ---------- データ読み込み ----------
const db = new DatabaseSync(join(ROOT, 'data', 'compass.db'));
const AWARDS = db.prepare(`
  SELECT a.rowid, a.case_no, a.name, a.award_date, a.amount, a.ministry_code, a.method_code,
         a.winner_name, a.corporate_no, c.slug
  FROM awards a LEFT JOIN enrich_class c ON a.rowid = c.award_rowid
  ORDER BY a.award_date DESC`).all();
const COMPANIES = db.prepare(`SELECT corporate_no, name FROM companies`).all();
// 表示品質: 公式データの社名は全角英数（例: Ｎｏａｈｌｏｇｙ株式会社 / 株式会社ＵＳＥＮ　ＦＩＥＬＤＩＮＧ）が多く読みにくい。
// NFKCで英数字・記号・スペースを半角へ正規化して表示する（DBのキーや原データは変更しない。カナ・漢字は不変）
const normDisp = (s) => (s ? String(s).normalize('NFKC').replace(/\s+/g, ' ').trim() : s);
for (const c of COMPANIES) c.name = normDisp(c.name);
for (const a of AWARDS) a.winner_name = normDisp(a.winner_name);
let LOCALS = [];
try { LOCALS = db.prepare(`SELECT org, dept, pref, name, open_date, category, method, winner_name, corporate_no, amount, slug, fiscal_year FROM local_awards ORDER BY open_date DESC`).all(); } catch {}
for (const a of LOCALS) a.winner_name = normDisp(a.winner_name);
const byCorpLocal = new Map();
for (const a of LOCALS) if (a.corporate_no) (byCorpLocal.get(a.corporate_no) ?? byCorpLocal.set(a.corporate_no, []).get(a.corporate_no)).push(a);
const PREF_SLUGS = {
  '北海道': 'hokkaido', '青森県': 'aomori', '岩手県': 'iwate', '宮城県': 'miyagi', '秋田県': 'akita',
  '山形県': 'yamagata', '福島県': 'fukushima', '茨城県': 'ibaraki', '栃木県': 'tochigi', '群馬県': 'gunma',
  '埼玉県': 'saitama', '千葉県': 'chiba', '東京都': 'tokyo', '神奈川県': 'kanagawa', '新潟県': 'niigata',
  '富山県': 'toyama', '石川県': 'ishikawa', '福井県': 'fukui', '山梨県': 'yamanashi', '長野県': 'nagano',
  '岐阜県': 'gifu', '静岡県': 'shizuoka', '愛知県': 'aichi', '三重県': 'mie', '滋賀県': 'shiga',
  '京都府': 'kyoto', '大阪府': 'osaka', '兵庫県': 'hyogo', '奈良県': 'nara', '和歌山県': 'wakayama',
  '鳥取県': 'tottori', '島根県': 'shimane', '岡山県': 'okayama', '広島県': 'hiroshima', '山口県': 'yamaguchi',
  '徳島県': 'tokushima', '香川県': 'kagawa', '愛媛県': 'ehime', '高知県': 'kochi', '福岡県': 'fukuoka',
  '佐賀県': 'saga', '長崎県': 'nagasaki', '熊本県': 'kumamoto', '大分県': 'oita', '宮崎県': 'miyazaki',
  '鹿児島県': 'kagoshima', '沖縄県': 'okinawa',
};
// 地域×業務の相場（自治体データ）: pref|slug → awards[]
const localByPrefCat = new Map();
for (const a of LOCALS) { if (!a.slug || a.slug === 'other') continue; const k = a.pref + '|' + a.slug; (localByPrefCat.get(k) ?? localByPrefCat.set(k, []).get(k)).push(a); }

let NOTICES = [];
try {
  NOTICES = db.prepare(`SELECT key, name, org, pref, city, issue_date, deadline, category, url, slug FROM notices`).all();
} catch { /* notices未取得のローカル環境でもビルド可能にする */ }
const TODAY = new Date().toISOString().slice(0, 10);
const OPEN_NOTICES = NOTICES.filter((x) =>
  (x.deadline && x.deadline >= TODAY) ||
  (x.issue_date && (new Date(TODAY) - new Date(x.issue_date)) / 86400000 <= 21));
// 公告（KKJ・全国47都道府県）を地域別に索引: 落札データが無い県も地域ページを作れる
const noticeByPref = new Map();
const noticeByCity = new Map(); // '県|市区町村' → notices[]
// ページの存在が日々ぶれないよう、判定は35日窓の全公告で行う（表示は新しい順）
for (const n of [...NOTICES].sort((a, b) => (a.issue_date < b.issue_date ? 1 : -1))) {
  if ((n.issue_date || '') < new Date(Date.now() - 35 * 86400000).toISOString().slice(0, 10)) continue; // 35日より古い分は「履歴」側で扱う
  if (n.pref) (noticeByPref.get(n.pref) ?? noticeByPref.set(n.pref, []).get(n.pref)).push(n);
  if (n.pref && n.city) {
    const k = n.pref + '|' + n.city;
    (noticeByCity.get(k) ?? noticeByCity.set(k, []).get(k)).push(n);
  }
}
// 公告アーカイブ（notices_archive: 35日窓で消える公告を蓄積したもの）を市区町村別に索引。
// 現在窓(NOTICES)とkeyで統合し、「履歴」= 現在窓に無い過去分とする。
let NARCH = [];
try {
  NARCH = db.prepare(`SELECT key, name, org, pref, city, issue_date, category, slug FROM notices_archive`).all();
} catch { /* アーカイブ未整備でもビルド可能 */ }
// 「直近」= 公告日が35日以内（noticesテーブルの窓幅に依らず日付で判定し、ローカルと本番で描画を揃える）。
// 「履歴」= それより古いもの（noticesの残りと、noticesに無いアーカイブ分をkeyで統合）。
const CUR_CUTOFF = new Date(Date.now() - 35 * 86400000).toISOString().slice(0, 10);
const allNoticeKeys = new Set(NOTICES.map((n) => n.key));
const histRows = [
  ...NOTICES.filter((n) => (n.issue_date || '') < CUR_CUTOFF),
  ...NARCH.filter((n) => !allNoticeKeys.has(n.key) && (n.issue_date || '') < CUR_CUTOFF),
].sort((a, b) => (a.issue_date < b.issue_date ? 1 : -1));
const histByCity = new Map(); // '県|市区町村' → 過去公告[]（新しい順）
const histByPref = new Map();
for (const n of histRows) {
  if (n.pref) (histByPref.get(n.pref) ?? histByPref.set(n.pref, []).get(n.pref)).push(n);
  if (n.pref && n.city) {
    const k = n.pref + '|' + n.city;
    (histByCity.get(k) ?? histByCity.set(k, []).get(k)).push(n);
  }
}
const PROP_RE = /プロポーザル|公募|企画競争|企画提案/; // 「公募・プロポーザル」ページの抽出語彙
const propPrefOk = new Set(); // /proposal/{pref}/ が生成される県（3件以上）。リンクはこの集合でガード
for (const [pn, arr] of noticeByPref) {
  const c = arr.filter((n) => PROP_RE.test(n.name)).length + (histByPref.get(pn) || []).filter((n) => PROP_RE.test(n.name)).length;
  if (c >= 3) propPrefOk.add(pn);
}
for (const [pn, arr] of histByPref) {
  if (propPrefOk.has(pn)) continue;
  const c = arr.filter((n) => PROP_RE.test(n.name)).length + (noticeByPref.get(pn) || []).filter((n) => PROP_RE.test(n.name)).length;
  if (c >= 3) propPrefOk.add(pn);
}
const BUILT_AT = new Date().toISOString().slice(0, 10);
const LABEL = Object.fromEntries(TAXONOMY.map((t) => [t.slug, t.label]));

// 集計インデックス
const byCompany = new Map(), byCat = new Map(), byMinistry = new Map();
for (const a of AWARDS) {
  if (a.corporate_no) (byCompany.get(a.corporate_no) ?? byCompany.set(a.corporate_no, []).get(a.corporate_no)).push(a);
  if (a.slug && a.slug !== 'other') (byCat.get(a.slug) ?? byCat.set(a.slug, []).get(a.slug)).push(a);
  (byMinistry.get(a.ministry_code) ?? byMinistry.set(a.ministry_code, []).get(a.ministry_code)).push(a);
}
const companyName = new Map(COMPANIES.map((c) => [c.corporate_no, c.name]));
// ページが生成されない対象（企業=落札2件未満・機関=50件未満）にはリンクしない。リンクは必ずこのヘルパー経由にして404を出さない
const companyHref = (no) => (no && byCompany.has(no) && (byCompany.get(no) || []).length >= MIN_COMPANY_AWARDS) ? `/company/${no}/` : null;
const companyLink = (no, label) => companyHref(no) ? `<a href="${companyHref(no)}">${label}</a>` : label;
const organHref = (code) => (code && MINISTRIES[code] && (byMinistry.get(code) || []).length >= MIN_PRICE_AWARDS) ? `/organ/${code.toLowerCase()}/` : null;
const organLink = (code, label) => organHref(code) ? `<a href="${organHref(code)}">${label}</a>` : label;

// 案件名クラスタ（同一契約の年次繰り返しを検出。企業ページの「契約ヒストリー」と次回予測の基盤）
const normName = (n) => n.replace(/令和\d+年度?|平成\d+年度?|Ｒ\d+|R\d+|[０-９0-9]+|（[^）]*）|\([^)]*\)|【[^】]*】|[　\s]/g, '');
const clusters = new Map(); // normKey|ministry → awards[]
for (const a of AWARDS) {
  const k = normName(a.name) + '|' + a.ministry_code;
  if (k.length < 8) continue; // 正規化で短くなりすぎた名前はノイズ
  (clusters.get(k) ?? clusters.set(k, []).get(k)).push(a);
}
// 機関×分野 → 企業ランキング（「同じ土俵の企業」相互リンク用）
const pairCompanies = new Map(); // ministry|slug → Map(corpNo→count)
for (const a of AWARDS) {
  if (!a.corporate_no || !a.slug || a.slug === 'other') continue;
  const k = a.ministry_code + '|' + a.slug;
  const m = pairCompanies.get(k) ?? pairCompanies.set(k, new Map()).get(k);
  m.set(a.corporate_no, (m.get(a.corporate_no) || 0) + 1);
}
const clusterKey = (a) => normName(a.name) + '|' + a.ministry_code;
// 継続契約ページ: 3年以上繰り返す契約クラスタに安定IDを振る（正規化名+機関のsha1先頭12桁）
const contractIdOf = (key) => createHash('sha1').update(key).digest('hex').slice(0, 12);
const CONTRACTS = new Map(); // id → { key, arr, years, latest, ministry, slug }
for (const [key, arr] of clusters) {
  const years = new Set(arr.map((a) => a.award_date.slice(0, 4)));
  if (years.size < 3) continue;
  const sorted = [...arr].sort((x, y) => (x.award_date < y.award_date ? 1 : -1));
  const last = sorted[0];
  if (!last.name || !last.ministry_code) continue;
  CONTRACTS.set(contractIdOf(key), { key, arr: sorted, years: years.size, latest: +last.award_date.slice(0, 4),
    ministry: last.ministry_code, slug: last.slug, name: last.name });
}
const contractIdByKey = new Map([...CONTRACTS].map(([id, c]) => [c.key, id]));
// 分野別の「入れ替わり率」: 年をまたいで繰り返された契約のうち落札者が変わった割合（参入者を動かす反証データ）
const TURNOVER = {}; // slug → { pairs, flips, firstTermShare }
{
  const firstTerm = {}; // slug → [契約数, 現職1回目の契約数]
  for (const [, arr] of clusters) {
    const s = [...arr].filter((a) => a.corporate_no).sort((x, y) => (x.award_date < y.award_date ? -1 : 1));
    if (new Set(s.map((a) => a.award_date.slice(0, 4))).size < 2) continue;
    for (let i = 1; i < s.length; i++) {
      if (s[i].award_date.slice(0, 4) === s[i - 1].award_date.slice(0, 4)) continue;
      const sl = s[i].slug || 'other';
      const o = TURNOVER[sl] ?? (TURNOVER[sl] = { pairs: 0, flips: 0 });
      o.pairs++; if (s[i].corporate_no !== s[i - 1].corporate_no) o.flips++;
    }
    if (s.length >= 3) {
      const sl = s[s.length - 1].slug || 'other';
      const f = firstTerm[sl] ?? (firstTerm[sl] = [0, 0]);
      f[0]++; if (s[s.length - 1].corporate_no !== s[s.length - 2].corporate_no) f[1]++;
    }
  }
  for (const sl of Object.keys(TURNOVER)) {
    const f = firstTerm[sl] || [0, 0];
    TURNOVER[sl].rate = TURNOVER[sl].pairs ? Math.round((TURNOVER[sl].flips / TURNOVER[sl].pairs) * 100) : null;
    TURNOVER[sl].firstTermShare = f[0] ? Math.round((f[1] / f[0]) * 100) : null;
  }
}
const allPairs = Object.values(TURNOVER).reduce((s, o) => s + o.pairs, 0);
const allFlips = Object.values(TURNOVER).reduce((s, o) => s + o.flips, 0);
const TURNOVER_ALL = allPairs ? Math.round((allFlips / allPairs) * 100) : 0;
const contractLink = (key, label) => { const id = contractIdByKey.get(key); return id ? `<a href="/contract/${id}/">${label}</a>` : label; };
const monthMode = (list) => {
  const m = {};
  for (const a of list) { const mm = Number(a.award_date?.slice(5, 7)); if (mm) m[mm] = (m[mm] || 0) + 1; }
  return Number(Object.keys(m).sort((x, y) => m[y] - m[x])[0] || 0);
};

// 満了レーダー: 3年以上続く年次契約で、直近に実績があり今年度まだ公告されていない=次回公告が近い契約
const RADAR_FY = Number(BUILT_AT.slice(5, 7)) >= 4 ? Number(BUILT_AT.slice(0, 4)) : Number(BUILT_AT.slice(0, 4)) - 1;
const noticeKeys = new Set(NOTICES.map((n) => normName(n.name)));
const radarBySlug = new Map();
for (const [, arr] of clusters) {
  const years = new Set(arr.map((a) => a.award_date.slice(0, 4)));
  if (years.size < 3) continue;
  const latest = Math.max(...arr.map((a) => +a.award_date.slice(0, 4)));
  if (latest < RADAR_FY - 1) continue;                              // 途切れた契約は除外
  if (arr.some((a) => +a.award_date.slice(0, 4) >= RADAR_FY)) continue; // 今年度落札済みは除外
  const last = [...arr].sort((x, y) => (x.award_date < y.award_date ? 1 : -1))[0];
  if (!last.slug || last.slug === 'other') continue;
  const m = monthMode(arr);
  const item = {
    name: last.name, ministry: last.ministry_code, month: m, pubMonth: ((m + 10 - 1) % 12) + 1,
    lastYear: latest, lastWinner: last.winner_name, lastCorp: last.corporate_no, amount: last.amount,
    years: years.size, open: noticeKeys.has(normName(last.name)),
  };
  (radarBySlug.get(last.slug) ?? radarBySlug.set(last.slug, []).get(last.slug)).push(item);
}

// ---------- レイアウト（航海図ポップ: ネイビー×クリーム×コーラル + Zen Maru Gothic） ----------
const CSS = `
:root{--navy:#16324F;--cream:#FDF6EC;--coral:#E8604C;--brass:#F4B942;--shallow:#EAF2F8;
--ink:#1D3149;--sub:#4A5A6E;--line:#E4DACA;--bg:#FBF5EA;--acc:#16324F}
*{box-sizing:border-box}
body{margin:0;font-family:'BIZ UDPGothic','Hiragino Sans','Yu Gothic UI',Meiryo,sans-serif;color:var(--ink);background:#FFFDF8;line-height:1.75}
h1,h2,h3,.mk{font-family:'Zen Maru Gothic','BIZ UDPGothic',sans-serif}
main{max-width:960px;margin:0 auto;padding:16px}
h1{font-size:1.55rem;line-height:1.45;color:var(--navy)}
h2{font-size:1.15rem;color:var(--navy);border-left:5px solid var(--coral);padding-left:10px;margin-top:2.2em;border-radius:0}
h3{font-size:1rem;color:var(--navy)}
table{border-collapse:collapse;width:100%;font-size:.92rem;background:#fff}
th,td{border:1px solid var(--line);padding:6px 10px;text-align:left}
th{background:var(--shallow);color:var(--navy)}td.num{text-align:right;white-space:nowrap}
.wrap{overflow-x:auto}a{color:#155A8A}
.crumb{font-size:.85rem;color:var(--sub);margin:8px 0}.crumb a{color:var(--sub)}
header{background:var(--navy)}
header .in{max-width:960px;margin:0 auto;padding:10px 16px;display:flex;justify-content:space-between;align-items:center;gap:10px}
header .logo{font-family:'Zen Maru Gothic',sans-serif;font-weight:700;font-size:1.15rem;color:var(--cream);text-decoration:none;display:flex;align-items:center;gap:9px}
header .hcta{background:var(--coral);color:#fff;text-decoration:none;font-weight:700;font-size:.85rem;padding:8px 16px;border-radius:999px;white-space:nowrap}
.cta{background:var(--cream);border:2px solid var(--navy);border-radius:16px;padding:18px;margin:28px 0;display:flex;gap:14px;align-items:flex-start}
.cta .ctxt{flex:1}
.cta a.btn{display:inline-block;background:var(--coral);color:#fff;padding:11px 26px;border-radius:999px;text-decoration:none;font-weight:700;font-family:'Zen Maru Gothic',sans-serif}
.meta{color:var(--sub);font-size:.85rem}
footer{background:var(--navy);color:#C9D6E4;margin-top:56px;padding:28px 16px;font-size:.82rem}
footer .in{max-width:960px;margin:0 auto}footer a{color:var(--cream)}
.stats{display:flex;gap:10px;flex-wrap:wrap;margin:16px 0}
.stat{background:#fff;border:2px solid var(--navy);border-radius:12px;padding:10px 16px;color:var(--navy)}
.stat b{display:block;font-size:1.35rem;font-family:'Zen Maru Gothic',sans-serif}
.kun-row{display:flex;gap:12px;align-items:flex-start;margin:18px 0}
.kun-row svg{flex-shrink:0}
.kun-bubble{background:var(--shallow);border-radius:2px 16px 16px 16px;padding:12px 16px;flex:1;color:var(--navy)}
.kun-bubble b{color:var(--coral)}
.chart{margin:16px 0;max-width:640px}.bars{display:flex;align-items:flex-end;gap:3px;height:110px}
.bars>div{flex:1;background:var(--navy);border-radius:4px 4px 0 0;position:relative}
.bars .blab{position:absolute;top:-1.4em;left:50%;transform:translateX(-50%);font-size:.75rem;color:var(--sub);white-space:nowrap}
.xlab{display:flex;gap:3px;margin-top:4px}.xlab>span{flex:1;text-align:center;font-size:.75rem;color:var(--sub)}
.tool{background:var(--cream);border:2px dashed #D8CDBC;border-radius:16px;padding:16px;margin:16px 0}
.tool input[type=search]{width:100%;max-width:420px;padding:10px 14px;border:2px solid var(--navy);border-radius:12px;font-size:1rem;background:#fff;font-family:inherit}
.tool select{padding:9px 12px;border:2px solid var(--navy);border-radius:12px;margin:8px 8px 0 0;background:#fff;color:var(--navy);font-family:inherit}
.tool .tstats{margin:12px 0;font-size:.95rem}.tool .tstats b{font-size:1.15rem;color:var(--coral)}
button,.btn{font-family:'Zen Maru Gothic',sans-serif}
input[type=email],textarea{border:2px solid var(--navy);border-radius:12px;font-family:inherit}
form button{background:var(--coral);color:#fff;border:0;padding:11px 28px;border-radius:999px;font-weight:700;font-size:1rem;cursor:pointer}
mark{background:linear-gradient(transparent 62%,var(--brass) 62%);color:inherit}
.g{display:inline-block;border-radius:4px;padding:0 6px;line-height:1.5;cursor:pointer;white-space:nowrap}
.g-m{background:#F2EBDD;color:#8A7A64;border:1px dashed #D8CDBC}
.g-p{background:#FDEDE9;color:#B8432F;border:1px dashed var(--coral);font-weight:700}
.g .lk{font-size:.85em}
.lockbox{border:2px dashed var(--coral);background:#FFF8F5;border-radius:14px;padding:14px 16px;margin:16px 0}
.lockbox h3{margin:0 0 6px;color:#B8432F}
.btn-s{display:inline-block;background:var(--navy);color:#fff;padding:7px 16px;border-radius:999px;text-decoration:none;font-weight:700;font-size:.9rem}
.member-only .g-m{background:transparent;border:0;color:inherit;padding:0;cursor:auto}
.tbl-note{font-size:.85rem;color:var(--sub)}
`;

// コンパスくん（v2: 顔とおなかの文字盤を分離、赤針のアホ毛は常に北東を指す）
function kun(size, expr = 'normal') {
  const eyes = expr === 'idea'
    ? `<path d="M 36 70 Q 42 64 48 70" fill="none" stroke="#16324F" stroke-width="4" stroke-linecap="round"/><path d="M 72 70 Q 78 64 84 70" fill="none" stroke="#16324F" stroke-width="4" stroke-linecap="round"/><ellipse cx="60" cy="88" rx="7" ry="9" fill="#16324F"/><ellipse cx="60" cy="91" rx="4" ry="5" fill="#E8604C"/>`
    : expr === 'salute'
      ? `<path d="M 36 74 L 48 70" stroke="#16324F" stroke-width="4" stroke-linecap="round"/><circle cx="78" cy="72" r="5.5" fill="#16324F"/><circle cx="80" cy="70" r="1.8" fill="#fff"/><path d="M 50 86 Q 60 93 70 86" fill="none" stroke="#16324F" stroke-width="4" stroke-linecap="round"/><path d="M 14 60 Q 24 50 34 58" fill="none" stroke="#16324F" stroke-width="5" stroke-linecap="round"/>`
      : `<circle cx="42" cy="72" r="5.5" fill="#16324F"/><circle cx="78" cy="72" r="5.5" fill="#16324F"/><circle cx="44" cy="70" r="1.8" fill="#fff"/><circle cx="80" cy="70" r="1.8" fill="#fff"/><path d="M 50 84 Q 60 92 70 84" fill="none" stroke="#16324F" stroke-width="4" stroke-linecap="round"/>`;
  const spark = expr === 'idea' ? `<g stroke="#F4B942" stroke-width="3" stroke-linecap="round"><line x1="88" y1="20" x2="94" y2="12"/><line x1="96" y1="30" x2="104" y2="26"/><line x1="80" y1="12" x2="82" y2="4"/></g>` : '';
  const dial = size >= 30
    ? `<circle cx="60" cy="112" r="14" fill="#FDF6EC" stroke="#16324F" stroke-width="3"/><g stroke="#16324F" stroke-width="2" stroke-linecap="round"><line x1="60" y1="100" x2="60" y2="103"/><line x1="48" y1="112" x2="51" y2="112"/><line x1="69" y1="112" x2="72" y2="112"/></g><g transform="rotate(-40 60 112)"><line x1="60" y1="104" x2="60" y2="112" stroke="#E8604C" stroke-width="3" stroke-linecap="round"/><line x1="60" y1="112" x2="60" y2="119" stroke="#16324F" stroke-width="3" stroke-linecap="round"/></g>`
    : '';
  const cheeks = expr === 'salute'
    ? `<circle cx="88" cy="82" r="4.5" fill="#F0999B"/>`
    : `<circle cx="32" cy="82" r="4.5" fill="#F0999B"/><circle cx="88" cy="82" r="4.5" fill="#F0999B"/>`;
  return `<svg width="${size}" height="${Math.round(size * 140 / 120)}" viewBox="0 0 120 140" aria-hidden="true"><g transform="rotate(-40 60 26)"><polygon points="60,2 66,26 54,26" fill="#E8604C"/><polygon points="60,50 66,26 54,26" fill="#16324F"/><circle cx="60" cy="26" r="4" fill="#F4B942" stroke="#16324F" stroke-width="2"/></g>${spark}<circle cx="60" cy="82" r="52" fill="#FFFFFF" stroke="#16324F" stroke-width="5"/>${eyes}${cheeks}${dial}</svg>`;
}
const kunSays = (html, expr = 'idea') => html
  ? `<div class="kun-row">${kun(46, expr)}<div class="kun-bubble">${html}</div></div>` : '';

function page(path, { title, desc, crumb = [], body, noindex = false, jsonld = null, lastmod = null }) {
  const canonical = ORIGIN + encodeURI(path); // 日本語パス(市町村名)は%エンコード、英数字/は不変
  const crumbHtml = crumb.length
    ? `<nav class="crumb">${[['トップ', '/'], ...crumb].map(([t, h], i, arr) =>
        i === arr.length - 1 ? esc(t) : `<a href="${h}">${esc(t)}</a>`).join(' › ')}</nav>` : '';
  // パンくず構造化データ + ページ固有JSON-LDを併記
  const breadcrumb = crumb.length ? {
    '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: [['トップ', '/'], ...crumb].map(([t, h], i, arr) => ({
      '@type': 'ListItem', position: i + 1, name: t,
      ...(i < arr.length - 1 ? { item: ORIGIN + h } : {}),
    })),
  } : null;
  jsonld = [breadcrumb, ...(Array.isArray(jsonld) ? jsonld : [jsonld])].filter(Boolean);
  jsonld = jsonld.length === 0 ? null : jsonld.length === 1 ? jsonld[0] : jsonld;
  const html = `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${canonical}">${noindex ? '\n<meta name="robots" content="noindex">' : '\n<meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1">'}
<meta property="og:site_name" content="${SITE}">
<meta property="og:type" content="${path === '/' ? 'website' : 'article'}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${canonical}">
<meta property="og:locale" content="ja_JP">
<meta property="og:image" content="${ORIGIN}/assets/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/favicon.ico" sizes="48x48">
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/assets/apple-touch-icon.png">
<link rel="manifest" href="/assets/site.webmanifest">
<meta name="theme-color" content="#16324F">
<link rel="preconnect" href="https://fonts.googleapis.com">
<meta name="msvalidate.01" content="AB03214349E5D12EC85FE63B4AA928C6">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Zen+Maru+Gothic:wght@700&family=BIZ+UDPGothic:wght@400;700&display=swap" rel="stylesheet">
<style>${CSS}</style>${jsonld ? `\n<script type="application/ld+json">${JSON.stringify(jsonld)}</script>` : ''}
<script defer src="/assets/gate.js"></script>
</head><body>
<header><div class="in"><a class="logo" href="/">${kun(30)}<span>${SITE}</span></a><a class="hcta" href="/alert/?back=${encodeURIComponent(path)}">${CTA_LABEL}</a></div></header>
<main>${crumbHtml}
${body}
${path === '/alert/' || path === '/alert/thanks/' ? '' : `<div class="cta">${kun(52)}<div class="ctxt"><b class="mk">歴代の落札金額・前回比・契約の中央値・類似案件検索の全期間が、無料会員で開きます。</b><br>
メール登録だけ。登録した瞬間に、このページの続きが見られます。<br><br>
${cta(path)}</div></div>`}
</main>
<footer><div class="in">
<p>${SITE} — 官公庁入札の落札相場・落札実績データベース。データ出典: 調達ポータル「落札実績オープンデータ」（政府標準利用規約準拠）ほか公的公表情報。最終更新: ${BUILT_AT}</p>
<p><a href="/price/">落札相場</a> ／ <a href="/company/">落札企業</a> ／ <a href="/organ/">発注機関</a> ／ <a href="/local/">地域別</a> ／ <a href="/contract/">継続契約</a> ／ <a href="/radar/">満了レーダー</a> ／ <a href="/weekly/">週間レポート</a> ／ <a href="/shindan/">入札機会診断</a> ／ <a href="/guide/">入札ガイド</a></p>
<p><a href="/about/">運営者情報・データについて</a> ／ <a href="/policy/">掲載ポリシー・削除依頼</a></p>
</div></footer>
</body></html>`;
  const file = join(DIST, path.replace(/\/$/, '/index.html').replace(/^\//, ''));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, html);
  if (!noindex) urls.push({ loc: canonical, lastmod }); // noindexページはsitemapに載せない。lastmodは実データの動いた日
  return canonical;
}

const awardRows = (list, { company = true, freeRows = Infinity } = {}) => `
<div class="wrap"><table><tr><th>落札日</th><th>案件名</th><th>機関</th>${company ? '<th>落札者</th>' : ''}<th>落札価格</th></tr>
${list.map((a, i) => `<tr><td>${a.award_date}</td><td>${esc(a.name)}</td><td>${esc(MINISTRIES[a.ministry_code] || a.ministry_code)}</td>${
  company ? `<td>${companyLink(a.corporate_no, esc(a.winner_name))}</td>` : ''
}<td class="num">${i < freeRows ? yen(a.amount) : gM(yen(a.amount))}</td></tr>`).join('\n')}</table></div>`;

const statBoxes = (pairs) => `<div class="stats">${pairs.map(([k, v]) => `<div class="stat"><b>${v}</b>${k}</div>`).join('')}</div>`;

// ---------- 判断支援ヘルパー（金額帯・洞察文・月別チャート） ----------
const BANDS = [
  { label: '100万円未満', min: 0, max: 1e6 },
  { label: '100万〜500万円', min: 1e6, max: 5e6 },
  { label: '500万〜3,000万円', min: 5e6, max: 3e7 },
  { label: '3,000万〜1億円', min: 3e7, max: 1e8 },
  { label: '1億円以上', min: 1e8, max: Infinity },
];
const pctile = (arr, p) => { const a = [...arr].sort((x, y) => x - y); return a.length ? a[Math.floor((a.length - 1) * p)] : null; };
const monthCounts = (list) => { const m = Array(12).fill(0); for (const a of list) { const mm = Number(a.award_date?.slice(5, 7)); if (mm) m[mm - 1]++; } return m; };

function bandTable(list) {
  const rows = BANDS.map((b) => {
    const sub = list.filter((a) => a.amount >= b.min && a.amount < b.max);
    return { b, n: sub.length, med: median(sub.map((a) => a.amount)) };
  }).filter((r) => r.n > 0);
  return `<div class="wrap"><table><tr><th>金額帯</th><th>件数</th><th>帯内の中央値</th></tr>${rows.map((r) =>
    `<tr><td>${r.b.label}</td><td class="num">${r.n.toLocaleString()}</td><td class="num">${yen(r.med)}</td></tr>`).join('\n')}</table></div>`;
}

function insights(list, subject) {
  const s = [];
  const n = list.length;
  if (!n) return '';
  const lowest = list.filter((a) => ['8002010', '8003010'].includes(a.method_code)).length;
  const sogo = list.filter((a) => ['8002040', '8003040'].includes(a.method_code)).length;
  const zui = list.filter((a) => /^(8001|8004|8011|8014)/.test(a.method_code || '')).length;
  if (lowest / n >= 0.7) s.push(`${subject}の落札は<b>${Math.round((lowest / n) * 100)}%が最低価格方式</b>——技術点より価格勝負の分野です。`);
  else if (sogo / n >= 0.3) s.push(`<b>総合評価方式が${Math.round((sogo / n) * 100)}%</b>を占め、価格だけでなく技術提案の比重が大きい分野です。`);
  if (zui / n >= 0.3) s.push(`随意契約系が${Math.round((zui / n) * 100)}%あり、少額・オープンカウンタでの受注余地があります。`);
  const bandCounts = BANDS.map((b) => list.filter((a) => a.amount >= b.min && a.amount < b.max).length);
  const bi = bandCounts.indexOf(Math.max(...bandCounts));
  s.push(`落札額は<b>${BANDS[bi].label}</b>の案件が最多（全体の${Math.round((bandCounts[bi] / n) * 100)}%）。`);
  const mc = monthCounts(list);
  const mx = Math.max(...mc);
  if (mx >= (n / 12) * 2) s.push(`落札決定は<b>${mc.indexOf(mx) + 1}月に集中</b>（年間の${Math.round((mx / n) * 100)}%）。その1〜2ヶ月前が公告シーズンです。`);
  const y25 = list.filter((a) => a.award_date?.startsWith('2025')).length;
  const y24 = list.filter((a) => a.award_date?.startsWith('2024')).length;
  if (y24 >= 30 && Math.abs(y25 - y24) / y24 >= 0.15) {
    s.push(y25 > y24 ? `件数は<b>増加傾向</b>（2024年${y24.toLocaleString()}件 → 2025年${y25.toLocaleString()}件）。` :
      `件数は<b>減少傾向</b>（2024年${y24.toLocaleString()}件 → 2025年${y25.toLocaleString()}件）。`);
  }
  return s.join(' ');
}

function monthChart(list, caption) {
  const mc = monthCounts(list);
  const mx = Math.max(...mc, 1);
  const peak = mc.indexOf(Math.max(...mc));
  return `<div class="chart" role="img" aria-label="${esc(caption)}の月別件数">
<div class="bars">${mc.map((c, i) => `<div style="height:${Math.max(2, Math.round((c / mx) * 100))}%" title="${i + 1}月: ${c.toLocaleString()}件">${i === peak ? `<span class="blab">${c.toLocaleString()}</span>` : ''}</div>`).join('')}</div>
<div class="xlab">${mc.map((_, i) => `<span>${i + 1}</span>`).join('')}</div>
<p class="meta">${esc(caption)}の落札決定月の分布（1〜12月）。公告はおおむねこの1〜2ヶ月前に出ます。</p></div>`;
}

// 企業ランキング（件数順位→分析文の「上位◯%」に使用）
const companyRank = new Map();
{
  const ranked = [...byCompany.entries()].map(([no, l]) => [no, l.length]).sort((x, y) => y[1] - x[1]);
  ranked.forEach(([no], i) => companyRank.set(no, i + 1));
}
// 分野×金額帯の中央値（価格ポジション分析用）
const bandOf = (amt) => BANDS.findIndex((b) => amt >= b.min && amt < b.max);
const bandMedians = new Map(); // slug|band → median
{
  const tmp = new Map();
  for (const a of AWARDS) {
    if (!a.slug || a.slug === 'other' || !(a.amount > 0)) continue;
    const k = a.slug + '|' + bandOf(a.amount);
    (tmp.get(k) ?? tmp.set(k, []).get(k)).push(a.amount);
  }
  for (const [k, arr] of tmp) bandMedians.set(k, median(arr));
}

function groupTable(list, keyFn, labelFn, linkFn = null, limit = 10) {
  const m = new Map();
  for (const a of list) { const k = keyFn(a); if (!k) continue; const o = m.get(k) ?? { n: 0, sum: 0 }; o.n++; o.sum += a.amount || 0; m.set(k, o); }
  const rows = [...m.entries()].sort((x, y) => y[1].n - x[1].n).slice(0, limit);
  if (!rows.length) return `<p class="meta">分類・集計できる実績がまだありません。</p>`;
  return `<div class="wrap"><table><tr><th></th><th>件数</th><th>合計金額</th></tr>${rows.map(([k, o]) =>
    `<tr><td>${(() => { const h = linkFn && linkFn(k); return h ? `<a href="${h}">${esc(labelFn(k))}</a>` : esc(labelFn(k)); })()}</td><td class="num">${o.n.toLocaleString()}</td><td class="num">${yen(o.sum)}</td></tr>`).join('\n')}</table></div>`;
}

// ---------- 生成 ----------
rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });
if (existsSync(join(ROOT, 'site', 'static'))) cpSync(join(ROOT, 'site', 'static'), join(DIST, 'assets'), { recursive: true });
const urls = [];

// 相場ページ（類似案件検索ツール + 洞察 + 金額帯 + 発注カレンダー）
let priceCount = 0;
for (const t of TAXONOMY) {
  const list = byCat.get(t.slug) || [];
  if (list.length < MIN_PRICE_AWARDS) continue;
  priceCount++;
  const amounts = list.map((a) => a.amount).filter((n) => n > 0);
  const med = median(amounts);
  const bandCounts = BANDS.map((b) => list.filter((a) => a.amount >= b.min && a.amount < b.max).length);
  const topBand = BANDS[bandCounts.indexOf(Math.max(...bandCounts))].label;
  const recent = list.slice(0, RECENT_LIMIT);

  // 類似案件検索の元データ（直近5,000件・軽量配列）
  const toolRows = list.slice(0, 5000).map((a) => [a.name, a.award_date, a.amount, a.ministry_code, a.winner_name]);
  const minsUsed = {};
  for (const a of list) if (MINISTRIES[a.ministry_code]) minsUsed[a.ministry_code] = MINISTRIES[a.ministry_code];
  const dataFile = join(DIST, 'price', t.slug, 'data.json');
  mkdirSync(dirname(dataFile), { recursive: true });
  writeFileSync(dataFile, JSON.stringify({ mins: minsUsed, rows: toolRows }));

  page(`/price/${t.slug}/`, {
    title: `${t.label}の落札相場・落札価格【官公庁 実績${list.length.toLocaleString()}件】｜${SITE}`,
    desc: `${t.label}の入札はいくらで落ちる? 落札価格の中央値は${yen(med)}（実績${list.length.toLocaleString()}件・毎日更新）。金額帯別の相場・発注機関・落札企業・公告時期に加え、類似案件検索で自社案件の値付けの目安がわかります。`,
    crumb: [['落札相場', '/price/'], [t.label, '']],
    lastmod: list[0]?.award_date,
    jsonld: { '@context': 'https://schema.org', '@type': 'Dataset', name: `${t.label}の落札実績データ`, description: `国の機関の${t.label}に関する落札実績${list.length}件の統計`, license: 'https://www.digital.go.jp/copyright-policy/', creator: { '@type': 'Organization', name: SITE } },
    body: `<h1>${t.label}の入札はいくらで落ちる?</h1>
<p class="meta">調達ポータル公表の落札実績（2013年度〜）のうち「${t.label}」${list.length.toLocaleString()}件のデータ。毎日更新。</p>
${kunSays(insights(list, `${t.label}`))}
<h2>あなたの案件に近い落札事例を探す</h2>
<div class="tool">
<p>案件名のキーワードで過去の落札事例を絞り込むと、<b>その条件での落札額の水準</b>がわかります。<span class="meta">（例: 庁舎 定期、機械警備、データ入力）</span></p>
<input id="q" type="search" placeholder="キーワード（空白区切りで絞り込み）" autocomplete="off">
<br><select id="fmin"><option value="">すべての機関</option></select>
<select id="fband"><option value="">すべての金額帯</option>${BANDS.map((b, i) => `<option value="${i}">${b.label}</option>`).join('')}</select>
<div class="tstats" id="tstats"></div><div class="wrap" id="tres"></div>
</div>
<script>window.NC_TOOL={data:'/price/${t.slug}/data.json',bands:${JSON.stringify(BANDS.map((b) => [b.min, b.max === Infinity ? null : b.max]))}}</script>
<script defer src="/assets/search.js"></script>
<h2>落札額の分布</h2>
${statBoxes([['実績件数', list.length.toLocaleString() + '件'], ['最も多い金額帯', topBand], ['全体の中央値', yen(med)]])}
${bandTable(list)}
${(() => { const regs = [...localByPrefCat.entries()].filter(([k, v]) => k.endsWith('|' + t.slug) && v.length >= 30).map(([k]) => k.split('|')[0]); return regs.length ? `<h2>地域別の相場</h2><p>${regs.map((pn) => `<a href="/price/${t.slug}/${PREF_SLUGS[pn]}/">${pn}の${t.label}</a>`).join(' ／ ')}</p>` : ''; })()}
<h2>発注時期のパターン</h2>${monthChart(list, t.label)}
<h2>発注が多い機関</h2>${groupTable(list, (a) => a.ministry_code, (k) => MINISTRIES[k] || k, (k) => organHref(k))}
<h2>落札件数の多い企業</h2>${groupTable(list.filter((a) => a.corporate_no), (a) => a.corporate_no, (k) => companyName.get(k) || k, (k) => companyHref(k))}
<h2>入札方式の内訳</h2>${groupTable(list, (a) => a.method_code, (k) => BIDDING_METHODS[k] || k)}
<h2>直近の落札事例</h2>${awardRows(recent)}`,
  });
}

// 地域×業務の相場ページ（自治体データ。競合ゼロ棚。データ30件以上のみ）
let regionPriceCount = 0;
// 地域相場ページの実在集合（'分類slug|県slug'）。リンク側はこの集合でガードして404を防ぐ
const prefCatPages = new Set();
for (const [key, rlist] of localByPrefCat) {
  if (rlist.length < 30) continue;
  const [pn, cs] = key.split('|');
  if (PREF_SLUGS[pn] && LABEL[cs]) prefCatPages.add(cs + '|' + PREF_SLUGS[pn]);
}
for (const [key, rlist] of localByPrefCat) {
  if (rlist.length < 30) continue;
  const [prefName, cslug] = key.split('|');
  const pslug = PREF_SLUGS[prefName];
  const label = LABEL[cslug];
  if (!pslug || !label) continue;
  regionPriceCount++;
  const amounts = rlist.map((a) => a.amount).filter((n) => n > 0);
  const med = median(amounts);
  const orgAgg = new Map();
  for (const a of rlist) { const o = orgAgg.get(a.org) ?? { n: 0, sum: 0 }; o.n++; o.sum += a.amount || 0; orgAgg.set(a.org, o); }
  page(`/price/${cslug}/${pslug}/`, {
    title: `${prefName}の${label}の落札相場・落札価格【入札実績${rlist.length.toLocaleString()}件】｜${SITE}`,
    desc: `${prefName}と県内市町村が発注する「${label}」入札の落札相場。落札価格の中央値は${yen(med)}（実績${rlist.length.toLocaleString()}件・毎日更新）。発注自治体・金額帯・直近の落札事例をデータで公開。`,
    crumb: [['落札相場', '/price/'], [label, `/price/${cslug}/`], [prefName, '']],
    lastmod: rlist[0]?.open_date,
    jsonld: { '@context': 'https://schema.org', '@type': 'Dataset', name: `${prefName}の${label}落札実績データ`, description: `${prefName}域の${label}に関する落札実績${rlist.length}件`, creator: { '@type': 'Organization', name: SITE } },
    body: `<h1>${prefName}の${label} 落札相場</h1>
${kunSays(`${prefName}域（県+市町村）の「${label}」の落札実績を<b>${rlist.length.toLocaleString()}件</b>集めたよ。落札価格の中央値は<b>${yen(med)}</b>だよ。`)}
${statBoxes([['実績件数', rlist.length.toLocaleString() + '件'], ['落札価格の中央値', yen(med)], ['最高額', yen(Math.max(...amounts, 0))]])}
<h2>金額帯の分布</h2>${bandTable(rlist)}
<h2>発注する自治体</h2><div class="wrap"><table><tr><th>自治体</th><th>件数</th><th>合計金額</th></tr>
${[...orgAgg.entries()].sort((x, y) => y[1].n - x[1].n).slice(0, 20).map(([o, v]) => `<tr><td>${esc(o)}</td><td class="num">${v.n.toLocaleString()}</td><td class="num">${yen(v.sum)}</td></tr>`).join('\n')}</table></div>
<h2>発注時期のパターン</h2>${monthChart(rlist.map((a) => ({ award_date: a.open_date })), `${prefName}の${label}`)}
<h2>直近の落札事例</h2><div class="wrap"><table><tr><th>開札日</th><th>案件名</th><th>自治体</th><th>落札者</th><th>金額</th></tr>
${rlist.slice(0, 30).map((a) => `<tr><td>${a.open_date}</td><td>${esc(a.name)}</td><td>${esc(a.org)}</td><td>${a.corporate_no && byCompany.has(a.corporate_no) && (byCompany.get(a.corporate_no) || []).length >= MIN_COMPANY_AWARDS ? `<a href="/company/${a.corporate_no}/">${esc(a.winner_name)}</a>` : esc(a.winner_name)}</td><td class="num">${yen(a.amount)}</td></tr>`).join('\n')}</table></div>
<p><a href="/price/${cslug}/">→ ${label}の全国（国の機関）の相場を見る</a></p>`,
  });
}

// 相場ハブ
page('/price/', {
  title: `業務別の落札相場一覧 | ${SITE}`,
  desc: '官公庁入札の落札相場を業務分類別に公開。清掃・警備・システム開発など、実データに基づく落札価格の水準がわかります。',
  crumb: [['落札相場', '']],
  body: `<h1>業務別の落札相場</h1><ul>${TAXONOMY.filter((t) => (byCat.get(t.slug) || []).length >= MIN_PRICE_AWARDS)
    .map((t) => `<li><a href="/price/${t.slug}/">${t.label}</a>（${(byCat.get(t.slug) || []).length.toLocaleString()}件）</li>`).join('')}</ul>`,
});

// 継続契約ページ（1契約=1ページ。「(案件名) 落札」検索に正対。履歴+次回予測+相場文脈）
let contractCount = 0;
const contractsByMinistry = new Map();
for (const [id, c] of CONTRACTS) {
  contractCount++;
  (contractsByMinistry.get(c.ministry) ?? contractsByMinistry.set(c.ministry, []).get(c.ministry)).push([id, c]);
  const { arr, years, latest, ministry, slug, name } = c;
  const mname = MINISTRIES[ministry] || ministry;
  const m = monthMode(arr);
  const pubM = ((m + 10 - 1) % 12) + 1;
  const last = arr[0];
  const amounts = arr.map((a) => a.amount).filter((n) => n > 0);
  const med = median(amounts);
  const winners = [...new Set(arr.map((a) => a.winner_name))];
  // 直近の落札者の連続回数
  let streak = 0;
  for (const a of arr) { if (a.corporate_no && a.corporate_no === last.corporate_no) streak++; else break; }
  // リプレイス回数（隣接する落札で落札者が変わった回数）
  let switches = 0;
  for (let i = 0; i < arr.length - 1; i++) if ((arr[i].corporate_no || arr[i].winner_name) !== (arr[i + 1].corporate_no || arr[i + 1].winner_name)) switches++;
  // 価格トレンド（最新 vs 最古）
  const first = arr[arr.length - 1];
  const trend = first.amount > 0 && last.amount > 0 ? Math.round((last.amount / first.amount - 1) * 100) : null;
  // 相場文脈（同分野・同金額帯の中央値との比較）
  const bm = slug && slug !== 'other' && last.amount > 0 ? bandMedians.get(slug + '|' + bandOf(last.amount)) : null;
  const vsBand = bm ? Math.round((last.amount / bm - 1) * 100) : null;
  const isDue = latest >= RADAR_FY - 1 && !arr.some((a) => +a.award_date.slice(0, 4) >= RADAR_FY);
  const openNow = noticeKeys.has(normName(name));

  const sentences = [];
  sentences.push(`「${esc(name)}」は${esc(mname)}が発注する継続契約で、当サイト収録の落札実績は<b>${years}年分・${arr.length}件</b>です。`);
  if (winners.length === 1) sentences.push(`この間の落札者は<b>${esc(last.winner_name)}</b>の1社のみで、固定的な契約といえます。`);
  else sentences.push(`落札者は${winners.length}社にわたり、業者の交代が<b>${switches}回</b>起きています。直近は${esc(last.winner_name)}が${streak >= 2 ? `${streak}回連続で` : ''}落札しています。`);
  if (trend !== null && Math.abs(trend) >= 10) sentences.push(`落札額は${first.award_date.slice(0, 4)}年の${gM(yen(first.amount))}から${last.award_date.slice(0, 4)}年の${yen(last.amount)}へ<b>${gM((trend > 0 ? '+' : '') + trend + '%', '●%')}</b>${trend > 0 ? '上昇' : '下落'}しました。`);
  if (vsBand !== null && Math.abs(vsBand) >= 15) sentences.push(`直近の落札額は同分野・同規模帯の中央値より${gM(Math.abs(vsBand) + '%', '●%')}${vsBand > 0 ? '高い' : '低い'}水準です。`);
  if (m) sentences.push(`例年<b>${m}月頃</b>に落札が決まっており、公告はその1〜2ヶ月前（${pubM}月頃）が目安です。${isDue ? `前回の落札から年度が変わっており、<b>次の公告が近い</b>可能性があります。` : ''}${openNow ? ' <b style="color:#E8604C">いま公告が出ている可能性があります。</b>' : ''}`);

  const faqs = [
    [`「${name}」の直近の落札者は?`, `${last.award_date}の落札で${last.winner_name}が${yen(last.amount)}で落札しています（${mname}発注）。`],
    [`「${name}」はいくらで落札されていますか?`, `直近は${last.award_date}に${yen(last.amount)}で落札されています。収録${arr.length}件の歴代の落札額と中央値は無料会員登録で全件表示されます。`],
    [`「${name}」の次回公告はいつ頃ですか?`, m ? `例年${m}月頃に落札が決まるため、公告は${pubM}月頃が目安です（過去の周期からの推定であり発注を保証するものではありません）。` : '過去の周期から時期を推定できるほどのデータがありません。'],
  ];
  page(`/contract/${id}/`, {
    title: `${name}の落札結果・落札履歴【${mname}・${years}年分】｜${SITE}`,
    desc: `「${name}」（${mname}）の落札結果を${years}年分収録。直近は${last.award_date}に${last.winner_name}が${yen(last.amount)}で落札。歴代の落札者・金額の推移、次回公告の目安、同分野の相場との比較をデータで公開。`,
    crumb: [['継続契約', '/contract/'], [mname, `/contract/${ministry.toLowerCase()}/`], [name, '']],
    lastmod: last.award_date,
    jsonld: [
      { '@context': 'https://schema.org', '@type': 'Dataset', name: `${name}の落札履歴`, description: `${mname}の継続契約「${name}」の落札実績${arr.length}件（${years}年分）`, creator: { '@type': 'Organization', name: SITE }, isAccessibleForFree: false },
      { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: faqs.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) },
    ],
    body: `<h1>${esc(name)}の落札結果・落札履歴</h1>
<p class="meta">発注機関: ${organLink(ministry, esc(mname))}${slug && slug !== 'other' ? ` ／ 業務分野: <a href="/price/${slug}/">${LABEL[slug]}</a>` : ''}</p>
<h2 style="margin-top:1em">値付けの目安（札を入れる前に）</h2>
${statBoxes([['前回の落札額', yen(last.amount)], ['この契約の中央値', gM(yen(med))], ['同分野・同規模帯との比較', vsBand === null ? '—' : gM(`${vsBand > 0 ? '+' : ''}${vsBand}%`, '●%')], ['例年の落札月', m ? m + '月頃' : '—'], ['前回の落札者', last.winner_name.length > 14 ? last.winner_name.slice(0, 14) + '…' : last.winner_name]])}
${(() => { const r = estimateRange(arr); return `<div class="lockbox"><h3>この契約の「勝てる札」推定レンジ</h3>
<p style="margin:4px 0"><b style="font-size:1.3rem">${r ? gP(teaseYen(r.lo) + ' 〜 ' + teaseYen(r.hi)) : gP('●●●万円 〜 ●●●万円')}</b></p>
<p class="meta" style="margin:4px 0">根拠: 前回の落札額、前回比のトレンド、同分野・同規模帯の中央値、この分野の最低価格方式の比率から算出した参考レンジです。
あわせて<b>狙い目スコア</b>（現職の固定度と入れ替わり確率）、<b>前回落札者の価格傾向</b>、<b>次の公告が出た瞬間の通知</b>をウォッチ会員に提供します（月9,800円・準備中）。</p>
<p style="margin:8px 0 0">${cta(`/contract/${id}/`, `&watch=contract&id=${id}&name=${encodeURIComponent(name)}`)}</p></div>`; })()}
${kunSays(sentences.join(' '))}
<h2>落札履歴（誰が・いくらで落としてきたか）</h2>
<div class="wrap"><table><tr><th>落札日</th><th>落札者</th><th>落札価格</th><th>前回比</th><th>入札方式</th></tr>
${arr.map((a, i) => { const prev = arr[i + 1]; const d = prev && prev.amount > 0 && a.amount > 0 ? Math.round((a.amount / prev.amount - 1) * 100) : null;
  const amt = i === 0 ? yen(a.amount) : gM(yen(a.amount)); const dd = d === null ? '—' : gM(`${d > 0 ? '+' : ''}${d}%`, '●%');
  return `<tr><td>${a.award_date}</td><td>${a.corporate_no && byCompany.has(a.corporate_no) && (byCompany.get(a.corporate_no) || []).length >= MIN_COMPANY_AWARDS ? `<a href="/company/${a.corporate_no}/">${esc(a.winner_name)}</a>` : esc(a.winner_name)}</td><td class="num">${amt}</td><td class="num">${dd}</td><td>${esc(BIDDING_METHODS[a.method_code] || '')}</td></tr>`; }).join('\n')}</table></div>
<p class="tbl-note unlock-hide">${arr.length > 1 ? `過去${arr.length - 1}件の落札金額と前回比は<b>無料会員</b>（メール登録）で表示されます。 ${unlockBtn(`/contract/${id}/`)}` : ''}</p>
<p class="meta">案件名の年度表記ゆれ（令和◯年度等）を正規化して同一契約として束ねています。別契約が混在する場合は<a href="/policy/">こちら</a>からお知らせください。</p>
<h2>よくある質問</h2>${faqs.map(([q, a]) => `<h3>Q. ${esc(q)}</h3><p>A. ${esc(a)}</p>`).join('\n')}
<p>${slug && slug !== 'other' ? `<a href="/price/${slug}/">→ ${LABEL[slug]}の相場・類似案件検索</a> ／ ` : ''}${organHref(ministry) ? `<a href="${organHref(ministry)}">→ ${esc(mname)}の入札結果を見る</a>` : `<a href="/organ/">→ 発注機関別の落札結果を見る</a>`}</p>`,
  });
}
// 機関別の契約一覧（ページネーション）+ 全体ハブ
const CPER = 200;
for (const [mcode, list] of contractsByMinistry) {
  const mname = MINISTRIES[mcode] || mcode;
  list.sort((x, y) => y[1].years - x[1].years || (y[1].arr[0].amount || 0) - (x[1].arr[0].amount || 0));
  const pages = Math.ceil(list.length / CPER);
  for (let pg = 0; pg < pages; pg++) {
    const slice = list.slice(pg * CPER, (pg + 1) * CPER);
    const path = pg === 0 ? `/contract/${mcode.toLowerCase()}/` : `/contract/${mcode.toLowerCase()}/page/${pg + 1}/`;
    const nav = pages > 1 ? `<p>${pg > 0 ? `<a href="${pg === 1 ? `/contract/${mcode.toLowerCase()}/` : `/contract/${mcode.toLowerCase()}/page/${pg}/`}">← 前へ</a>　` : ''}${pg + 1} / ${pages}ページ${pg < pages - 1 ? `　<a href="/contract/${mcode.toLowerCase()}/page/${pg + 2}/">次へ →</a>` : ''}</p>` : '';
    page(path, {
      title: `${mname}の継続契約一覧${pg ? `（${pg + 1}ページ目）` : ''}【${list.length.toLocaleString()}件】落札履歴と次回公告の目安｜${SITE}`,
      desc: `${mname}が毎年繰り返し発注している継続契約${list.length.toLocaleString()}件。各契約の落札履歴（歴代の落札者・金額）と次回公告の目安を収録。`,
      crumb: pg === 0 ? [['継続契約', '/contract/'], [mname, '']] : [['継続契約', '/contract/'], [mname, `/contract/${mcode.toLowerCase()}/`], [`${pg + 1}ページ目`, '']],
      body: `<h1>${esc(mname)}の継続契約一覧</h1>
<p>毎年繰り返し発注されている契約です。契約名を選ぶと、歴代の落札者・金額・次回公告の目安が見られます。</p>${nav}
<div class="wrap"><table><tr><th>契約名</th><th>収録年数</th><th>直近の落札</th><th>直近の落札者</th></tr>
${slice.map(([id, c]) => `<tr><td><a href="/contract/${id}/">${esc(c.name)}</a></td><td class="num">${c.years}年</td><td class="num">${c.arr[0].award_date.slice(0, 4)}年 ${yen(c.arr[0].amount)}</td><td>${esc(c.arr[0].winner_name)}</td></tr>`).join('\n')}</table></div>${nav}`,
    });
  }
}
page('/contract/', {
  title: `官公庁の継続契約データベース【${contractCount.toLocaleString()}契約】落札履歴と次回公告の目安｜${SITE}`,
  desc: `国の機関が毎年繰り返し発注している継続契約${contractCount.toLocaleString()}件を収録。契約ごとに歴代の落札者・金額の推移、次回公告の目安、相場との比較を公開。`,
  crumb: [['継続契約', '']],
  body: `<h1>継続契約データベース</h1>
${kunSays(`毎年くり返し発注されている契約を<b>${contractCount.toLocaleString()}件</b>束ねたよ。「この契約、誰がいくらで落としてきたか」「次はいつ公告か」が1ページでわかるよ!`)}
<h2>発注機関から探す</h2><ul>${[...contractsByMinistry.entries()].sort((x, y) => y[1].length - x[1].length).map(([mc, l]) => `<li><a href="/contract/${mc.toLowerCase()}/">${esc(MINISTRIES[mc] || mc)}</a>（${l.length.toLocaleString()}契約）</li>`).join('')}</ul>`,
});

// 満了レーダーページ（業務別。次回公告が近い継続契約の予測。国内唯一のコンテンツ）
const MONTHS_JP = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];
let radarCount = 0;
const radarSlugs = [];
for (const t of TAXONOMY) {
  const items = radarBySlug.get(t.slug);
  if (!items || items.length < 10) continue;
  radarCount++;
  radarSlugs.push(t.slug);
  items.sort((a, b) => a.pubMonth - b.pubMonth || (b.amount || 0) - (a.amount || 0));
  const openN = items.filter((i) => i.open).length;
  page(`/radar/${t.slug}/`, {
    title: `${t.label}の入札 次回公告カレンダー【継続契約${items.length.toLocaleString()}件の満了予測】｜${SITE}`,
    desc: `${t.label}で毎年繰り返し発注されている継続契約の「次回公告はいつ頃か」を過去の周期から予測。前回の落札者・金額つき。${items.length.toLocaleString()}件の満了予測を月別に公開（毎日更新）。`,
    crumb: [['満了レーダー', '/radar/'], [t.label, '']],
    lastmod: AWARDS[0]?.award_date || BUILT_AT, // データ由来の日付に統一（IndexNowの更新判定に使うため）
    body: `<h1>${t.label}の入札 次回公告カレンダー</h1>
${kunSays(`${t.label}で毎年くり返し発注されている継続契約<b>${items.length.toLocaleString()}件</b>について、過去の周期から<b>次の公告が来そうな時期</b>を予測したよ${openN ? `。うち<b>${openN}件</b>はいま公告が出ている可能性があるよ!` : ''}`)}
<p class="meta">各契約が例年どの時期に公告・落札されているかを、過去の周期から示しています（発注を保証するものではありません）。公告は落札のおおむね1〜2ヶ月前に出ます。前回落札から年度が変わり、次の公告が控えている継続契約を対象にしています。</p>
<div class="wrap"><table><tr><th>例年の公告時期</th><th>契約名</th><th>発注機関</th><th>前回落札</th><th>前回落札者</th><th>状態</th></tr>
${items.slice(0, 120).map((i) => `<tr><td>例年${MONTHS_JP[i.pubMonth - 1]}頃</td><td>${contractLink(normName(i.name) + '|' + i.ministry, esc(i.name))}</td><td>${esc(MINISTRIES[i.ministry] || i.ministry)}</td><td class="num">${i.lastYear}年 ${gM(yen(i.amount))}</td><td>${gM(i.lastCorp && byCompany.has(i.lastCorp) && (byCompany.get(i.lastCorp) || []).length >= MIN_COMPANY_AWARDS ? `<a href="/company/${i.lastCorp}/">${esc(i.lastWinner)}</a>` : esc(i.lastWinner), '●●●●')}</td><td>${i.open ? gP('公告中かも') : `${i.years}年連続`}</td></tr>`).join('\n')}</table></div>
<p class="tbl-note unlock-hide">前回の落札額・落札者は<b>無料会員</b>（メール登録）で表示されます。「公告中かも」の検知はウォッチ会員限定。 ${unlockBtn(`/radar/${t.slug}/`)}</p>
<p><a href="/price/${t.slug}/">→ ${t.label}の落札相場を見る</a></p>`,
  });
}
if (radarCount) {
  page('/radar/', {
    title: `入札 満了レーダー — 次回公告が近い継続契約の予測 | ${SITE}`,
    desc: '官公庁の継続契約が「次にいつ公告されるか」を過去の落札周期から予測。業務分野別に次回公告カレンダーを公開。入札の先回り準備に。',
    crumb: [['満了レーダー', '']],
    body: `<h1>入札 満了レーダー</h1>
${kunSays('毎年くり返される契約の「次はいつ公告されるか」を、過去の落札周期から予測しているよ。入札の準備を先回りできる、入札コンパスだけのデータだよ!')}
<p>官公庁の継続契約について、過去の落札周期から次回公告時期を予測しています。業務分野を選んでください。</p>
<ul>${radarSlugs.map((s) => `<li><a href="/radar/${s}/">${LABEL[s]}の次回公告カレンダー</a>（${radarBySlug.get(s).length.toLocaleString()}件）</li>`).join('')}</ul>`,
  });
}

// 入札ガイド（初心者のペインに答える入口。実データで数値を埋め、道具へ誘導する）
{
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  const lowestOf = (slug) => { const l = byCat.get(slug) || []; return pct(l.filter((a) => ['8002010', '8003010'].includes(a.method_code)).length, l.length); };
  const smallCos = [...byCompany.values()].filter((l) => l.length >= 1 && l.length <= 4).length;
  const prefCount = new Map(); for (const n of NOTICES) if (n.pref) prefCount.set(n.pref, (prefCount.get(n.pref) || 0) + 1);
  const topPref = [...prefCount.entries()].sort((a, b) => b[1] - a[1])[0];
  const kojiLocal = LOCALS.filter((a) => a.slug === 'koji').length;
  const stats = {
    awards: AWARDS.length.toLocaleString(), notices: NOTICES.length.toLocaleString(),
    topNoticePref: topPref ? `${topPref[0]}（${topPref[1].toLocaleString()}件）` : '東京都',
    seisoLowestPct: lowestOf('seiso'), keibiLowestPct: lowestOf('keibi'),
    seisoCount: (byCat.get('seiso') || []).length.toLocaleString(),
    companies: byCompany.size.toLocaleString(), smallSharePct: pct(smallCos, byCompany.size),
    kojiLocalPct: pct(kojiLocal, LOCALS.length || 1), contracts: contractCount.toLocaleString(),
    localAwards: LOCALS.length.toLocaleString(),
  };
  for (const g of GUIDES) {
    page(`/guide/${g.slug}/`, {
      title: `${g.title}｜${SITE}`,
      desc: g.desc,
      crumb: [['入札ガイド', '/guide/'], [g.title.split(' — ')[0], '']],
      lastmod: BUILT_AT,
      jsonld: { '@context': 'https://schema.org', '@type': 'Article', headline: g.title, description: g.desc,
        author: { '@type': 'Organization', name: SITE }, publisher: { '@type': 'Organization', name: SITE }, dateModified: BUILT_AT },
      body: `<h1>${esc(g.title)}</h1>
${kunSays('このガイドの数字は、当サイトが毎日更新している実データから自動で埋めているよ。読みながら道具のページへ飛べるようにしてあるよ!')}
${g.body(stats)}
<h2>関連ガイド</h2><ul>${GUIDES.filter((x) => x.slug !== g.slug).map((x) => `<li><a href="/guide/${x.slug}/">${esc(x.title.split(' — ')[0])}</a></li>`).join('')}</ul>`,
    });
  }
  page('/guide/', {
    title: `官公庁入札のはじめ方ガイド — 資格・案件探し・相場・電子入札・結果の調べ方 | ${SITE}`,
    desc: '官公庁・自治体の入札に初めて参加する中小企業向けガイド。参加資格と等級、案件の探し方、落札相場の調べ方、電子入札の準備、入札結果の調べ方を実データつきで解説。',
    crumb: [['入札ガイド', '']],
    body: `<h1>官公庁入札のはじめ方ガイド</h1>
${kunSays('はじめて入札する人が詰まるところを、順番に解説しているよ。数字は全部、当サイトの実データだよ!')}
<ul>${GUIDES.map((x) => `<li><a href="/guide/${x.slug}/"><b>${esc(x.title.split(' — ')[0])}</b></a><br><span class="meta">${esc(x.desc)}</span></li>`).join('')}</ul>
<h2>都道府県別ガイド</h2>
<p><a href="/guide/shikaku/"><b>都道府県別 入札参加資格・電子入札の始め方（47都道府県）</b></a></p>
<h2>データレポート</h2>
<p><a href="/report/kotai/"><b>官公庁の入札は本当に「いつも同じ業者」なのか — ${(allPairs).toLocaleString()}回の入札の実データ</b></a></p>`,
  });
}

// 企業ページ（概況文・契約ヒストリー・次回予測・同じ土俵の企業）
const nameCounts = new Map();
for (const [no, l] of byCompany) {
  if (l.length < MIN_COMPANY_AWARDS) continue;
  const nm = companyName.get(no) || l[0].winner_name;
  nameCounts.set(nm, (nameCounts.get(nm) || 0) + 1);
}
let companyCount = 0;
for (const [corpNo, list] of byCompany) {
  if (list.length < MIN_COMPANY_AWARDS) continue;
  companyCount++;
  const name = companyName.get(corpNo) || list[0].winner_name;
  const dupName = (nameCounts.get(name) || 0) > 1; // 同名別法人はtitleに法人番号を併記して重複回避
  const total = list.reduce((s, a) => s + (a.amount || 0), 0);
  const years = list.map((a) => a.award_date?.slice(0, 4)).filter(Boolean);
  const yMin = Math.min(...years), yMax = Math.max(...years);

  // 概況文（機械生成・ページ固有）
  const minTop = [...list.reduce((m, a) => m.set(a.ministry_code, (m.get(a.ministry_code) || 0) + 1), new Map()).entries()]
    .sort((x, y) => y[1] - x[1])[0];
  const catCount = list.reduce((m, a) => (a.slug && a.slug !== 'other' ? m.set(a.slug, (m.get(a.slug) || 0) + 1) : m), new Map());
  const catTop = [...catCount.entries()].sort((x, y) => y[1] - x[1])[0];
  const summary = `${name}は、${MINISTRIES[minTop[0]] || '国の機関'}を中心に` +
    (catTop ? `「${LABEL[catTop[0]]}」分野で` : '') +
    `${yMin === yMax ? `${yMin}年` : `${yMin}〜${yMax}年`}に落札実績${list.length.toLocaleString()}件・総額${yen(total)}。`;

  // 契約ヒストリー: この会社の案件が属するクラスタのうち、複数年繰り返しているもの
  const seen = new Set();
  const histories = [];
  for (const a of list) {
    const k = clusterKey(a);
    if (seen.has(k)) continue;
    seen.add(k);
    const cl = clusters.get(k);
    if (!cl || cl.length < 2) continue;
    const clYears = new Set(cl.map((x) => x.award_date?.slice(0, 4)));
    if (clYears.size < 2) continue;
    histories.push({ a, cl: [...cl].sort((x, y) => (x.award_date < y.award_date ? 1 : -1)), years: clYears.size });
  }
  histories.sort((x, y) => y.years - x.years);
  const histHtml = histories.slice(0, 5).map(({ a, cl }) => {
    const m = monthMode(cl);
    const latestYear = Math.max(...cl.map((x) => Number(x.award_date?.slice(0, 4)) || 0));
    const thisYear = new Date().getFullYear();
    const pubM = ((m + 10 - 1) % 12) + 1;
    const forecast = latestYear >= thisYear - 1
      ? `例年${m}月頃に落札 → <b>次回公告の目安は${pubM}月頃</b>`
      : `直近${latestYear}年を最後に実績が途切れています`;
    return `<h3>${contractLink(clusterKey(a), esc(a.name))}</h3>
<p class="meta">${forecast}</p>
<div class="wrap"><table><tr><th>落札日</th><th>落札者</th><th>落札価格</th></tr>
${cl.slice(0, 8).map((x, i) => `<tr><td>${x.award_date}</td><td>${x.corporate_no === corpNo ? `<b>${esc(x.winner_name)}</b>` : companyLink(x.corporate_no, esc(x.winner_name))}</td><td class="num">${i === 0 ? yen(x.amount) : gM(yen(x.amount))}</td></tr>`).join('\n')}
</table></div>`;
  }).join('\n');

  // データ分析プローズ（全文が実データ由来。条件を満たす文だけ出るため構成は社ごとに変わる）
  const paras = [];
  {
    const rank = companyRank.get(corpNo);
    const pct = Math.ceil((rank / byCompany.size) * 100);
    if (pct <= 50) paras.push(`当サイトが収録する落札実績のある${byCompany.size.toLocaleString()}社のうち、${esc(name)}の落札件数は<b>第${rank.toLocaleString()}位（上位${pct}%）</b>にあたります。`);
    // 継続性・活動期間
    const ySet = [...new Set(years)].sort();
    if (ySet.length >= 5) paras.push(`${ySet[0]}年から${ySet[ySet.length - 1]}年まで<b>${ySet.length}年にわたり継続的に受注</b>しており、官公需の常連事業者といえます。`);
    else if (ySet.length === 1 && Number(ySet[0]) >= 2025) paras.push(`落札実績は${ySet[0]}年からで、<b>官公庁市場への参入は比較的最近</b>です。`);
    // 機関依存度
    const minShare = minTop[1] / list.length;
    if (list.length >= 5 && minShare >= 0.8) paras.push(`落札の${Math.round(minShare * 100)}%が${MINISTRIES[minTop[0]]}に集中しており、<b>特定機関との取引が深い</b>タイプです。`);
    else if (list.length >= 5 && minShare <= 0.4) paras.push(`取引機関が分散しており、<b>複数の省庁にまたがって受注できる体制</b>を持っています。`);
    // 入札方式の傾向
    const sogoWins = list.filter((a) => ['8002040', '8003040'].includes(a.method_code)).length;
    const zuiWins = list.filter((a) => /^(8001|8004|8011|8014)/.test(a.method_code || '')).length;
    if (sogoWins >= 2) paras.push(`総合評価方式での落札が${sogoWins}件あり、<b>価格だけでなく技術提案でも評価されている</b>ことがうかがえます。`);
    if (list.length >= 5 && zuiWins / list.length >= 0.5) paras.push(`随意契約・オープンカウンタ経由の受注が${Math.round((zuiWins / list.length) * 100)}%を占め、少額案件の積み上げ型です。`);
    // 価格ポジション（同分野×同金額帯の中央値と比較。比較可能3件以上のみ）
    const ratios = [];
    for (const a of list) {
      if (!a.slug || a.slug === 'other' || !(a.amount > 0)) continue;
      const bm = bandMedians.get(a.slug + '|' + bandOf(a.amount));
      if (bm > 0) ratios.push(a.amount / bm);
    }
    if (ratios.length >= 3) {
      const avg = ratios.reduce((s, r) => s + r, 0) / ratios.length;
      if (avg <= 0.85) paras.push(`落札額を同分野・同規模帯の中央値と比べると平均${gP('●●%')}低い水準にあり、<b>価格競争力で取りにいく傾向</b>が読み取れます。`);
      else if (avg >= 1.15) paras.push(`落札額は同分野・同規模帯の中央値より平均${gP('●●%')}高い水準で、<b>価格以外の要素（実績・仕様適合）で選ばれている</b>可能性があります。`);
    }
    // 成長トレンド
    const recent2 = list.filter((a) => a.award_date >= '2024-01-01').length;
    const prior2 = list.filter((a) => a.award_date >= '2022-01-01' && a.award_date < '2024-01-01').length;
    if (prior2 >= 2 && recent2 >= prior2 * 1.5) paras.push(`直近2年の落札は${recent2}件と、その前の2年（${prior2}件）から<b>受注ペースが拡大</b>しています。`);
    else if (prior2 >= 3 && recent2 <= prior2 * 0.5) paras.push(`直近2年の落札は${recent2}件と、その前の2年（${prior2}件）から減速しています。`);
    // 契約奪取の検出（クラスタ内で直前の落札者が別業者だった勝ち）
    for (const { cl } of histories.slice(0, 3)) {
      const idx = cl.findIndex((x) => x.corporate_no === corpNo);
      if (idx >= 0 && idx < cl.length - 1) {
        const prev = cl[idx + 1];
        if (prev.corporate_no && prev.corporate_no !== corpNo) {
          const streak = cl.slice(idx + 1).filter((x) => x.corporate_no === prev.corporate_no).length;
          paras.push(`「${esc(cl[idx].name)}」では、それまで${esc(prev.winner_name)}が${streak >= 2 ? `${streak}回` : ''}落札していた契約を${cl[idx].award_date.slice(0, 4)}年に<b>獲得（リプレイス）した実績</b>があります。`);
          break;
        }
      }
    }
    // 1件あたりレンジ
    const amts = list.map((a) => a.amount).filter((n) => n > 0);
    if (amts.length >= 3) paras.push(`1件あたりの落札額は${yen(pctile(amts, 0.25))}〜${yen(pctile(amts, 0.75))}が中心レンジです。`);
  }
  const analysisHtml = paras.length >= 2 ? `<h2>データからみた${esc(name)}</h2>${paras.map((p) => `<p>${p}</p>`).join('\n')}
<p class="meta">※本分析は公表データ（落札実績）のみに基づく機械的な集計であり、企業の信用力等を評価するものではありません。</p>` : '';

  // FAQ（AI検索・リッチリザルト向け。回答は全て実データ）
  const faqs = [];
  faqs.push([`${name}の法人番号は?`,
    `${name}の法人番号は${corpNo}です（国税庁の法人番号。調達ポータルの落札実績オープンデータに記載のもの）。当サイトではこの法人番号をキーに、官公庁入札の落札実績${list.length.toLocaleString()}件を集計しています。`]);
  faqs.push([`${name}は官公庁との取引実績がありますか?`,
    `はい。当サイト収録範囲（国の機関・2013年度以降）で${list.length.toLocaleString()}件・総額${yen(total)}の落札実績があります。直近は${list[0].award_date}の「${list[0].name}」（${MINISTRIES[list[0].ministry_code] || '国の機関'}・${yen(list[0].amount)}）です。`]);
  faqs.push([`${name}はどの機関のどんな案件を受注していますか?`,
    `${MINISTRIES[minTop[0]] || '国の機関'}との取引が最も多く${minTop[1]}件${catTop ? `、業務分野では「${LABEL[catTop[0]]}」が中心` : ''}です。`]);
  if (histories.length) {
    const h = histories[0];
    const m = monthMode(h.cl);
    faqs.push([`${name}が関わる契約の次回公告はいつ頃ですか?`,
      `「${h.a.name}」は例年${m}月頃に落札が決まっており、次回の公告は${((m + 10 - 1) % 12) + 1}月頃が目安です（過去の周期からの推定であり、発注を保証するものではありません）。`]);
  }
  const faqHtml = `<h2>よくある質問</h2>${faqs.map(([q, a]) => `<h3>Q. ${esc(q)}</h3><p>A. ${esc(a)}</p>`).join('\n')}`;
  const faqLd = { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: faqs.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) };

  // 同じ土俵の企業（主戦場= 最頻の機関×分野 の他社）
  let cohortHtml = '';
  if (catTop) {
    const pk = minTop[0] + '|' + catTop[0];
    const cohort = [...(pairCompanies.get(pk) || new Map()).entries()]
      .filter(([no]) => no !== corpNo && (byCompany.get(no) || []).length >= MIN_COMPANY_AWARDS)
      .sort((x, y) => y[1] - x[1]).slice(0, 10);
    if (cohort.length) {
      cohortHtml = `<h2>同じ土俵の企業（${MINISTRIES[minTop[0]] || ''}×${LABEL[catTop[0]]}）</h2>
<ul>${cohort.map(([no, n]) => `<li>${companyLink(no, esc(companyName.get(no) || no))}（${n.toLocaleString()}件）</li>`).join('')}</ul>`;
    }
  }

  page(`/company/${corpNo}/`, {
    title: `${name}の入札結果・落札実績【官公庁${list.length.toLocaleString()}件】${dupName ? `（法人番号${corpNo}）` : ''}｜${SITE}`,
    desc: `${name}の入札結果・落札実績${list.length.toLocaleString()}件（法人番号${corpNo}）。${summary}継続契約の落札履歴と次回公告の目安、同分野の落札企業をデータで公開。`,
    crumb: [['落札企業', '/company/'], [name, '']],
    lastmod: list[0]?.award_date,
    jsonld: [{ '@context': 'https://schema.org', '@type': 'Organization', name, identifier: corpNo, url: `${ORIGIN}/company/${corpNo}/` }, faqLd],
    body: `<h1>${esc(name)}の入札結果・落札実績</h1>
<p class="meta">法人番号 ${corpNo}。調達ポータル公表の落札実績オープンデータに基づく。</p>
${kunSays(esc(summary) + (histories.length ? ` 複数年くり返し発注されている継続契約${histories.length}件に関わっているよ（下に履歴と次回公告の目安があるよ）。` : ''), 'normal')}
${statBoxes([['落札件数', list.length.toLocaleString() + '件'], ['落札総額', yen(total)], ['直近の落札', list[0].award_date]])}
${analysisHtml}
${histHtml ? `<h2>継続契約の落札履歴と次回予測</h2>
<p class="meta">この会社が関わる案件のうち、複数年繰り返し発注されているもの。過去に誰がいくらで落札してきたかの履歴です。</p>${histHtml}` : ''}
<h2>取引の多い機関</h2>${groupTable(list, (a) => a.ministry_code, (k) => MINISTRIES[k] || k, (k) => organHref(k))}
<h2>業務分野</h2>${groupTable(list.filter((a) => a.slug && a.slug !== 'other'), (a) => a.slug, (k) => LABEL[k] || k, (k) => `/price/${k}/`)}
${cohortHtml}
${(() => { const loc = byCorpLocal.get(corpNo); if (!loc?.length) return ''; const lt = loc.reduce((s, a) => s + (a.amount || 0), 0); return `<h2>自治体の落札実績（${loc[0].pref}域）</h2>
<p class="meta">県・市町村の入札結果公表より（収録地域は順次拡大中）。${loc.length.toLocaleString()}件・総額${yen(lt)}。</p>
<div class="wrap"><table><tr><th>開札日</th><th>案件名</th><th>発注機関</th><th>金額</th></tr>
${loc.slice(0, 15).map((a) => `<tr><td>${a.open_date}</td><td>${esc(a.name)}</td><td>${esc(a.org)}</td><td class="num">${yen(a.amount)}</td></tr>`).join('\n')}</table></div>`; })()}
<h2>直近の落札案件</h2>${awardRows(list.slice(0, RECENT_LIMIT), { company: false, freeRows: 3 })}
${list.length > 3 ? `<p class="tbl-note unlock-hide">4件目以降の落札金額は<b>無料会員</b>（メール登録）で表示されます。 ${unlockBtn(`/company/${corpNo}/`)}</p>` : ''}
<div class="lockbox"><h3>${esc(name)}の攻略データ（ウォッチ会員限定）</h3>
<p style="margin:4px 0"><b>価格傾向</b>: 同分野・同規模帯の中央値比 ${gP('●●%')}　<b>保有する継続契約</b>: ${gP(histories.length ? `${histories.length}件` : '●件')}（次回公告の目安つき）　<b>新規落札の通知</b>: 即時</p>
<p class="meta" style="margin:4px 0">この会社がどの価格帯で入れてくるか、いま持っている契約はいつ次の公告を迎えるか——競合として追うための材料です（月9,800円・準備中）。</p></div>
${faqHtml}`,
  });
}

let catIndexHtml = '';
// 業種別の企業索引（主戦場=最頻分野で企業を引ける。企業ページへの第3のクロール経路）
{
  const byPrimaryCat = new Map();
  for (const [no, l] of byCompany) {
    if (l.length < MIN_COMPANY_AWARDS) continue;
    const cnt = new Map();
    for (const a of l) if (a.slug && a.slug !== 'other') cnt.set(a.slug, (cnt.get(a.slug) || 0) + 1);
    const top = [...cnt.entries()].sort((x, y) => y[1] - x[1])[0];
    if (!top) continue;
    (byPrimaryCat.get(top[0]) ?? byPrimaryCat.set(top[0], []).get(top[0])).push([no, l.length, top[1]]);
  }
  const CPER = 200;
  for (const [slug, list] of byPrimaryCat) {
    list.sort((x, y) => y[1] - x[1]);
    const pages = Math.ceil(list.length / CPER);
    for (let pg = 0; pg < pages; pg++) {
      const slice = list.slice(pg * CPER, (pg + 1) * CPER);
      const path = pg === 0 ? `/company/cat/${slug}/` : `/company/cat/${slug}/page/${pg + 1}/`;
      const nav = pages > 1 ? `<p>${pg > 0 ? `<a href="${pg === 1 ? `/company/cat/${slug}/` : `/company/cat/${slug}/page/${pg}/`}">← 前へ</a>　` : ''}${pg + 1} / ${pages}ページ${pg < pages - 1 ? `　<a href="/company/cat/${slug}/page/${pg + 2}/">次へ →</a>` : ''}</p>` : '';
      page(path, {
        title: `${LABEL[slug]}を主力とする落札企業一覧${pg ? `（${pg + 1}ページ目）` : ''}【${list.length.toLocaleString()}社】｜${SITE}`,
        desc: `官公庁入札で「${LABEL[slug]}」分野の落札が最も多い企業${list.length.toLocaleString()}社を落札件数順に掲載。各社の落札実績・取引機関・継続契約の履歴へ。`,
        crumb: pg === 0 ? [['落札企業', '/company/'], [LABEL[slug], '']] : [['落札企業', '/company/'], [LABEL[slug], `/company/cat/${slug}/`], [`${pg + 1}ページ目`, '']],
        body: `<h1>${LABEL[slug]}を主力とする落札企業</h1>
<p>官公庁入札の落札実績のうち「${LABEL[slug]}」分野が最も多い企業です。相場は<a href="/price/${slug}/">${LABEL[slug]}の落札相場</a>${radarSlugs.includes(slug) ? `、次回公告の目安は<a href="/radar/${slug}/">満了レーダー</a>` : ''}へ。</p>${nav}
<ol start="${pg * CPER + 1}">${slice.map(([no, n, c]) => `<li><a href="/company/${no}/">${esc(companyName.get(no) || no)}</a>（全${n.toLocaleString()}件・うち${LABEL[slug]}${c.toLocaleString()}件）</li>`).join('')}</ol>${nav}`,
      });
    }
  }
  // 企業ハブ（1ページ目）に業種索引への導線
  catIndexHtml = `<h2>業種別に探す</h2><p>${[...byPrimaryCat.entries()].sort((x, y) => y[1].length - x[1].length).map(([s, l]) => `<a href="/company/cat/${s}/">${LABEL[s]}</a>（${l.length.toLocaleString()}社）`).join(' ／ ')}</p>`;
}

// 企業ハブ（全社をページネーションで列挙 → 内部リンク孤児をなくす）
const topCompanies = [...byCompany.entries()].filter(([, l]) => l.length >= MIN_COMPANY_AWARDS)
  .sort((x, y) => y[1].length - x[1].length);
const PER_PAGE = 200;
const hubPages = Math.ceil(topCompanies.length / PER_PAGE);
for (let p = 0; p < hubPages; p++) {
  const slice = topCompanies.slice(p * PER_PAGE, (p + 1) * PER_PAGE);
  const path = p === 0 ? '/company/' : `/company/page/${p + 1}/`;
  const nav = `<p>${p > 0 ? `<a href="${p === 1 ? '/company/' : `/company/page/${p}/`}">← 前へ</a>　` : ''}${p + 1} / ${hubPages}ページ${p < hubPages - 1 ? `　<a href="/company/page/${p + 2}/">次へ →</a>` : ''}</p>`;
  page(path, {
    title: p === 0 ? `官公庁入札の落札企業データベース（${companyCount.toLocaleString()}社） | ${SITE}`
      : `落札企業一覧 ${p + 1}ページ目（落札件数順） | ${SITE}`,
    desc: `官公庁入札で落札実績のある企業${companyCount.toLocaleString()}社を法人番号ベースで収録。落札件数順の一覧${p + 1}ページ目。`,
    crumb: p === 0 ? [['落札企業', '']] : [['落札企業', '/company/'], [`${p + 1}ページ目`, '']],
    body: `<h1>落札企業データベース${p > 0 ? `（${p + 1}ページ目）` : ''}</h1>
<p>官公庁入札で落札実績のある${companyCount.toLocaleString()}社を収録（落札件数順）。</p>${p === 0 ? catIndexHtml : ''}${nav}
<ol start="${p * PER_PAGE + 1}">${slice.map(([no, l]) => `<li><a href="/company/${no}/">${esc(companyName.get(no) || no)}</a>（${l.length.toLocaleString()}件）</li>`).join('')}</ol>${nav}`,
  });
}

// 機関ページ
let organCount = 0;
for (const [code, list] of byMinistry) {
  const name = MINISTRIES[code];
  if (!name || list.length < MIN_PRICE_AWARDS) continue;
  organCount++;
  page(`/organ/${code.toLowerCase()}/`, {
    title: `${name}の入札結果・落札結果一覧【${list.length.toLocaleString()}件】｜${SITE}`,
    desc: `${name}の入札結果・落札結果を${list.length.toLocaleString()}件収録（毎日更新）。落札企業ランキング・よく発注される業務・発注時期のパターン・直近の落札一覧を公式公表データから構造化して公開。`,
    crumb: [['発注機関', '/organ/'], [name, '']],
    lastmod: list[0]?.award_date,
    body: `<h1>${esc(name)}の落札結果</h1>
${statBoxes([['実績件数', list.length.toLocaleString() + '件'], ['落札総額', yen(list.reduce((s, a) => s + (a.amount || 0), 0))]])}
${kunSays(insights(list, name))}
<h2>発注時期のパターン</h2>${monthChart(list, name)}
<h2>発注の多い業務</h2>${groupTable(list.filter((a) => a.slug && a.slug !== 'other'), (a) => a.slug, (k) => LABEL[k] || k, (k) => `/price/${k}/`)}
<h2>落札の多い企業</h2>${groupTable(list.filter((a) => a.corporate_no), (a) => a.corporate_no, (k) => companyName.get(k) || k, (k) => companyHref(k))}
<h2>直近の落札事例</h2>${awardRows(list.slice(0, RECENT_LIMIT))}`,
  });
}
page('/organ/', {
  title: `発注機関別の落札結果一覧 | ${SITE}`,
  desc: '国の機関別に落札結果を集約。省庁ごとの発注傾向・落札企業がわかります。',
  crumb: [['発注機関', '']],
  body: `<h1>発注機関別の落札結果</h1><ul>${[...byMinistry.entries()].filter(([c, l]) => MINISTRIES[c] && l.length >= MIN_PRICE_AWARDS)
    .sort((x, y) => y[1].length - x[1].length)
    .map(([c, l]) => `<li><a href="/organ/${c.toLowerCase()}/">${MINISTRIES[c]}</a>（${l.length.toLocaleString()}件）</li>`).join('')}</ul>`,
});

// アラートLP（POSTはNetlify Functionで中継。hidden formはNetlify Formsの検出用）
const PREFS = ['北海道','青森県','岩手県','宮城県','秋田県','山形県','福島県','茨城県','栃木県','群馬県','埼玉県','千葉県','東京都','神奈川県','新潟県','富山県','石川県','福井県','山梨県','長野県','岐阜県','静岡県','愛知県','三重県','滋賀県','京都府','大阪府','兵庫県','奈良県','和歌山県','鳥取県','島根県','岡山県','広島県','山口県','徳島県','香川県','愛媛県','高知県','福岡県','佐賀県','長崎県','熊本県','大分県','宮崎県','鹿児島県','沖縄県'];
page('/alert/', {
  title: `無料会員登録 — 歴代の落札金額・前回比・類似案件検索の全期間が開きます | ${SITE}`,
  desc: 'メール登録だけで、すべての契約の歴代落札金額と前回比、契約ごとの中央値、類似案件検索の全期間が表示されます。月1回の入札機会レポートと、即時通知プランの先行案内も。',
  body: `<h1>無料会員登録</h1>
<p>メール登録だけで、いますぐ次が開きます。</p>
<ul><li><b>すべての契約の歴代落札金額と前回比</b>（公式サイトでは消えてしまう過去の結果も）</li>
<li><b>契約ごとの中央値・価格トレンド</b></li>
<li><b>類似案件検索の全期間・100件表示</b></li>
<li>月1回の「あなたの業種の入札機会レポート」</li></ul>
<p class="meta">気になる契約・競合企業・地域を下の欄に書いておくと、結果や公告が出たときにお知らせする即時通知プラン（月9,800円・準備中）の先行案内をお送りします。</p>
<p id="invalidmsg" class="meta" style="display:none;color:#B8432F">リンクが無効でした。下のフォームから登録し直してください。</p>
<script>if(new URLSearchParams(location.search).get('invalid'))document.getElementById('invalidmsg').style.display='block';</script>
<div id="watchinfo" class="meta"></div>
<script>(function(){var q=new URLSearchParams(location.search);var w=q.get('watch'),n=q.get('name'),id=q.get('id');if(q.get('back'))try{sessionStorage.setItem('nc_back',q.get('back'))}catch(e){}
if(w&&n){var lbl={contract:'契約',company:'会社',organ:'機関',local:'地域',cat:'分野'}[w]||'対象';document.getElementById('watchinfo').innerHTML='ウォッチ対象（'+lbl+'）: <b>'+n.replace(/</g,'&lt;')+'</b>';var f=document.querySelector('input[name=watch_target]');if(f)f.value=lbl+':'+n+(id?' ['+id+']':'');}})();</script>
${OPEN_NOTICES.length ? `<p class="meta">いま全国で公告中の案件: <b>${OPEN_NOTICES.length.toLocaleString()}件</b>（官公需情報ポータル連携・毎日更新）</p>` : ''}
<form name="alert" method="POST" action="/.netlify/functions/alert-form" data-netlify="true" netlify-honeypot="bot-field">
<input type="hidden" name="form-name" value="alert">
<p style="display:none"><label>入力しないでください: <input name="bot-field"></label></p>
<p><label>メールアドレス<br><input type="email" name="email" required style="width:100%;max-width:400px;padding:8px"></label></p>
<p><label>ウォッチしたい対象（契約名・会社名・機関名・地域など。任意）<br><input type="text" name="watch_target" placeholder="例: 寝具等クリーニング業務（法務省） / 株式会社◯◯ / 千葉県 清掃" style="width:100%;max-width:560px;padding:8px"></label></p>
<p><label>業種（主な入札分野）<br><select name="category" required style="padding:8px">
<option value="">選択してください</option>
${TAXONOMY.map((t) => `<option>${t.label}</option>`).join('')}
<option>その他</option></select></label></p>
<p><label>対象の都道府県<br><select name="pref" required style="padding:8px">
<option value="">選択してください</option><option>全国</option>
${PREFS.map((p) => `<option>${p}</option>`).join('')}</select></label></p>
<p><button type="submit" style="background:#0f6ab2;color:#fff;border:0;padding:12px 32px;border-radius:6px;font-weight:700;font-size:1rem">無料で登録する</button></p>
</form>
<p class="meta">登録いただいたメールアドレスは、会員機能の提供とレポート・案内の配信以外に使用しません。配信停止・退会はいつでもできます（<a href="/policy/">会員規約・プライバシー</a>）。</p>`,
});
page('/alert/welcome/', {
  title: `会員を有効にしました | ${SITE}`,
  desc: '入札コンパスの無料会員が有効になりました。歴代の落札金額・前回比・契約ごとの中央値・類似案件検索の全期間をご利用いただけます。',
  noindex: true,
  body: `<div style="text-align:center;margin:24px 0">${kun(90, 'salute')}</div><h1 style="text-align:center">会員を有効にしました!</h1>
<p style="text-align:center"><b>この端末で1年間、歴代の落札金額・前回比・契約の中央値・類似案件検索の全期間が表示されます。</b></p>
<p id="backp" style="text-align:center"><a class="btn" href="/contract/">継続契約データベースを見る</a></p>
<p class="meta" style="text-align:center">別の端末で見るときは、届いたメールの同じリンクを開いてください。</p>
<script>(function(){var q=new URLSearchParams(location.search);var b=q.get('back');if(!b){try{b=sessionStorage.getItem('nc_back')}catch(e){}}if(b&&/^\\//.test(b)){document.getElementById('backp').innerHTML='<a class="btn" href="'+b.replace(/"/g,'')+'">元のページに戻って続きを見る</a>';}})();</script>`,
});
page('/alert/thanks/', {
  title: `登録ありがとうございます | ${SITE}`,
  desc: '入札新着アラートの登録を受け付けました。',
  noindex: true,
  body: `<div style="text-align:center;margin:24px 0">${kun(90, 'salute')}</div><h1 style="text-align:center">登録ありがとうございます!</h1>
<p style="text-align:center"><b>無料会員として、歴代の落札金額・前回比・契約の中央値・類似案件検索の全期間が表示されるようになりました。</b></p>
<p id="backp" style="text-align:center"></p>
<p>ウォッチ（結果・公告の即時通知）の有料プランは準備中です。ご登録のメールに先行案内をお送りします。お問い合わせの方は、確認のうえご連絡します。</p>
<p>それまでの間は<a href="/contract/">継続契約データベース</a>・<a href="/price/">落札相場</a>・<a href="/shindan/">入札機会診断</a>をご活用ください。</p>
<p class="meta" style="text-align:center">この端末では24時間、仮会員として続きが見られます。届いたメールの「会員を有効にする」リンクを開くと、1年間有効になります（別の端末でもそのリンクで開けます）。</p>
<script>(function(){document.cookie='nc_m=1; max-age=86400; path=/; SameSite=Lax';var b=null;try{b=sessionStorage.getItem('nc_back')}catch(e){}if(b&&/^\//.test(b)){document.getElementById('backp').innerHTML='<a class="btn" href="'+b.replace(/"/g,'')+'">元のページに戻って続きを見る</a>';}})();</script>`,
});

// 自治体ページ（落札データのある県 ∪ 公告のある全国47県）
// 落札=過去の実績、公告=いま出ている案件。両方を1ページに統合する。
let localCityCount = 0, localPrefCount = 0;
const cityPagesByPref = new Map(); // 県slug → Set(市区町村名)。生成された市区町村ページの実在集合
const localByPref = new Map();
for (const a of LOCALS) (localByPref.get(a.pref) ?? localByPref.set(a.pref, []).get(a.pref)).push(a);

const noticeTable = (list, { withCity = false } = {}) => `<div class="wrap"><table><tr><th>公告日</th><th>案件名</th><th>発注機関</th>${withCity ? '<th>地域</th>' : ''}<th>区分</th></tr>
${list.slice(0, 40).map((n) => `<tr><td>${n.issue_date || '—'}</td><td>${n.url ? `<a href="${esc(n.url)}" rel="nofollow noopener">${esc(n.name)}</a>` : esc(n.name)}</td><td>${esc(n.org || '')}</td>${withCity ? `<td>${esc(n.city || '')}</td>` : ''}<td>${esc(n.category || '')}${n.deadline ? `<br><span class="meta">入札 ${n.deadline}</span>` : ''}</td></tr>`).join('\n')}</table></div>
<p class="meta">出典: 官公需情報ポータルサイト（中小企業庁）。直近35日間に公告された案件を新しい順に掲載しています（毎日更新）。応募可否・締切は必ず公告原文でご確認ください。</p>`;
// 自治体自身の発注か（機関名に市区町村名を含む）を判定。国の出先機関の所在地混入を避けるため。
const isOwnOrg = (n, city) => (n.org || '').includes(city);
const histTable = (list, max = 60) => `<div class="wrap"><table><tr><th>公告日</th><th>案件名</th><th>発注機関</th><th>区分</th></tr>
${list.slice(0, max).map((n) => `<tr><td>${n.issue_date || ''}</td><td>${esc(n.name)}</td><td>${esc(n.org || '')}</td><td>${esc(n.category || '')}</td></tr>`).join(String.fromCharCode(10))}</table></div>
${list.length > max ? `<p class="meta">ほか${(list.length - max).toLocaleString()}件を収録。</p>` : ''}`;
const histStats = (list, name) => {
  if (!list.length) return '';
  const ym = new Map(), cat = new Map();
  for (const n of list) {
    const m = (n.issue_date || '').slice(0, 7);
    if (m) ym.set(m, (ym.get(m) || 0) + 1);
    if (n.slug && n.slug !== 'other') cat.set(n.slug, (cat.get(n.slug) || 0) + 1);
  }
  const cats = [...cat.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([s, c]) => `${LABEL[s] || s}（${c}件）`).join('、');
  const months = [...ym.entries()].sort().slice(-6).map(([m, c]) => `${Number(m.slice(5))}月 ${c}件`).join(' / ');
  return `<p>${esc(name)}の公告履歴 ${list.length.toLocaleString()}件の内訳: ${cats || '分類集計中'}。月別の公告数は ${months}。
官公需情報ポータル等では公告は掲載期間終了後に閲覧できなくなりますが、当サイトは取得済みの公告を履歴として保持しています。</p>`;
};

const allPrefs = new Set([...localByPref.keys(), ...noticeByPref.keys()]);
for (const prefName of allPrefs) {
  const pslug = PREF_SLUGS[prefName];
  if (!pslug) continue;
  const plist = localByPref.get(prefName) || [];
  const nlist = noticeByPref.get(prefName) || [];
  if (!plist.length && nlist.length < 5) continue; // 品質フィルタ
  localPrefCount++;
  const hasAwards = plist.length > 0;

  let awardHtml = '';
  if (hasAwards) {
    const orgAgg = new Map();
    for (const a of plist) { const o = orgAgg.get(a.org) ?? { n: 0, sum: 0 }; o.n++; o.sum += a.amount || 0; orgAgg.set(a.org, o); }
    const localCorp = new Map();
    for (const a of plist) { const k = a.corporate_no || a.winner_name; if (!k || (!a.corporate_no && /^[-－ー\s]*$/.test(a.winner_name || ''))) continue; const o = localCorp.get(k) ?? { n: 0, corp: a.corporate_no, name: a.winner_name }; o.n++; localCorp.set(k, o); }
    const topLocal = [...localCorp.values()].sort((x, y) => y.n - x.n).slice(0, 20);
    awardHtml = `<h2>機関別の落札件数</h2><div class="wrap"><table><tr><th>機関</th><th>件数</th><th>合計金額</th></tr>
${[...orgAgg.entries()].sort((x, y) => y[1].n - x[1].n).slice(0, 45).map(([o, v]) => `<tr><td>${o !== prefName && v.n >= 30 ? `<a href="/local/${pslug}/${encodeURIComponent(o)}/">${esc(o)}</a>` : esc(o)}</td><td class="num">${v.n.toLocaleString()}</td><td class="num">${yen(v.sum)}</td></tr>`).join('\n')}</table></div>
<h2>落札の多い企業</h2><ul>${topLocal.map((v) => `<li>${v.corp && byCompany.has(v.corp) && (byCompany.get(v.corp) || []).length >= MIN_COMPANY_AWARDS ? `<a href="/company/${v.corp}/">${esc(companyName.get(v.corp) || v.name)}</a>` : esc(v.name)}（${v.n}件）</li>`).join('')}</ul>
<h2>直近の落札</h2><div class="wrap"><table><tr><th>開札日</th><th>案件名</th><th>機関</th><th>落札者</th><th>金額</th></tr>
${plist.slice(0, 30).map((a) => `<tr><td>${a.open_date}</td><td>${esc(a.name)}</td><td>${esc(a.org)}</td><td>${esc(a.winner_name)}</td><td class="num">${yen(a.amount)}</td></tr>`).join('\n')}</table></div>`;
  }

  // 市区町村ページの生成条件（落札30件以上 or 自治体自身の公告が直近3件/履歴3件以上）を満たす市だけを対象にする。
  // 県ページのリンク一覧とページ生成が同じ判定を使うことで、リンク切れを構造的に防ぐ
  const cityEligible = new Map(); // city → 件数（表示用）
  {
    const cand = new Set();
    for (const a of plist) if (a.org && a.org !== prefName) cand.add(a.org);
    for (const [k] of noticeByCity) if (k.startsWith(prefName + '|')) cand.add(k.split('|')[1]);
    for (const [k] of histByCity) if (k.startsWith(prefName + '|')) cand.add(k.split('|')[1]);
    for (const city of cand) {
      const nA = plist.filter((a) => a.org === city).length;
      const nOwn = (noticeByCity.get(prefName + '|' + city) || []).filter((n) => isOwnOrg(n, city)).length;
      const nHist = (histByCity.get(prefName + '|' + city) || []).filter((n) => isOwnOrg(n, city)).length;
      if (nA >= 30 || nOwn >= 3 || nHist >= 3) cityEligible.set(city, nA + nOwn + nHist);
    }
  }
  const title = hasAwards
    ? `${prefName}の入札結果・入札情報【${ymLabel(plist[0]?.open_date)}更新・県と市町村の落札${plist.length.toLocaleString()}件】｜${SITE}`
    : `${prefName}の入札情報・公告一覧【公告中${nlist.length.toLocaleString()}件】｜${SITE}`;
  const desc = hasAwards
    ? `${prefName}と県内市町村の入札結果（落札者・落札金額）を${ymLabel(plist[0]?.open_date)}分まで${plist.length.toLocaleString()}件横断収録、毎日更新。直近の公告${nlist.length}件、機関別の落札件数、落札企業、直近の落札案件を公開。`
    : `${prefName}で直近35日間に公告された入札案件${nlist.length.toLocaleString()}件を毎日更新で掲載。発注機関・案件名・区分・公告原文へのリンクをまとめています。`;

  page(`/local/${pslug}/`, {
    title, desc,
    crumb: [['自治体の入札結果', '/local/'], [prefName, '']],
    lastmod: hasAwards ? plist[0]?.open_date : (nlist[0]?.issue_date || BUILT_AT),
    body: `<h1>${hasAwards ? `${prefName}の入札結果・入札情報` : `${prefName}の入札情報`}</h1>
${kunSays(hasAwards
    ? `${prefName}域の入札結果を<b>${plist.length.toLocaleString()}件</b>収録（県+市町村を横断）。直近の公告は<b>${nlist.length.toLocaleString()}件</b>あるよ!`
    : `${prefName}で直近に公告された入札案件は<b>${nlist.length.toLocaleString()}件</b>だよ。毎日更新しているよ!`)}
${statBoxes([...(hasAwards ? [['落札実績', plist.length.toLocaleString() + '件']] : []), ['直近の公告', nlist.length.toLocaleString() + '件'], ...((histByPref.get(prefName) || []).length ? [['公告の履歴', (histByPref.get(prefName) || []).length.toLocaleString() + '件']] : []), ['更新', '毎日']])}
${nlist.length ? `<h2>直近の入札公告</h2>${noticeTable(nlist, { withCity: true })}` : ''}
${(() => { const cities = [...cityEligible.entries()].sort((a, b) => b[1] - a[1]).slice(0, 80);
  return cities.length ? `<h2>市区町村別の入札情報</h2><p>${cities.map(([city, n]) => `<a href="/local/${pslug}/${encodeURIComponent(city)}/">${esc(city)}</a>（${n}）`).join(' ／ ')}</p>` : ''; })()}
${(() => { const pc = (noticeByPref.get(prefName) || []).filter((n) => PROP_RE.test(n.name)).length + (histByPref.get(prefName) || []).filter((n) => PROP_RE.test(n.name)).length;
  return pc >= 3 ? `<p><a href="/proposal/${pslug}/"><b>→ ${prefName}の公募・プロポーザル案件だけを見る</b>（${pc.toLocaleString()}件）</a></p>` : ''; })()}
${awardHtml}
${!hasAwards ? `<p class="meta">${prefName}の落札結果データは順次収録予定です。国の機関の落札実績は<a href="/price/">業務別の落札相場</a>から確認できます。</p>` : ''}`,
  });

  // 市区町村ページ: 落札30件以上 ∪ 公告5件以上
  for (const city of cityEligible.keys()) cityPagesByPref.set(pslug, (cityPagesByPref.get(pslug) || new Set()).add(city));
  for (const city of cityEligible.keys()) {
    const olist = plist.filter((a) => a.org === city);
    const cnotices = noticeByCity.get(prefName + '|' + city) || [];
    const ownNotices = cnotices.filter((n) => isOwnOrg(n, city));   // その自治体自身の発注
    const natNotices = cnotices.filter((n) => !isOwnOrg(n, city));  // 市内に所在する国の機関等
    const chist = histByCity.get(prefName + '|' + city) || [];      // 公告アーカイブ（現在窓と重複しない過去分）
    const histOwn = chist.filter((n) => isOwnOrg(n, city));
    // 自治体自身の情報が薄いページは作らない（所在地混入だけのページを防ぐ）
    if (olist.length < 30 && ownNotices.length < 3 && histOwn.length < 3) continue;
    localCityCount++;
    const amounts = olist.map((a) => a.amount).filter((n) => n > 0);
    const hasA = olist.length >= 30;

    let cityAward = '';
    if (hasA) {
      const cityCorp = new Map();
      for (const a of olist) { const k = a.corporate_no || a.winner_name; if (!k || (!a.corporate_no && /^[-－ー\s]*$/.test(a.winner_name || ''))) continue; const o = cityCorp.get(k) ?? { n: 0, corp: a.corporate_no, name: a.winner_name }; o.n++; cityCorp.set(k, o); }
      const catAgg = new Map();
      for (const a of olist) { if (a.slug && a.slug !== 'other') { const o = catAgg.get(a.slug) ?? { n: 0, sum: 0 }; o.n++; o.sum += a.amount || 0; catAgg.set(a.slug, o); } }
      cityAward = `<h2>発注の多い業務</h2><div class="wrap"><table><tr><th>業務</th><th>件数</th><th>合計金額</th></tr>
${[...catAgg.entries()].sort((x, y) => y[1].n - x[1].n).slice(0, 12).map(([s, v]) => `<tr><td>${prefCatPages.has(s + '|' + pslug) ? `<a href="/price/${s}/${pslug}/">${LABEL[s] || s}</a>` : (LABEL[s] || s)}</td><td class="num">${v.n.toLocaleString()}</td><td class="num">${yen(v.sum)}</td></tr>`).join('\n')}</table></div>
<h2>落札の多い企業</h2><ul>${[...cityCorp.values()].sort((x, y) => y.n - x.n).slice(0, 15).map((v) => `<li>${v.corp && byCompany.has(v.corp) && (byCompany.get(v.corp) || []).length >= MIN_COMPANY_AWARDS ? `<a href="/company/${v.corp}/">${esc(companyName.get(v.corp) || v.name)}</a>` : esc(v.name)}（${v.n}件）</li>`).join('')}</ul>
<h2>発注時期のパターン</h2>${monthChart(olist.map((a) => ({ award_date: a.open_date })), city)}
<h2>直近の落札案件</h2><div class="wrap"><table><tr><th>開札日</th><th>案件名</th><th>落札者</th><th>金額</th></tr>
${olist.slice(0, 30).map((a) => `<tr><td>${a.open_date}</td><td>${esc(a.name)}</td><td>${a.corporate_no && byCompany.has(a.corporate_no) && (byCompany.get(a.corporate_no) || []).length >= MIN_COMPANY_AWARDS ? `<a href="/company/${a.corporate_no}/">${esc(a.winner_name)}</a>` : esc(a.winner_name)}</td><td class="num">${yen(a.amount)}</td></tr>`).join('\n')}</table></div>`;
    }

    page(`/local/${pslug}/${city}/`, {
      title: hasA
        ? `${city}の入札結果【${ymLabel(olist[0]?.open_date)}更新・${olist.length.toLocaleString()}件】落札者と落札金額の一覧｜${SITE}`
        : (ownNotices.length
          ? `${city}の入札情報【直近の公告${ownNotices.length}件・履歴${(ownNotices.length + histOwn.length).toLocaleString()}件】｜${SITE}`
          : `${city}の入札情報【公告の履歴${histOwn.length.toLocaleString()}件を収録】｜${SITE}`),
      desc: hasA
        ? `${city}の入札結果（落札者・落札金額）を${ymLabel(olist[0]?.open_date)}分まで${olist.length.toLocaleString()}件収録、毎日更新。落札価格の中央値${yen(median(amounts))}、発注の多い業務、落札の多い企業、直近の入札公告を公開。`
        : (ownNotices.length
          ? `${city}が発注した入札情報を毎日更新で収録（直近の公告${ownNotices.length}件・公告の履歴${(ownNotices.length + histOwn.length).toLocaleString()}件）。掲載期間が終わって公式サイトで見られなくなった公告も履歴として保持しています。`
          : `${city}が発注した入札の公告履歴${histOwn.length.toLocaleString()}件を収録。掲載期間が終わって公式サイトで見られなくなった公告も履歴として保持し、新しい公告が出れば毎日の更新で掲載します。`),
      crumb: [['自治体の入札結果', '/local/'], [prefName, `/local/${pslug}/`], [city, '']],
      lastmod: hasA ? olist[0]?.open_date : (cnotices[0]?.issue_date || chist[0]?.issue_date || BUILT_AT),
      jsonld: hasA ? { '@context': 'https://schema.org', '@type': 'Dataset', name: `${city}の落札実績データ`, description: `${city}の入札結果${olist.length}件`, creator: { '@type': 'Organization', name: SITE } } : null,
      body: `<h1>${hasA ? `${city}の入札結果・入札情報` : `${city}の入札情報`}</h1>
${kunSays(hasA
    ? `${city}の入札結果を<b>${olist.length.toLocaleString()}件</b>収録。落札価格の中央値は<b>${yen(median(amounts))}</b>だよ${ownNotices.length ? `。直近の公告は<b>${ownNotices.length}件</b>あるよ!` : ''}`
    : (ownNotices.length
      ? `${city}が発注した直近の公告は<b>${ownNotices.length}件</b>、過去の公告履歴は<b>${histOwn.length.toLocaleString()}件</b>あるよ。毎日更新しているよ!`
      : `${city}の公告の履歴を<b>${histOwn.length.toLocaleString()}件</b>収録しているよ。新しい公告が出たら毎日の更新で載せるよ!`))}
${statBoxes([...(hasA ? [['落札実績', olist.length.toLocaleString() + '件'], ['落札価格の中央値', yen(median(amounts))]] : []), ['直近の公告', ownNotices.length + '件'], ...(chist.length ? [['公告の履歴', chist.length.toLocaleString() + '件']] : [])])}
${ownNotices.length ? `<h2>${city}が発注した直近の入札公告</h2>${noticeTable(ownNotices)}` : ''}
${natNotices.length ? `<h2>${city}に所在する国の機関等の入札公告</h2>
<p class="meta">発注機関の所在地が${city}の案件です（履行場所は他地域の場合があります）。</p>${noticeTable(natNotices)}` : ''}
${(() => { const pc = ownNotices.filter((n) => PROP_RE.test(n.name)); const ph = histOwn.filter((n) => PROP_RE.test(n.name));
  if (pc.length + ph.length < 1) return '';
  return `<h2>${city}の公募・プロポーザル案件</h2>
<p>${city}が公募型プロポーザル・企画競争・公募で募集した案件です。提案内容で受注者が決まる方式のため、例年の募集時期を知っておくと先回りの準備ができます。${pc.length ? `現在募集中は<b>${pc.length}件</b>。` : `直近の募集はありませんが、履歴${ph.length}件を収録しています。`}</p>
${pc.length ? noticeTable(pc) : ''}
${ph.length ? histTable(ph, 20) : ''}
<p class="meta"><a href="${propPrefOk.has(prefName) ? `/proposal/${pslug}/` : '/proposal/'}">→ ${propPrefOk.has(prefName) ? `${prefName}全体` : '全国'}の公募・プロポーザル案件を見る</a></p>`; })()}
${cityAward}
${chist.length >= 3 ? `<h2>${city}の公告の履歴</h2>
${histStats(chist, city)}
${histTable(chist)}
<p class="meta">履歴は当サイトが官公需情報ポータル等から取得し保存したものです。掲載期間終了後の原文は各発注機関にお問い合わせください。</p>` : ''}
${(() => { const others = [...cityEligible.entries()].filter(([c]) => c !== city).sort((a, b) => b[1] - a[1]).slice(0, 15);
  return others.length ? `<h2>${prefName}の他の市区町村</h2><p>${others.map(([c]) => `<a href="/local/${pslug}/${encodeURIComponent(c)}/">${esc(c)}</a>`).join(' ／ ')}</p>` : ''; })()}
<p><a href="/local/${pslug}/">→ ${prefName}全体の入札情報を見る</a></p>`,
    });
  }
}
if (localPrefCount) {
  page('/local/', {
    title: `全国の入札情報・入札結果（都道府県別） | ${SITE}`,
    desc: '全国47都道府県の入札公告と、県・市町村の入札結果を都道府県別に収録。毎日更新。',
    crumb: [['自治体の入札結果', '']],
    body: `<h1>全国の入札情報・入札結果</h1>
${kunSays(`全国<b>${localPrefCount}都道府県</b>の入札公告と、収録済みの落札結果をまとめているよ。都道府県を選んでね!`)}
<div class="wrap"><table><tr><th>都道府県</th><th>直近の公告</th><th>落札実績</th></tr>
${[...allPrefs].filter((pn) => PREF_SLUGS[pn]).map((pn) => ({ pn, n: (noticeByPref.get(pn) || []).length, a: (localByPref.get(pn) || []).length }))
  .filter((r) => r.a > 0 || r.n >= 5).sort((x, y) => (y.a + y.n) - (x.a + x.n))
  .map((r) => `<tr><td><a href="/local/${PREF_SLUGS[r.pn]}/">${r.pn}</a></td><td class="num">${r.n.toLocaleString()}</td><td class="num">${r.a ? r.a.toLocaleString() + '件' : '—'}</td></tr>`).join('\n')}</table></div>
<p class="meta">公告は全国を毎日収録。落札結果は千葉・秋田・静岡から順次拡大中です。</p>`,
  });
}

// 週間レポート（毎週自動で新ページが増える鮮度資産。過去26週分を遡って生成）
{
  const companyFirst = new Map(); // corpNo → 初落札日
  for (let i = AWARDS.length - 1; i >= 0; i--) { // AWARDSは日付降順なので逆走査で最古から
    const a = AWARDS[i];
    if (a.corporate_no && !companyFirst.has(a.corporate_no)) companyFirst.set(a.corporate_no, a.award_date);
  }
  const fmtMD = (iso) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;
  const today = new Date(BUILT_AT + 'T00:00:00Z');
  const dow = (today.getUTCDay() + 6) % 7; // 月曜=0
  let monday = new Date(today.getTime() - (dow + 7) * 86400000); // 直近の完了した週の月曜
  const weekly = [];
  for (let w = 0; w < 26; w++) {
    const start = new Date(monday.getTime() - w * 7 * 86400000);
    const end = new Date(start.getTime() + 6 * 86400000);
    const s = start.toISOString().slice(0, 10), e = end.toISOString().slice(0, 10);
    const list = AWARDS.filter((a) => a.award_date >= s && a.award_date <= e);
    if (list.length < 50) continue;
    const slug = s.replaceAll('-', '');
    const total = list.reduce((x, a) => x + (a.amount || 0), 0);
    // 大型案件トップ10
    const big = [...list].sort((x, y) => (y.amount || 0) - (x.amount || 0)).slice(0, 10);
    // 契約リプレイス: 同一契約クラスタで直前回と落札者が変わった事例
    const repl = [];
    for (const a of list) {
      if (!a.corporate_no) continue;
      const cl = clusters.get(clusterKey(a));
      if (!cl || cl.length < 2) continue;
      const prev = cl.filter((x) => x.award_date < a.award_date && x.corporate_no)
        .sort((x, y) => (x.award_date < y.award_date ? 1 : -1))[0];
      if (prev && prev.corporate_no !== a.corporate_no &&
          (new Date(a.award_date) - new Date(prev.award_date)) / 86400000 <= 550) {
        repl.push({ a, prev });
        if (repl.length >= 10) break;
      }
    }
    // 新規参入: この週に初落札した企業
    const debut = [...new Set(list.map((a) => a.corporate_no).filter(Boolean))]
      .filter((no) => companyFirst.get(no) >= s && companyFirst.get(no) <= e).slice(0, 10);
    const label = `${Number(s.slice(0, 4))}年${fmtMD(s)}〜${fmtMD(e)}`;
    weekly.push({ slug, s, e, label, count: list.length, total });
    page(`/weekly/${slug}/`, {
      title: `官公庁入札 週間レポート ${label} — 落札${list.length.toLocaleString()}件・リプレイス${repl.length}件 | ${SITE}`,
      desc: `${label}の官公庁落札動向。落札${list.length.toLocaleString()}件・総額${yen(total)}。大型案件、契約が業者交代したリプレイス事例${repl.length}件、新規参入${debut.length}社をデータで解説。`,
      crumb: [['週間レポート', '/weekly/'], [label, '']],
      lastmod: e,
      body: `<h1>官公庁入札 週間レポート（${label}）</h1>
${kunSays(`この週の国の機関の落札は<b>${list.length.toLocaleString()}件・総額${yen(total)}</b>! 契約の業者交代（リプレイス）を<b>${repl.length}件</b>見つけたよ${debut.length ? `。初めて落札した新規参入は<b>${debut.length}社</b>` : ''}。`)}
<h2>今週の大型案件</h2>${awardRows(big)}
${repl.length ? `<h2>契約リプレイス（業者交代が起きた契約）</h2>
<p class="meta">前回と落札者が変わった契約。競争が動いた場所であり、次回の狙い目でもあります。</p>
<div class="wrap"><table><tr><th>案件</th><th>新しい落札者</th><th>今回</th><th>前回の落札者</th><th>前回</th></tr>
${repl.map(({ a, prev }) => `<tr><td>${esc(a.name)}</td><td>${companyLink(a.corporate_no, esc(a.winner_name))}</td><td class="num">${yen(a.amount)}</td><td>${companyLink(prev.corporate_no, esc(prev.winner_name))}</td><td class="num">${yen(prev.amount)}</td></tr>`).join('\n')}</table></div>` : ''}
${debut.length ? `<h2>新規参入（この週に初落札）</h2>
<ul>${debut.map((no) => `<li>${companyLink(no, esc(companyName.get(no) || no))}</li>`).join('')}</ul>` : ''}
<h2>分野別の落札件数</h2>${groupTable(list.filter((a) => a.slug && a.slug !== 'other'), (a) => a.slug, (k) => LABEL[k] || k, (k) => `/price/${k}/`, 8)}`,
    });
  }
  page('/weekly/', {
    title: `官公庁入札 週間レポート一覧 | ${SITE}`,
    desc: '毎週の官公庁落札動向を自動集計。大型案件・契約リプレイス・新規参入企業のデータレポート。',
    crumb: [['週間レポート', '']],
    lastmod: weekly[0]?.e,
    body: `<h1>週間レポート</h1><p>毎週の落札動向・契約リプレイス・新規参入を自動集計しています。</p>
<ul>${weekly.map((w) => `<li><a href="/weekly/${w.slug}/">${w.label}</a> — 落札${w.count.toLocaleString()}件・${yen(w.total)}</li>`).join('')}</ul>`,
  });
}

// 入札機会診断（10秒診断の入札版。統計は事前計算、定番案件はカテゴリdata.jsonから動的算出）
const shindanStats = TAXONOMY.filter((t) => (byCat.get(t.slug) || []).length >= MIN_PRICE_AWARDS).map((t) => {
  const list = byCat.get(t.slug);
  const y24 = list.filter((a) => a.award_date?.startsWith('2024')).length;
  const y25 = list.filter((a) => a.award_date?.startsWith('2025')).length;
  const amt25 = list.filter((a) => a.award_date?.startsWith('2025')).reduce((s, a) => s + (a.amount || 0), 0);
  const amounts = list.map((a) => a.amount).filter((n) => n > 0);
  const bandCounts = BANDS.map((b) => list.filter((a) => a.amount >= b.min && a.amount < b.max).length);
  const minCount = new Map();
  for (const a of list) minCount.set(a.ministry_code, (minCount.get(a.ministry_code) || 0) + 1);
  return {
    slug: t.slug, label: t.label, total: list.length,
    perYear: Math.round((y24 + y25) / 2), amountYear: amt25,
    median: median(amounts), band: BANDS[bandCounts.indexOf(Math.max(...bandCounts))].label,
    months: monthCounts(list),
    topMins: [...minCount.entries()].filter(([c]) => MINISTRIES[c]).sort((x, y) => y[1] - x[1]).slice(0, 5),
  };
});
// 開いている公告（KKJ）を診断に接続: 分類×都道府県の件数と直近サンプル
const openBySlug = {};
for (const nt of OPEN_NOTICES) {
  const s = nt.slug || 'other';
  const o = openBySlug[s] ?? (openBySlug[s] = { n: 0, byPref: {}, sample: [] });
  o.n++;
  if (nt.pref) o.byPref[nt.pref] = (o.byPref[nt.pref] || 0) + 1;
  if (o.sample.length < 3 || (nt.deadline && nt.deadline >= TODAY && o.sample.length < 6)) {
    o.sample.push({ name: nt.name.slice(0, 80), org: nt.org, deadline: nt.deadline || '', url: nt.url });
  }
}
mkdirSync(join(DIST, 'shindan'), { recursive: true });
writeFileSync(join(DIST, 'shindan', 'data.json'),
  JSON.stringify({ mins: MINISTRIES, cats: shindanStats, open: openBySlug, openTotal: OPEN_NOTICES.length, turnover: TURNOVER, turnoverAll: TURNOVER_ALL }));

page('/shindan/', {
  title: `入札機会診断 — あなたの業種の官公庁市場が10秒でわかる | ${SITE}`,
  desc: '業種を選ぶだけで、官公庁入札の年間発注件数・金額・発注機関・落札相場・公告シーズン・毎年出る定番案件がその場でわかる無料診断。登録不要。',
  crumb: [['入札機会診断', '']],
  body: `<div style="display:flex;align-items:center;gap:14px">${kun(72, 'idea')}<div><h1 style="margin:0">入札機会診断</h1>
<p style="margin:4px 0 0">業種を選ぶだけで、<b>あなたの市場の実データ</b>がその場で出るよ。登録不要・無料!</p></div></div>
<div class="tool">
<select id="scat"><option value="">業種を選んでください</option>${shindanStats.map((s) => `<option value="${s.slug}">${s.label}</option>`).join('')}</select>
<select id="spref"><option value="">全国（国の機関）</option>${PREFS.map((p) => `<option>${p}</option>`).join('')}</select>
<span class="meta">地域は案件名からの推定（参考値）。自治体の入札データは順次追加予定です。</span>
<div id="sout"></div>
</div>
<script defer src="/assets/shindan.js"></script>`,
});

// ---------- 都道府県別ガイド（入札参加資格・電子入札の始め方）＋ データレポート ----------
// 検索需要「{県} 入札参加資格」「{県} 電子入札」に正対する47ページ。共通の制度解説＋県ごとの実データで固有化。
const SHIKAKU_SYSTEMS = { // 当サイトが実際にデータ取得している電子入札・入札情報システム（確実なものだけ掲載）
  '千葉県': ['ちば電子調達システム', 'https://www.chiba-ep-bis.supercals.jp/'],
  '静岡県': ['静岡県の電子入札共同システム（入札情報サービス）', 'https://www.ppi.cals-shiz.jp/'],
  '宮崎県': ['宮崎県の入札情報サービス', 'https://www.e-nyusatsu-joho.pref.miyazaki.lg.jp/'],
  '新潟県': ['新潟県の入札情報サービス', 'https://www.ep-bis.pref.niigata.jp/'],
  '愛媛県': ['愛媛県の入札情報サービス', 'https://www.ebid-ppi.pref.ehime.jp/'],
  '秋田県': ['秋田県電子入札システム', 'https://cals05.pref.akita.lg.jp/'],
  '神奈川県': ['かながわ電子入札共同システム', 'https://ebid-joho.e-kanagawa.lg.jp/'],
};
const shikakuPrefs = [];
for (const prefName of PREFS) {
  const pslug = PREF_SLUGS[prefName];
  if (!pslug) continue;
  const cutoff = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
  const all = [...(noticeByPref.get(prefName) || []), ...(histByPref.get(prefName) || [])]
    .filter((n) => (n.issue_date || '') >= cutoff);
  const byCat = new Map(), byOrg = new Map(), byCity = new Map();
  for (const n of all) {
    if (n.category) byCat.set(n.category, (byCat.get(n.category) || 0) + 1);
    if (n.org) byOrg.set(n.org, (byOrg.get(n.org) || 0) + 1);
    if (n.city) byCity.set(n.city, (byCity.get(n.city) || 0) + 1);
  }
  const la = localByPref.get(prefName) || [];
  const laAmounts = la.map((a) => a.amount).filter((x) => x > 0);
  const sys = SHIKAKU_SYSTEMS[prefName];
  const cityPages = cityPagesByPref.get(pslug) || new Set();
  const topOrgs = [...byOrg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  const topCities = [...byCity.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const catLine = [...byCat.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${esc(k)} ${v.toLocaleString()}件`).join('、');
  shikakuPrefs.push([prefName, pslug, all.length]);
  const faqs = [
    [`${prefName}の入札に参加するには何が必要?`,
      `${prefName}や県内市町村の入札に参加するには、原則として発注する自治体ごと（または県内共同）の入札参加資格審査の申請が必要です。国の機関（${prefName}内の出先機関を含む）の入札には全省庁統一資格を取得します。定期受付の時期は自治体により異なるため、「${prefName} 入札参加資格審査」で公式の案内をご確認ください。`],
    [`${prefName}ではどのくらい入札の公告が出ている?`,
      `当サイトの収録では、${prefName}の機関・自治体の入札公告は直近1年間で${all.length.toLocaleString()}件です（官公需情報ポータル連携・毎日更新）。${catLine ? `内訳は${catLine}。` : ''}`],
  ];
  page(`/guide/shikaku/${pslug}/`, {
    title: `${prefName}の入札参加資格と電子入札の始め方【公告${all.length.toLocaleString()}件/年のデータつき】｜${SITE}`,
    desc: `${prefName}の入札に参加する手順を解説。参加資格審査（自治体）と全省庁統一資格（国）の違い、${sys ? `${sys[0]}、` : ''}直近1年の公告${all.length.toLocaleString()}件の内訳・発注の多い機関${la.length ? `・落札実績${la.length.toLocaleString()}件` : ''}を実データで公開。`,
    crumb: [['入札ガイド', '/guide/'], ['都道府県別 参加資格ガイド', '/guide/shikaku/'], [prefName, '']],
    lastmod: all[0]?.issue_date,
    jsonld: { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: faqs.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) },
    body: `<h1>${prefName}の入札参加資格と電子入札の始め方</h1>
${kunSays(`${prefName}の公告は直近1年で<b>${all.length.toLocaleString()}件</b>${la.length ? `、落札結果は<b>${la.length.toLocaleString()}件</b>収録している` : ''}よ。資格の取り方から順番に説明するね!`)}
${statBoxes([['直近1年の公告', all.length.toLocaleString() + '件'], ...(la.length ? [['収録落札実績', la.length.toLocaleString() + '件'], ['落札価格の中央値', yen(median(laAmounts))]] : []), ['更新', '毎日']])}
<h2>1. 参加資格は「自治体」と「国」の2系統</h2>
<p>${prefName}で官公庁入札に参加するには、まず入札参加資格が必要です。資格は大きく2系統に分かれます。</p>
<ul>
<li><b>${prefName}・県内市町村の入札</b> — 発注する自治体ごと（または県内共同方式）の入札参加資格審査に申請します。
建設工事・測量等コンサル・物品/役務で区分が分かれ、定期受付（おおむね2年に1度）と随時受付があります。
申請先・時期・様式は自治体ごとに異なるため、「${prefName} 入札参加資格審査」で最新の公式案内を確認してください</li>
<li><b>国の機関の入札</b>（${prefName}内の地方支分部局・国立大学・独立行政法人等） — <b>全省庁統一資格</b>を1回取得すれば
全省庁で有効です。物品・役務はこの資格で、等級（A〜D）により入札できる案件の規模が決まります。
詳しくは<a href="/guide/hajimekata/">入札のはじめ方ガイド</a>へ</li>
</ul>
<h2>2. ${prefName}の電子入札と案件の探し方</h2>
<p>${sys ? `${prefName}域の入札情報は<a href="${sys[1]}" rel="noopener">${sys[0]}</a>で公開されており、当サイトはここから毎日データを取得・構造化しています。` : `${prefName}の各自治体の電子入札システム・入札情報サービスは自治体の公式サイトから案内されています。`}
案件の横断検索は当サイトの<a href="/local/${pslug}/">${prefName}の入札情報</a>（毎日更新）が便利です。
公告は掲載期間が終わると公式サイトで見られなくなりますが、当サイトは履歴として保持しています。</p>
<h2>3. ${prefName}の入札市場データ（直近1年）</h2>
${topOrgs.length ? `<div class="wrap"><table><tr><th>公告の多い機関</th><th>件数</th></tr>
${topOrgs.map(([o, n]) => `<tr><td>${esc(o)}</td><td class="num">${n.toLocaleString()}</td></tr>`).join(String.fromCharCode(10))}</table></div>` : `<p class="meta">${prefName}の公告データは収集中です。</p>`}
${topCities.length ? `<p><b>市区町村別:</b> ${topCities.map(([c, n]) => cityPages.has(c) ? `<a href="/local/${pslug}/${encodeURIComponent(c)}/">${esc(c)}</a>（${n}）` : `${esc(c)}（${n}）`).join(' ／ ')}</p>` : ''}
${la.length ? `<p>${prefName}の<b>落札結果（誰がいくらで落札したか）は${la.length.toLocaleString()}件</b>を収録しています。
<a href="/local/${pslug}/">→ ${prefName}の入札結果を見る</a></p>` : ''}
<h2>4. 値付けの前に「相場」を確認する</h2>
<p>札を入れる前に、類似案件の落札水準を確認しましょう。<a href="/price/">業務別の落札相場</a>と
<a href="/shindan/">入札機会診断</a>（業種を選ぶだけ・登録不要）で、${prefName}から狙える市場が数分でわかります。</p>
<h2>よくある質問</h2>
${faqs.map(([q, a]) => `<h3>${esc(q)}</h3><p>${esc(a)}</p>`).join(String.fromCharCode(10))}`,
  });
}
page('/guide/shikaku/', {
  title: `都道府県別 入札参加資格・電子入札の始め方【47都道府県】 | ${SITE}`,
  desc: '入札参加資格の取り方と電子入札の始め方を都道府県別に解説。各県の直近1年の公告件数・発注の多い機関・落札実績のデータつき。',
  crumb: [['入札ガイド', '/guide/'], ['都道府県別 参加資格ガイド', '']],
  body: `<h1>都道府県別 入札参加資格・電子入札の始め方</h1>
${kunSays('自分の県を選んでね。資格の取り方と、県の入札市場データをまとめてあるよ!')}
<ul>${shikakuPrefs.map(([pn, ps, n]) => `<li><a href="/guide/shikaku/${ps}/">${pn}の入札参加資格と電子入札の始め方</a>（公告${n.toLocaleString()}件/年）</li>`).join('')}</ul>`,
});

// データレポート: 被リンク獲得を狙う統計読み物（引用歓迎を明記）
{
  const minTurn = new Map(); // 府省 → {pairs, flips}
  for (const [, arr] of clusters) {
    const s = [...arr].filter((a) => a.corporate_no).sort((x, y) => (x.award_date < y.award_date ? -1 : 1));
    if (new Set(s.map((a) => a.award_date.slice(0, 4))).size < 2) continue;
    for (let i = 1; i < s.length; i++) {
      if (s[i].award_date.slice(0, 4) === s[i - 1].award_date.slice(0, 4)) continue;
      const o = minTurn.get(s[i].ministry_code) ?? { pairs: 0, flips: 0 };
      o.pairs++; if (s[i].corporate_no !== s[i - 1].corporate_no) o.flips++;
      minTurn.set(s[i].ministry_code, o);
    }
  }
  const catRows = Object.entries(TURNOVER).filter(([sl, o]) => sl !== 'other' && o.pairs >= 300 && LABEL[sl])
    .sort((a, b) => b[1].rate - a[1].rate);
  const minRows = [...minTurn.entries()].filter(([c, o]) => MINISTRIES[c] && o.pairs >= 300)
    .map(([c, o]) => [c, { ...o, rate: Math.round((o.flips / o.pairs) * 100) }])
    .sort((a, b) => b[1].rate - a[1].rate);
  page('/report/kotai/', {
    title: `官公庁の入札は本当に「いつも同じ業者」なのか — ${allPairs.toLocaleString()}回の入札を調べた｜${SITE}`,
    desc: `「官公庁入札は出来レース」は本当か。毎年繰り返される継続契約${allPairs.toLocaleString()}回の入札を実データで検証したところ、${TURNOVER_ALL}%で落札者が入れ替わっていた。分野別・府省別の入れ替わり率ランキングを公開。引用歓迎。`,
    crumb: [['データレポート', '']],
    jsonld: { '@context': 'https://schema.org', '@type': 'Article', headline: `官公庁の入札は本当に「いつも同じ業者」なのか`, author: { '@type': 'Organization', name: SITE }, publisher: { '@type': 'Organization', name: SITE } },
    body: `<h1>官公庁の入札は本当に「いつも同じ業者」なのか — ${allPairs.toLocaleString()}回の入札を調べた</h1>
<p class="meta">入札コンパス データレポート ／ 対象: 国の機関の落札実績オープンデータ（2013年度〜）のうち、年をまたいで繰り返し発注された継続契約 ／ 本レポートの数値・図表は<b>出典（入札コンパス・本ページURL）を明記のうえ自由に引用いただけます</b>。</p>
${kunSays(`結論: 継続契約の入札${allPairs.toLocaleString()}回のうち、<b>${TURNOVER_ALL}%で前年と違う業者が落札</b>していたよ。「いつも同じ業者」は、分野によっては本当で、分野によっては思い込みだよ!`)}
<h2>結論サマリー</h2>
<ul>
<li>毎年繰り返される契約の入札を前年と比べると、<b>${TURNOVER_ALL}%で落札者が交代</b>している（約3件に1件）</li>
<li>入れ替わりが最も激しいのは<b>${LABEL[catRows[0]?.[0]] || ''}（${catRows[0]?.[1].rate}%）</b>、最も固定的なのは<b>${LABEL[catRows[catRows.length - 1]?.[0]] || ''}（${catRows[catRows.length - 1]?.[1].rate}%）</b></li>
<li>「同じ業者が取り続けている」契約でも、現在の落札者がまだ1回目という（=固定化していない）契約が約3分の1ある</li>
</ul>
<h2>分野別の入れ替わり率ランキング</h2>
<div class="wrap"><table><tr><th>業務分野</th><th>検証した入札</th><th>入れ替わり率</th></tr>
${catRows.map(([sl, o]) => `<tr><td><a href="/price/${sl}/">${LABEL[sl]}</a></td><td class="num">${o.pairs.toLocaleString()}回</td><td class="num"><b>${o.rate}%</b></td></tr>`).join(String.fromCharCode(10))}</table></div>
<h2>府省別の入れ替わり率</h2>
<div class="wrap"><table><tr><th>府省</th><th>検証した入札</th><th>入れ替わり率</th></tr>
${minRows.map(([c, o]) => `<tr><td>${organLink(c, esc(MINISTRIES[c]))}</td><td class="num">${o.pairs.toLocaleString()}回</td><td class="num"><b>${o.rate}%</b></td></tr>`).join(String.fromCharCode(10))}</table></div>
<h2>読み方 — 新規参入を考える会社へ</h2>
<p>入れ替わり率が高い分野（物品購入・広報・研修など）は、仕様が標準化されていて価格勝負になりやすく、新規でも取りに行く余地が大きい市場です。
逆に低い分野（除雪・保守点検・通信など）は、地理的条件や既存設備への依存で現職が有利な構造ですが、その中でも「現職1回目」の契約は固定化がまだ進んでいません。
自社の業種の入れ替わり率と狙い目は<a href="/shindan/">入札機会診断</a>（無料・登録不要）で確認できます。</p>
<h2>方法論</h2>
<p>調達ポータルの落札実績オープンデータ（2013年度〜、約31万件）から、案件名を正規化（年度表記・数字・括弧を除去）して同一府省の繰り返し契約に束ね、
年をまたいだ連続する2回の落札で法人番号が変わったかを数えました。検証対象は${allPairs.toLocaleString()}回。
法人番号の無い落札（個人・任意団体等）は除外しています。データは毎日更新され、本ページの数値も自動で再計算されます。</p>
<p><a href="/contract/">→ 個別の契約ごとの落札履歴（継続契約データベース）</a></p>`,
  });
}

// ---------- 公募・プロポーザル案件（都道府県別） ----------
// 「{県} プロポーザル」「{県} 公募」は企画・コンサル系の検索語彙。案件は収録済みなのに
// 「入札公告」の語彙に埋もれて拾えていなかったため、専用ページで正対する。
{
  const propPrefs = [];
  for (const prefName of PREFS) {
    const pslug = PREF_SLUGS[prefName];
    if (!pslug) continue;
    const cur = (noticeByPref.get(prefName) || []).filter((n) => PROP_RE.test(n.name));
    const hist = (histByPref.get(prefName) || []).filter((n) => PROP_RE.test(n.name));
    if (cur.length + hist.length < 3) continue;
    propPrefs.push([prefName, pslug, cur.length, hist.length]);
    const byOrg = new Map();
    for (const n of [...cur, ...hist]) if (n.org) byOrg.set(n.org, (byOrg.get(n.org) || 0) + 1);
    const topOrgs = [...byOrg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
    page(`/proposal/${pslug}/`, {
      title: `${prefName}の公募・プロポーザル案件${cur.length ? `【募集中${cur.length}件・履歴${(cur.length + hist.length).toLocaleString()}件】` : `【履歴${hist.length.toLocaleString()}件を収録】`}｜${SITE}`,
      desc: `${prefName}の公募型プロポーザル・企画競争・公募案件を毎日更新で収録${cur.length ? `。現在募集中${cur.length}件と過去の履歴${hist.length.toLocaleString()}件` : `（履歴${hist.length.toLocaleString()}件）`}。発注機関・公告日・原文リンクつき。掲載期間が終わった案件も履歴として保持しています。`,
      crumb: [['公募・プロポーザル', '/proposal/'], [prefName, '']],
      lastmod: cur[0]?.issue_date || hist[0]?.issue_date,
      body: `<h1>${prefName}の公募・プロポーザル案件</h1>
${kunSays(cur.length
    ? `${prefName}で募集中の公募・プロポーザルは<b>${cur.length}件</b>、過去の履歴は<b>${hist.length.toLocaleString()}件</b>あるよ。毎日更新しているよ!`
    : `${prefName}の公募・プロポーザルの履歴を<b>${hist.length.toLocaleString()}件</b>収録しているよ。新しい募集が出たら毎日の更新で載せるよ!`)}
${statBoxes([['募集中', cur.length + '件'], ['履歴', (cur.length + hist.length).toLocaleString() + '件'], ['更新', '毎日']])}
<p>プロポーザル方式（企画競争）は、価格だけでなく<b>企画提案の内容で受注者が決まる</b>調達方式です。
コンサルティング・計画策定・広報制作・システム企画・調査研究などで多く使われ、価格競争の一般競争入札とは準備も勝ち筋も異なります。
このページでは${prefName}の機関・自治体が出した公募型プロポーザル・企画競争・公募案件をまとめています。</p>
${cur.length ? `<h2>募集中の案件</h2>${noticeTable(cur, { withCity: true })}` : ''}
${hist.length >= 3 ? `<h2>過去の公募・プロポーザル（履歴）</h2>
<p>例年どの機関が・いつ頃プロポーザルを出しているかは、次年度の先回り準備に使えます。${topOrgs.length ? `件数が多いのは${topOrgs.map(([o, n]) => `${esc(o)}（${n}件）`).join('、')}。` : ''}</p>
${histTable(hist)}` : ''}
<p><a href="/local/${pslug}/">→ ${prefName}の入札情報全体を見る</a> ／ <a href="/proposal/">→ 他の都道府県の公募・プロポーザル</a></p>`,
    });
  }
  page('/proposal/', {
    title: `全国の公募・プロポーザル案件（都道府県別） | ${SITE}`,
    desc: '公募型プロポーザル・企画競争・公募案件を都道府県別に毎日更新で収録。募集中の案件と、掲載期間が終わった過去案件の履歴。',
    crumb: [['公募・プロポーザル', '']],
    body: `<h1>全国の公募・プロポーザル案件</h1>
${kunSays('企画提案で決まるプロポーザル案件だけを集めたよ。都道府県を選んでね!')}
<p>プロポーザル方式（企画競争）は価格でなく提案内容で受注者が決まる調達方式です。都道府県別に、募集中の案件と過去の履歴をまとめています。</p>
<ul>${propPrefs.map(([pn, ps, c, h]) => `<li><a href="/proposal/${ps}/">${pn}の公募・プロポーザル</a>（募集中${c}件・履歴${h.toLocaleString()}件）</li>`).join('')}</ul>`,
  });
}

// about / policy
page('/about/', {
  title: `運営者情報・データについて | ${SITE}`,
  desc: '入札コンパスの運営者情報。調達ポータルの落札実績オープンデータと官公需情報ポータルを毎日取得し、契約・企業・機関・地域の切り口で構造化して公開しています。',
  body: `<h1>運営者情報・データについて</h1>
<p>${SITE}は、官公庁入札の落札相場・落札実績を公開データから構造化して提供するサービスです。
「この案件はいくらで落ちるのか」「どの機関がいつ発注するのか」という入札実務の判断を、
推測ではなく実データで支えることを目的としています。</p>
<h2>データの方法論</h2>
<ul>
<li><b>収集元</b>: 調達ポータル「落札実績オープンデータ」（デジタル庁公表・2013年度〜）を毎日取得し、
法人番号で名寄せ・業務分類を付与して構造化しています</li>
<li><b>更新</b>: 毎朝、前日までの新規落札データを自動で反映します（各ページ下部に最終更新日を表示）</li>
<li><b>業務分類</b>: 案件名からルールベースで自動分類しています（現在31分類・分類率約84%）。
分類の誤りを見つけた場合はお知らせください</li>
<li><b>金額</b>: 落札価格は公表データの値をそのまま表示しています（税抜/税込は公表元に依存します）</li>
</ul>
<h2>データの限界（正直な注意書き）</h2>
<ul>
<li>収録範囲は<b>国の機関（府省・独立行政法人等）の落札実績</b>と、<b>自治体は千葉・秋田・静岡県域（県+市町村）から順次収録中</b>（2026年8月開始）です</li>
<li>収録元は政府電子調達（GEPS）経由の案件が中心のため、一部の省庁調達
（例: 地方整備局の工事の一部）は含まれない場合があります</li>
<li>「次回公告の目安」は過去の繰り返しパターンからの推定であり、発注を保証するものではありません</li>
</ul>
<h2>データソースと利用規約</h2>
<ul><li>調達ポータル「落札実績オープンデータ」（デジタル庁）— <a href="https://www.digital.go.jp/copyright-policy/" rel="noopener">政府標準利用規約</a>に準拠して利用</li>
<li>官公需情報ポータルサイト（中小企業庁）検索API — 公告情報の取得に利用</li></ul>
<p>本サービスは官公需情報ポータルサイトのAPIを利用しています: <a href="https://www.kkj.go.jp/s/" rel="noopener">官公需情報ポータルサイト</a></p>`,
});
page('/policy/', {
  title: `掲載ポリシー・会員規約・プライバシー・削除依頼 | ${SITE}`,
  desc: '掲載情報の方針、無料会員の規約とメールアドレスの取り扱い、訂正・削除依頼の窓口。',
  body: `<h1>掲載ポリシー・会員規約・プライバシー</h1>
<h2>無料会員について</h2>
<ul>
<li><b>内容</b>: メールアドレスの登録により、歴代の落札金額・前回比・契約ごとの中央値・類似案件検索の全期間など、非会員には伏せている情報が表示されます。無料です</li>
<li><b>メールの利用目的</b>: 会員機能の有効化リンクの送付、月1回の入札機会レポート、サービスの案内（有料プランの先行案内を含む）。これ以外の目的に使用せず、第三者に提供しません。配信はアスメル（メール配信サービス）を通じて行います</li>
<li><b>cookie</b>: 会員であることを記録するため、端末にcookie（nc_m / nc_s）を保存します。個人を特定する情報は含みません。cookieを削除すると非会員表示に戻ります</li>
<li><b>配信停止・退会</b>: 各メールの配信停止リンク、または下のフォームからいつでもできます</li>
<li><b>免責</b>: 掲載データは公表情報の構造化であり、正確性・完全性を保証しません。「勝てる札」推定レンジ等の導出値は参考情報であり、入札の結果について責任を負いません</li>
</ul>
<h2>掲載ポリシー</h2>
<p>掲載している落札実績は、国の機関が公表した公開情報（調達ポータル 落札実績オープンデータ等）をそのまま構造化したものです。</p>
<p>掲載内容の誤り、法人情報の訂正・削除のご依頼は、以下のフォームからお送りください。公表元データを確認のうえ対応します。</p>
<form name="contact" method="POST" action="/.netlify/functions/alert-form" data-netlify="true" netlify-honeypot="bot-field">
<input type="hidden" name="form-name" value="contact">
<p style="display:none"><label>入力しないでください: <input name="bot-field"></label></p>
<p><label>ご連絡先メールアドレス<br><input type="email" name="email" required style="width:100%;max-width:400px;padding:8px"></label></p>
<p><label>内容（対象ページのURLと依頼内容）<br><textarea name="message" required rows="5" style="width:100%;max-width:560px;padding:8px"></textarea></label></p>
<p><button type="submit" style="background:#0f6ab2;color:#fff;border:0;padding:10px 24px;border-radius:6px;font-weight:700">送信する</button></p>
</form>`,
});

// トップ
page('/', {
  title: `${SITE}｜いくらで入れるか、決める前に見る。落札相場・入札結果データベース`,
  desc: `官公庁入札の落札相場と落札実績${AWARDS.length.toLocaleString()}件を無料公開。業務別の相場、企業別の落札履歴、機関別の発注傾向がわかる入札の判断支援データベース。`,
  jsonld: { '@context': 'https://schema.org', '@type': 'WebSite', name: SITE, url: ORIGIN },
  body: `<h1>いくらで入れるか、決める前に見る。</h1>
<p>官公庁入札の落札結果${AWARDS.length.toLocaleString()}件から、この契約は前回いくらで誰が取ったか・類似案件の相場・競合の価格帯を、札を入れる前に数分で。結果が出た瞬間のお知らせも。</p>
${statBoxes([['落札実績', AWARDS.length.toLocaleString() + '件'], ['収録企業', companyCount.toLocaleString() + '社'], ['収録機関', organCount + '機関'], ['データ期間', '2013年度〜']])}
<div class="cta"><div class="ctxt"><b class="mk">無料会員になると、すべての契約の歴代落札金額と前回比、類似案件検索の全期間が開きます。</b><br>メール登録だけ。<br><br>${cta('/')}</div></div>
<h2>業務別の落札相場</h2>
<ul>${TAXONOMY.filter((t) => (byCat.get(t.slug) || []).length >= MIN_PRICE_AWARDS).slice(0, 12)
  .map((t) => `<li><a href="/price/${t.slug}/">${t.label}の落札相場</a></li>`).join('')}</ul>
<p><a href="/price/">→ すべての業務分類を見る</a> ／ <a href="/company/">→ 落札企業データベース</a> ／ <a href="/organ/">→ 発注機関別</a> ／ <a href="/guide/">→ 入札のはじめ方ガイド</a> ／ <a href="/contract/">→ 継続契約DB</a> ／ <a href="/radar/">→ 満了レーダー</a> ／ <a href="/weekly/">→ 週間レポート</a>${LOCALS.length ? ` ／ <a href="/local/">→ 自治体の入札結果</a>` : ''}</p>`,
});

// 3層ゲートのクライアント（cookie nc_member=1 で無料会員分を復元）
writeFileSync(join(DIST, 'assets', 'gate.js'), `(function(){
'use strict';
var member=/(^|; )nc_m=1/.test(document.cookie)||/(^|; )nc_member=1/.test(document.cookie);
function dec(b){try{return decodeURIComponent(escape(atob(b)))}catch(e){return ''}}
function back(){return encodeURIComponent(location.pathname+location.search)}
document.addEventListener('DOMContentLoaded',function(){
  if(member){document.documentElement.classList.add('member-only');
    document.querySelectorAll('.g-m').forEach(function(el){var v=dec(el.getAttribute('data-v'));if(v){el.innerHTML=v;}});
    document.querySelectorAll('.unlock-hide').forEach(function(el){el.style.display='none'});
  }else{
    document.querySelectorAll('.g-m').forEach(function(el){el.addEventListener('click',function(){location.href='/alert/?back='+back()})});
  }
  document.querySelectorAll('.g-p').forEach(function(el){el.addEventListener('click',function(){location.href='/alert/?back='+back()})});
  window.NC_MEMBER=member;
});
})();
`);

// 類似案件検索エンジン（全相場ページ共通・キャッシュされる）
mkdirSync(join(DIST, 'assets'), { recursive: true });
writeFileSync(join(DIST, 'assets', 'search.js'), `// 類似案件検索（データは初回操作時に遅延ロード）
(function(){
'use strict';
var D=null,loading=false;
var q=document.getElementById('q'),fmin=document.getElementById('fmin'),fband=document.getElementById('fband');
var tstats=document.getElementById('tstats'),tres=document.getElementById('tres');
if(!q)return;
function yen(n){if(n>=1e8)return (n/1e8).toFixed(n>=1e10?0:1)+'億円';if(n>=1e4)return Math.round(n/1e4).toLocaleString()+'万円';return n.toLocaleString()+'円'}
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
function load(){if(D||loading)return;loading=true;tstats.textContent='データ読み込み中…';
 fetch(window.NC_TOOL.data).then(function(r){return r.json()}).then(function(j){D=j;
  Object.keys(j.mins).sort().forEach(function(c){var o=document.createElement('option');o.value=c;o.textContent=j.mins[c];fmin.appendChild(o)});
  run()}).catch(function(){tstats.textContent='読み込みに失敗しました。再読み込みしてください。'})}
function median(a){if(!a.length)return null;var b=a.slice().sort(function(x,y){return x-y});return b[Math.floor(b.length/2)]}
function pct(a,p){if(!a.length)return null;var b=a.slice().sort(function(x,y){return x-y});return b[Math.floor((b.length-1)*p)]}
var t=null;function deb(){clearTimeout(t);t=setTimeout(run,200)}
function run(){if(!D)return;
 var terms=(q.value||'').trim().split(/\\s+/).filter(Boolean);
 var mc=fmin.value,bi=fband.value===''?null:Number(fband.value),bands=window.NC_TOOL.bands;
 var cutoff=new Date(Date.now()-365*86400000).toISOString().slice(0,10);
 var rows=D.rows.filter(function(r){
  if(!window.NC_MEMBER&&r[1]<cutoff)return false;
  if(mc&&r[3]!==mc)return false;
  if(bi!==null){var b=bands[bi];if(r[2]<b[0]||(b[1]!==null&&r[2]>=b[1]))return false}
  for(var i=0;i<terms.length;i++)if(r[0].indexOf(terms[i])<0)return false;
  return true});
 var am=rows.map(function(r){return r[2]}).filter(function(n){return n>0});
 if(!rows.length){tstats.innerHTML='該当する事例がありません。キーワードを減らすか変えてみてください。';tres.innerHTML='';return}
 tstats.innerHTML='該当 <b>'+rows.length.toLocaleString()+'件</b>'
  +(am.length?'　落札額の中央値 <b>'+yen(median(am))+'</b>　中心レンジ(25〜75%) <b>'+yen(pct(am,0.25))+' 〜 '+yen(pct(am,0.75))+'</b>':'');
 var lim=window.NC_MEMBER?100:20;
 var top=rows.slice(0,lim);
 tres.innerHTML='<table><tr><th>落札日</th><th>案件名</th><th>機関</th><th>落札者</th><th>落札価格</th></tr>'
  +top.map(function(r){return '<tr><td>'+r[1]+'</td><td>'+esc(r[0])+'</td><td>'+esc(D.mins[r[3]]||r[3])+'</td><td>'+esc(r[4]||'')+'</td><td style="text-align:right;white-space:nowrap">'+yen(r[2])+'</td></tr>'}).join('')
  +'</table>'+(window.NC_MEMBER?(rows.length>100?'<p class="meta">上位100件を表示（全'+rows.length.toLocaleString()+'件）。キーワードでさらに絞り込めます。</p>':''):'<p class="meta">非会員は直近1年・20件まで表示。<a href="/alert/?unlock=1&back='+encodeURIComponent(location.pathname)+'">無料会員</a>で全期間・100件まで表示されます。</p>');
}
['focus','input'].forEach(function(ev){q.addEventListener(ev,function(){load();deb()})});
[fmin,fband].forEach(function(el){el.addEventListener('change',function(){load();run()})});
})();
`);

// 入札機会診断エンジン
writeFileSync(join(DIST, 'assets', 'shindan.js'), `// 入札機会診断（統計は/shindan/data.json、定番案件は各カテゴリのdata.jsonから算出）
(function(){
'use strict';
var scat=document.getElementById('scat'),spref=document.getElementById('spref'),sout=document.getElementById('sout');
if(!scat)return;
var S=null,CATD={};
function yen(n){if(n==null)return '—';if(n>=1e8)return (n/1e8).toFixed(n>=1e10?0:1)+'億円';if(n>=1e4)return Math.round(n/1e4).toLocaleString()+'万円';return n.toLocaleString()+'円'}
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
function norm(n){return n.replace(/令和\\d+年度?|平成\\d+年度?|Ｒ\\d+|R\\d+|[０-９0-9]+|（[^）]*）|\\([^)]*\\)|【[^】]*】|[　\\s]/g,'')}
function teiban(rows){
 var g={};
 rows.forEach(function(r){var k=norm(r[0])+'|'+r[3];(g[k]=g[k]||[]).push(r)});
 var out=[];
 Object.keys(g).forEach(function(k){
  var es=g[k],ys={};es.forEach(function(r){ys[r[1].slice(0,4)]=1});
  if(Object.keys(ys).length>=3){
   var ms={};es.forEach(function(r){var m=+r[1].slice(5,7);ms[m]=(ms[m]||0)+1});
   var topM=+Object.keys(ms).sort(function(a,b){return ms[b]-ms[a]})[0];
   var latest=es.sort(function(a,b){return b[1]<a[1]?-1:1})[0];
   out.push({name:latest[0],min:latest[3],month:topM,amount:latest[2],years:Object.keys(ys).length})
  }});
 return out.sort(function(a,b){return b.years-a.years}).slice(0,3);
}
function render(){
 if(!S)return;
 var slug=scat.value,pref=spref.value;
 if(!slug){sout.innerHTML='';return}
 var c=S.cats.filter(function(x){return x.slug===slug})[0];
 var op=(S.open||{})[slug];
 var openN=op?(pref?(op.byPref[pref]||0):op.n):0;
 var tv=(S.turnover||{})[slug];
 var peak=c.months.indexOf(Math.max.apply(null,c.months))+1;
 var pubM=((peak+10-1)%12)+1; // 公告はおおむね落札の2ヶ月前
 var html='<h2>あなたの市場: '+esc(c.label)+(pref?' × '+esc(pref)+'（参考）':'（国の機関・全国）')+'</h2>'
  +'<div class="stats">'
  +'<div class="stat"><b>年間 約'+c.perYear.toLocaleString()+'件</b>発注件数（直近2年平均）</div>'
  +'<div class="stat"><b>'+yen(c.amountYear)+'</b>年間発注総額（2025年）</div>'
  +'<div class="stat"><b>'+esc(c.band)+'</b>最多の金額帯</div>'
  +'<div class="stat"><b>'+peak+'月</b>落札の集中月（公告は'+pubM+'月頃〜）</div>'
  +(op?'<div class="stat" style="border-color:#E8604C"><b style="color:#E8604C">'+openN.toLocaleString()+'件</b>いま開いている案件'+(pref?'（'+pref+'）':'（全国）')+'</div>':'')
  +(tv&&tv.rate!=null?'<div class="stat"><b>'+tv.rate+'%</b>毎年入れ替わる契約の割合</div>':'')
  +'</div>'
  +(tv&&tv.rate!=null?'<p>'+esc(c.label)+'の継続契約は<b>毎年'+tv.rate+'%で落札者が入れ替わって</b>います（全分野平均'+(S.turnoverAll||'—')+'%）'+(tv.firstTermShare!=null?'。現職が1回目（まだ固まっていない）契約が'+tv.firstTermShare+'%あり、'+(tv.rate>=40?'動きの大きい分野です。新規でも取りに行く余地があります':(tv.rate<=22?'固定的な分野です。狙うなら現職1回目の契約を':'平均的な流動性です'))+'。</p>':'')
  +'<h3>発注が多い機関</h3><ul>'+c.topMins.map(function(m){return '<li><a href="/organ/'+m[0].toLowerCase()+'/">'+esc(S.mins[m[0]]||m[0])+'</a>（'+m[1].toLocaleString()+'件）</li>'}).join('')+'</ul>'
  +(op&&op.sample.length?'<h3>いま公告中の案件（例）</h3><ul>'+op.sample.slice(0,4).map(function(x){return '<li>'+esc(x.name)+'（'+esc(x.org)+(x.deadline?'・入札 '+x.deadline:'')+'）'+(x.url?' <a href="'+x.url+'" rel="nofollow noopener" target="_blank">原文</a>':'')+'</li>'}).join('')+'</ul>':'')
  +'<div id="steiban"><p class="meta">定番案件を分析中…</p></div>'
  +'<div class="cta"><div class="ctxt"><b class="mk">この分野の契約ごとの歴代落札金額・前回比は、無料会員で開きます。</b><br>メール登録だけ。<br><br>'
  +'<a class="btn" href="/alert/?back=%2Fshindan%2F&watch=cat&name='+encodeURIComponent(c.label)+'">無料会員登録して続きを見る</a></div></div>';
 sout.innerHTML=html;
 var render_id=slug+'|'+pref;sout.dataset.rid=render_id;
 (CATD[slug]?Promise.resolve(CATD[slug]):fetch('/price/'+slug+'/data.json').then(function(r){return r.json()}).then(function(j){CATD[slug]=j;return j}))
 .then(function(j){
  if(sout.dataset.rid!==render_id)return;
  var rows=j.rows;
  var el=document.getElementById('steiban');if(!el)return;
  var prefNote='';
  if(pref){var pk=pref.replace(/[都府県]$/,'');var pr=rows.filter(function(r){return r[0].indexOf(pk)>=0});
   prefNote='<p>案件名に「'+esc(pk)+'」を含む事例: <b>'+pr.length.toLocaleString()+'件</b>'+(pr.length?'（<a href="/price/'+slug+'/">検索ツールで「'+esc(pk)+'」と入れると一覧できます</a>）':'')+'</p>';
   if(pr.length>=30)rows=pr}
  var tb=teiban(rows);
  el.innerHTML=prefNote+(tb.length?'<h3>毎年出ている定番案件（例）</h3><div class="wrap"><table><tr><th>案件</th><th>機関</th><th>例年の時期</th><th>直近の落札額</th></tr>'
   +tb.map(function(t){return '<tr><td>'+esc(t.name)+'</td><td>'+esc(S.mins[t.min]||t.min)+'</td><td>'+t.month+'月頃</td><td style="text-align:right">'+yen(t.amount)+'</td></tr>'}).join('')
   +'</table></div><p class="meta">同名系の案件が3年以上繰り返し落札されているもの。来期も同時期に公告される可能性が高い「先回り」の入口です。</p>':'')
 });
}
fetch('/shindan/data.json').then(function(r){return r.json()}).then(function(j){S=j;render()});
scat.addEventListener('change',render);spref.addEventListener('change',render);
})();
`);

// robots / llms / sitemap（1万URLごとに分割）
writeFileSync(join(DIST, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${ORIGIN}/sitemap.xml\n`);
// Search Console所有権確認 + IndexNowキー（公開仕様）
writeFileSync(join(DIST, 'googlea7352c9a5da5cbc1.html'), 'google-site-verification: googlea7352c9a5da5cbc1.html');
cpSync(join(ROOT, 'site', 'static', 'favicon.ico'), join(DIST, 'favicon.ico')); // ブラウザは /favicon.ico を直接見に来る
writeFileSync(join(DIST, 'BingSiteAuth.xml'), ['<?xml version="1.0"?>', '<users>', '  <user>AB03214349E5D12EC85FE63B4AA928C6</user>', '</users>', ''].join('\n')); // Bing Webmaster Tools 所有権確認
writeFileSync(join(DIST, '68c8ff01b5ee8614e56c3a91ccbb8f59.txt'), '68c8ff01b5ee8614e56c3a91ccbb8f59');
writeFileSync(join(DIST, 'llms.txt'), `# ${SITE}（nyusatsu-compass.com）

> 日本の官公庁入札の落札相場・入札結果データベース。調達ポータル（デジタル庁）の落札実績
> オープンデータ${AWARDS.length.toLocaleString()}件（2013年度〜）を毎日取得し、法人番号で名寄せ・業務分類して公開。
> 「この業務はいくらで落ちるか」「この機関はいつ何を発注するか」「この会社は何を落札してきたか」に
> 実データで答えるサイト。運営は独立系。データ出典は政府標準利用規約に準拠。

## このサイトが答えられる質問の例

- 「庁舎清掃の入札はいくらぐらいで落札される?」→ /price/seiso/（金額帯別の相場・類似案件検索）
- 「国土交通省の入札結果・落札企業は?」→ /organ/s1/
- 「◯◯株式会社の官公庁の落札実績は?」→ /company/{法人番号}/（契約履歴・次回公告の目安つき）
- 「今週の官公庁入札の動き・業者が交代した契約は?」→ /weekly/
- 「自分の業種の官公庁市場の規模・公告シーズンは?」→ /shindan/（無料10秒診断）

## 主要ディレクトリ

- /price/ : 業務別の落札相場（${priceCount}分類。中央値・金額帯分布・発注時期・落札企業・類似案件検索）
${TAXONOMY.filter((t) => (byCat.get(t.slug) || []).length >= MIN_PRICE_AWARDS).slice(0, 10).map((t) => `  - /price/${t.slug}/ : ${t.label}`).join('\n')}
- /company/ : 落札企業データベース（${companyCount.toLocaleString()}社。落札履歴・継続契約の次回予測・同分野の競合）
- /organ/ : 発注機関別の入札結果アーカイブ（${organCount}機関）
- /weekly/ : 週間レポート（大型案件・契約リプレイス・新規参入の自動集計）
- /shindan/ : 入札機会診断（業種別の市場データを即時表示する無料ツール）

## データの範囲と限界

収録は国の機関（府省・独立行政法人等）の落札実績。都道府県・市区町村は未収録（順次追加予定）。
「次回公告の目安」は過去周期からの推定であり発注を保証しない。毎日更新（最終更新: ${BUILT_AT}）。
`);
const shards = [];
for (let i = 0; i < urls.length; i += 10000) shards.push(urls.slice(i, i + 10000));
shards.forEach((s, i) => writeFileSync(join(DIST, `sitemap-${i}.xml`),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${s.map((u) => `<url><loc>${u.loc}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}</url>`).join('\n')}\n</urlset>`));
writeFileSync(join(DIST, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${shards.map((_, i) => `<sitemap><loc>${ORIGIN}/sitemap-${i}.xml</loc></sitemap>`).join('\n')}\n</sitemapindex>`);

console.log(`生成完了: 計${urls.length}ページ（相場${priceCount}+地域相場${regionPriceCount}+満了レーダー${radarCount}+契約${contractCount}+地域${localPrefCount}県/${localCityCount}市区町村 / 企業${companyCount} / 機関${organCount}）→ site/dist`);
