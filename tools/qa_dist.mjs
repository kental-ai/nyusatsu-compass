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
const ASSETS = [];
(function walk(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.html') && !/^google[a-f0-9]+\.html$/.test(e.name)) files.push(p);
    else ASSETS.push(p);
  }
})(DIST);

const issues = new Map();
const counts = new Map();
const add = (kind, detail) => {
  counts.set(kind, (counts.get(kind) || 0) + 1);
  const l = issues.get(kind) ?? issues.set(kind, []).get(kind);
  if (l.length < 200) l.push(detail); // 詳細は種別ごと200件まで（異常時のメモリ爆発を防ぐ）
};
const titles = new Map();
const stripJs = (h) => h.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
// 実在パスの集合を一度だけ作る（7万ページでのfs参照とキャッシュ肥大を避ける。メモリと速度の両方に効く）
const VALID = new Set(['/']);
for (const f of files) {
  const rel = '/' + f.slice(DIST.length + 1).split(String.fromCharCode(92)).join('/');
  VALID.add(rel);
  if (rel.endsWith('/index.html')) VALID.add(rel.slice(0, -'index.html'.length));
}
for (const f of ASSETS) VALID.add('/' + f.slice(DIST.length + 1).split(String.fromCharCode(92)).join('/'));
const checkLink = (href) => {
  let path = href.split('#')[0].split('?')[0];
  if (!path || path === '/') return true;
  try { path = decodeURIComponent(path); } catch { /* 不正エンコードはそのまま */ }
  if (VALID.has(path)) return true;
  return VALID.has(path.endsWith('/') ? path : path + '/');
};

let checked = 0;
for (const f of files) {
  checked++;
  const rel = '/' + f.slice(DIST.length + 1).split(String.fromCharCode(92)).join('/');
  const html = readFileSync(f, 'utf8');
  const body = stripJs(html);

  {
    // 本文テキスト（タグ除去後）に対して検査する。位置を問わず拾う
    const text = body.replace(/<[^>]+>/g, ' ');
    for (const re of [/undefined/, /NaN/, /Invalid Date/, /\[object Object\]/, />null</, /。。/, /（）/, /、、/, /です。です/, /ます。ます/]) {
      const m = text.match(re) || (re.source === '>null<' ? body.match(re) : null);
      if (m) add(`漏出: ${re.source}`, `${rel}  …${text.slice(Math.max(0, m.index - 24), m.index + 30).replace(/\s+/g, ' ')}…`);
    }
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
for (const [kind, list] of [...issues.entries()].sort((a, b) => (counts.get(b[0]) || 0) - (counts.get(a[0]) || 0))) {
  const n = counts.get(kind) || list.length;
  total += n;
  console.log(`NG ${kind}: ${n}件`);
  for (const d of list.slice(0, 8)) console.log(`   ${d}`);
  if (n > 8) console.log(`   …ほか${n - 8}件`);
}
console.log(`\n検品: ${checked}ページ / 問題${total}件`);
if (total && process.argv.includes('--fail')) process.exit(1);
