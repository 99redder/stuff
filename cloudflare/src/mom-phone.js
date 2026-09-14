import { MOM_PHONE_WEB_ORIGIN, MOM_PHONE_API_ORIGIN, MOM_PHONE_SESSION_SECONDS } from './mom-phone-access.js';

const SESSION = '__Host-mom_session';
const FLOW = '__Host-mom_flow';
// The page is hosted on GitHub Pages while the API is on workers.dev, so the
// browser treats this as cross-site. SameSite=None is required for the cookie
// to accompany fetch() calls; exact Origin checking below provides the CSRF
// boundary, while Secure and HttpOnly keep the bearer out of page JavaScript.
const COOKIE_FLAGS = 'Path=/; Secure; HttpOnly; SameSite=None';
const headers = {
  'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
};
function cookie(request, name) {
  return (request.headers.get('Cookie') || '').split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`))?.slice(name.length + 1) || '';
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...headers, 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': MOM_PHONE_WEB_ORIGIN, 'Access-Control-Allow-Credentials': 'true', 'Vary': 'Origin', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'" } });
}
function finish(result) {
  if (result.error) return json({ error: result.error }, result.status || 400);
  const { flowToken, sessionToken, ...body } = result;
  const response = json(body);
  if (flowToken) response.headers.append('Set-Cookie', `${FLOW}=${flowToken}; Max-Age=300; ${COOKIE_FLAGS}`);
  if (sessionToken) {
    response.headers.append('Set-Cookie', `${SESSION}=${sessionToken}; Max-Age=${MOM_PHONE_SESSION_SECONDS}; ${COOKIE_FLAGS}`);
    response.headers.append('Set-Cookie', `${FLOW}=; Max-Age=0; ${COOKIE_FLAGS}`);
  }
  return response;
}

export async function handleMomPhone(request, env, { readJson, summary }) {
  const url = new URL(request.url);
  const apiOrigin = env.MOM_PHONE_API_ORIGIN || MOM_PHONE_API_ORIGIN;
  const webOrigin = env.MOM_PHONE_WEB_ORIGIN || MOM_PHONE_WEB_ORIGIN;
  if (url.origin !== apiOrigin) return json({ error: 'Not found.' }, 404);
  if (request.method === 'GET' && (url.pathname === '/mom' || url.pathname === '/mom/')) return Response.redirect(`${webOrigin}/stuff/mom-budget-phone.html`, 302);
  if (!url.pathname.startsWith('/mom/api/')) return json({ error: 'Not found.' }, 404);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...headers, 'Access-Control-Allow-Origin': webOrigin, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Credentials': 'true', 'Vary': 'Origin' } });
  if (request.method !== 'POST') return json({ error: 'Not found.' }, 404);
  if (request.headers.get('Origin') !== webOrigin) return json({ error: 'Origin not allowed.' }, 403);
  if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers.get('Content-Type') || '')) return json({ error: 'JSON required.' }, 415);
  let body;
  try { body = await readJson(request, 24000); } catch { return json({ error: 'Invalid request.' }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Invalid request.' }, 400);

  const store = env.MOM_PHONE_ACCESS.getByName('mom_phone');
  const action = url.pathname.slice('/mom/api/'.length);
  try {
    if (['enroll/options', 'enroll/verify', 'login/options', 'login/verify'].includes(action)) {
      if (env.AUTH_RATELIMIT) {
        const rate = await env.AUTH_RATELIMIT.limit({ key: `mom:${request.headers.get('CF-Connecting-IP') || 'unknown'}` });
        if (!rate.success) return json({ error: 'Please wait a minute and try again.' }, 429);
      }
      const flow = cookie(request, FLOW);
      if (action === 'enroll/options') return finish(await store.call('enroll-options', { token: body.token, oldFlow: flow }));
      if (action === 'enroll/verify') return finish(await store.call('enroll-verify', { flow, response: body.response }));
      if (action === 'login/options') return finish(await store.call('login-options', { oldFlow: flow }));
      return finish(await store.call('login-verify', { flow, response: body.response }));
    }
    const token = cookie(request, SESSION);
    if (action === 'logout') {
      await store.call('logout', { token });
      const response = json({ success: true });
      response.headers.append('Set-Cookie', `${SESSION}=; Max-Age=0; ${COOKIE_FLAGS}`);
      response.headers.append('Set-Cookie', `${FLOW}=; Max-Age=0; ${COOKIE_FLAGS}`);
      return response;
    }
    if (action !== 'summary') return json({ error: 'Not found.' }, 404);
    const session = await store.call('session', { token });
    if (!session.authenticated) {
      const response = json({ error: 'Unlock your budget to continue.' }, 401);
      response.headers.append('Set-Cookie', `${SESSION}=; Max-Age=0; ${COOKIE_FLAGS}`);
      return response;
    }
    const result = await summary(request, env, body.month);
    if (!result.ok) return json({ error: (await result.json()).error || 'Please try again.' }, result.status);
    const info = await store.call('private-info');
    return json({ ...await result.json(), privateInfo: info.data, sessionExpiresAt: session.expiresAt });
  } catch {
    // Fail closed if access storage, verification or the rate limiter is down.
    return json({ error: 'Could not connect securely. Please try again shortly.' }, 503);
  }
}
