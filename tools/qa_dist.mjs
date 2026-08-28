// 生成後の全ページ検品（品質ゲート）。
//   1) 内部リンク切れ（distに実体が無いhref）
//   2) テンプレ事故の漏出: undefined / NaN / Invalid Date / [object Object] / 空の表
//   3) title/h1/description の欠落・重複title
// 使い方: node tools/qa_dist.mjs [--fail]   （--fail で問題>0なら exit 1）
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'site', 'dist');
const files = [];
(function walk(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.html') && !/^google[a-f0-9]+\.html$/.test(e.name)) files.push(p);
  }
})(DIST);

const issues = new Map();
const add = (kind, detail) => { (issues.get(kind) ?? issues.set(kind, []).get(kind)).push(detail); };
const titles = new Map();
const stripJs = (h) => h.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
const linkOk = new Map();
const checkLink = (href) => {
  if (linkOk.has(href)) return linkOk.get(href);
  let path = href.split('#')[0].split('?')[0];
  if (!path || path === '/') { linkOk.set(href, true); return true; }
  try { path = decodeURIComponent(path); } catch { /* 不正エンコードはそのまま */ }
  const fs1 = join(DIST, path);
  const ok = existsSync(fs1) && (path.includes('.') ? true : existsSync(join(fs1, 'index.html')));
  linkOk.set(href, ok);
  return ok;
};

let checked = 0;
for (const f of files) {
  checked++;
  const rel = '/' + f.slice(DIST.length + 1).split(String.fromCharCode(92)).join('/');
  const html = readFileSync(f, 'utf8');
  const body = stripJs(html);

  for (const pat of ['>undefined<', '>NaN<', 'NaN円', 'NaN%', 'Invalid Date', '[object Object]', '>null<', 'undefined件', 'undefined円']) {
    if (body.includes(pat)) add(`漏出: ${pat}`, rel);
  }
  const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
  if (!title.trim()) add('titleなし', rel);
  else {
    if (titles.has(title)) add('title重複', `${rel} == ${titles.get(title)}`);
    else titles.set(title, rel);
  }
  if (!/<h1[ >]/.test(body)) add('h1なし', rel);
  if (!/name="description" content="[^"]{20,}/.test(html)) add('description欠落/短すぎ', rel);
  for (const tb of body.matchAll(/<table>[\s\S]*?<\/table>/g)) {
    if (!tb[0].includes('<td')) { add('空の表', rel); break; }
  }
  for (const m of body.matchAll(/href="(\/[^"]*)"/g)) {
    if (!checkLink(m[1])) add('内部リンク切れ', `${rel} → ${m[1]}`);
  }
}

let total = 0;
for (const [kind, list] of [...issues.entries()].sort((a, b) => b[1].length - a[1].length)) {
  total += list.length;
  console.log(`NG ${kind}: ${list.length}件`);
  for (const d of list.slice(0, 8)) console.log(`   ${d}`);
  if (list.length > 8) console.log(`   …ほか${list.length - 8}件`);
}
console.log(`\n検品: ${checked}ページ / 問題${total}件`);
if (total && process.argv.includes('--fail')) process.exit(1);
