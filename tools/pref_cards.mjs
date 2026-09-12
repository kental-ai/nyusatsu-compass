// 実務編の付録「県の数字カード」を計測する（予定価格・最低制限価格・応札社数が公表されている県だけ）。
// 使い方: node --no-warnings tools/pref_cards.mjs [--validate] [--examples]
//   --validate : 方式・金額帯が率に効くかを、応札社数をそろえて確かめる（原稿の規則の裏取り）
//   --examples : 記入例に使える継続契約（前年もある・率・最低制限・応札が揃う）を探す
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const db = new DatabaseSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'compass.db'), { readOnly: true });
const args = new Set(process.argv.slice(2));
const pct = (arr, p) => { const a = [...arr].sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p))] : null; };
const r1 = (x) => Math.round(x * 10) / 10;
const LABEL = Object.fromEntries(db.prepare('select 1').all().length ? [] : []);
const rows = db.prepare(`select pref, org, name, open_date, category, method, winner_name, amount, slug, fiscal_year, planned_price, floor_price, bidders
  from local_awards where amount>0 and planned_price>0 and amount <= planned_price*1.05`).all()
  .map((a) => ({ ...a, rate: a.amount / a.planned_price * 100 }));
const by = (arr, key) => { const m = new Map(); for (const a of arr) { const k = key(a); if (k == null || k === '') continue; (m.get(k) ?? m.set(k, []).get(k)).push(a); } return m; };
const MIN = 30;

function card(list) {
  const rates = list.map((a) => a.rate);
  const wf = list.filter((a) => a.floor_price > 0 && a.floor_price <= a.planned_price);
  const bd = list.filter((a) => a.bidders > 0).map((a) => a.bidders);
  const months = Array(12).fill(0); for (const a of list) { const mo = +String(a.open_date).slice(5, 7); if (mo) months[mo - 1]++; }
  const top = months.map((n, i) => [i + 1, n]).sort((x, y) => y[1] - x[1]).slice(0, 3).filter(([, n]) => n / list.length >= 0.12).map(([m]) => m + '月');
  return {
    n: list.length,
    rateL: r1(pct(rates, .25)), rateM: r1(pct(rates, .5)), rateH: r1(pct(rates, .75)),
    floorN: wf.length,
    floorCoef: wf.length ? r1(pct(wf.map((a) => a.floor_price / a.planned_price * 100), .5)) : null,
    atFloor: wf.length ? r1(wf.filter((a) => (a.amount - a.floor_price) / a.planned_price < 0.01).length / wf.length * 100) : null,
    bidM: bd.length ? pct(bd, .5) : null, bidN: bd.length,
    months: top.join('・'),
  };
}
const type = (c) => c.atFloor == null ? '—' : c.atFloor >= 50 ? '寄せる' : c.atFloor < 30 ? 'ばらつき' : '案件ごと';

console.log('#### 県の数字カード（分類はシステムの「category」列。n>=30）');
for (const [pref, list] of [...by(rows, (a) => a.pref)].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`\n== ${pref}（${list.length}件・${[...new Set(list.map((a) => a.fiscal_year))].sort().join('/')}年度）`);
  const all = card(list);
  console.log(`  全体: 率 安め${all.rateL} 真ん中${all.rateM} 高め${all.rateH} ／ 最低制限係数 ${all.floorCoef}%（n=${all.floorN}） 同額率 ${all.atFloor}% → ${type(all)} ／ 社数 真ん中${all.bidM} ／ 集中月 ${all.months}`);
  for (const [cat, l] of [...by(list, (a) => a.category)].sort((a, b) => b[1].length - a[1].length)) {
    if (l.length < MIN) continue;
    const c = card(l);
    console.log(`  ${cat.padEnd(10)} n=${String(c.n).padStart(5)} 率 ${c.rateL}/${c.rateM}/${c.rateH} ／ 最低制限 ${c.floorCoef ?? '—'}%（n=${c.floorN}） 同額 ${c.atFloor ?? '—'}% ${type(c)} ／ 社数 ${c.bidM ?? '—'} ／ 月 ${c.months}`);
  }
  console.log('  -- 業種（taxonomy slug）別 --');
  for (const [slug, l] of [...by(list, (a) => a.slug)].sort((a, b) => b[1].length - a[1].length)) {
    if (l.length < MIN) continue;
    const c = card(l);
    console.log(`  ${slug.padEnd(10)} n=${String(c.n).padStart(5)} 率 ${c.rateL}/${c.rateM}/${c.rateH} ／ 最低制限 ${c.floorCoef ?? '—'}%（n=${c.floorN}） 同額 ${c.atFloor ?? '—'}% ${type(c)} ／ 社数 ${c.bidM ?? '—'} ／ 月 ${c.months}`);
  }
}

if (args.has('--validate')) {
  console.log('\n#### 検証1: 応札社数をそろえたとき、方式で率は違うか（4〜10社の案件だけ）');
  const mid = rows.filter((a) => a.bidders >= 4 && a.bidders <= 10);
  for (const [m, l] of [...by(mid, (a) => a.method)].sort((a, b) => b[1].length - a[1].length).slice(0, 6)) console.log(`  ${m.padEnd(16)} n=${l.length} 率の真ん中 ${r1(pct(l.map((a) => a.rate), .5))}`);
  console.log('\n#### 検証2: 応札社数をそろえたとき、金額帯で率は違うか（4〜10社）');
  const band = (n) => n < 5e6 ? '〜500万' : n < 3e7 ? '500万〜3000万' : '3000万〜';
  for (const [b, l] of [...by(mid, (a) => band(a.planned_price))]) console.log(`  ${b.padEnd(12)} n=${l.length} 率の真ん中 ${r1(pct(l.map((a) => a.rate), .5))}`);
  console.log('\n#### 検証3: 県×分類をそろえたとき、社数で率はどれだけ動くか');
  for (const [k, l] of [...by(rows, (a) => a.pref + '|' + a.category)].sort((a, b) => b[1].length - a[1].length).slice(0, 8)) {
    const g = by(l.filter((a) => a.bidders > 0), (a) => a.bidders <= 3 ? '1-3社' : a.bidders <= 10 ? '4-10社' : '11社+');
    console.log(`  ${k.padEnd(18)} ` + ['1-3社', '4-10社', '11社+'].map((b) => `${b} ${g.get(b)?.length >= 15 ? r1(pct(g.get(b).map((a) => a.rate), .5)) : '—'}(n=${g.get(b)?.length ?? 0})`).join('  '));
  }
  console.log('\n#### 検証4: 同額率（1pt以内）を県×分類で');
  for (const [k, l] of [...by(rows.filter((a) => a.floor_price > 0), (a) => a.pref + '|' + a.category)].sort((a, b) => b[1].length - a[1].length).slice(0, 10)) {
    console.log(`  ${k.padEnd(18)} n=${l.length} 同額 ${r1(l.filter((a) => (a.amount - a.floor_price) / a.planned_price < 0.01).length / l.length * 100)}%  ちょうど ${r1(l.filter((a) => a.amount === a.floor_price).length / l.length * 100)}%`);
  }
}

if (args.has('--examples')) {
  console.log('\n#### 記入例候補: 率・最低制限・応札が揃い、前年にも同名の落札がある契約（コンサル・委託・物品）');
  const norm = (s) => String(s || '').replace(/[（(].*?[）)]/g, '').replace(/(令和|平成|R|H)\s*\d+\s*年度?/g, '').replace(/\d+年度/g, '').replace(/[0-9０-９]+/g, '#').replace(/\s+/g, '');
  const allLocal = db.prepare('select pref, org, name, open_date, winner_name, amount, fiscal_year, planned_price, floor_price, bidders, category, method from local_awards where amount>0').all();
  const g = by(allLocal, (a) => a.pref + '|' + a.org + '|' + norm(a.name));
  const out = [];
  for (const [k, l] of g) {
    const cur = l.filter((a) => a.planned_price > 0 && a.floor_price > 0 && a.bidders > 0 && !/工事/.test(a.category || ''));
    if (!cur.length) continue;
    const c = cur.sort((a, b) => (a.open_date < b.open_date ? 1 : -1))[0];
    const prev = l.filter((a) => a.fiscal_year === c.fiscal_year - 1);
    if (prev.length !== 1 || l.filter((a) => a.fiscal_year === c.fiscal_year).length !== 1) continue;
    out.push({ k, c, p: prev[0] });
  }
  out.sort((a, b) => b.c.bidders - a.c.bidders);
  for (const { c, p } of out.slice(0, 12)) console.log(`  ${c.pref} ${c.org} 「${c.name}」 ${c.category}/${c.method}\n     前年: ${p.open_date} ${p.winner_name} ${p.amount.toLocaleString()}円 → 今年: ${c.open_date} ${c.winner_name} ${c.amount.toLocaleString()}円 予定${c.planned_price.toLocaleString()} 最低制限${c.floor_price.toLocaleString()} 率${r1(c.amount / c.planned_price * 100)}% 最低制限係数${r1(c.floor_price / c.planned_price * 100)}% 応札${c.bidders}社 ${c.winner_name === p.winner_name ? '現職継続' : '交代'}`);
}
