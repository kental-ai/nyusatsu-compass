// SQLite（node:sqlite・外部依存ゼロ）。ホジョナビの db.mjs と同流儀。
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = join(ROOT, 'data');

export function openDb() {
  mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(join(DATA_DIR, 'compass.db'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS awards (             -- 落札実績（GEPS。P2で自治体も同居）
      case_no       TEXT NOT NULL,                  -- 調達案件番号
      name          TEXT NOT NULL,                  -- 案件名
      award_date    TEXT NOT NULL,                  -- 落札日 (YYYY-MM-DD)
      amount        INTEGER,                        -- 落札金額（円・小数切捨て）
      category      TEXT,                           -- 区分コード (S1等)
      ministry_code TEXT,                           -- 府省コード
      winner_name   TEXT,                           -- 落札者名称
      corporate_no  TEXT,                           -- 法人番号（13桁。無い行は空文字）
      fiscal_year   INTEGER,                        -- 取得元ファイルの年度
      source        TEXT NOT NULL,                  -- geps_all / geps_diff / 自治体slug
      first_seen    TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_awards
      ON awards (case_no, corporate_no, award_date, amount);
    CREATE INDEX IF NOT EXISTS idx_awards_corp ON awards (corporate_no);
    CREATE INDEX IF NOT EXISTS idx_awards_ministry ON awards (ministry_code);
    CREATE INDEX IF NOT EXISTS idx_awards_date ON awards (award_date);

    CREATE TABLE IF NOT EXISTS companies (          -- 法人番号→企業（集計はビルド時に再計算）
      corporate_no  TEXT PRIMARY KEY,
      name          TEXT NOT NULL,                  -- 代表表記（最頻の落札者名称）
      name_variants TEXT,                           -- 表記ゆれ(JSON配列)
      first_seen    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS organs (             -- 機関マスタ（府省コード→表示名。P2で自治体追加）
      code          TEXT PRIMARY KEY,
      name          TEXT,
      kind          TEXT                            -- ministry / agency / pref / city
    );

    CREATE TABLE IF NOT EXISTS fetch_log (          -- 取得履歴（差分運用と失敗検知）
      source        TEXT NOT NULL,
      key           TEXT NOT NULL,                  -- ファイル名や日付
      fetched_at    TEXT NOT NULL,
      rows          INTEGER,
      PRIMARY KEY (source, key)
    );
  `);
  return db;
}
