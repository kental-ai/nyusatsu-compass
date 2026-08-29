// GEPS過去年度の凍結スナップショット。
// 過去年度の全件zipは内容が変わらないのに、Netlifyビルドは毎回14年分をダウンロードしていて
// ビルド時間上限(15分)超過の主因になった。確定した過去年度をgit管理のスナップショットにし、
// Netlifyは「import + 直近年度のみ取得(fetch_geps recent)」で済ませる。
//   export [cutoffYear]: awards(fiscal_year<=cutoff, GEPS由来) → data/snapshots/geps_history.csv.gz
//   import:              スナップショット → awards（INSERT OR IGNORE）
// 年度が進んだら年1回 export し直す（daily-local Actionからも実行可能）。
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import { openDb } from './db.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SNAP = join(ROOT, 'data', 'snapshots', 'geps_history.csv.gz');
const mode = process.argv[2];
const db = openDb();

const COLS = ['case_no', 'name', 'award_date', 'amount', 'ministry_code', 'method_code',
  'winner_name', 'corporate_no', 'fiscal_year', 'source', 'first_seen'];
const escCsv = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s; };

if (mode === 'export') {
  const cutoff = Number(process.argv[3]) || (new Date().getFullYear() - 2);
  const rows = db.prepare(`SELECT ${COLS.join(',')} FROM awards
    WHERE source LIKE 'geps%' AND fiscal_year <= ? ORDER BY award_date, case_no`).all(cutoff);
  const csv = [COLS.join(','), ...rows.map((r) => COLS.map((c) => escCsv(r[c])).join(','))].join('\n');
  mkdirSync(dirname(SNAP), { recursive: true });
  const gz = gzipSync(Buffer.from(csv, 'utf8'), { level: 9 });
  writeFileSync(SNAP, gz);
  console.log(`export: 〜${cutoff}年度 ${rows.length}行 → ${SNAP}（${Math.round(gz.length / 1024 / 1024 * 10) / 10}MB）`);
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
  const ins = db.prepare(`INSERT OR IGNORE INTO awards (${COLS.join(',')}) VALUES (${COLS.map(() => '?').join(',')})`);
  db.exec('BEGIN');
  let n = 0;
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const v = parseLine(lines[i]);
    if (v.length !== COLS.length) continue;
    v[3] = Number(v[3]) || 0; v[8] = Number(v[8]) || null;
    ins.run(...v);
    n++;
  }
  db.exec('COMMIT');
  console.log(`import: ${n}行を取込`);
} else {
  console.error('使い方: node pipeline/snapshot_geps.mjs export [cutoffYear] | import');
  process.exit(1);
}
