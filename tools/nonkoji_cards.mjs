// 実務編 v3（工事以外が主な読者）の根拠数字と県カードを計測する。読み取り専用。
// 使い方: node --no-warnings tools/nonkoji_cards.mjs
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { TAXONOMY } from '../pipeline/taxonomy.mjs';
const db = new DatabaseSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'compass.db'), { readOnly: true });
const LABEL = Object.fromEntries(TAXONOMY.map((t) => [t.slug, t.label]));
const r1 = (x) => Math.round(x * 10) / 10;
const pct = (arr, p) => { const a = [...arr].sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p))] : null; };
const GROUP = {};
for (const s of ['sekkei', 'chosa', 'shien']) GROUP[s] = 'コンサル';
for (const s of ['seiso', 'keibi', 'ryokka', 'josetsu', 'haiki', 'hoshu', 'unei', 'unpan', 'insatsu', 'kenshu', 'koho', 'honyaku', 'jinzai', 'iryo', 'kyushoku', 'senmon', 'ringyo', 'josen', 'system', 'tsushin']) GROUP[s] = '役務';
for (const s of ['kounyu', 'kiki', 'sharyo', 'chintai', 'energy', 'tosho', 'seizo']) GROUP[s] = '物品';
const grp = (s) => GROUP[s] || (s === 'koji' ? '工事' : 'その他');
const by = (arr, key) => { const m = new Map(); for (const a of arr) { const k = key(a); if (k == null || k === '') continue; (m.get(k) ?? m.set(k, []).get(k)).push(a); } return m; };

const rows = db.prepare(`select pref, org, name, open_date, category, method, winner_name, corporate_no, amount, slug, fiscal_year, planned_price, floor_price, bidders
  from local_awards where amount>0 and planned_price>0 and amount <= planned_price*1.05`).all()
  .map((a) => ({ ...a, g: grp(a.slug), rate: a.amount / a.planned_price * 100, hasFloor: a.floor_price > 0 && a.floor_price <= a.planned_price }));
const NK = rows.filter((a) => a.g !== '工事');

function card(list) {
  const rates = list.map((a) => a.rate);
  const wf = list.filter((a) => a.hasFloor);
  const bd = list.filter((a) => a.bidders > 0).map((a) => a.bidders);
  const months = Array(12).fill(0); for (const a of list) { const mo = +String(a.open_date).slice(5, 7); if (mo) months[mo - 1]++; }
  const top = months.map((n, i) => [i + 1, n]).sort((x, y) => y[1] - x[1]).slice(0, 3).filter(([, n]) => n / list.length >= 0.12).map(([m]) => m + '月');
  const q = (f) => (wf.length ? r1(wf.filter(f).length / wf.length * 100) : '—');
  return `n=${list.length} 率 ${r1(pct(rates, .25))}/${r1(pct(rates, .5))}/${r1(pct(rates, .75))} 幅${r1(pct(rates, .75) - pct(rates, .25))} ／ 最低制限あり ${r1(wf.length / list.length * 100)}% 係数 ${wf.length ? r1(pct(wf.map((a) => a.floor_price / a.planned_price * 100), .5)) : '—'} 同額1pt ${q((a) => (a.amount - a.floor_price) / a.planned_price < 0.01)}% ちょうど ${q((a) => a.amount === a.floor_price)}% ／ 社数 ${bd.length ? pct(bd, .5) : '—'} 1社 ${bd.length ? r1(bd.filter((x) => x === 1).length / bd.length * 100) : '—'}% ／ 月 ${top.join('・')}`;
}

console.log('#### A. グループ別（3県合算）');
for (const [g, l] of [...by(rows, (a) => a.g)].sort((a, b) => b[1].length - a[1].length)) console.log(`  ${g.padEnd(4)} ${card(l)}`);
console.log('\n#### A2. 県×グループ');
for (const [k, l] of [...by(NK, (a) => a.pref + '|' + a.g)].sort((a, b) => (a[0] < b[0] ? -1 : 1))) if (l.length >= 30) console.log(`  ${k.padEnd(10)} ${card(l)}`);
console.log('\n#### A3. 業種別（3県合算・工事以外・n>=40）');
for (const [s, l] of [...by(NK, (a) => a.slug)].sort((a, b) => b[1].length - a[1].length)) if (l.length >= 40) console.log(`  ${(LABEL[s] || s).padEnd(10)} [${grp(s)}] ${card(l)}`);
console.log('\n#### A4. 県×業種（工事以外・n>=40）');
for (const [k, l] of [...by(NK, (a) => a.pref + '|' + a.slug)].sort((a, b) => (a[0] < b[0] ? -1 : 1))) if (l.length >= 40) { const [p, s] = k.split('|'); console.log(`  ${p} ${(LABEL[s] || s).padEnd(10)} ${card(l)}`); }

console.log('\n#### B. 社数×率（グループ×最低制限の有無）');
const bk = (n) => (n <= 1 ? '1社' : n <= 3 ? '2-3社' : n <= 6 ? '4-6社' : n <= 10 ? '7-10社' : '11社+');
for (const [k, l] of [...by(NK.filter((a) => a.bidders > 0 && a.g !== 'その他'), (a) => a.g + '|' + (a.hasFloor ? '最低制限あり' : '最低制限なし'))].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
  const g = by(l, (a) => bk(a.bidders));
  console.log(`  ${k.padEnd(14)} ` + ['1社', '2-3社', '4-6社', '7-10社', '11社+'].map((b) => `${b} ${g.get(b)?.length >= 15 ? r1(pct(g.get(b).map((a) => a.rate), .5)) : '—'}(${g.get(b)?.length ?? 0})`).join('  '));
}
console.log('\n#### C. 方式×率（工事以外・4〜10社）');
for (const [k, l] of [...by(NK.filter((a) => a.bidders >= 4 && a.bidders <= 10), (a) => a.method)].sort((a, b) => b[1].length - a[1].length).slice(0, 6)) console.log(`  ${k.padEnd(16)} n=${l.length} 率 ${r1(pct(l.map((a) => a.rate), .5))}`);

console.log('\n#### D. 国（GEPS）: グループ別の落札月');
const N = db.prepare(`select a.award_date d, e.slug from awards a join enrich_class e on e.award_rowid=a.rowid`).all();
for (const [g, l] of [...by(N, (a) => grp(a.slug))]) {
  const m = Array(12).fill(0); for (const a of l) { const mo = +String(a.d).slice(5, 7); if (mo) m[mo - 1]++; }
  console.log(`  ${g.padEnd(4)} n=${l.length} ` + m.map((x, i) => `${i + 1}月${r1(x / l.length * 100)}`).join(' '));
}
console.log('\n#### D2. 自治体（全県）: グループ別の開札月');
const LA = db.prepare(`select open_date d, slug from local_awards`).all();
for (const [g, l] of [...by(LA, (a) => grp(a.slug))]) {
  const m = Array(12).fill(0); for (const a of l) { const mo = +String(a.d).slice(5, 7); if (mo) m[mo - 1]++; }
  console.log(`  ${g.padEnd(4)} n=${l.length} ` + m.map((x, i) => `${i + 1}月${r1(x / l.length * 100)}`).join(' '));
}
console.log('\n#### E. 公告→開札・締切の日数（区分別）');
const NA = db.prepare(`select category, issue_date i, opening o, deadline d from notices_archive where issue_date>='2025-01-01'`).all();
for (const [c, l] of [...by(NA, (a) => a.category || '(空)')]) {
  const op = l.filter((a) => a.o > a.i).map((a) => Math.round((new Date(a.o) - new Date(a.i)) / 864e5)).filter((d) => d > 0 && d < 200);
  const dl = l.filter((a) => a.d > a.i).map((a) => Math.round((new Date(a.d) - new Date(a.i)) / 864e5)).filter((d) => d > 0 && d < 200);
  console.log(`  ${c.padEnd(4)} 公告→開札 n=${op.length} 真ん中${pct(op, .5)} (${pct(op, .1)}〜${pct(op, .9)}) ／ 公告→締切 n=${dl.length} 真ん中${pct(dl, .5)}`);
}

console.log('\n#### F. 記入例候補（工事以外・前年に同名1件・今年1件・社数あり）');
const norm = (s) => String(s || '').replace(/[（(].*?[）)]/g, '').replace(/(令和|平成|R|H)\s*\d+\s*年度?/g, '').replace(/\d+年度/g, '').replace(/[0-9０-９]+/g, '#').replace(/\s+/g, '');
const all = db.prepare('select pref, org, name, open_date, winner_name, amount, fiscal_year, planned_price, floor_price, bidders, category, method, slug from local_awards where amount>0').all();
const G = by(all, (a) => a.pref + '|' + a.org + '|' + norm(a.name));
const cands = [];
for (const l of G.values()) {
  const years = by(l, (a) => a.fiscal_year);
  const fy = Math.max(...years.keys());
  const cur = years.get(fy), prev = years.get(fy - 1);
  if (!cur || !prev || cur.length !== 1 || prev.length !== 1) continue;
  const c = cur[0], p = prev[0];
  if (grp(c.slug) === '工事' || grp(c.slug) === 'その他' || !(c.planned_price > 0) || !(c.bidders > 0) || c.amount > c.planned_price * 1.05) continue;
  cands.push({ c, p, floor: c.floor_price > 0 });
}
const sets = [['役務・最低制限なし', (x) => grp(x.c.slug) === '役務' && !x.floor], ['役務・最低制限あり', (x) => grp(x.c.slug) === '役務' && x.floor], ['物品', (x) => grp(x.c.slug) === '物品'], ['コンサル・最低制限なし', (x) => grp(x.c.slug) === 'コンサル' && !x.floor]];
for (const [lab, f] of sets) {
  console.log(`  -- ${lab}（候補${cands.filter(f).length}件）`);
  for (const { c, p } of cands.filter(f).sort((a, b) => b.c.bidders - a.c.bidders).slice(0, 6))
    console.log(`   ${c.pref} ${c.org} 「${c.name}」 ${LABEL[c.slug]}/${c.method}\n      前年 ${p.open_date} ${p.winner_name} ${p.amount.toLocaleString()} → 今年 ${c.open_date} ${c.winner_name} ${c.amount.toLocaleString()} 予定${c.planned_price.toLocaleString()} 最低制限${c.floor_price ? c.floor_price.toLocaleString() : 'なし'} 率${r1(c.amount / c.planned_price * 100)}% 応札${c.bidders}社 ${norm(c.winner_name) === norm(p.winner_name) ? '継続' : '交代'} 前年比${r1((c.amount / p.amount - 1) * 100)}%`);
}
