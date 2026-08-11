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
`;

function page(path, { title, desc, crumb = [], body, noindex = false, jsonld = null }) {
  const canonical = ORIGIN + path;
  const crumbHtml = crumb.length
    ? `<nav class="crumb">${[['トップ', '/'], ...crumb].map(([t, h], i, arr) =>
        i === arr.length - 1 ? esc(t) : `<a href="${h}">${esc(t)}</a>`).join(' › ')}</nav>` : '';
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
<div class="cta"><b>あなたの会社が入れる案件だけ、毎朝届く。</b><br>
業種と地域を登録すると、官公庁・自治体の新着入札案件を無料でお知らせします。<br><br>
<a href="/alert/">無料アラートに登録する</a></div>
</main>
<footer><div class="in">
<p>${SITE} — 官公庁入札の落札相場・落札実績データベース。データ出典: 調達ポータル「落札実績オープンデータ」（政府標準利用規約準拠）ほか公的公表情報。最終更新: ${BUILT_AT}</p>
<p><a href="/about/">運営者情報・データについて</a> ／ <a href="/policy/">掲載ポリシー・削除依頼</a></p>
</div></footer>
</body></html>`;
  const file = join(DIST, path.replace(/\/$/, '/index.html').replace(/^\//, ''));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, html);
  return canonical;
}

const awardRows = (list, { company = true } = {}) => `
<div class="wrap"><table><tr><th>落札日</th><th>案件名</th><th>機関</th>${company ? '<th>落札者</th>' : ''}<th>落札価格</th></tr>
${list.map((a) => `<tr><td>${a.award_date}</td><td>${esc(a.name)}</td><td>${esc(MINISTRIES[a.ministry_code] || a.ministry_code)}</td>${
  company ? `<td>${a.corporate_no ? `<a href="/company/${a.corporate_no}/">${esc(a.winner_name)}</a>` : esc(a.winner_name)}</td>` : ''
}<td class="num">${yen(a.amount)}</td></tr>`).join('\n')}</table></div>`;

const statBoxes = (pairs) => `<div class="stats">${pairs.map(([k, v]) => `<div class="stat"><b>${v}</b>${k}</div>`).join('')}</div>`;

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

// 相場ページ
let priceCount = 0;
for (const t of TAXONOMY) {
  const list = byCat.get(t.slug) || [];
  if (list.length < MIN_PRICE_AWARDS) continue;
  priceCount++;
  const amounts = list.map((a) => a.amount).filter((n) => n > 0);
  const med = median(amounts);
  const recent = list.slice(0, RECENT_LIMIT);
  urls.push(page(`/price/${t.slug}/`, {
    title: `${t.label}の入札 落札相場・落札実績【国の機関 ${list.length.toLocaleString()}件】 | ${SITE}`,
    desc: `官公庁の「${t.label}」入札の落札相場。落札価格の中央値${yen(med)}・実績${list.length.toLocaleString()}件から、発注機関別の傾向・主要落札企業・直近の落札事例をデータで公開。`,
    crumb: [['落札相場', '/price/'], [t.label, '']],
    jsonld: { '@context': 'https://schema.org', '@type': 'Dataset', name: `${t.label}の落札実績データ`, description: `国の機関の${t.label}に関する落札実績${list.length}件の統計`, license: 'https://www.digital.go.jp/resources/open_data/', creator: { '@type': 'Organization', name: SITE } },
    body: `<h1>${t.label}の入札 落札相場・実績データ</h1>
<p class="meta">調達ポータル公表の落札実績（2013年度〜）のうち「${t.label}」に分類される${list.length.toLocaleString()}件の統計。毎日更新。</p>
${statBoxes([['実績件数', list.length.toLocaleString() + '件'], ['落札価格の中央値', yen(med)], ['平均', yen(amounts.length ? Math.round(amounts.reduce((s, n) => s + n, 0) / amounts.length) : null)]])}
<h2>発注が多い機関</h2>${groupTable(list, (a) => a.ministry_code, (k) => MINISTRIES[k] || k, (k) => `/organ/${k.toLowerCase()}/`)}
<h2>落札件数の多い企業</h2>${groupTable(list.filter((a) => a.corporate_no), (a) => a.corporate_no, (k) => companyName.get(k) || k, (k) => `/company/${k}/`)}
<h2>入札方式の内訳</h2>${groupTable(list, (a) => a.method_code, (k) => BIDDING_METHODS[k] || k)}
<h2>直近の落札事例</h2>${awardRows(recent)}`,
  }));
}

// 相場ハブ
urls.push(page('/price/', {
  title: `業務別の落札相場一覧 | ${SITE}`,
  desc: '官公庁入札の落札相場を業務分類別に公開。清掃・警備・システム開発など、実データに基づく落札価格の水準がわかります。',
  crumb: [['落札相場', '']],
  body: `<h1>業務別の落札相場</h1><ul>${TAXONOMY.filter((t) => (byCat.get(t.slug) || []).length >= MIN_PRICE_AWARDS)
    .map((t) => `<li><a href="/price/${t.slug}/">${t.label}</a>（${(byCat.get(t.slug) || []).length.toLocaleString()}件）</li>`).join('')}</ul>`,
}));

// 企業ページ
let companyCount = 0;
for (const [corpNo, list] of byCompany) {
  if (list.length < MIN_COMPANY_AWARDS) continue;
  companyCount++;
  const name = companyName.get(corpNo) || list[0].winner_name;
  const total = list.reduce((s, a) => s + (a.amount || 0), 0);
  urls.push(page(`/company/${corpNo}/`, {
    title: `${name}の落札実績【${list.length.toLocaleString()}件】入札・落札情報 | ${SITE}`,
    desc: `${name}（法人番号${corpNo}）の官公庁入札の落札実績。落札${list.length.toLocaleString()}件・総額${yen(total)}。取引の多い機関・業務分野・直近の落札案件をデータで公開。`,
    crumb: [['落札企業', '/company/'], [name, '']],
    jsonld: { '@context': 'https://schema.org', '@type': 'Organization', name, identifier: corpNo },
    body: `<h1>${esc(name)}の落札実績</h1>
<p class="meta">法人番号 ${corpNo}。調達ポータル公表の落札実績オープンデータに基づく。</p>
${statBoxes([['落札件数', list.length.toLocaleString() + '件'], ['落札総額', yen(total)], ['直近の落札', list[0].award_date]])}
<h2>取引の多い機関</h2>${groupTable(list, (a) => a.ministry_code, (k) => MINISTRIES[k] || k, (k) => `/organ/${k.toLowerCase()}/`)}
<h2>業務分野</h2>${groupTable(list.filter((a) => a.slug && a.slug !== 'other'), (a) => a.slug, (k) => LABEL[k] || k, (k) => `/price/${k}/`)}
<h2>直近の落札案件</h2>${awardRows(list.slice(0, RECENT_LIMIT), { company: false })}`,
  }));
}

// 企業ハブ（落札件数トップ100のみ列挙。全社はsitemapから）
const topCompanies = [...byCompany.entries()].filter(([, l]) => l.length >= MIN_COMPANY_AWARDS)
  .sort((x, y) => y[1].length - x[1].length);
urls.push(page('/company/', {
  title: `官公庁入札の落札企業データベース（${companyCount.toLocaleString()}社） | ${SITE}`,
  desc: '官公庁入札で落札実績のある企業を法人番号ベースで収録。企業ごとの落札件数・金額・取引機関を公開。',
  crumb: [['落札企業', '']],
  body: `<h1>落札企業データベース</h1><p>${companyCount.toLocaleString()}社を収録。落札件数トップ100:</p>
<ol>${topCompanies.slice(0, 100).map(([no, l]) => `<li><a href="/company/${no}/">${esc(companyName.get(no) || no)}</a>（${l.length.toLocaleString()}件）</li>`).join('')}</ol>`,
}));

// 機関ページ
let organCount = 0;
for (const [code, list] of byMinistry) {
  const name = MINISTRIES[code];
  if (!name || list.length < MIN_PRICE_AWARDS) continue;
  organCount++;
  urls.push(page(`/organ/${code.toLowerCase()}/`, {
    title: `${name}の入札 落札結果・落札企業【${list.length.toLocaleString()}件】 | ${SITE}`,
    desc: `${name}の入札・落札結果アーカイブ。落札実績${list.length.toLocaleString()}件から、よく発注される業務・落札の多い企業・直近の落札事例を公開。`,
    crumb: [['発注機関', '/organ/'], [name, '']],
    body: `<h1>${esc(name)}の落札結果</h1>
${statBoxes([['実績件数', list.length.toLocaleString() + '件'], ['落札総額', yen(list.reduce((s, a) => s + (a.amount || 0), 0))]])}
<h2>発注の多い業務</h2>${groupTable(list.filter((a) => a.slug && a.slug !== 'other'), (a) => a.slug, (k) => LABEL[k] || k, (k) => `/price/${k}/`)}
<h2>落札の多い企業</h2>${groupTable(list.filter((a) => a.corporate_no), (a) => a.corporate_no, (k) => companyName.get(k) || k, (k) => `/company/${k}/`)}
<h2>直近の落札事例</h2>${awardRows(list.slice(0, RECENT_LIMIT))}`,
  }));
}
urls.push(page('/organ/', {
  title: `発注機関別の落札結果一覧 | ${SITE}`,
  desc: '国の機関別に落札結果を集約。省庁ごとの発注傾向・落札企業がわかります。',
  crumb: [['発注機関', '']],
  body: `<h1>発注機関別の落札結果</h1><ul>${[...byMinistry.entries()].filter(([c, l]) => MINISTRIES[c] && l.length >= MIN_PRICE_AWARDS)
    .sort((x, y) => y[1].length - x[1].length)
    .map(([c, l]) => `<li><a href="/organ/${c.toLowerCase()}/">${MINISTRIES[c]}</a>（${l.length.toLocaleString()}件）</li>`).join('')}</ul>`,
}));

// アラートLP（POSTはNetlify Functionで中継。hidden formはNetlify Formsの検出用）
const PREFS = ['北海道','青森県','岩手県','宮城県','秋田県','山形県','福島県','茨城県','栃木県','群馬県','埼玉県','千葉県','東京都','神奈川県','新潟県','富山県','石川県','福井県','山梨県','長野県','岐阜県','静岡県','愛知県','三重県','滋賀県','京都府','大阪府','兵庫県','奈良県','和歌山県','鳥取県','島根県','岡山県','広島県','山口県','徳島県','香川県','愛媛県','高知県','福岡県','佐賀県','長崎県','熊本県','大分県','宮崎県','鹿児島県','沖縄県'];
urls.push(page('/alert/', {
  title: `無料の入札新着アラート | ${SITE}`,
  desc: '業種と地域を登録するだけで、官公庁・自治体の新着入札案件を毎朝メールでお知らせします。無料。',
  body: `<h1>入札の新着案件を、毎朝メールで</h1>
<p>業種と地域を登録すると、条件に合う新着の入札案件を毎朝お届けします。登録は無料です。</p>
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
}));
urls.push(page('/alert/thanks/', {
  title: `登録ありがとうございます | ${SITE}`,
  desc: '入札新着アラートの登録を受け付けました。',
  noindex: true,
  body: `<h1>登録を受け付けました</h1>
<p>配信の準備ができ次第、毎朝の新着案件メールをお届けします。それまでの間は<a href="/price/">落札相場データ</a>をご活用ください。</p>`,
}));

// about / policy
urls.push(page('/about/', {
  title: `運営者情報・データについて | ${SITE}`,
  desc: '入札コンパスのデータソースと運営方針。',
  body: `<h1>運営者情報・データについて</h1>
<p>${SITE}は、官公庁入札の落札相場・落札実績を公開データから構造化して提供するサービスです。</p>
<h2>データソース</h2>
<ul><li>調達ポータル「落札実績オープンデータ」（デジタル庁）— 政府標準利用規約に準拠して利用</li>
<li>官公需情報ポータルサイト（中小企業庁）検索API — 公告情報の取得に利用</li></ul>
<p>本サービスは官公需情報ポータルサイトのAPIを利用しています: <a href="https://www.kkj.go.jp/s/" rel="noopener">官公需情報ポータルサイト</a></p>`,
}));
urls.push(page('/policy/', {
  title: `掲載ポリシー・削除依頼 | ${SITE}`,
  desc: '掲載情報の方針と訂正・削除依頼の窓口。',
  body: `<h1>掲載ポリシー・削除依頼</h1>
<p>掲載している落札実績は、国の機関が公表した公開情報（調達ポータル 落札実績オープンデータ等）をそのまま構造化したものです。</p>
<p>掲載内容の誤り、法人情報の訂正・削除のご依頼は、公表元データの確認のうえ対応します。お問い合わせはトップページ記載の窓口まで。</p>`,
}));

// トップ
urls.push(page('/', {
  title: `${SITE} | 官公庁入札の落札相場・落札実績データベース`,
  desc: `官公庁入札の落札相場と落札実績${AWARDS.length.toLocaleString()}件を無料公開。業務別の相場、企業別の落札履歴、機関別の発注傾向がわかる入札の判断支援データベース。`,
  jsonld: { '@context': 'https://schema.org', '@type': 'WebSite', name: SITE, url: ORIGIN },
  body: `<h1>官公庁入札の落札相場・実績データベース</h1>
${statBoxes([['落札実績', AWARDS.length.toLocaleString() + '件'], ['収録企業', companyCount.toLocaleString() + '社'], ['収録機関', organCount + '機関'], ['データ期間', '2013年度〜']])}
<h2>業務別の落札相場</h2>
<ul>${TAXONOMY.filter((t) => (byCat.get(t.slug) || []).length >= MIN_PRICE_AWARDS).slice(0, 12)
  .map((t) => `<li><a href="/price/${t.slug}/">${t.label}の落札相場</a></li>`).join('')}</ul>
<p><a href="/price/">→ すべての業務分類を見る</a> ／ <a href="/company/">→ 落札企業データベース</a> ／ <a href="/organ/">→ 発注機関別</a></p>`,
}));

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
