// 無料アラート登録フォームの受け口（Netlify Function）
// hojokin-dbで実証済みの方式: Netlify Formsの静的受付はHTTP/2 POSTで404になる不具合があるため、
// ブラウザのPOSTをこの関数で受け、サーバー側からNetlify Formsへ転送して記録・通知を維持する。
export default async (req) => {
  const thanksUrl = new URL('/alert/thanks/', req.url);
  if (req.method !== 'POST') {
    return Response.redirect(new URL('/alert/', req.url), 303);
  }
  let params;
  try {
    params = new URLSearchParams(await req.text());
  } catch {
    return Response.redirect(thanksUrl, 303);
  }
  // honeypot: botには成功したふりをして何もしない
  if (params.get('bot-field')) return Response.redirect(thanksUrl, 303);
  if (!params.get('form-name')) params.set('form-name', 'alert');
  try {
    const res = await fetch(new URL('/', req.url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    if (!res.ok) console.error('forms relay failed:', res.status);
  } catch (e) {
    console.error('forms relay error:', e);
  }
  return Response.redirect(thanksUrl, 303);
};
