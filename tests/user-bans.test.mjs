import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSubscriptions, saveSubscriptions, setUserBan, isUserBanned, readBannedUsers, readPreviousNationsName, addSubscriber } from '../subscriptions.mjs';
import { handleSubscriptionCommand } from '../discord-commands.mjs';
import { startDashboard } from '../dashboard.mjs';

const offender = '821001820309815368', rightful = '229311536827465728';
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'nations-bans-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'friends.json');
  writeFileSync(path, JSON.stringify({ subscriptions: { Kayser: offender }, matches: [], dmPreferences: { [offender]: true } }));
  return path;
}
test('ban atomically releases name, survives restart, rejects claims, and unban never restores stolen name', t => {
  const path = fixture(t);
  setUserBan(path, offender, true);
  assert.equal(isUserBanned(path, offender), true);
  assert.deepEqual(Object.keys(readSubscriptions(path)), []);
  assert.equal(readPreviousNationsName(path, offender), null);
  assert.equal(readBannedUsers(path)[offender].nationsName, 'Kayser');
  assert.throws(() => saveSubscriptions(path, { AnotherName: offender }), /spärrad/);
  saveSubscriptions(path, { Kayser: rightful });
  setUserBan(path, offender, false);
  assert.equal(isUserBanned(path, offender), false);
  assert.equal(readSubscriptions(path).Kayser, rightful);
  assert.equal(readPreviousNationsName(path, offender), null);
  assert.equal(JSON.parse(readFileSync(path)).dmPreferences[offender], true);
  saveSubscriptions(path, { Kayser: rightful, Suddoman: offender });
  assert.equal(readSubscriptions(path).Suddoman, offender);
});
test('unsubscribed users can be banned, repeated bans preserve timestamp, malformed storage fails closed', t => {
  const path = fixture(t);
  setUserBan(path, rightful, true);
  const original = readBannedUsers(path)[rightful];
  setUserBan(path, rightful, true); assert.deepEqual(readBannedUsers(path)[rightful], original);
  assert.equal(original.nationsName, null);
  assert.throws(() => setUserBan(path, 'bad', true));
  const config = JSON.parse(readFileSync(path)); config.bannedUsers = { [offender]: true };
  writeFileSync(path, JSON.stringify(config));
  assert.throws(() => readSubscriptions(path), /spärrlista/);
  assert.throws(() => saveSubscriptions(path, {}), /spärrlista/);
});
test('blocking one shared subscriber preserves every other follower and remembered name', t => {
  const path = fixture(t);
  saveSubscriptions(path, addSubscriber(readSubscriptions(path), 'Kayser', rightful));
  assert.deepEqual(readSubscriptions(path).Kayser, [offender, rightful]);
  setUserBan(path, offender, true);
  assert.equal(readSubscriptions(path).Kayser, rightful);
  assert.equal(readPreviousNationsName(path, rightful), 'Kayser');
  setUserBan(path, offender, false);
  assert.equal(readSubscriptions(path).Kayser, rightful);
});
test('all commands deny banned users without reading subscriptions or changing preferences', () => {
  for (const locale of ['sv-SE', 'en-US']) for (const command of ['notifications', 'dm', 'language', 'status', 'help']) {
    const deny = () => assert.fail('banned user must not access or mutate the service');
    const result = handleSubscriptionCommand({ command, action: 'on', userId: offender, nationsName: 'Other', locale: 'en-US' }, {
      isBanned: () => true, getLocale: () => locale, getSubscriptions: deny, getNames: deny, commit: deny, getStatus: deny, setLanguage: deny, setDm: deny,
    });
    assert.match(result, locale === 'sv-SE' ? /spärrad/ : /blocked/);
  }
});
test('ban routes require CSRF and validate IDs for both ban and unban', async t => {
  const changes = [];
  const dashboard = await startDashboard({ port: 0, snapshot: () => ({}), setBan: async (...args) => changes.push(args) });
  t.after(() => dashboard.close());
  const html = await (await fetch(dashboard.url)).text(), token = html.match(/const token='([a-f0-9]+)'/)[1];
  const headers = { origin: dashboard.url, 'x-nations-token': token };
  for (const method of ['POST', 'DELETE']) {
    assert.equal((await fetch(dashboard.url + '/api/bans/' + offender, { method })).status, 403);
    assert.equal((await fetch(dashboard.url + '/api/bans/' + offender, { method, headers: { ...headers, origin: 'https://evil.test' } })).status, 403);
    assert.equal((await fetch(dashboard.url + '/api/bans/bad', { method, headers })).status, 400);
    assert.equal((await fetch(dashboard.url + '/api/bans/' + offender, { method, headers })).status, 200);
  }
  assert.deepEqual(changes, [[offender, true], [offender, false]]);
});
