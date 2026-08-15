// IndexNow通知（Bing等への即時URL通知。hojokin-dbと同方式）
// GoogleはIndexNow非対応だが、BingのインデックスはChatGPT等のAI検索が参照するため
// AI検索チャネルのインデックス鮮度を上げる目的で使う。
//
// 通常実行: 日次で内容が変わる中核ページ（トップ・相場・機関ハブ）を通知
// --full: sitemap-*.xmlの全URLを一括送信（初回・大規模変更後用。1リクエスト1万URLまで→分割送信）
// キーは公開仕様（{ORIGIN}/{KEY}.txt で所有権を証明。秘密情報ではない）
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const KEY = '68c8ff01b5ee8614e56c3a91ccbb8f59';
const ORIGIN = 'https://nyusatsu-compass.com';
const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'site', 'dist');
const FULL = process.argv.includes('--full');

const REMOTE = process.argv.includes('--remote'); // distが無い環境（CI等）では本番sitemapを読む
async function readSitemapLocs() {
  const out = [];
  if (REMOTE) {
    const idx = await (await fetch(`${ORIGIN}/sitemap.xml`)).text();
    for (const m of idx.matchAll(/<loc>([^<]+)<\/loc>/g)) {
      const body = await (await fetch(m[1])).text();
      out.push(...[...body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((x) => x[1]));
    }
  } else {
    for (let i = 0; existsSync(join(DIST, `sitemap-${i}.xml`)); i++) {
      const locs = (readFileSync(join(DIST, `sitemap-${i}.xml`), 'utf8').match(/<loc>([^<]+)<\/loc>/g) || [])
        .map((m) => m.slice(5, -6));
      out.push(...locs);
    }
  }
  return out;
}

let urls = [];
const allLocs = await readSitemapLocs();
if (FULL) {
  urls = allLocs;
} else {
  // 週次/日次: 統計が動く中核ページ+週報のみ
  urls.push(`${ORIGIN}/`, `${ORIGIN}/price/`, `${ORIGIN}/organ/`, `${ORIGIN}/company/`, `${ORIGIN}/weekly/`);
  urls.push(...allLocs.filter((u) => u.includes('/price/') || u.includes('/organ/') || u.includes('/weekly/')));
}
urls = [...new Set(urls)];

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
