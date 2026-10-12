import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiscordAuth, adminSettings } from '../admin-auth.mjs';
import { startDashboard } from '../dashboard.mjs';
import { request as httpRequest } from 'node:http';

const owner = '229311536827465728';
const settings = { origin: 'https://admin.example.test', clientId: '1558936899446374570', clientSecret: 'synthetic-client-secret', ownerId: owner };
async function fixture(t) {
  let clock = 0, identity = owner, calls = 0, snapshots = 0, edits = 0;
  const auth = createDiscordAuth(settings, { now: () => clock, fetcher: async (url, options) => {
    calls++;
    if (url.endsWith('/oauth2/token')) {
      const body = new URLSearchParams(options.body);
      assert.equal(body.get('client_secret'), settings.clientSecret);
      assert.equal(body.get('redirect_uri'), settings.origin + '/auth/callback');
      return Response.json({ access_token: 'synthetic-access-token', token_type: 'Bearer', scope: 'identify' });
    }
    assert.equal(options.headers.authorization, 'Bearer synthetic-access-token');
    return Response.json({ id: identity, username: 'Owner' });
  } });
  const dashboard = await startDashboard({ port: 0, auth, snapshot: () => { snapshots++; return { private: 'owner-only' }; },
    subscribe: async () => { edits++; }, unsubscribe: async () => { edits++; } });
  t.after(() => dashboard.close());
  // Emulate the TLS proxy with an explicit Host header (fetch derives Host from URL).
  const request = (path, options = {}) => new Promise((resolve, reject) => {
    const req = httpRequest('http://127.0.0.1:' + dashboard.port + path, {
      method: options.method ?? 'GET', headers: { host: 'admin.example.test', 'x-forwarded-proto': 'https', ...options.headers },
    }, response => {
      const chunks = [], headers = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        for (const item of Array.isArray(value) ? value : [value]) if (item !== undefined) headers.append(name, item);
      }
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers })));
    });
    req.on('error', reject); req.end(options.body);
  });
  async function login() {
    const response = await request('/auth/login');
    assert.equal(response.status, 303);
    const authorize = new URL(response.headers.get('location'));
    assert.equal(authorize.origin, 'https://discord.com');
    assert.equal(authorize.searchParams.get('scope'), 'identify');
    const cookie = response.headers.getSetCookie()[0].split(';')[0];
    const callback = '/auth/callback?code=synthetic-code&state=' + authorize.searchParams.get('state');
    return { cookie, callback };
  }
  return { request, login, setIdentity: value => { identity = value; }, setClock: value => { clock = value; },
    counts: () => ({ calls, snapshots, edits }) };
}

test('public admin pages disclose no state; APIs require authentication and HTTPS', async t => {
  const f = await fixture(t);
  const landing = await f.request('/');
  const html = await landing.text();
  assert.ok(html.includes('Logga in med Discord'));
  assert.equal(html.includes('owner-only'), false);
  assert.equal((await f.request('/api/status')).status, 401);
  assert.equal((await f.request('/api/subscriptions', { method: 'POST' })).status, 401);
  assert.equal((await f.request('/api/status', { headers: { host: 'evil.test' } })).status, 403);
  assert.equal((await f.request('/', { headers: { 'x-forwarded-proto': 'http' } })).status, 403);
  assert.deepEqual(f.counts(), { calls: 0, snapshots: 0, edits: 0 });
});

test('OAuth state is browser-bound, expires, is single-use and cannot authorize another user', async t => {
  const f = await fixture(t);
  let attempt = await f.login();
  assert.equal((await f.request(attempt.callback)).status, 400);
  assert.equal(f.counts().calls, 0);
  f.setClock(300001);
  assert.equal((await f.request(attempt.callback, { headers: { cookie: attempt.cookie } })).status, 400);
  attempt = await f.login(); f.setIdentity('111111111111111111');
  const rejected = await f.request(attempt.callback, { headers: { cookie: attempt.cookie } });
  assert.equal(rejected.status, 403);
  assert.equal(rejected.headers.getSetCookie().some(value => value.startsWith('__Host-nations-admin=')), false);
  assert.equal((await f.request(attempt.callback, { headers: { cookie: attempt.cookie } })).status, 400);
  assert.equal((await f.request('/api/status')).status, 401);
});

test('owner session protects page and edits, rejects forged CSRF, and ends on logout', async t => {
  const f = await fixture(t), attempt = await f.login();
  const callback = await f.request(attempt.callback, { headers: { cookie: attempt.cookie } });
  assert.equal(callback.status, 303);
  const sessionCookie = callback.headers.getSetCookie().find(value => value.startsWith('__Host-nations-admin='));
  for (const flag of ['Secure', 'HttpOnly', 'SameSite=Lax', 'Path=/']) assert.ok(sessionCookie.includes(flag));
  const cookie = sessionCookie.split(';')[0];
  const page = await f.request('/', { headers: { cookie } });
  const html = await page.text(), csrf = html.match(/const token='([a-f0-9]+)'/)[1];
  assert.ok(html.includes('Logga ut'));
  assert.equal(html.includes(settings.clientSecret), false); assert.equal(html.includes('synthetic-access-token'), false);
  assert.equal((await f.request('/api/status', { headers: { cookie } })).status, 200);
  const headers = { cookie, origin: settings.origin, 'content-type': 'application/json', 'x-nations-token': csrf };
  const body = JSON.stringify({ username: 'Kayser', userId: owner });
  assert.equal((await f.request('/api/subscriptions', { method: 'POST', body, headers: { ...headers, origin: 'https://evil.test' } })).status, 403);
  assert.equal((await f.request('/api/subscriptions', { method: 'POST', body, headers: { ...headers, 'x-nations-token': 'forged' } })).status, 403);
  assert.equal((await f.request('/api/subscriptions', { method: 'POST', body, headers })).status, 200);
  assert.equal(f.counts().edits, 1);
  assert.equal((await f.request('/api/subscriptions/Kayser', { method: 'DELETE', headers })).status, 200);
  assert.equal((await f.request('/auth/logout', { headers })).status, 403);
  assert.equal((await f.request('/auth/logout', { method: 'POST', headers })).status, 303);
  assert.equal((await f.request('/api/status', { headers: { cookie } })).status, 401);
});

test('owner sessions expire and OAuth failures do not expose secrets', async t => {
  const f = await fixture(t), attempt = await f.login();
  const response = await f.request(attempt.callback, { headers: { cookie: attempt.cookie } });
  const cookie = response.headers.getSetCookie().find(value => value.startsWith('__Host-nations-admin=')).split(';')[0];
  f.setClock(3600001);
  assert.equal((await f.request('/api/status', { headers: { cookie } })).status, 401);
  const auth = createDiscordAuth(settings, { fetcher: async () => { throw new Error(settings.clientSecret); } });
  let headers = {}, body = '';
  const res = { setHeader: (key, value) => { headers[key] = value; }, writeHead: (status, values) => { res.status = status; Object.assign(headers, values); }, end: value => { body = value ?? ''; } };
  await auth.handle({ method: 'GET', headers: {} }, res, new URL(settings.origin + '/auth/login'));
  const state = new URL(headers.location).searchParams.get('state');
  await auth.handle({ method: 'GET', headers: { cookie: '__Host-nations-login=' + state } }, res, new URL(settings.origin + '/auth/callback?code=code&state=' + state));
  assert.equal(res.status, 502); assert.equal(body.includes(settings.clientSecret), false);
});

test('cloud admin settings are opt-in and reject incomplete or unsafe setup', () => {
  assert.equal(adminSettings({}), null);
  assert.throws(() => adminSettings({ NATIONS_ADMIN_ENABLED: '1' }));
  assert.throws(() => createDiscordAuth({ ...settings, origin: 'http://admin.example.test' }));
  assert.throws(() => createDiscordAuth({ ...settings, origin: 'https://admin.example.test/path' }));
  assert.throws(() => createDiscordAuth({ ...settings, ownerId: 'not-an-id' }));
});
