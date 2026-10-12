import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareCloudConfiguration } from '../cloud-config.mjs';

test('cloud startup stores configuration on the volume without saving the bot token', t => {
  const directory = mkdtempSync(join(tmpdir(), 'nations-cloud-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const env = { NATIONS_DATA_DIR: directory, NATIONS_DISCORD_BOT_TOKEN: 'test-secret-not-persisted',
    NATIONS_DISCORD_GUILD_ID: '111111111111111111', NATIONS_DISCORD_CHANNEL_ID: '222222222222222222' };
  assert.equal(prepareCloudConfiguration(env), directory);
  assert.deepEqual(readdirSync(directory), ['friends.json']);
  const path = join(directory, 'friends.json');
  const raw = readFileSync(path, 'utf8');
  assert.equal(raw.includes(env.NATIONS_DISCORD_BOT_TOKEN), false);
  const config = JSON.parse(raw);
  assert.deepEqual(config.subscriptions, {});
  config.subscriptions = { ExamplePlayer: '333333333333333333' };
  config.dmPreferences = { '333333333333333333': true };
  config.lastNationsNames = { '333333333333333333': 'ExamplePlayer' };
  writeFileSync(path, JSON.stringify(config));
  prepareCloudConfiguration(env);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), config);
  assert.throws(() => prepareCloudConfiguration({ ...env, NATIONS_DISCORD_CHANNEL_ID: '444444444444444444' }), /differs/);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), config);
});

test('cloud setup rejects missing secrets, relative storage and malformed destination', t => {
  const directory = mkdtempSync(join(tmpdir(), 'nations-cloud-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  assert.throws(() => prepareCloudConfiguration({}), /BOT_TOKEN/);
  assert.throws(() => prepareCloudConfiguration({ NATIONS_DISCORD_BOT_TOKEN: 'test', NATIONS_DATA_DIR: '.data' }), /absolute/);
  assert.throws(() => prepareCloudConfiguration({ NATIONS_DISCORD_BOT_TOKEN: 'test', NATIONS_DATA_DIR: directory }), /valid/);
  assert.deepEqual(readdirSync(directory), []);
});
