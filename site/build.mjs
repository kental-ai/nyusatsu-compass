// 入札コンパス 静的サイト生成（外部依存ゼロ）
// 使い方: node site/build.mjs  → site/dist に出力
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TAXONOMY } from '../pipeline/taxonomy.mjs';
import { MINISTRIES, BIDDING_METHODS } from '../pipeline/codes.mjs';

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

// ---------- データ読み込み ----------
const db = new DatabaseSync(join(ROOT, 'data', 'compass.db'));
const AWARDS = db.prepare(`
  SELECT a.rowid, a.case_no, a.name, a.award_date, a.amount, a.ministry_code, a.method_code,
         a.winner_name, a.corporate_no, c.slug
  FROM awards a LEFT JOIN enrich_class c ON a.rowid = c.award_rowid
  ORDER BY a.award_date DESC`).all();
const COMPANIES = db.prepare(`SELECT corporate_no, name FROM companies`).all();
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
const monthMode = (list) => {
  const m = {};
  for (const a of list) { const mm = Number(a.award_date?.slice(5, 7)); if (mm) m[mm] = (m[mm] || 0) + 1; }
  return Number(Object.keys(m).sort((x, y) => m[y] - m[x])[0] || 0);
};

// ---------- レイアウト ----------
const CSS = `
:root{--ink:#1a2333;--sub:#5a6472;--line:#dde3ea;--acc:#0f6ab2;--bg:#f7f9fb}
*{box-sizing:border-box}body{margin:0;font-family:"Hiragino Sans","Yu Gothic",Meiryo,sans-serif;color:var(--ink);background:#fff;line-height:1.7}
main{max-width:960px;margin:0 auto;padding:16px}h1{font-size:1.5rem;line-height:1.4}h2{font-size:1.15rem;border-left:4px solid var(--acc);padding-left:10px;margin-top:2em}
table{border-collapse:collapse;width:100%;font-size:.92rem}th,td{border:1px solid var(--line);padding:6px 10px;text-align:left}th{background:var(--bg)}td.num{text-align:right;white-space:nowrap}
.wrap{overflow-x:auto}a{color:var(--acc)}.crumb{font-size:.85rem;color:var(--sub);margin:8px 0}.crumb a{color:var(--sub)}
header{border-bottom:1px solid var(--line)}header .in{max-width:960px;margin:0 auto;padding:10px 16px;display:flex;justify-content:space-between;align-items:center}
header .logo{font-weight:700;font-size:1.1rem;color:var(--ink);text-decoration:none}
.cta{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:16px;margin:24px 0}
.cta a{display:inline-block;background:var(--acc);color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:700}
.meta{color:var(--sub);font-size:.85rem}footer{border-top:1px solid var(--line);margin-top:48px;padding:24px 16px;font-size:.82rem;color:var(--sub)}
footer .in{max-width:960px;margin:0 auto}.stats{display:flex;gap:12px;flex-wrap:wrap;margin:16px 0}
.stat{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px 16px}.stat b{display:block;font-size:1.3rem}
.insight{background:#eef5fb;border-left:4px solid var(--acc);padding:12px 16px;border-radius:0 8px 8px 0;margin:16px 0}
.chart{margin:16px 0;max-width:640px}.bars{display:flex;align-items:flex-end;gap:3px;height:110px}
.bars>div{flex:1;background:var(--acc);border-radius:3px 3px 0 0;position:relative}
.bars .blab{position:absolute;top:-1.4em;left:50%;transform:translateX(-50%);font-size:.75rem;color:var(--sub);white-space:nowrap}
.xlab{display:flex;gap:3px;margin-top:4px}.xlab>span{flex:1;text-align:center;font-size:.75rem;color:var(--sub)}
.tool{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:16px;margin:16px 0}
.tool input[type=search]{width:100%;max-width:420px;padding:10px;border:1px solid var(--line);border-radius:6px;font-size:1rem}
.tool select{padding:9px;border:1px solid var(--line);border-radius:6px;margin:8px 8px 0 0}
.tool .tstats{margin:12px 0;font-size:.95rem}.tool .tstats b{font-size:1.15rem;color:var(--acc)}
`;

function page(path, { title, desc, crumb = [], body, noindex = false, jsonld = null }) {
  const canonical = ORIGIN + path;
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
  jsonld = [breadcrumb, jsonld].filter(Boolean);
  jsonld = jsonld.length === 0 ? null : jsonld.length === 1 ? jsonld[0] : jsonld;
  const html = `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${canonical}">${noindex ? '\n<meta name="robots" content="noindex">' : ''}
<style>${CSS}</style>${jsonld ? `\n<script type="application/ld+json">${JSON.stringify(jsonld)}</script>` : ''}
</head><body>
<header><div class="in"><a class="logo" href="/">${SITE}</a><a href="/alert/">無料の新着アラート</a></div></header>
<main>${crumbHtml}
${body}
<div class="cta"><b>あなたの業種の官公庁市場、10秒でわかります。</b><br>
年間の発注件数・相場・公告シーズン・毎年出る定番案件を、実データから無料で診断。登録不要。<br><br>
<a href="/shindan/">入札機会診断をやってみる</a></div>
</main>
<footer><div class="in">
<p>${SITE} — 官公庁入札の落札相場・落札実績データベース。データ出典: 調達ポータル「落札実績オープンデータ」（政府標準利用規約準拠）ほか公的公表情報。最終更新: ${BUILT_AT}</p>
<p><a href="/about/">運営者情報・データについて</a> ／ <a href="/policy/">掲載ポリシー・削除依頼</a></p>
</div></footer>
</body></html>`;
  const file = join(DIST, path.replace(/\/$/, '/index.html').replace(/^\//, ''));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, html);
  if (!noindex) urls.push(canonical); // noindexページはsitemapに載せない
  return canonical;
}

const awardRows = (list, { company = true } = {}) => `
<div class="wrap"><table><tr><th>落札日</th><th>案件名</th><th>機関</th>${company ? '<th>落札者</th>' : ''}<th>落札価格</th></tr>
${list.map((a) => `<tr><td>${a.award_date}</td><td>${esc(a.name)}</td><td>${esc(MINISTRIES[a.ministry_code] || a.ministry_code)}</td>${
  company ? `<td>${a.corporate_no ? `<a href="/company/${a.corporate_no}/">${esc(a.winner_name)}</a>` : esc(a.winner_name)}</td>` : ''
}<td class="num">${yen(a.amount)}</td></tr>`).join('\n')}</table></div>`;

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
  return `<p class="insight">${s.join(' ')}</p>`;
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

function groupTable(list, keyFn, labelFn, linkFn = null, limit = 10) {
  const m = new Map();
  for (const a of list) { const k = keyFn(a); if (!k) continue; const o = m.get(k) ?? { n: 0, sum: 0 }; o.n++; o.sum += a.amount || 0; m.set(k, o); }
  const rows = [...m.entries()].sort((x, y) => y[1].n - x[1].n).slice(0, limit);
  return `<div class="wrap"><table><tr><th></th><th>件数</th><th>合計金額</th></tr>${rows.map(([k, o]) =>
    `<tr><td>${linkFn ? `<a href="${linkFn(k)}">${esc(labelFn(k))}</a>` : esc(labelFn(k))}</td><td class="num">${o.n.toLocaleString()}</td><td class="num">${yen(o.sum)}</td></tr>`).join('\n')}</table></div>`;
}

// ---------- 生成 ----------
rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });
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
    title: `${t.label}の入札はいくらで落ちる? 落札相場と${list.length.toLocaleString()}件の実績検索 | ${SITE}`,
    desc: `官公庁の「${t.label}」入札の落札相場。過去${list.length.toLocaleString()}件からあなたの案件に近い落札事例を検索し、金額帯・発注時期・落札企業の実データで「いくらで入れるか」の判断材料を提供。`,
    crumb: [['落札相場', '/price/'], [t.label, '']],
    jsonld: { '@context': 'https://schema.org', '@type': 'Dataset', name: `${t.label}の落札実績データ`, description: `国の機関の${t.label}に関する落札実績${list.length}件の統計`, license: 'https://www.digital.go.jp/copyright-policy/', creator: { '@type': 'Organization', name: SITE } },
    body: `<h1>${t.label}の入札はいくらで落ちる?</h1>
<p class="meta">調達ポータル公表の落札実績（2013年度〜）のうち「${t.label}」${list.length.toLocaleString()}件のデータ。毎日更新。</p>
${insights(list, `${t.label}`)}
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
<h2>発注時期のパターン</h2>${monthChart(list, t.label)}
<h2>発注が多い機関</h2>${groupTable(list, (a) => a.ministry_code, (k) => MINISTRIES[k] || k, (k) => `/organ/${k.toLowerCase()}/`)}
<h2>落札件数の多い企業</h2>${groupTable(list.filter((a) => a.corporate_no), (a) => a.corporate_no, (k) => companyName.get(k) || k, (k) => `/company/${k}/`)}
<h2>入札方式の内訳</h2>${groupTable(list, (a) => a.method_code, (k) => BIDDING_METHODS[k] || k)}
<h2>直近の落札事例</h2>${awardRows(recent)}`,
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

// 企業ページ（概況文・契約ヒストリー・次回予測・同じ土俵の企業）
let companyCount = 0;
for (const [corpNo, list] of byCompany) {
  if (list.length < MIN_COMPANY_AWARDS) continue;
  companyCount++;
  const name = companyName.get(corpNo) || list[0].winner_name;
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
    return `<h3>${esc(a.name)}</h3>
<p class="meta">${forecast}</p>
<div class="wrap"><table><tr><th>落札日</th><th>落札者</th><th>落札価格</th></tr>
${cl.slice(0, 8).map((x) => `<tr><td>${x.award_date}</td><td>${x.corporate_no === corpNo ? `<b>${esc(x.winner_name)}</b>` : (x.corporate_no ? `<a href="/company/${x.corporate_no}/">${esc(x.winner_name)}</a>` : esc(x.winner_name))}</td><td class="num">${yen(x.amount)}</td></tr>`).join('\n')}
</table></div>`;
  }).join('\n');

  // 同じ土俵の企業（主戦場= 最頻の機関×分野 の他社）
  let cohortHtml = '';
  if (catTop) {
    const pk = minTop[0] + '|' + catTop[0];
    const cohort = [...(pairCompanies.get(pk) || new Map()).entries()]
      .filter(([no]) => no !== corpNo && (byCompany.get(no) || []).length >= MIN_COMPANY_AWARDS)
      .sort((x, y) => y[1] - x[1]).slice(0, 10);
    if (cohort.length) {
      cohortHtml = `<h2>同じ土俵の企業（${MINISTRIES[minTop[0]] || ''}×${LABEL[catTop[0]]}）</h2>
<ul>${cohort.map(([no, n]) => `<li><a href="/company/${no}/">${esc(companyName.get(no) || no)}</a>（${n.toLocaleString()}件）</li>`).join('')}</ul>`;
    }
  }

  page(`/company/${corpNo}/`, {
    title: `${name}の落札実績【${list.length.toLocaleString()}件】入札・落札情報 | ${SITE}`,
    desc: `${summary}継続契約の落札履歴と次回公告の目安、同分野の落札企業をデータで公開。`,
    crumb: [['落札企業', '/company/'], [name, '']],
    jsonld: { '@context': 'https://schema.org', '@type': 'Organization', name, identifier: corpNo, url: `${ORIGIN}/company/${corpNo}/` },
    body: `<h1>${esc(name)}の落札実績</h1>
<p class="meta">法人番号 ${corpNo}。調達ポータル公表の落札実績オープンデータに基づく。</p>
<p class="insight">${esc(summary)}${histories.length ? ` 複数年にわたり繰り返し発注されている継続契約${histories.length}件に関与しています（下記に履歴と次回公告の目安）。` : ''}</p>
${statBoxes([['落札件数', list.length.toLocaleString() + '件'], ['落札総額', yen(total)], ['直近の落札', list[0].award_date]])}
${histHtml ? `<h2>継続契約の落札履歴と次回予測</h2>
<p class="meta">この会社が関わる案件のうち、複数年繰り返し発注されているもの。過去に誰がいくらで落札してきたかの履歴です。</p>${histHtml}` : ''}
<h2>取引の多い機関</h2>${groupTable(list, (a) => a.ministry_code, (k) => MINISTRIES[k] || k, (k) => `/organ/${k.toLowerCase()}/`)}
<h2>業務分野</h2>${groupTable(list.filter((a) => a.slug && a.slug !== 'other'), (a) => a.slug, (k) => LABEL[k] || k, (k) => `/price/${k}/`)}
${cohortHtml}
<h2>直近の落札案件</h2>${awardRows(list.slice(0, RECENT_LIMIT), { company: false })}`,
  });
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
<p>官公庁入札で落札実績のある${companyCount.toLocaleString()}社を収録（落札件数順）。</p>${nav}
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
    title: `${name}の入札 落札結果・落札企業【${list.length.toLocaleString()}件】 | ${SITE}`,
    desc: `${name}の入札・落札結果アーカイブ。落札実績${list.length.toLocaleString()}件から、よく発注される業務・落札の多い企業・直近の落札事例を公開。`,
    crumb: [['発注機関', '/organ/'], [name, '']],
    body: `<h1>${esc(name)}の落札結果</h1>
${statBoxes([['実績件数', list.length.toLocaleString() + '件'], ['落札総額', yen(list.reduce((s, a) => s + (a.amount || 0), 0))]])}
${insights(list, name)}
<h2>発注時期のパターン</h2>${monthChart(list, name)}
<h2>発注の多い業務</h2>${groupTable(list.filter((a) => a.slug && a.slug !== 'other'), (a) => a.slug, (k) => LABEL[k] || k, (k) => `/price/${k}/`)}
<h2>落札の多い企業</h2>${groupTable(list.filter((a) => a.corporate_no), (a) => a.corporate_no, (k) => companyName.get(k) || k, (k) => `/company/${k}/`)}
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
  title: `無料の入札新着アラート | ${SITE}`,
  desc: '業種と地域を登録するだけで、官公庁・自治体の新着入札案件を毎朝メールでお知らせします。無料。',
  body: `<h1>あなた向けの入札機会レポートを、月1回無料で</h1>
<p>業種と地域を登録すると、あなたの条件の新着案件・落札相場の動き・来期の公告予測をまとめた
<b>月次レポート</b>を無料でお届けします。毎朝の自動配信（有料プラン・準備中）の先行案内もこちらから。</p>
<form name="alert" method="POST" action="/.netlify/functions/alert-form" data-netlify="true" netlify-honeypot="bot-field">
<input type="hidden" name="form-name" value="alert">
<p style="display:none"><label>入力しないでください: <input name="bot-field"></label></p>
<p><label>メールアドレス<br><input type="email" name="email" required style="width:100%;max-width:400px;padding:8px"></label></p>
<p><label>業種（主な入札分野）<br><select name="category" required style="padding:8px">
<option value="">選択してください</option>
${TAXONOMY.map((t) => `<option>${t.label}</option>`).join('')}
<option>その他</option></select></label></p>
<p><label>対象の都道府県<br><select name="pref" required style="padding:8px">
<option value="">選択してください</option><option>全国</option>
${PREFS.map((p) => `<option>${p}</option>`).join('')}</select></label></p>
<p><button type="submit" style="background:#0f6ab2;color:#fff;border:0;padding:12px 32px;border-radius:6px;font-weight:700;font-size:1rem">無料で登録する</button></p>
</form>
<p class="meta">登録いただいたメールアドレスは案件通知以外に使用しません。配信はいつでも停止できます。</p>`,
});
page('/alert/thanks/', {
  title: `登録ありがとうございます | ${SITE}`,
  desc: '入札新着アラートの登録を受け付けました。',
  noindex: true,
  body: `<h1>送信を受け付けました</h1>
<p>レポート登録の方は、配信の準備ができ次第メールでお届けします。お問い合わせの方は、確認のうえご連絡します。</p>
<p>それまでの間は<a href="/shindan/">入札機会診断</a>や<a href="/price/">落札相場データ</a>をご活用ください。</p>`,
});

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
mkdirSync(join(DIST, 'shindan'), { recursive: true });
writeFileSync(join(DIST, 'shindan', 'data.json'),
  JSON.stringify({ mins: MINISTRIES, cats: shindanStats }));

page('/shindan/', {
  title: `入札機会診断 — あなたの業種の官公庁市場が10秒でわかる | ${SITE}`,
  desc: '業種を選ぶだけで、官公庁入札の年間発注件数・金額・発注機関・落札相場・公告シーズン・毎年出る定番案件がその場でわかる無料診断。登録不要。',
  crumb: [['入札機会診断', '']],
  body: `<h1>入札機会診断</h1>
<p>業種を選ぶだけで、<b>あなたの市場の実データ</b>がその場で出ます。登録不要・無料。</p>
<div class="tool">
<select id="scat"><option value="">業種を選んでください</option>${shindanStats.map((s) => `<option value="${s.slug}">${s.label}</option>`).join('')}</select>
<select id="spref"><option value="">全国（国の機関）</option>${PREFS.map((p) => `<option>${p}</option>`).join('')}</select>
<span class="meta">地域は案件名からの推定（参考値）。自治体の入札データは順次追加予定です。</span>
<div id="sout"></div>
</div>
<script defer src="/assets/shindan.js"></script>`,
});

// about / policy
page('/about/', {
  title: `運営者情報・データについて | ${SITE}`,
  desc: '入札コンパスのデータソースと運営方針。',
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
<li>現在の収録範囲は<b>国の機関（府省・独立行政法人等）の落札実績</b>です。
<b>都道府県・市区町村の入札は未収録</b>で、順次追加予定です</li>
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
  title: `掲載ポリシー・削除依頼 | ${SITE}`,
  desc: '掲載情報の方針と訂正・削除依頼の窓口。',
  body: `<h1>掲載ポリシー・削除依頼</h1>
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
  title: `${SITE} | 官公庁入札の落札相場・落札実績データベース`,
  desc: `官公庁入札の落札相場と落札実績${AWARDS.length.toLocaleString()}件を無料公開。業務別の相場、企業別の落札履歴、機関別の発注傾向がわかる入札の判断支援データベース。`,
  jsonld: { '@context': 'https://schema.org', '@type': 'WebSite', name: SITE, url: ORIGIN },
  body: `<h1>官公庁入札の落札相場・実績データベース</h1>
${statBoxes([['落札実績', AWARDS.length.toLocaleString() + '件'], ['収録企業', companyCount.toLocaleString() + '社'], ['収録機関', organCount + '機関'], ['データ期間', '2013年度〜']])}
<div class="cta"><b>まずは10秒診断から。</b>業種を選ぶだけで、年間発注件数・相場・公告シーズン・毎年出る定番案件がその場でわかります。<br><br><a href="/shindan/">入札機会診断をやってみる</a></div>
<h2>業務別の落札相場</h2>
<ul>${TAXONOMY.filter((t) => (byCat.get(t.slug) || []).length >= MIN_PRICE_AWARDS).slice(0, 12)
  .map((t) => `<li><a href="/price/${t.slug}/">${t.label}の落札相場</a></li>`).join('')}</ul>
<p><a href="/price/">→ すべての業務分類を見る</a> ／ <a href="/company/">→ 落札企業データベース</a> ／ <a href="/organ/">→ 発注機関別</a></p>`,
});

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
 var rows=D.rows.filter(function(r){
  if(mc&&r[3]!==mc)return false;
  if(bi!==null){var b=bands[bi];if(r[2]<b[0]||(b[1]!==null&&r[2]>=b[1]))return false}
  for(var i=0;i<terms.length;i++)if(r[0].indexOf(terms[i])<0)return false;
  return true});
 var am=rows.map(function(r){return r[2]}).filter(function(n){return n>0});
 if(!rows.length){tstats.innerHTML='該当する事例がありません。キーワードを減らすか変えてみてください。';tres.innerHTML='';return}
 tstats.innerHTML='該当 <b>'+rows.length.toLocaleString()+'件</b>'
  +(am.length?'　落札額の中央値 <b>'+yen(median(am))+'</b>　中心レンジ(25〜75%) <b>'+yen(pct(am,0.25))+' 〜 '+yen(pct(am,0.75))+'</b>':'');
 var top=rows.slice(0,100);
 tres.innerHTML='<table><tr><th>落札日</th><th>案件名</th><th>機関</th><th>落札者</th><th>落札価格</th></tr>'
  +top.map(function(r){return '<tr><td>'+r[1]+'</td><td>'+esc(r[0])+'</td><td>'+esc(D.mins[r[3]]||r[3])+'</td><td>'+esc(r[4]||'')+'</td><td style="text-align:right;white-space:nowrap">'+yen(r[2])+'</td></tr>'}).join('')
  +'</table>'+(rows.length>100?'<p class="meta">上位100件を表示（全'+rows.length.toLocaleString()+'件）。キーワードでさらに絞り込めます。</p>':'');
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
 var peak=c.months.indexOf(Math.max.apply(null,c.months))+1;
 var pubM=((peak+10-1)%12)+1; // 公告はおおむね落札の2ヶ月前
 var html='<h2>あなたの市場: '+esc(c.label)+(pref?' × '+esc(pref)+'（参考）':'（国の機関・全国）')+'</h2>'
  +'<div class="stats">'
  +'<div class="stat"><b>年間 約'+c.perYear.toLocaleString()+'件</b>発注件数（直近2年平均）</div>'
  +'<div class="stat"><b>'+yen(c.amountYear)+'</b>年間発注総額（2025年）</div>'
  +'<div class="stat"><b>'+esc(c.band)+'</b>最多の金額帯</div>'
  +'<div class="stat"><b>'+peak+'月</b>落札の集中月（公告は'+pubM+'月頃〜）</div></div>'
  +'<h3>発注が多い機関</h3><ul>'+c.topMins.map(function(m){return '<li><a href="/organ/'+m[0].toLowerCase()+'/">'+esc(S.mins[m[0]]||m[0])+'</a>（'+m[1].toLocaleString()+'件）</li>'}).join('')+'</ul>'
  +'<div id="steiban"><p class="meta">定番案件を分析中…</p></div>'
  +'<div class="cta"><b>この条件の新着案件を、毎朝自動で受け取りませんか?</b><br>'
  +'いま準備中の有料プラン（月9,800円）では、あなたの条件に合う新着案件を毎朝、類似案件の落札相場つきでお届けします。<br><br>'
  +'<a href="/alert/">無料の月次レポートに登録して先行案内を受け取る</a></div>';
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
writeFileSync(join(DIST, '68c8ff01b5ee8614e56c3a91ccbb8f59.txt'), '68c8ff01b5ee8614e56c3a91ccbb8f59');
writeFileSync(join(DIST, 'llms.txt'), `# ${SITE}
官公庁入札の落札相場・落札実績データベース。調達ポータルの落札実績オープンデータ（2013年度〜、${AWARDS.length.toLocaleString()}件）を構造化し、
業務別相場（/price/）、企業別落札実績（/company/）、機関別落札結果（/organ/）として公開している。
データ出典: 調達ポータル落札実績オープンデータ（政府標準利用規約準拠）。毎日更新。
`);
const shards = [];
for (let i = 0; i < urls.length; i += 10000) shards.push(urls.slice(i, i + 10000));
shards.forEach((s, i) => writeFileSync(join(DIST, `sitemap-${i}.xml`),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${s.map((u) => `<url><loc>${u}</loc></url>`).join('\n')}\n</urlset>`));
writeFileSync(join(DIST, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${shards.map((_, i) => `<sitemap><loc>${ORIGIN}/sitemap-${i}.xml</loc></sitemap>`).join('\n')}\n</sitemapindex>`);

console.log(`生成完了: 計${urls.length}ページ（相場${priceCount} / 企業${companyCount} / 機関${organCount}）→ site/dist`);
