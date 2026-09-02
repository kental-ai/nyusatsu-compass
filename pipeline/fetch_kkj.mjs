// KKJ（官公需情報ポータル）検索APIから公告を取り込む。
// 使い方: node pipeline/fetch_kkj.mjs [日数]   （既定35日。開いている案件の在庫を丸ごと持つ設計:
//         Netlifyビルドはデータを持ち越さないため、毎ビルドでローリング窓を再取得する）
// 網羅の作り: LG_Code付き（自治体+地方支分部局）は都道府県別×適応分割、
//             LGコード無しの国の機関は機関名トークン検索で補完し、Keyで重複排除。
// 利用規約対応: 直列実行・300ms間隔・サイトにAPI利用明記済み（docs/kkj-api-terms.md）
import https from 'node:https';
import { openDb } from './db.mjs';
import { classify } from './taxonomy.mjs';

const DELAY = 300;
// 引数: [日数] または range <from> <to>（アーカイブのバックフィル用。rangeでは窓外削除をしない）
const RANGE = process.argv[2] === 'range' ? [process.argv[3], process.argv[4]] : null;
const DAYS = Number(process.argv[2]) || 35;
const ORG_TOKENS = ['省', '庁', '機構', '大学', '法人', '研究所', 'センター', '裁判所', '議院'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let requestCount = 0;

// KKJはTLS中間証明書が不完全なため、このホストに限り検証を緩和して取得する
function kkjGet(params) {
  requestCount++;
  return new Promise((resolve, reject) => {
    https.get({ host: 'www.kkj.go.jp', path: '/api/?' + params, rejectUnauthorized: false, timeout: 30000 },
      (res) => { let d = ''; res.setEncoding('utf8'); res.on('data', (c) => (d += c)); res.on('end', () => resolve(d)); })
      .on('error', reject).on('timeout', function () { this.destroy(new Error('timeout')); });
  });
}

const tag = (block, name) => {
  const m = block.match(new RegExp(`<${name}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${name}>`));
  return m ? m[1].trim() : '';
};
function parse(xml) {
  const err = xml.match(/<Error>([^<]*)<\/Error>/);
  if (err) throw new Error(`KKJ API: ${err[1]}`);
  const hits = Number((xml.match(/<SearchHits>(\d+)<\/SearchHits>/) || [])[1] ?? 0);
  const rows = [...xml.matchAll(/<SearchResult>([\s\S]*?)<\/SearchResult>/g)].map((m) => {
    const b = m[1];
    return {
      key: tag(b, 'Key'), name: tag(b, 'ProjectName'), org: tag(b, 'OrganizationName'),
      pref: tag(b, 'PrefectureName'), lg: tag(b, 'LgCode'), city: tag(b, 'CityName'),
      issue: (tag(b, 'CftIssueDate') || '').slice(0, 10), deadline: (tag(b, 'TenderSubmissionDeadline') || '').slice(0, 10),
      opening: (tag(b, 'OpeningTendersEvent') || '').slice(0, 10), category: tag(b, 'Category'),
      procedure: tag(b, 'ProcedureType'), cert: tag(b, 'Certification'),
      url: tag(b, 'ExternalDocumentURI'), desc: RANGE ? '' : tag(b, 'ProjectDescription').slice(0, 4000), // rangeモードはアーカイブ用途で本文不要（メモリ対策）
    };
  });
  return { hits, rows };
}

const midDate = (f, t) => new Date((new Date(f + 'T00:00:00Z').getTime() + new Date(t + 'T00:00:00Z').getTime()) / 2).toISOString().slice(0, 10);
const nextDay = (d) => new Date(new Date(d + 'T00:00:00Z').getTime() + 86400000).toISOString().slice(0, 10);

// hits>1000なら日付分割で再帰取得（APIにオフセットが無いため）
async function collect(baseParams, from, to, out, depth = 0) {
  const xml = await kkjGet(`${baseParams}&CFT_Issue_Date=${from}/${to}&Count=1000`);
  await sleep(DELAY);
  const { hits, rows } = parse(xml);
  if (hits <= 1000 || from === to || depth >= 8) {
    for (const r of rows) out.set(r.key, r);
    if (hits > 1000) console.error(`  警告: ${baseParams} ${from}/${to} が${hits}件（1000件で打ち切り）`);
    return;
  }
  const mid = midDate(from, to);
  await collect(baseParams, from, mid, out, depth + 1);
  await collect(baseParams, nextDay(mid) > to ? to : nextDay(mid), to, out, depth + 1);
}

const db = openDb();
const to = RANGE ? RANGE[1] : new Date().toISOString().slice(0, 10);
const from = RANGE ? RANGE[0] : new Date(Date.now() - DAYS * 86400000).toISOString().slice(0, 10);
if (RANGE && !(/^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to))) { console.error('range: YYYY-MM-DD YYYY-MM-DD'); process.exit(1); }
const found = new Map();

// 1) 都道府県コード付き（自治体+所在地コードを持つ国の機関）
for (let i = 1; i <= 47; i++) {
  await collect(`LG_Code=${String(i).padStart(2, '0')}`, from, to, found);
}
// 2) LGコード無しの国の機関を機関名トークンで補完（Keyで自然に重複排除）
for (const t of ORG_TOKENS) {
  await collect(`Organization_Name=${encodeURIComponent(t)}`, from, to, found);
}

const now = new Date().toISOString();
const ins = db.prepare(`INSERT OR REPLACE INTO notices
  (key, name, org, pref, lg_code, city, issue_date, deadline, opening, category, procedure, cert, url, description, slug, fetched_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
db.exec('BEGIN');
let n = 0;
for (const r of found.values()) {
  if (!r.key || !r.name) continue;
  ins.run(r.key, r.name, r.org, r.pref, r.lg, r.city, r.issue, r.deadline, r.opening,
    r.category, r.procedure, r.cert, r.url, r.desc, classify(r.name), now);
  n++;
}
// 窓の外に出た古い公告は落とす（「開いている案件の在庫」を保つ）。rangeモード（バックフィル）では削除しない
const purged = RANGE ? { changes: 0 } : db.prepare(`DELETE FROM notices WHERE issue_date < ?`).run(from);
db.exec('COMMIT');
db.prepare(`INSERT OR REPLACE INTO fetch_log (source, key, fetched_at, rows) VALUES (?,?,?,?)`)
  .run('kkj', `${from}/${to}`, now, n);

const stats = db.prepare(`SELECT COUNT(*) c FROM notices`).get();
console.log(`KKJ公告: ${from}〜${to} を${requestCount}リクエストで取得 → 取込${n}件 / 保持${stats.c}件（窓外削除${purged.changes}件）`);
