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
      award_date    TEXT NOT NULL,                  -- 落札決定日 (YYYY-MM-DD)
      amount        INTEGER,                        -- 落札価格（円・小数切捨て）
      ministry_code TEXT,                           -- 府省コード（2桁: A1〜JB。仕様書3.1）
      method_code   TEXT,                           -- 入札方式コード（7桁: 8002010等。仕様書3.2）
      winner_name   TEXT,                           -- 商号又は名称
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

    CREATE TABLE IF NOT EXISTS notices (            -- 公告（KKJ検索API。落札=過去に対する未来側）
      key           TEXT PRIMARY KEY,               -- KKJのKey（一意）
      name          TEXT NOT NULL,                  -- 件名
      org           TEXT,                           -- 機関名
      pref          TEXT,                           -- 都道府県名
      lg_code       TEXT,                           -- 都道府県コード
      city          TEXT,                           -- 市区町村名
      issue_date    TEXT,                           -- 公告日 (YYYY-MM-DD)
      deadline      TEXT,                           -- 入札開始日
      opening       TEXT,                           -- 開札日
      category      TEXT,                           -- 物品/工事/役務
      procedure     TEXT,                           -- 公示種別
      cert          TEXT,                           -- 参加資格 (A B等)
      url           TEXT,                           -- 公告原文URL
      description   TEXT,                           -- 公告文（先頭4,000字）
      slug          TEXT,                           -- 業務分類（taxonomy）
      fetched_at    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notices_issue ON notices (issue_date);
    CREATE INDEX IF NOT EXISTS idx_notices_slug ON notices (slug);

    CREATE TABLE IF NOT EXISTS local_awards (       -- 自治体の入札結果（P2。スナップショット供給）
      src         TEXT NOT NULL,
      org         TEXT NOT NULL,
      dept        TEXT,
      pref        TEXT NOT NULL,
      name        TEXT NOT NULL,
      open_date   TEXT,
      category    TEXT,
      method      TEXT,
      winner_name TEXT,
      corporate_no TEXT,
      amount      INTEGER,
      slug        TEXT,
      fiscal_year INTEGER,
      first_seen  TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_local ON local_awards (src, org, name, open_date, corporate_no, amount);
    CREATE INDEX IF NOT EXISTS idx_local_corp ON local_awards (corporate_no);

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
