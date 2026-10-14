import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { cardAssetName } from './card-images.mjs';

export async function startCardAssetServer({ port = 8081, host = '0.0.0.0' } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid card asset port.');
  const manifest = JSON.parse(readFileSync(new URL('./data/cards/asset-manifest.json', import.meta.url), 'utf8'));
  const assets = new Map();
  for (const file of manifest.files) {
    if (!cardAssetName(file.filename)) throw new Error('Invalid card asset filename.');
    const body = readFileSync(new URL('./public/card-assets/' + file.filename, import.meta.url));
    const sha256 = createHash('sha256').update(body).digest('hex');
    if (sha256 !== file.sha256 || body.length !== file.bytes || !file.filename.endsWith('.' + sha256.slice(0, 12) + '.png')) throw new Error('Card asset changed: ' + file.cardId);
    const path = '/card-assets/' + file.filename;
    if (assets.has(path)) throw new Error('Duplicate card asset.');
    assets.set(path, { body, etag: '"' + sha256 + '"' });
  }
  // This listener only knows the image allowlist; it has no dashboard or user-data routes.
  const server = createServer((req, res) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
    res.setHeader('cache-control', 'no-store');
    req.resume();
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(405, { allow: 'GET, HEAD' }); res.end(); return;
    }
    const asset = assets.get(req.url);
    if (!asset) { res.writeHead(404); res.end(); return; }
    res.setHeader('cache-control', 'public, max-age=31536000, immutable');
    res.setHeader('etag', asset.etag);
    if (req.headers['if-none-match'] === asset.etag) { res.writeHead(304); res.end(); return; }
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': asset.body.length });
    res.end(req.method === 'HEAD' ? undefined : asset.body);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  server.unref();
  return { port: server.address().port, close: () => { server.close(); server.closeIdleConnections(); } };
}
