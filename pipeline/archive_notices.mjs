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
const SNAP_DIR = join(ROOT, 'data', 'snapshots');
const SNAP = join(SNAP_DIR, 'notices_archive.csv.gz');            // 現行年＋日付不明分（毎日更新）
const yearSnap = (y) => join(SNAP_DIR, `notices_archive_${y}.csv.gz`); // 過去年（凍結・再書き込みしない）
const CUR_YEAR = new Date().getFullYear();
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
  // 年別に分割して書き出す。過去年のファイルは一度作ったら凍結（毎日のgit差分を現行年だけに抑える）
  mkdirSync(SNAP_DIR, { recursive: true });
  const years = db.prepare(`SELECT DISTINCT substr(issue_date, 1, 4) y FROM notices_archive
    WHERE issue_date >= '2000' ORDER BY y`).all().map((r) => r.y).filter((y) => Number(y) < CUR_YEAR);
  const dump = (rows, file) => {
    const csv = [COLS.join(','), ...rows.map((r) => COLS.map((c) => escCsv(r[c])).join(','))].join('\n');
    const gz = gzipSync(Buffer.from(csv, 'utf8'), { level: 9 });
    writeFileSync(file, gz);
    return Math.round(gz.length / 1024);
  };
  for (const y of years) {
    if (existsSync(yearSnap(y))) continue; // 凍結済み
    const rows = db.prepare(`SELECT ${COLS.join(',')} FROM notices_archive
      WHERE substr(issue_date, 1, 4) = ? ORDER BY issue_date, key`).all(y);
    console.log(`export: ${y}年 ${rows.length}行 → notices_archive_${y}.csv.gz（${dump(rows, yearSnap(y))}KB・凍結）`);
  }
  const cur = db.prepare(`SELECT ${COLS.join(',')} FROM notices_archive
    WHERE issue_date >= ? OR issue_date IS NULL OR issue_date < '2000' ORDER BY issue_date, key`).all(String(CUR_YEAR));
  console.log(`export: 現行 ${cur.length}行 → notices_archive.csv.gz（${dump(cur, SNAP)}KB）`);
} else if (mode === 'import') {
  const files = [];
  try {
    const { readdirSync } = await import('node:fs');
    for (const f of readdirSync(SNAP_DIR)) if (/^notices_archive(_\d{4})?\.csv\.gz$/.test(f)) files.push(join(SNAP_DIR, f));
  } catch { /* ディレクトリなし */ }
  if (!files.length) { console.log('import: スナップショットなし（スキップ）'); process.exit(0); }
  let csv = '';
  for (const f of files) {
    const body = gunzipSync(readFileSync(f)).toString('utf8');
    csv += csv ? '\n' + body.slice(body.indexOf('\n') + 1) : body; // 2つ目以降はヘッダ行を除いて連結
  }
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
