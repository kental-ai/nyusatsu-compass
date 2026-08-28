// KKJ公告の永続アーカイブ管理。KKJポータル自体は約35日で公告が消えるため、
// 「取り続けて蓄積する」ことで市区町村ごとの公告履歴という固有コンテンツを作る。
//   absorb: notices（現在の取得窓）→ notices_archive へ INSERT OR IGNORE（keyで重複排除）
//   export: notices_archive → data/snapshots/notices_archive.csv.gz（git管理・日次Actionがコミット）
//   import: スナップショット → notices_archive（Netlifyビルドの先頭で実行）
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import { openDb } from './db.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SNAP = join(ROOT, 'data', 'snapshots', 'notices_archive.csv.gz');
const mode = process.argv[2];
const db = openDb();

const COLS = ['key', 'name', 'org', 'pref', 'lg_code', 'city', 'issue_date', 'deadline', 'opening',
  'category', 'procedure', 'cert', 'url', 'slug', 'first_seen'];
const escCsv = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s; };

if (mode === 'absorb') {
  const now = new Date().toISOString();
  const r = db.exec(`INSERT OR IGNORE INTO notices_archive (${COLS.join(',')})
    SELECT key, name, org, pref, lg_code, city, issue_date, deadline, opening,
           category, procedure, cert, url, slug, '${now}' FROM notices WHERE key != '' AND name != ''`);
  const c = db.prepare('SELECT COUNT(*) c FROM notices_archive').get();
  console.log(`absorb: notices → archive（累計${c.c}件）`);
} else if (mode === 'export') {
  const rows = db.prepare(`SELECT ${COLS.join(',')} FROM notices_archive ORDER BY issue_date, key`).all();
  const csv = [COLS.join(','), ...rows.map((r) => COLS.map((c) => escCsv(r[c])).join(','))].join('\n');
  mkdirSync(dirname(SNAP), { recursive: true });
  const gz = gzipSync(Buffer.from(csv, 'utf8'), { level: 9 });
  writeFileSync(SNAP, gz);
  console.log(`export: ${rows.length}行 → ${SNAP}（${Math.round(gz.length / 1024)}KB）`);
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
  const ins = db.prepare(`INSERT OR IGNORE INTO notices_archive (${COLS.join(',')}) VALUES (${COLS.map(() => '?').join(',')})`);
  db.exec('BEGIN');
  let n = 0;
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const v = parseLine(lines[i]);
    if (v.length !== COLS.length) continue;
    ins.run(...v);
    n++;
  }
  db.exec('COMMIT');
  console.log(`import: ${n}行を取込`);
} else {
  console.error('使い方: node pipeline/archive_notices.mjs absorb|export|import');
  process.exit(1);
}
