import { openDb } from './pipeline/db.mjs';
const db = openDb();
const s='iwate';
console.log(db.prepare(`SELECT COUNT(*) n, SUM(open_date IS NULL OR open_date='') nod, SUM(winner_name='') now_, SUM(amount=0) amt0, SUM(dept='') nodept, MIN(open_date) mn, MAX(open_date) mx, COUNT(DISTINCT dept) depts FROM local_awards WHERE src=?`).get(s));
console.log(db.prepare(`SELECT fiscal_year fy, COUNT(*) n FROM local_awards WHERE src=? GROUP BY 1 ORDER BY 1`).all(s));
console.log(db.prepare(`SELECT category, COUNT(*) n FROM local_awards WHERE src=? GROUP BY 1`).all(s));
console.log('--- 無作為24行 ---');
for(const r of db.prepare(`SELECT open_date,name,winner_name,amount,method,dept,category FROM local_awards WHERE src=? ORDER BY random() LIMIT 24`).all(s))
  console.log(`${r.open_date} | ${r.category} | ${r.method} | ${r.name.slice(0,42)} | ${r.winner_name} | ${r.amount.toLocaleString()} | ${r.dept}`);
console.log('--- 金額分布 ---');
console.log(db.prepare(`SELECT MIN(amount) mn, MAX(amount) mx, AVG(amount) av FROM local_awards WHERE src=?`).get(s));
