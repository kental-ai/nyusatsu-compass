// 自治体データのスナップショット管理。
// Netlifyはビルド間でデータを持ち越さないため、local_awardsはgit管理のスナップショットで供給する。
//   export: local_awards → data/snapshots/local_awards.csv.gz（git管理・日次Actionがコミット）
//   import: スナップショット → local_awards（Netlifyビルドの先頭で実行）
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import { openDb } from './db.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SNAP = join(ROOT, 'data', 'snapshots', 'local_awards.csv.gz');
const mode = process.argv[2];
const db = openDb();

const COLS = ['src', 'org', 'dept', 'pref', 'name', 'open_date', 'category', 'method',
  'winner_name', 'corporate_no', 'amount', 'slug', 'fiscal_year', 'first_seen',
  'planned_price', 'floor_price', 'bidders'];
const NUM_COLS = new Set(['amount', 'fiscal_year', 'planned_price', 'floor_price', 'bidders']);
const escCsv = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s; };

if (mode === 'export') {
  const rows = db.prepare(`SELECT ${COLS.join(',')} FROM local_awards ORDER BY open_date, org, name`).all();
  const csv = [COLS.join(','), ...rows.map((r) => COLS.map((c) => escCsv(r[c])).join(','))].join('\n');
  mkdirSync(dirname(SNAP), { recursive: true });
  writeFileSync(SNAP, gzipSync(Buffer.from(csv, 'utf8'), { level: 9 }));
  console.log(`export: ${rows.length}行 → ${SNAP}（${Math.round(gzipSync(Buffer.from(csv)).length / 1024)}KB）`);
} else if (mode === 'import') {
  if (!existsSync(SNAP)) { console.log('import: スナップショットなし（スキップ）'); process.exit(0); }
  const csv = gunzipSync(readFileSync(SNAP)).toString('utf8');
  const lines = csv.split('\n');
  const parseLine = (line) => {
    const out = []; let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
      else if (ch === '"') q = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  };
  const ins = db.prepare(`INSERT OR IGNORE INTO local_awards (${COLS.join(',')}) VALUES (${COLS.map(() => '?').join(',')})`);
  db.exec('BEGIN');
  let n = 0;
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const v = parseLine(line);
    while (v.length < COLS.length) v.push(''); // 旧形式（3列追加前）のスナップショットも受ける
    ins.run(...COLS.map((c, i) => (NUM_COLS.has(c) ? (v[i] === '' || v[i] == null ? (c === 'amount' || c === 'fiscal_year' ? 0 : null) : Number(v[i]) || 0) : v[i])));
    n++;
  }
  db.exec('COMMIT');
  console.log(`import: ${n}行を取込`);
} else {
  console.error('usage: node pipeline/snapshot_local.mjs export|import');
  process.exit(1);
}
