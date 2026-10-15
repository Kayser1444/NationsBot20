import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { startDashboard } from '../dashboard.mjs';
import { validateSubscriptions, saveSubscriptions, readSubscriptions, readPreviousNationsName, readDmPreference, saveDmPreference } from '../subscriptions.mjs';
import { handleSubscriptionCommand } from '../discord-commands.mjs';
import { EventLog } from '../event-log.mjs';
import { request } from 'node:http';

test('local dashboard accepts its own edits and rejects cross-origin or missing-token changes', async t => {
  const subscribers = {};
  const server = await startDashboard({ port: 0, snapshot: () => ({ subscribers }),
    subscribe: async (username, id) => { Object.assign(subscribers, validateSubscriptions({ ...subscribers, [username]: id })); },
    unsubscribe: async username => { delete subscribers[username]; },
  });
  t.after(() => server.close());
  const html = await (await fetch(server.url)).text();
  const token = html.match(/const token='([a-f0-9]+)'/)[1];
  const options = { method: 'POST', headers: { origin: server.url, 'content-type': 'application/json', 'x-nations-token': token }, body: JSON.stringify({ username: 'Kayser', userId: '229311536827465728' }) };
  assert.equal((await fetch(server.url + '/api/subscriptions', { ...options, headers: { ...options.headers, origin: 'https://example.com' } })).status, 403);
  assert.equal((await fetch(server.url + '/api/subscriptions', { ...options, headers: { origin: server.url, 'content-type': 'application/json' } })).status, 403);
  const foreignHostStatus = await new Promise((resolve, reject) => {
    request(server.url + '/api/status', { headers: { host: 'evil.example' } }, response => {
      response.resume(); resolve(response.statusCode);
    }).on('error', reject).end();
  });
  assert.equal(foreignHostStatus, 403);
  assert.equal((await fetch(server.url + '/api/subscriptions', options)).status, 200);
  assert.equal((await (await fetch(server.url + '/api/status')).json()).subscribers.Kayser, '229311536827465728');
  assert.equal((await fetch(server.url + '/api/subscriptions/Kayser', { method: 'DELETE', headers: options.headers })).status, 200);
  assert.deepEqual(subscribers, {});
});

test('subscription saves preserve other configuration and reject invalid/duplicate IDs', t => {
  const dir = mkdtempSync(join(tmpdir(), 'nations-admin-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'friends.json');
  writeFileSync(path, JSON.stringify({ discord: { channelId: 'channel' }, matches: [{ id: '1' }], subscriptions: {} }));
  saveSubscriptions(path, { Kayser: '229311536827465728' });
  assert.equal(readSubscriptions(path).Kayser, '229311536827465728');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(config.matches, [{ id: '1' }]); assert.deepEqual(config.discord, { channelId: 'channel' });
  assert.throws(() => saveSubscriptions(path, { Kayser: 'bad' }));
  assert.throws(() => validateSubscriptions({ Kayser: '229311536827465728', Other: '229311536827465728' }));
  assert.equal(readSubscriptions(path).Kayser, '229311536827465728');
  saveSubscriptions(path, {}); assert.deepEqual(Object.keys(readSubscriptions(path)), []);
});

test('event log rotates and keeps a bounded recent list', t => {
  const dir = mkdtempSync(join(tmpdir(), 'nations-log-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'events.log');
  const log = new EventLog(path, { maxBytes: 100, output: () => {} });
  for (let i = 0; i < 105; i++) log.add('Event ' + i);
  assert.equal(log.entries.length, 100);
  assert.ok(readFileSync(path + '.1', 'utf8').includes('Event'));
  assert.ok(readFileSync(path, 'utf8').includes('Event 104'));
  assert.equal(log.error, null);
});

test('previous name survives off and restart, including subscriptions created before history existed', t => {
  const dir = mkdtempSync(join(tmpdir(), 'nations-history-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'friends.json'), userId = '229311536827465728';
  writeFileSync(path, JSON.stringify({ subscriptions: { DifferentCase: userId } }));
  const reopen = () => ({
    getSubscriptions: () => readSubscriptions(path), getNames: () => [],
    getPreviousName: id => readPreviousNationsName(path, id),
    commit: next => saveSubscriptions(path, next),
  });
  handleSubscriptionCommand({ command: 'notifications', action: 'off', userId }, reopen());
  assert.deepEqual(Object.keys(readSubscriptions(path)), []);
  assert.equal(readPreviousNationsName(path, userId), 'DifferentCase');
  handleSubscriptionCommand({ command: 'notifications', action: 'on', userId, displayName: 'Changed Discord name' }, reopen());
  assert.equal(readSubscriptions(path).DifferentCase, userId);
  saveSubscriptions(path, {});
  handleSubscriptionCommand({ command: 'notifications', action: 'on', userId, nationsName: 'NewName' }, reopen());
  saveSubscriptions(path, {});
  assert.equal(readPreviousNationsName(path, userId), 'NewName');
});
test('DM preferences survive subscription edits and restart without enabling unsubscribed users', t => {
  const dir = mkdtempSync(join(tmpdir(), 'nations-dm-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'friends.json'), userId = '229311536827465728';
  writeFileSync(path, JSON.stringify({ subscriptions: {}, discord: { channelId: 'channel' } }));
  assert.equal(readDmPreference(path, userId), true);
  saveDmPreference(path, userId, true);
  assert.equal(Object.keys(readSubscriptions(path)).length, 0);
  saveSubscriptions(path, { Kayser: userId }); saveSubscriptions(path, {});
  assert.equal(readDmPreference(path, userId), true);
  assert.equal(readPreviousNationsName(path, userId), 'Kayser');
  saveDmPreference(path, userId, false);
  assert.equal(readDmPreference(path, userId), false);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).discord.channelId, 'channel');
  const invalid = JSON.parse(readFileSync(path, 'utf8')); invalid.dmPreferences[userId] = 'true';
  writeFileSync(path, JSON.stringify(invalid));
  assert.throws(() => readDmPreference(path, userId), /Ogiltig sparad DM/);
});

test('thinking measurement routes enforce CSRF and preserve match selection on stop', async t => {
  const selected = new Map();
  const server = await startDashboard({ port: 0, snapshot: () => ({}), setTracking: async (id, enabled) => { selected.set(id, enabled); } });
  t.after(() => server.close());
  const html = await (await fetch(server.url)).text();
  const token = html.match(/const token='([a-f0-9]+)'/)[1];
  const headers = { origin: server.url, 'x-nations-token': token };
  assert.equal((await fetch(server.url + '/api/thinking/123', { method: 'POST' })).status, 403);
  assert.equal((await fetch(server.url + '/api/thinking/bad', { method: 'POST', headers })).status, 400);
  assert.equal((await fetch(server.url + '/api/thinking/123', { method: 'POST', headers })).status, 200);
  assert.equal(selected.get('123'), true);
  assert.equal((await fetch(server.url + '/api/thinking/123', { method: 'DELETE', headers })).status, 200);
  assert.equal(selected.get('123'), false);
});
