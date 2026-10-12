import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

const page = readFileSync(new URL('./dashboard.html', import.meta.url), 'utf8');
export async function startDashboard({ port = 24680, snapshot, subscribe, unsubscribe }) {
  const token = randomBytes(24).toString('hex');
  let origin;
  const server = createServer(async (req, res) => {
    const json = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(data));
    };
    // Loopback binding + exact Host/Origin + per-process token prevent remote
    // pages from changing local subscriptions (including DNS rebinding).
    if (req.headers.host !== new URL(origin).host) { json(403, { error: 'Fel lokal adress.' }); return; }
    const url = new URL(req.url, origin);
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'self'; script-src 'self' 'nonce-" + token + "'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
      });
      res.end(page.replaceAll('__TOKEN__', token)); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/status') { json(200, snapshot()); return; }
    if (!['POST', 'DELETE'].includes(req.method)) { json(404, { error: 'Sidan finns inte.' }); return; }
    if (req.headers.origin !== origin || req.headers['x-nations-token'] !== token) { json(403, { error: 'Ladda om statusfönstret och försök igen.' }); return; }
    try {
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
        await unsubscribe(decodeURIComponent(url.pathname.slice('/api/subscriptions/'.length)));
        json(200, { ok: true }); return;
      }
      json(404, { error: 'Sidan finns inte.' });
    } catch (error) {
      json(400, { error: error instanceof SyntaxError ? 'Ogiltig förfrågan.' : error.message });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { url: origin, close: () => { server.close(); server.closeIdleConnections(); } };
}
