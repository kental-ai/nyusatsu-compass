// 週次セルフ監査: 本番サイト・sitemap整合・データソース生存を機械チェック。
// 失敗時はexit 1（GitHub Actionsの失敗通知がそのままアラートになる）。
const ORIGIN = 'https://nyusatsu-compass.com';
let failures = 0;
const check = async (label, fn) => {
  try {
    const msg = await fn();
    console.log(`OK  ${label}${msg ? ` — ${msg}` : ''}`);
  } catch (e) {
    failures++;
    console.error(`NG  ${label} — ${e.message}`);
  }
};
const get = async (url, opts = {}) => {
  const res = await fetch(url, { redirect: 'manual', ...opts });
  return res;
};

await check('トップページ', async () => {
  const r = await get(`${ORIGIN}/`);
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  const t = await r.text();
  if (!t.includes('入札コンパス')) throw new Error('タイトル欠落');
});
await check('相場ページ（清掃）', async () => {
  const r = await get(`${ORIGIN}/price/seiso/`);
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
});
await check('sitemap整合', async () => {
  const idx = await (await get(`${ORIGIN}/sitemap.xml`)).text();
  const shards = [...idx.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  if (shards.length < 1) throw new Error('sitemap index が空');
  let total = 0;
  const sample = [];
  for (const s of shards) {
    const body = await (await get(s)).text();
    const locs = [...body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    total += locs.length;
    sample.push(locs[Math.floor(locs.length / 2)]);
  }
  if (total < 10000) throw new Error(`URL数が異常に少ない: ${total}`);
  for (const u of sample) {
    const r = await get(u);
    if (r.status !== 200) throw new Error(`サンプルURL ${u} が HTTP ${r.status}`);
  }
  return `${total} URLs`;
});
await check('週間レポートの鮮度', async () => {
  const t = await (await get(`${ORIGIN}/weekly/`)).text();
  const m = t.match(/\/weekly\/(\d{8})\//);
  if (!m) throw new Error('週次ページが見つからない');
  const latest = new Date(`${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6, 8)}`);
  const ageDays = (Date.now() - latest.getTime()) / 86400000;
  if (ageDays > 21) throw new Error(`最新週報が${Math.round(ageDays)}日前 — 日次ビルドが止まっている可能性`);
  return `最新 ${m[1]}`;
});
await check('GEPS差分エンドポイント', async () => {
  const d = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10).replaceAll('-', '');
  const r = await get(`https://api.p-portal.go.jp/pps-web-biz/UAB03/OAB0301?fileversion=v001&filename=successful_bid_record_info_diff_${d}.zip`);
  if (r.status !== 200) throw new Error(`HTTP ${r.status}（仕様変更の可能性）`);
});
await check('KKJ API', async () => {
  // KKJはTLS中間証明書が不完全なためNode既定では失敗しうる → ステータスのみ寛容に判定
  const r = await get('https://www.kkj.go.jp/api/?Query=%E5%85%A5%E6%9C%AD&Count=1').catch((e) => { throw new Error(e.cause?.code || e.message); });
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
});
await check('フォーム受け口（Function）', async () => {
  const r = await get(`${ORIGIN}/.netlify/functions/alert-form`);
  if (r.status !== 303) throw new Error(`HTTP ${r.status}（303リダイレクトのはず）`);
});

console.log(failures ? `\n監査結果: ${failures}件の異常` : '\n監査結果: すべて正常');
process.exit(failures ? 1 : 0);
