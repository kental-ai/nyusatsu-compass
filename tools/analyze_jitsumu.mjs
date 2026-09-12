import { DatabaseSync } from 'node:sqlite';
// 実務編（有料）の根拠数字を再計測する。使い方: node --no-warnings tools/analyze_jitsumu.mjs（読み取り専用・約1分）
import { fileURLToPath } from 'node:url'; import { dirname, join } from 'node:path';
const db = new DatabaseSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'compass.db'), { readOnly: true });
const q = (s) => db.prepare(s).all();
const pct = (arr, p) => { const a = [...arr].sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p))] : null; };
const dist = (arr) => arr.length ? `n=${arr.length} p10=${pct(arr, .1)} p25=${pct(arr, .25)} p50=${pct(arr, .5)} p75=${pct(arr, .75)} p90=${pct(arr, .9)}` : 'n=0';
const r1 = (x) => Math.round(x * 10) / 10;
const norm = (s) => String(s || '').replace(/[（(].*?[）)]/g, '').replace(/(令和|平成|R|H)\s*\d+\s*年度?/g, '').replace(/\d+年度/g, '').replace(/第\s*\d+\s*回/g, '').replace(/[0-9０-９]+/g, '#').replace(/\s+/g, '').trim();

console.log('#### 1. coverage of local_awards');
console.log(q(`select count(*) n, sum(planned_price>0) pp, sum(floor_price>0) fp, sum(bidders>0) bd, sum(planned_price>0 and floor_price>0) both from local_awards`)[0]);
console.log('by pref (pp>0):', q(`select pref, count(*) n, sum(planned_price>0) pp, sum(floor_price>0) fp, sum(bidders>0) bd from local_awards group by pref having pp>0 order by pp desc`).map(r => `${r.pref}:${r.n}/${r.pp}/${r.fp}/${r.bd}`).join(' '));

const L = q(`select org, pref, name, open_date, category, method, winner_name, corporate_no, amount, slug, fiscal_year, planned_price, floor_price, bidders from local_awards where amount>0`);
const withRate = L.filter(a => a.planned_price > 0 && a.amount <= a.planned_price * 1.05).map(a => ({ ...a, rate: a.amount / a.planned_price * 100 }));
console.log('\n#### 2. 落札率 distribution (amount/planned)');
console.log('ALL', dist(withRate.map(a => r1(a.rate))));
const by = (arr, key) => { const m = new Map(); for (const a of arr) { const k = key(a); if (k == null) continue; (m.get(k) ?? m.set(k, []).get(k)).push(a); } return m; };
for (const [k, v] of [...by(withRate, a => a.category)].sort((a, b) => b[1].length - a[1].length).slice(0, 6)) console.log(' category', k, dist(v.map(a => r1(a.rate))));
for (const [k, v] of [...by(withRate, a => a.slug)].sort((a, b) => b[1].length - a[1].length).slice(0, 12)) console.log(' slug', k, dist(v.map(a => r1(a.rate))));
for (const [k, v] of [...by(withRate, a => a.method)].sort((a, b) => b[1].length - a[1].length).slice(0, 10)) console.log(' method', k, dist(v.map(a => r1(a.rate))));
for (const [k, v] of [...by(withRate, a => a.pref)].sort((a, b) => b[1].length - a[1].length).slice(0, 8)) console.log(' pref', k, dist(v.map(a => r1(a.rate))));
const band = (n) => n < 1e6 ? 'a<100万' : n < 5e6 ? 'b100-500万' : n < 3e7 ? 'c500-3000万' : n < 1e8 ? 'd3000万-1億' : 'e1億+';
for (const [k, v] of [...by(withRate, a => band(a.planned_price))].sort((a, b) => (a[0] < b[0] ? -1 : 1))) console.log(' band', k, dist(v.map(a => r1(a.rate))));

console.log('\n#### 3. 最低制限価格 (floor)');
const wf = withRate.filter(a => a.floor_price > 0 && a.floor_price <= a.planned_price);
console.log('floor/planned %', dist(wf.map(a => r1(a.floor_price / a.planned_price * 100))));
for (const [k, v] of [...by(wf, a => a.category)].sort((a, b) => b[1].length - a[1].length).slice(0, 4)) console.log(' floor/planned by category', k, dist(v.map(a => r1(a.floor_price / a.planned_price * 100))));
const gap = wf.map(a => (a.amount - a.floor_price) / a.planned_price * 100);
console.log('(amount-floor)/planned pts', dist(gap.map(r1)));
const sh = (f) => r1(wf.filter(f).length / wf.length * 100) + '%';
console.log('amount==floor:', sh(a => a.amount === a.floor_price), ' within 0.5pt:', sh(a => (a.amount - a.floor_price) / a.planned_price < 0.005), ' within 1pt:', sh(a => (a.amount - a.floor_price) / a.planned_price < 0.01), ' within 3pt:', sh(a => (a.amount - a.floor_price) / a.planned_price < 0.03), ' below floor(!):', sh(a => a.amount < a.floor_price));
for (const [k, v] of [...by(wf, a => a.category)].sort((a, b) => b[1].length - a[1].length).slice(0, 4)) console.log(' within1pt by category', k, r1(v.filter(a => (a.amount - a.floor_price) / a.planned_price < 0.01).length / v.length * 100) + '%', 'n=' + v.length);
for (const [k, v] of [...by(wf, a => a.pref)].sort((a, b) => b[1].length - a[1].length).slice(0, 6)) console.log(' within1pt by pref', k, r1(v.filter(a => (a.amount - a.floor_price) / a.planned_price < 0.01).length / v.length * 100) + '%', 'n=' + v.length);

console.log('\n#### 4. 率 vs 応札社数');
const wb = withRate.filter(a => a.bidders > 0);
const bb = (n) => n === 1 ? '1社' : n <= 3 ? '2-3社' : n <= 6 ? '4-6社' : n <= 10 ? '7-10社' : '11社+';
for (const [k, v] of [...by(wb, a => bb(a.bidders))].sort((a, b) => (a[0] < b[0] ? -1 : 1))) console.log(' ', k, dist(v.map(a => r1(a.rate))));
console.log('bidders dist ALL', dist(L.filter(a => a.bidders > 0).map(a => a.bidders)));
for (const [k, v] of [...by(L.filter(a => a.bidders > 0), a => a.category)].sort((a, b) => b[1].length - a[1].length).slice(0, 4)) console.log(' bidders by category', k, dist(v.map(a => a.bidders)));
for (const [k, v] of [...by(L.filter(a => a.bidders > 0), a => band(a.amount))].sort((a, b) => (a[0] < b[0] ? -1 : 1))) console.log(' bidders by band', k, dist(v.map(a => a.bidders)));
console.log(' 1社応札 share:', r1(L.filter(a => a.bidders === 1).length / L.filter(a => a.bidders > 0).length * 100) + '%');

console.log('\n#### 5. 継続契約: 前年比・交代・分割');
const N = q(`select ministry_code org, name, award_date open_date, amount, winner_name, corporate_no, fiscal_year, method_code method, e.slug from awards a join enrich_class e on e.award_rowid=a.rowid where amount>0`);
function contracts(rows) {
  const g = new Map();
  for (const a of rows) { const k = a.org + '|' + norm(a.name); (g.get(k) ?? g.set(k, []).get(k)).push(a); }
  const out = [];
  for (const [k, arr] of g) {
    const years = new Set(arr.map(a => a.fiscal_year)); if (years.size < 2) continue;
    const perYear = arr.length / years.size; const mixed = perYear >= 1.8;
    const s = [...arr].sort((a, b) => a.open_date < b.open_date ? -1 : 1);
    // one per fiscal year (first)
    const seen = new Set(); const one = s.filter(a => !seen.has(a.fiscal_year) && seen.add(a.fiscal_year));
    out.push({ k, arr: one, mixed, n: arr.length, years: years.size, slug: arr[0].slug });
  }
  return out;
}
for (const [label, rows] of [['national', N], ['local', L]]) {
  const cs = contracts(rows);
  console.log(`-- ${label}: contracts(>=2yrs)=${cs.length} mixed(>=1.8/yr)=${cs.filter(c => c.mixed).length} (${r1(cs.filter(c => c.mixed).length / cs.length * 100)}%)`);
  const clean = cs.filter(c => !c.mixed);
  const yoy = [], chg = { 1: [0, 0], 2: [0, 0], '3+': [0, 0] }, bySlugChg = new Map();
  let consecutive = 0, changes = 0;
  for (const c of clean) {
    const a = c.arr; let streak = 1;
    for (let i = 1; i < a.length; i++) {
      if (a[i].fiscal_year !== a[i - 1].fiscal_year + 1) { streak = 1; continue; }
      yoy.push((a[i].amount / a[i - 1].amount - 1) * 100);
      const same = (a[i].corporate_no && a[i].corporate_no === a[i - 1].corporate_no) || norm(a[i].winner_name) === norm(a[i - 1].winner_name);
      const key = streak >= 3 ? '3+' : String(streak);
      chg[key][1]++; if (!same) chg[key][0]++;
      consecutive++; if (!same) changes++;
      const m = bySlugChg.get(c.slug) ?? bySlugChg.set(c.slug, [0, 0]).get(c.slug); m[1]++; if (!same) m[0]++;
      streak = same ? streak + 1 : 1;
    }
  }
  console.log(' yoy % dist', dist(yoy.map(r1)));
  const within = (t) => r1(yoy.filter(x => Math.abs(x) <= t).length / yoy.length * 100) + '%';
  console.log(' |yoy|<=3%:', within(3), ' <=5%:', within(5), ' <=10%:', within(10), ' >+20%:', r1(yoy.filter(x => x > 20).length / yoy.length * 100) + '%', ' <-20%:', r1(yoy.filter(x => x < -20).length / yoy.length * 100) + '%', ' exactly 0:', r1(yoy.filter(x => x === 0).length / yoy.length * 100) + '%');
  console.log(' turnover overall', r1(changes / consecutive * 100) + '%', 'pairs=' + consecutive);
  for (const k of ['1', '2', '3+']) console.log(`  incumbent streak ${k}: change prob ${r1(chg[k][0] / chg[k][1] * 100)}% (n=${chg[k][1]})`);
  console.log(' turnover by slug (n>=300):', [...bySlugChg].filter(([, v]) => v[1] >= 300).sort((a, b) => b[1][0] / b[1][1] - a[1][0] / a[1][1]).map(([k, v]) => `${k}:${r1(v[0] / v[1] * 100)}%`).join(' '));
}

console.log('\n#### 6. 年度サイクル: 開札月分布');
const monthShare = (rows) => { const m = Array(12).fill(0); for (const a of rows) { const mo = +String(a.open_date).slice(5, 7); if (mo) m[mo - 1]++; } const t = m.reduce((s, x) => s + x, 0); return m.map((x, i) => `${i + 1}月:${r1(x / t * 100)}%`).join(' '); };
console.log('national', monthShare(N));
console.log('local   ', monthShare(L));
for (const [k, v] of [...by(L, a => a.category)].sort((a, b) => b[1].length - a[1].length).slice(0, 3)) console.log(' local', k, monthShare(v));

console.log('\n#### 7. 公告→開札の日数 (notices_archive)');
const NA = q(`select issue_date, opening, deadline, category from notices_archive where issue_date>='2025-01-01' and opening>issue_date`);
const days = NA.map(a => (new Date(a.opening) - new Date(a.issue_date)) / 86400000).filter(d => d > 0 && d < 200);
console.log('issue->opening days', dist(days.map(Math.round)));
for (const [k, v] of [...by(NA, a => a.category)].sort((a, b) => b[1].length - a[1].length).slice(0, 3)) console.log(' ', k, dist(v.map(a => Math.round((new Date(a.opening) - new Date(a.issue_date)) / 86400000)).filter(d => d > 0 && d < 200)));
const dl = NA.filter(a => a.deadline > a.issue_date).map(a => Math.round((new Date(a.deadline) - new Date(a.issue_date)) / 86400000)).filter(d => d > 0 && d < 200);
console.log('issue->deadline days', dist(dl));
