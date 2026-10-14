import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareDevelopment } from '../dev-config.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'nations-dev-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { NATIONS_DEV_BOT_TOKEN: 'private-test-token', NATIONS_DEV_APPLICATION_ID: '111111111111111111',
    NATIONS_DEV_CHANNEL_ID: '222222222222222222', NATIONS_DEV_GUILD_ID: '333333333333333333',
    NATIONS_DATA_DIR: '/production', NATIONS_CONFIG_DIR: '/production',
    NATIONS_DISCORD_BOT_TOKEN: 'production-token', NATIONS_MIGRATION_BUNDLE: 'must-not-import' };
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => url.endsWith('/oauth2/applications/@me')
      ? { id: env.NATIONS_DEV_APPLICATION_ID }
      : { id: env.NATIONS_DEV_CHANNEL_ID, guild_id: env.NATIONS_DEV_GUILD_ID, type: 0 } };
  };
  return { root, env, calls, fetcher };
}

test('dev verifies its identity and destination, isolates state and preserves subscriptions', async t => {
  const f = fixture(t);
  const settings = await prepareDevelopment(f);
  assert.equal(settings.directory, join(f.root, '.data', 'dev'));
  assert.equal(settings.port, 24682);
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every(call => call.options.headers.authorization === 'Bot private-test-token'));
  const path = join(settings.directory, 'friends.json');
  const raw = readFileSync(path, 'utf8');
  assert.equal(raw.includes('token'), false);
  const config = JSON.parse(raw);
  assert.deepEqual(config.subscriptions, {});
  config.subscriptions = { Tester: '444444444444444444' };
  writeFileSync(path, JSON.stringify(config));
  await prepareDevelopment(f);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), config);
  f.env.NATIONS_DEV_CHANNEL_ID = '555555555555555555';
  await assert.rejects(prepareDevelopment(f), /differs/);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), config);
});

test('dev refuses production application, channel and invalid settings without contacting Discord', async t => {
  const f = fixture(t);
  for (const extra of [{ NATIONS_DEV_APPLICATION_ID: '1558936899446374570' },
    { NATIONS_DEV_CHANNEL_ID: '1558878151646388264' }, { NATIONS_DEV_BOT_TOKEN: '' },
    { NATIONS_DEV_PORT: '0' }, { NATIONS_DEV_PORT: 'oops' }]) {
    await assert.rejects(prepareDevelopment({ ...f, env: { ...f.env, ...extra } }));
  }
  assert.equal(f.calls.length, 0);
  assert.deepEqual(readdirSync(f.root), []);
});

test('dev refuses a production or mismatched token before writing state', async t => {
  const f = fixture(t);
  for (const id of ['1558936899446374570', '999999999999999999']) {
    await assert.rejects(prepareDevelopment({ ...f, fetcher: async () => ({ ok: true, json: async () => ({ id }) }) }), /Token/);
  }
  assert.deepEqual(readdirSync(f.root), []);
});

test('dev refuses inaccessible or foreign channels and never exposes token in errors', async t => {
  const f = fixture(t);
  for (const fetcher of [async () => { throw new Error(f.env.NATIONS_DEV_BOT_TOKEN); },
    async () => ({ ok: false }),
    async url => ({ ok: true, json: async () => url.endsWith('/oauth2/applications/@me')
      ? { id: f.env.NATIONS_DEV_APPLICATION_ID }
      : { id: f.env.NATIONS_DEV_CHANNEL_ID, guild_id: '999999999999999999', type: 0 } })]) {
    await assert.rejects(prepareDevelopment({ ...f, fetcher }), error => !error.message.includes(f.env.NATIONS_DEV_BOT_TOKEN));
  }
  assert.deepEqual(readdirSync(f.root), []);
});
