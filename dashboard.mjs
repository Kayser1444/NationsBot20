import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dashboardTheme } from './dashboard-theme.mjs';
import { bulletinCredentialMatches } from './bulletins.mjs';
import { thinkingSummary } from './thinking-summary.mjs';
import { createRailwayBilling } from './railway-billing.mjs';
import { createOpenAiCredit } from './openai-credit.mjs';

const page = readFileSync(new URL('./dashboard.html', import.meta.url), 'utf8');
export async function startDashboard({ port = 24680, snapshot, thinkingSnapshot, subscribe, unsubscribe, setBan, setTracking, questionLog, questionQuota, resetQuestionQuota, bulletins = null, bulletinKeyHash = null, auth = null, environmentName = process.env.RAILWAY_ENVIRONMENT_NAME, railwayBilling = createRailwayBilling(), openAiCredit = createOpenAiCredit() }) {
  const token = randomBytes(24).toString('hex');
  let origin;
  const server = createServer(async (req, res) => {
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('cache-control', 'no-store');
    if (auth) res.setHeader('strict-transport-security', 'max-age=31536000');
    const json = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(data));
    };
    // Loopback binding + exact Host/Origin + per-process token prevent remote
    // pages from changing local subscriptions (including DNS rebinding).
    if (req.headers.host !== new URL(origin).host) { json(403, { error: 'Fel lokal adress.' }); return; }
    let url;
    try { url = new URL(req.url, origin); } catch { json(400, { error: 'Ogiltig adress.' }); return; }
    if (url.pathname === '/api/bulletins' || url.pathname.startsWith('/api/bulletins/')) {
      if (!auth || req.headers['x-forwarded-proto'] !== 'https') { json(403, { error: 'HTTPS krävs.' }); return; }
      if (!bulletins || !bulletinCredentialMatches(req.headers.authorization, bulletinKeyHash)) { json(401, { error: 'Bulletinbehörighet krävs.' }); return; }
      if (req.headers.origin && req.headers.origin !== origin) { json(403, { error: 'Ogiltigt ursprung.' }); return; }
      try {
        if (req.method === 'GET' && /^\/api\/bulletins\/[a-zA-Z0-9_-]{8,80}$/.test(url.pathname)) {
          const receipt = bulletins.receipt(url.pathname.slice('/api/bulletins/'.length));
          json(receipt ? 200 : 404, receipt ?? { error: 'Kvittot finns inte.' }); return;
        }
        if (req.method !== 'POST' || !['/api/bulletins', '/api/bulletins/preview'].includes(url.pathname)) { json(404, { error: 'Sidan finns inte.' }); return; }
        if (!req.headers['content-type']?.startsWith('application/json')) { json(415, { error: 'JSON krävs.' }); return; }
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 16384) throw Object.assign(new Error('För stor förfrågan.'), { status: 413 }); chunks.push(chunk); }
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (url.pathname.endsWith('/preview')) { json(200, bulletins.preview(input)); return; }
        const receipt = await bulletins.publish(input, req.headers['idempotency-key']);
        json(receipt.status === 'verified' ? 200 : receipt.status === 'failed' ? 502 : 202, receipt); return;
      } catch (error) { json(error.status ?? (error instanceof SyntaxError ? 400 : 503), { error: error.status ? error.message : 'Bulletinanropet kunde inte slutföras. Kontrollera kvittot innan nytt försök.' }); }
      return;
    }
    let activeSession = null;
    if (auth) {
      // Railway terminates TLS and forwards HTTPS requests to this private port.
      if (req.headers['x-forwarded-proto'] !== 'https') { json(403, { error: 'HTTPS krävs.' }); return; }
      try {
        if (await auth.handle(req, res, url)) return;
        activeSession = auth.session(req);
      } catch { json(500, { error: 'Inloggningen kunde inte verifieras.' }); return; }
      if (!activeSession) {
        if (req.method === 'GET' && url.pathname === '/') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8',
            'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' https://discord.com" });
          res.end(dashboardTheme('<!doctype html><html lang="sv"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NationsBot · Ägarpanel</title><style>body{font:16px system-ui;background:#f3f5f8;color:#203044;margin:0;padding:24px}main{max-width:440px;margin:12vh auto;background:white;border:1px solid #e0e5ec;border-radius:14px;padding:32px}h1{margin:0 0 8px}p{line-height:1.6}button{font:inherit;border:0;cursor:pointer;display:inline-block;background:#234f86;color:white;text-decoration:none;border-radius:8px;padding:12px 18px}.muted{font-size:13px;color:#64748b}</style><main><h1>NationsBot 2.0</h1><p>Hantera prenumerationer och se aktuell bevakning.</p><form action="/auth/login" method="get"><p><label><input type="checkbox" name="remember" value="1" checked> Kom ihåg mig i 30 dagar</label></p><p><button type="submit">Logga in med Discord</button></p></form><p class="muted">Endast botägaren har tillgång till ägarpanelen.</p></main></html>', environmentName)); return;
        }
        json(401, { error: 'Logga in med Discord.' }); return;
      }
    }
    const csrf = activeSession?.csrf ?? token;
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'self'; script-src 'self' 'nonce-" + csrf + "'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      });
      res.end(dashboardTheme(page.replaceAll('__TOKEN__', csrf).replaceAll('__LOCATION__', auth ? 'ägarpanel' : 'på den här datorn')
        .replaceAll('__ADMIN_OWNER__', /^\d{17,20}$/.test(activeSession?.userId) ? activeSession.userId : '')
        .replaceAll('__STOP_HINT__', auth ? 'Bevakningen körs på Railway.' : 'Stoppa tjänsten med Ctrl+C i terminalen.')
        .replaceAll('__ADMIN_CONTROLS__', auth ? '<button id="logout" type="button">Logga ut</button>' : ''), environmentName)); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/status') { json(200, snapshot()); return; }
    if (req.method === 'GET' && url.pathname === '/api/railway-billing') { json(200, await railwayBilling()); return; }
    if (req.method === 'GET' && url.pathname === '/api/openai-credit') { json(200, await openAiCredit()); return; }
    if (req.method === 'GET' && url.pathname === '/api/thinking') {
      if (!thinkingSnapshot) { json(503, { error: 'Betänketiderna är inte tillgängliga.' }); return; }
      const now = Date.now();
      json(200, { now: new Date(now).toISOString(), games: thinkingSummary(thinkingSnapshot(), now) }); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/questions') { json(200, questionLog?.list(Object.fromEntries(url.searchParams)) ?? { available: false, records: [], total: 0 }); return; }
    const quotaId = url.pathname.match(/^\/api\/question-quotas\/(\d{17,20})$/)?.[1];
    if (req.method === 'GET' && quotaId) {
      try { if (!questionQuota) throw new Error('Frågekvoten är inte tillgänglig.'); json(200, await questionQuota(quotaId)); }
      catch (error) { json(503, { error: error.message }); }
      return;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/questions/')) {
      const record = questionLog?.read(url.pathname.slice('/api/questions/'.length));
      json(record ? 200 : 404, record ?? { error: 'Frågan finns inte i loggen.' }); return;
    }
    if (!['POST', 'DELETE'].includes(req.method)) { json(404, { error: 'Sidan finns inte.' }); return; }
    if (req.headers.origin !== origin || req.headers['x-nations-token'] !== csrf) { json(403, { error: 'Ladda om statusfönstret och försök igen.' }); return; }
    try {
      if (req.method === 'POST' && url.pathname.startsWith('/api/question-quotas/')) {
        if (!quotaId) throw new Error('Discord-ID ska vara ett nummer med 17–20 siffror.');
        if (!resetQuestionQuota) throw new Error('Frågekvoten är inte tillgänglig.');
        json(200, await resetQuestionQuota(quotaId, activeSession?.userId ?? null)); return;
      }
      if (url.pathname.startsWith('/api/thinking/')) {
        const id = url.pathname.slice('/api/thinking/'.length);
        if (!/^\d+$/.test(id) || !setTracking) throw new Error('Ogiltigt parti-ID.');
        await setTracking(id, req.method === 'POST'); json(200, { ok: true }); return;
      }
      if (url.pathname.startsWith('/api/bans/')) {
        const userId = url.pathname.slice('/api/bans/'.length);
        if (!/^\d{17,20}$/.test(userId)) { json(400, { error: 'Discord-ID ska vara ett nummer med 17–20 siffror.' }); return; }
        if (!setBan) { json(404, { error: 'Spärrhantering är inte tillgänglig.' }); return; }
        await setBan(userId, req.method === 'POST');
        json(200, { ok: true }); return;
      }
      if (req.method === 'POST' && url.pathname === '/api/subscriptions') {
        if (!req.headers['content-type']?.startsWith('application/json')) { json(415, { error: 'Ogiltigt format.' }); return; }
        let body = '';
        for await (const chunk of req) {
          body += chunk.toString('utf8');
          if (Buffer.byteLength(body) > 4096) throw new Error('För stor förfrågan.');
        }
        const input = JSON.parse(body);
        if (typeof input.username !== 'string' || typeof input.userId !== 'string') throw new Error('Ange Nations-namn och Discord-ID.');
        await subscribe(input.username.trim(), input.userId.trim());
        json(200, { ok: true }); return;
      }
      if (req.method === 'DELETE' && url.pathname.startsWith('/api/subscriptions/')) {
        await unsubscribe(decodeURIComponent(url.pathname.slice('/api/subscriptions/'.length)), url.searchParams.get('userId'));
        json(200, { ok: true }); return;
      }
      json(404, { error: 'Sidan finns inte.' });
    } catch (error) {
      json(400, { error: error instanceof SyntaxError ? 'Ogiltig förfrågan.' : error.message });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, auth ? '0.0.0.0' : '127.0.0.1', resolve);
  });
  origin = auth?.origin ?? `http://127.0.0.1:${server.address().port}`;
  return { url: origin, port: server.address().port, close: () => { auth?.close(); server.close(); server.closeIdleConnections(); } };
}
