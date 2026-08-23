// 無料会員の有効化（ステップメール0通目のリンクの受け口）
// GET /.netlify/functions/verify?m=<メール>&id=<読者ID>&back=<戻り先パス>
//   - リンクはメール本文に差し込まれる（###mail### / ###tourokuid###）ため、クリック＝そのメールを受け取れた証拠とみなす
//   - nc_m=1（表示用・1年・JSが読む）と nc_s=HMAC（検証用・HttpOnly・1年）を発行して戻り先へ
//   - NC_SECRET 未設定でも nc_m は発行する（段階導入）。nc_s は後段（②b/③）のサーバー検証で使う
import { createHmac } from 'node:crypto';

const ONE_YEAR = 60 * 60 * 24 * 365;
const isEmail = (s) => /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(s || '');
const safeBack = (b) => (b && /^\/[A-Za-z0-9_\-\/%.?=&]*$/.test(b) && !b.startsWith('//') ? b : null);

export default async (req) => {
  const url = new URL(req.url);
  const m = (url.searchParams.get('m') || '').trim().toLowerCase();
  const id = (url.searchParams.get('id') || '').trim().slice(0, 64);
  const back = safeBack(url.searchParams.get('back'));
  const dest = new URL(`/alert/welcome/${back ? `?back=${encodeURIComponent(back)}` : ''}`, req.url);

  if (!isEmail(m)) {
    return Response.redirect(new URL('/alert/?invalid=1', req.url), 303);
  }
  const headers = new Headers({ Location: dest.toString() });
  const common = `Max-Age=${ONE_YEAR}; Path=/; SameSite=Lax; Secure`;
  headers.append('Set-Cookie', `nc_m=1; ${common}`);
  const secret = process.env.NC_SECRET;
  if (secret) {
    const sig = createHmac('sha256', secret).update(`${m}|${id}`).digest('base64url');
    // 値にメール本体は入れない（ハッシュのみ）。サーバー側で照合するときは m を別途受け取って再計算する
    headers.append('Set-Cookie', `nc_s=${sig}; ${common}; HttpOnly`);
  }
  return new Response(null, { status: 303, headers });
};
