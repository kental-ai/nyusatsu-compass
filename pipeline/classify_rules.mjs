// awardsの全件をtaxonomyルールで分類し enrich_class に保存。
// taxonomy変更時はそのまま再実行（全置き換え・数秒で完了）。
import { openDb } from './db.mjs';
import { classify, TAXONOMY } from './taxonomy.mjs';

const db = openDb();
db.exec(`
  CREATE TABLE IF NOT EXISTS enrich_class (
    award_rowid INTEGER PRIMARY KEY,
    slug        TEXT NOT NULL,
    method      TEXT NOT NULL      -- rule / ai
  );
  CREATE INDEX IF NOT EXISTS idx_class_slug ON enrich_class (slug);
`);

const rows = db.prepare(`SELECT rowid, name FROM awards`).all();
db.exec('BEGIN');
db.exec('DELETE FROM enrich_class');
const ins = db.prepare(`INSERT INTO enrich_class (award_rowid, slug, method) VALUES (?, ?, 'rule')`);
for (const r of rows) ins.run(r.rowid, classify(r.name));
db.exec('COMMIT');

// 自治体データ(local_awards)も同じルールで再分類（取得時slugを最新taxonomyで上書き）
try {
  const locs = db.prepare(`SELECT rowid, name FROM local_awards`).all();
  const upd = db.prepare(`UPDATE local_awards SET slug = ? WHERE rowid = ?`);
  db.exec('BEGIN');
  for (const r of locs) upd.run(classify(r.name), r.rowid);
  db.exec('COMMIT');
  const lo = db.prepare(`SELECT COUNT(*) n FROM local_awards WHERE slug != 'other'`).get();
  console.log(`local_awards再分類: ${lo.n}/${locs.length} (${(lo.n / locs.length * 100).toFixed(1)}%)`);
} catch { /* local_awards未取得環境ではスキップ */ }

const total = rows.length;
const stats = db.prepare(`SELECT slug, COUNT(*) n FROM enrich_class GROUP BY slug ORDER BY n DESC`).all();
const labels = Object.fromEntries(TAXONOMY.map((t) => [t.slug, t.label]));
let classified = 0;
for (const s of stats) {
  if (s.slug !== 'other') classified += s.n;
  console.log(`${(labels[s.slug] || s.slug).padEnd(12, '　')} ${s.n}`);
}
console.log(`---\n分類済み: ${classified}/${total} (${(classified / total * 100).toFixed(1)}%) / other: ${total - classified}`);
