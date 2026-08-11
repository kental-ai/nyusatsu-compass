// GEPS（調達ポータル）落札実績オープンデータの取り込み。
// 使い方:
//   node pipeline/fetch_geps.mjs all            # 全年度(2013〜最新)の全件ファイルを取得
//   node pipeline/fetch_geps.mjs diff 2026-08-10 # 指定日の日次差分を取得（省略時は昨日）
// 出典: https://www.p-portal.go.jp/pps-web-biz/UAB02/OAB0201 （政府標準利用規約準拠・出典明記）
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, DATA_DIR } from './db.mjs';
import { unzipSingle } from './zip.mjs';
import { seedOrgans } from './codes.mjs';

const BASE = 'https://api.p-portal.go.jp/pps-web-biz/UAB03/OAB0301?fileversion=v001&filename=';
const RAW_DIR = join(DATA_DIR, 'raw', 'geps');
const FIRST_YEAR = 2013;

function parseCsv(text) {
  // GEPSのCSVは全フィールドがダブルクォート囲み・8列固定。埋め込み改行は想定しない
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = line.match(/"((?:[^"]|"")*)"/g);
    if (!m || m.length < 8) continue;
    rows.push(m.slice(0, 8).map((f) => f.slice(1, -1).replace(/""/g, '"')));
  }
  return rows;
}

async function download(filename) {
  const res = await fetch(BASE + filename);
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 100 || buf.readUInt32LE(0) !== 0x04034b50) return null; // HTMLエラーページ等
  return buf;
}

function importRows(db, rows, fiscalYear, source) {
  const now = new Date().toISOString();
  // 列順は仕様書2.2: 案件番号/案件名称/落札決定日/落札価格/府省コード/入札方式コード/商号/法人番号
  const ins = db.prepare(`INSERT OR IGNORE INTO awards
    (case_no, name, award_date, amount, ministry_code, method_code, winner_name, corporate_no, fiscal_year, source, first_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let n = 0;
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      const [caseNo, name, date, amount, ministry, method, winner, corpNo] = r;
      if (!caseNo || !date) continue;
      const res = ins.run(caseNo, name, date, Math.floor(Number(amount) || 0), ministry,
        method, winner, /^\d{13}$/.test(corpNo) ? corpNo : '', fiscalYear, source, now);
      n += res.changes;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return n;
}

function rebuildCompanies(db) {
  // 法人番号ごとに最頻の表記を代表名に。表記ゆれは配列で保持
  db.exec(`DELETE FROM companies`);
  db.exec(`
    INSERT INTO companies (corporate_no, name, name_variants, first_seen)
    SELECT corporate_no,
           (SELECT winner_name FROM awards a2 WHERE a2.corporate_no = a1.corporate_no
             GROUP BY winner_name ORDER BY COUNT(*) DESC LIMIT 1),
           json_group_array(DISTINCT winner_name),
           MIN(first_seen)
    FROM awards a1 WHERE corporate_no != '' GROUP BY corporate_no
  `);
}

const db = openDb();
mkdirSync(RAW_DIR, { recursive: true });
const mode = process.argv[2] || 'all';

if (mode === 'all') {
  const thisYear = new Date().getFullYear();
  for (let y = FIRST_YEAR; y <= thisYear; y++) {
    const filename = `successful_bid_record_info_all_${y}.zip`;
    const cache = join(RAW_DIR, filename);
    let buf;
    if (existsSync(cache)) {
      buf = readFileSync(cache);
    } else {
      buf = await download(filename);
      if (!buf) { console.log(`${y}: ファイルなし（年度未開始?）`); continue; }
      writeFileSync(cache, buf);
      await new Promise((r) => setTimeout(r, 500));
    }
    const rows = parseCsv(unzipSingle(buf).toString('utf-8').replace(/^﻿/, ''));
    const added = importRows(db, rows, y, 'geps_all');
    db.prepare(`INSERT OR REPLACE INTO fetch_log (source, key, fetched_at, rows) VALUES (?,?,?,?)`)
      .run('geps_all', String(y), new Date().toISOString(), rows.length);
    console.log(`${y}年度: ${rows.length}行 → 新規${added}件`);
  }
} else if (mode === 'diff') {
  const d = process.argv[3] || new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const ymd = d.replaceAll('-', '');
  const buf = await download(`successful_bid_record_info_diff_${ymd}.zip`);
  if (!buf) { console.log(`差分なし: ${d}`); process.exit(0); }
  const rows = parseCsv(unzipSingle(buf).toString('utf-8').replace(/^﻿/, ''));
  const added = importRows(db, rows, Number(d.slice(0, 4)), 'geps_diff');
  db.prepare(`INSERT OR REPLACE INTO fetch_log (source, key, fetched_at, rows) VALUES (?,?,?,?)`)
    .run('geps_diff', d, new Date().toISOString(), rows.length);
  console.log(`差分 ${d}: ${rows.length}行 → 新規${added}件`);
} else {
  console.error('usage: node pipeline/fetch_geps.mjs [all|diff [YYYY-MM-DD]]');
  process.exit(1);
}

rebuildCompanies(db);
seedOrgans(db);
const stats = db.prepare(`SELECT COUNT(*) c FROM awards`).get();
const comps = db.prepare(`SELECT COUNT(*) c FROM companies`).get();
console.log(`awards合計: ${stats.c}件 / companies: ${comps.c}社`);
