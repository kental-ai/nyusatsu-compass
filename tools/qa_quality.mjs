// 品質の常設チェック。dist の全ページを1本ずつ測る。
//   1) 本文の字数（<main> 内）
//   2) 独自文の字数 — サイト内で BOILER_DF ページ以上に出る文を「定型」とみなして除いた残り
//   3) 近似重複 — 文字6グラムの MinHash + LSH で全ページ総当たりし、署名一致率 DUP_TH 以上のペアを出す
//
// 「見かけの字数は足りているのに、中身はサイト共通の文章だった」を検出するのが目的。
// 使い方: node tools/qa_quality.mjs [--json 出力先] [--top 30]
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DIST = 'site/dist';
const BOILER_DF = 100;   // これ以上のページに出る文は定型とみなす
const DUP_TH = 0.8;      // 署名一致率がこれ以上なら近似重複
const K = 32;            // MinHash のハッシュ本数
const args = process.argv.slice(2);
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
const TOP = Number(args.includes('--top') ? args[args.indexOf('--top') + 1] : 30);

const files = [];
(function walk(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p); else if (e.name.endsWith('.html')) files.push(p);
  }
})(DIST);

// 表のセルは1〜3文字に刻まれてしまうので、行（tr）単位で1文として扱う
const textOf = (h) => {
  const m = h.match(/<main[^>]*>([\s\S]*?)<\/main>/);
  let s = m ? m[1] : h;
  s = s.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ');
  s = s.replace(/<\/(td|th)>/g, ' ').replace(/<\/(p|h1|h2|h3|li|tr|div)>/g, '。');
  return s.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;|&#\d+;/g, ' ');
};
const sentsOf = (s) => s.split('。').map((x) => x.replace(/\s+/g, ' ').trim()).filter((x) => x.length >= 8);
const secOf = (p) => {
  const s = p.replace(/^\//, '').split('/');
  if (s[0] === 'local') return s.length <= 2 ? 'local/県' : 'local/市区町村';
  if (s[0] === 'contract') return s[1] === 'local' ? 'contract/自治体' : 'contract/国';
  return s[0] || 'root';
};

const SEEDS = Array.from({ length: K }, (_, i) => (i * 2654435761 + 40503) >>> 0);
const h32 = (str, seed) => { let h = seed >>> 0; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; };

const df = new Map();
const rows = [];
const sigs = [];
for (const f of files) {
  const raw = textOf(readFileSync(f, 'utf8'));
  const flat = raw.replace(/。/g, ' ').replace(/\s+/g, ' ').trim();
  const ss = sentsOf(raw);
  for (const s of new Set(ss)) df.set(s, (df.get(s) || 0) + 1);
  const path = f.slice(DIST.length).split(String.fromCharCode(92)).join('/');
  rows.push({ path, sec: secOf(path), len: flat.length, ss, uni: 0 });
  const sig = new Uint32Array(K).fill(0xffffffff);
  const seen = new Set();
  for (let i = 0; i + 6 <= flat.length; i += 2) {
    const sh = flat.slice(i, i + 6);
    if (seen.has(sh)) continue;
    seen.add(sh);
    for (let k = 0; k < K; k++) { const v = h32(sh, SEEDS[k]); if (v < sig[k]) sig[k] = v; }
  }
  sigs.push(sig);
}
for (const r of rows) { let u = 0; for (const s of r.ss) if ((df.get(s) || 0) < BOILER_DF) u += s.length; r.uni = u; r.ss = null; }

// --- 近似重複（LSH: 8バンド×4行）---
const B = 8, R = K / 8;
const buckets = new Map();
for (let i = 0; i < sigs.length; i++) {
  for (let b = 0; b < B; b++) {
    const key = b + ':' + Array.from(sigs[i].slice(b * R, b * R + R)).join(',');
    const a = buckets.get(key);
    if (a) a.push(i); else buckets.set(key, [i]);
  }
}
const cand = new Set();
for (const a of buckets.values()) {
  if (a.length < 2 || a.length > 200) continue;
  for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) cand.add(a[i] < a[j] ? a[i] * 1e6 + a[j] : a[j] * 1e6 + a[i]);
}
const dups = [];
const dupNodes = new Set();
for (const c of cand) {
  const x = Math.floor(c / 1e6), y = c % 1e6;
  let m = 0;
  for (let k = 0; k < K; k++) if (sigs[x][k] === sigs[y][k]) m++;
  const s = m / K;
  if (s >= DUP_TH) { dups.push([s, rows[x].path, rows[y].path]); dupNodes.add(x); dupNodes.add(y); }
}
dups.sort((a, b) => b[0] - a[0]);

// --- 出力 ---
const pct = (a, q) => a[Math.min(a.length - 1, Math.floor(a.length * q))];
const bySec = new Map();
for (const r of rows) (bySec.get(r.sec) ?? bySec.set(r.sec, []).get(r.sec)).push(r);
const out = [];
out.push(`品質チェック: ${rows.length.toLocaleString()}ページ（定型の判定は${BOILER_DF}ページ以上に出る文）`);
out.push('');
out.push(['section', 'pages', '本文p50', '独自p10', '独自p50', '独自p90', '独自<1500', '重複関与'].join('\t'));
const dupBySec = new Map();
for (const i of dupNodes) dupBySec.set(rows[i].sec, (dupBySec.get(rows[i].sec) || 0) + 1);
for (const [sec, a] of [...bySec.entries()].sort((x, y) => y[1].length - x[1].length)) {
  const L = a.map((r) => r.len).sort((x, y) => x - y);
  const U = a.map((r) => r.uni).sort((x, y) => x - y);
  out.push([sec, a.length, pct(L, .5), pct(U, .1), pct(U, .5), pct(U, .9), U.filter((v) => v < 1500).length, dupBySec.get(sec) || 0].join('\t'));
}
const L = rows.map((r) => r.len).sort((x, y) => x - y);
const U = rows.map((r) => r.uni).sort((x, y) => x - y);
out.push(['TOTAL', rows.length, pct(L, .5), pct(U, .1), pct(U, .5), pct(U, .9), U.filter((v) => v < 1500).length, dupNodes.size].join('\t'));
out.push('');
out.push(`近似重複（一致率${DUP_TH}以上）: ${dups.length.toLocaleString()}ペア / 関与${dupNodes.size.toLocaleString()}ページ（${Math.round(dupNodes.size / rows.length * 1000) / 10}%）`);
for (const d of dups.slice(0, TOP)) out.push(`  ${Math.round(d[0] * 100)}%\t${d[1]}\t${d[2]}`);
out.push('');
out.push('定型文トップ10（出現ページ数）');
for (const [s, n] of [...df.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) out.push(`  ${n}\t${s.slice(0, 56)}`);
console.log(out.join('\n'));
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ rows: rows.map((r) => ({ p: r.path, len: r.len, uni: r.uni })), dups }));
