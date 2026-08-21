// IndexNow通知（Bing等への即時URL通知。hojokin-dbと同方式）
// GoogleはIndexNow非対応だが、BingのインデックスはChatGPT等のAI検索が参照するため
// AI検索チャネルのインデックス鮮度を上げる目的で使う。
//
// 既定（日次ビルドの最終段で実行）: sitemapのlastmodを見て「実際にデータが動いたページ」＋
//   中核ハブだけを通知する。同じURLを毎日送りつけない（IndexNowのマナー）。
// --full: sitemap-*.xmlの全URLを一括送信（初回・大規模構造変更後のみ）
// --remote: distが無い環境（CI）から本番sitemapを読む
// --days=N: lastmodが何日以内のURLを対象にするか（既定3）
// キーは公開仕様（{ORIGIN}/{KEY}.txt で所有権を証明。秘密情報ではない）
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const KEY = '68c8ff01b5ee8614e56c3a91ccbb8f59';
const ORIGIN = 'https://nyusatsu-compass.com';
const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'site', 'dist');
const FULL = process.argv.includes('--full');
const REMOTE = process.argv.includes('--remote');
const DAYS = Number((process.argv.find((a) => a.startsWith('--days=')) || '').split('=')[1]) || 3;
const MAX_DAILY = 2000; // 1日の通知上限（過剰送信の抑制）

// sitemapを {loc, lastmod} で読む
async function readSitemapEntries() {
  const out = [];
  const parse = (xml) => {
    for (const m of xml.matchAll(/<url><loc>([^<]+)<\/loc>(?:<lastmod>([^<]*)<\/lastmod>)?<\/url>/g)) {
      out.push({ loc: m[1], lastmod: m[2] || '' });
    }
  };
  if (REMOTE) {
    const idx = await (await fetch(`${ORIGIN}/sitemap.xml`)).text();
    for (const m of idx.matchAll(/<loc>([^<]+)<\/loc>/g)) parse(await (await fetch(m[1])).text());
  } else {
    for (let i = 0; existsSync(join(DIST, `sitemap-${i}.xml`)); i++) {
      parse(readFileSync(join(DIST, `sitemap-${i}.xml`), 'utf8'));
    }
  }
  return out;
}

const entries = await readSitemapEntries();
let urls;
if (FULL) {
  urls = entries.map((e) => e.loc);
} else {
  // 中核ハブ（毎日中身が変わる集計ページ）は常に通知
  const hubs = ['/', '/price/', '/organ/', '/company/', '/weekly/', '/radar/', '/local/', '/shindan/']
    .map((p) => ORIGIN + p);
  // データが実際に動いたページ = lastmodが「データ上の最新日」からN日以内。
  // 公表元（GEPS等）に数日の公表ラグがあるため、実行日ではなくデータ最新日を基準にする。
  const newest = entries.reduce((mx, e) => (e.lastmod > mx ? e.lastmod : mx), '');
  const cutoff = newest
    ? new Date(new Date(newest + 'T00:00:00Z').getTime() - DAYS * 86400000).toISOString().slice(0, 10)
    : new Date(Date.now() - DAYS * 86400000).toISOString().slice(0, 10);
  const fresh = entries.filter((e) => e.lastmod && e.lastmod >= cutoff).map((e) => e.loc);
  console.log(`データ最新日 ${newest} / 基準日 ${cutoff} 以降を更新扱い`);
  urls = [...hubs, ...fresh];
}
urls = [...new Set(urls)];
if (!FULL && urls.length > MAX_DAILY) {
  console.log(`対象${urls.length}件 → 上限${MAX_DAILY}件に制限`);
  urls = urls.slice(0, MAX_DAILY);
}

if (!urls.length) { console.log('IndexNow: 通知対象なし'); process.exit(0); }
for (let i = 0; i < urls.length; i += 10000) {
  const batch = urls.slice(i, i + 10000);
  const res = await fetch('https://api.indexnow.org/indexnow', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ host: 'nyusatsu-compass.com', key: KEY, keyLocation: `${ORIGIN}/${KEY}.txt`, urlList: batch }),
  });
  console.log(`IndexNow: ${batch.length}件送信 → HTTP ${res.status}`);
  if (i + 10000 < urls.length) await new Promise((r) => setTimeout(r, 1000));
}
