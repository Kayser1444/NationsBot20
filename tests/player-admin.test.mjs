import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlayerAdmin } from '../player-admin.mjs';

test('admin proxy uses its fixed service URL and server credential and forwards the authenticated actor', async () => {
  const calls = [];
  const env = { NATIONS_PLAYER_CONTROL_URL: 'http://player.railway.internal:8080', NATIONS_PLAYER_CONTROL_TOKEN: 'a'.repeat(64) };
  const proxy = createPlayerAdmin({ env, fetcher: async (url, options) => { calls.push({ url: String(url), options }); return Response.json({ ok: true }); } });
  await proxy('settings', { settings: { pollingEnabled: false }, revision: 2, actor: 'untrusted' }, '229311536827465728');
  assert.equal(calls[0].url, 'http://player.railway.internal:8080/settings');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(JSON.parse(calls[0].options.body).actor, '229311536827465728');
  assert.equal(calls[0].options.headers.authorization, 'Bearer ' + env.NATIONS_PLAYER_CONTROL_TOKEN);
  assert.equal(createPlayerAdmin({ env: {} }), null);
  await assert.rejects(() => proxy('https://another.example/'), /Invalid/);
});

test('admin proxy hides connection details and preserves validation conflicts', async () => {
  const env = { NATIONS_PLAYER_CONTROL_URL: 'http://player.railway.internal:8080', NATIONS_PLAYER_CONTROL_TOKEN: 'a'.repeat(64) };
  const failed = createPlayerAdmin({ env, fetcher: async () => { throw new Error('sensitive connection details'); } });
  await assert.rejects(() => failed('poll'), error => error.status === 503 && !error.message.includes('sensitive'));
  const conflict = createPlayerAdmin({ env, fetcher: async () => Response.json({ error: 'Refresh before saving.' }, { status: 409 }) });
  await assert.rejects(() => conflict('settings', {}), error => error.status === 409);
});
