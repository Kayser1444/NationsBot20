import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareCloudConfiguration } from '../cloud-config.mjs';

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'nations-migrate-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const discord = { guildId: '111111111111111111', channelId: '222222222222222222' };
  const bundle = { version: 1, config: { subscriptions: { Player: '333333333333333333' }, matches: [], discord,
    dmPreferences: { '333333333333333333': true } },
    outbox: { version: 1, destination: discord, turns: { 1: { player: 'Player', sent: true, generation: 1 } }, jobs: [] } };
  const env = { NATIONS_DATA_DIR: directory, NATIONS_DISCORD_BOT_TOKEN: 'synthetic-secret',
    NATIONS_MIGRATION_BUNDLE: Buffer.from(JSON.stringify(bundle)).toString('base64') };
  return { directory, bundle, env };
}
test('one-time import preserves confirmed turns and never replays over later subscription edits', t => {
  const { directory, bundle, env } = setup(t);
  prepareCloudConfiguration(env);
  assert.deepEqual(JSON.parse(readFileSync(join(directory, 'friends-outbox.json'))), bundle.outbox);
  const changed = { ...bundle.config, subscriptions: {} };
  writeFileSync(join(directory, 'friends.json'), JSON.stringify(changed));
  prepareCloudConfiguration(env);
  assert.deepEqual(JSON.parse(readFileSync(join(directory, 'friends.json'))), changed);
  assert.throws(() => prepareCloudConfiguration({ ...env, NATIONS_MIGRATION_BUNDLE: Buffer.from('{}').toString('base64') }));
});
test('import rejects destination mismatches and refuses to overwrite existing files', t => {
  const { directory, env } = setup(t);
  assert.throws(() => prepareCloudConfiguration({ ...env, NATIONS_DISCORD_CHANNEL_ID: '444444444444444444' }));
  assert.deepEqual(readdirSync(directory), []);
  writeFileSync(join(directory, 'friends-outbox.json'), '{}');
  assert.throws(() => prepareCloudConfiguration(env), /overwrite/);
  assert.deepEqual(readdirSync(directory), ['friends-outbox.json']);
});
