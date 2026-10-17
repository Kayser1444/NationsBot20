import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { createBulletinService, bulletinCredentialMatches } from '../bulletins.mjs';
import { startDashboard } from '../dashboard.mjs';

const guildId = '706912380067643473', channelId = '1558878151646388264', botId = '1558936899446374570', messageId = '1561000000000000000';
const key = 'b'.repeat(64), keyHash = createHash('sha256').update(key).digest('hex');
const input = { environment: 'production', content: 'En godkänd bulletin 📚' };
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'bulletin-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let posts = 0, delivery = 'ok', verification = true, captured, identity = botId, targetGuild = guildId;
  const fetcher = async (url, options) => {
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.authorization, 'Bot synthetic-discord-token');
    if (url.endsWith('/users/@me')) return Response.json({ id: identity, bot: true });
    if (url.endsWith('/channels/' + channelId)) return Response.json({ id: channelId, guild_id: targetGuild, type: 0 });
    if (options.method === 'POST') {
      posts++; captured = JSON.parse(options.body);
      if (delivery === 'throw') throw new Error('synthetic transport lost acknowledgement');
      if (delivery === '500') return new Response('', { status: 500 });
      if (delivery === '429') return new Response('', { status: 429 });
      return Response.json(message());
    }
    if (!verification) return new Response('', { status: 503 });
    return Response.json(url.includes('?limit=50') ? [message()] : message());
  };
  const message = () => ({ id: messageId, channel_id: channelId, author: { id: botId }, content: captured?.content,
    nonce: captured?.nonce, mention_everyone: false, mentions: [], mention_roles: [] });
  const create = () => createBulletinService({ directory, environment: 'production', guildId, channelId, botId, token: 'synthetic-discord-token', fetcher });
  const service = create();
  return { directory, service, create, posts: () => posts, payload: () => captured,
    setDelivery: value => { delivery = value; }, setVerification: value => { verification = value; },
    setIdentity: value => { identity = value; }, setGuild: value => { targetGuild = value; } };
}
const approved = service => ({ ...input, sha256: service.preview(input).sha256 });

test('preview has no Discord side effects; wrong environment, mentions, UTF-16 limit and changed hash fail closed', async t => {
  const f = fixture(t), s = f.service;
  assert.deepEqual(s.preview(input).destination, { guildId, channelId, botId });
  assert.equal(f.posts(), 0);
  for (const content of ['', ' ', 'a'.repeat(2001), '📚'.repeat(1001), '@everyone', '<@229311536827465728>']) assert.throws(() => s.preview({ ...input, content }));
  assert.throws(() => s.preview({ ...input, environment: 'staging' }));
  await assert.rejects(s.publish({ ...input, sha256: '0'.repeat(64) }, 'changed-hash'), /förhandsgranskningen/);
  await assert.rejects(s.publish(approved(s), '../escape'), /publiceringsnyckel/);
  assert.equal(f.posts(), 0);
});

test('publication verifies identity, target, mention suppression and persisted idempotency across restarts', async t => {
  const f = fixture(t), request = approved(f.service);
  const result = await f.service.publish(request, 'release-20261017');
  assert.equal(result.status, 'verified'); assert.ok(result.url.endsWith('/' + messageId));
  assert.deepEqual(f.payload().allowed_mentions, { parse: [], users: [], roles: [] });
  assert.equal(f.payload().enforce_nonce, true); assert.ok(f.payload().nonce.length <= 25);
  assert.equal((await f.create().publish(request, result.id)).messageId, messageId);
  await assert.rejects(f.service.publish({ ...request, content: 'Annat', sha256: f.service.preview({ ...input, content: 'Annat' }).sha256 }, result.id), /annan text/);
  assert.equal(f.posts(), 1);
  assert.equal(f.service.receipt(result.id).status, 'verified');
});

test('a wrong bot or guild cannot send and reserves no publication', async t => {
  const f = fixture(t);
  f.setIdentity('1559978065348792460');
  await assert.rejects(f.service.publish(approved(f.service), 'wrong-bot'), /motsvarar/);
  f.setIdentity(botId); f.setGuild('1559978065348792460');
  await assert.rejects(f.service.publish(approved(f.service), 'wrong-guild'), /motsvarar/);
  assert.equal(f.posts(), 0); assert.equal(f.service.receipt('wrong-guild'), null);
});

test('lost acknowledgements never resend; later nonce reconciliation recovers the original message', async t => {
  const f = fixture(t); f.setDelivery('throw'); f.setVerification(false);
  const request = approved(f.service);
  assert.equal((await f.service.publish(request, 'lost-ack')).status, 'uncertain');
  assert.equal((await f.create().publish(request, 'lost-ack')).status, 'uncertain');
  assert.equal(f.posts(), 1);
  f.setVerification(true);
  assert.equal((await f.create().publish(request, 'lost-ack')).status, 'verified');
  assert.equal(f.posts(), 1);
});

test('crash reservation, failed rate-limit response, failed verification and corrupted receipts cannot cause automatic duplicates', async t => {
  const f = fixture(t), request = approved(f.service);
  f.setDelivery('429'); assert.equal((await f.service.publish(request, 'rate-limit')).status, 'failed');
  assert.equal((await f.create().publish(request, 'rate-limit')).status, 'failed'); assert.equal(f.posts(), 1);
  f.setDelivery('ok'); f.setVerification(false);
  assert.equal((await f.service.publish(request, 'unverified')).status, 'sent');
  assert.equal((await f.create().publish(request, 'unverified')).status, 'sent'); assert.equal(f.posts(), 2);
  f.setVerification(true); assert.equal((await f.create().publish(request, 'unverified')).status, 'verified');
  writeFileSync(join(f.directory, 'bulletins', 'corrupted.json'), '{}');
  await assert.rejects(f.create().publish(request, 'corrupted'), /kvittot/);
  assert.equal(f.posts(), 2);
  const reservation = { id: 'crash-reserve', ...f.service.preview(input), status: 'publishing', nonce: 'original-crashed-nonce' };
  writeFileSync(join(f.directory, 'bulletins', reservation.id + '.json'), JSON.stringify(reservation));
  assert.equal((await f.create().publish(request, reservation.id)).status, 'uncertain');
  assert.equal(f.posts(), 2, 'a stale reservation may be reconciled but never resent');
  f.setDelivery('500');
  assert.equal((await f.service.publish(request, 'server-error')).status, 'uncertain');
  assert.equal(f.posts(), 3);
  await f.create().publish(request, 'server-error');
  assert.equal(f.posts(), 3);
});

test('concurrent duplicate calls perform at most one Discord POST', async t => {
  const f = fixture(t), request = approved(f.service);
  const result = await Promise.allSettled([f.service.publish(request, 'concurrent'), f.service.publish(request, 'concurrent')]);
  assert.equal(result.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(f.posts(), 1);
});

test('scoped bearer API requires TLS, exact host, correct credential; cannot authorize unrelated admin routes', async t => {
  const f = fixture(t);
  const auth = { origin: 'https://admin.example.test', handle: async () => false, session: () => null, close() {} };
  const dashboard = await startDashboard({ port: 0, snapshot: () => ({ private: true }), auth, bulletins: f.service, bulletinKeyHash: keyHash });
  t.after(() => dashboard.close());
  const request = (path, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port: dashboard.port, path, method,
      headers: { host: 'admin.example.test', 'x-forwarded-proto': 'https', ...headers } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    }); req.on('error', reject); req.end(body);
  });
  const headers = { authorization: 'Bearer ' + key, 'content-type': 'application/json' }, body = JSON.stringify(input);
  assert.equal((await request('/api/bulletins/preview', { method: 'POST', body })).status, 401);
  for (const bad of [{ authorization: 'Bearer ' + 'c'.repeat(64) }, { 'x-forwarded-proto': 'http' }, { host: 'evil.test' }, { origin: 'https://evil.test' }]) {
    assert.ok([401, 403].includes((await request('/api/bulletins/preview', { method: 'POST', headers: { ...headers, ...bad }, body })).status));
  }
  assert.equal((await request('/api/status', { headers })).status, 401);
  assert.equal((await request('/api/subscriptions', { method: 'POST', headers, body: '{}' })).status, 401);
  const preview = await request('/api/bulletins/preview', { method: 'POST', headers, body });
  assert.equal(preview.status, 200); assert.equal(f.posts(), 0);
  assert.equal((await request('/api/bulletins', { method: 'POST', headers: { ...headers, 'idempotency-key': 'api-publish' }, body: JSON.stringify({ ...input, sha256: preview.data.sha256 }) })).status, 200);
  assert.equal((await request('/api/bulletins/api-publish', { headers })).data.status, 'verified');
  assert.equal((await request('/api/bulletins/preview', { method: 'POST', headers, body: '{broken' })).status, 400);
  assert.equal((await request('/api/bulletins/preview', { method: 'POST', headers, body: JSON.stringify({ ...input, content: 'a'.repeat(17000) }) })).status, 413);
  assert.equal(f.posts(), 1);
  assert.equal(bulletinCredentialMatches('Bearer ' + key, keyHash), true);
  assert.equal(bulletinCredentialMatches('Bearer ' + key, ''), false);
});
