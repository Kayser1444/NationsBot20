import test from 'node:test';
import assert from 'node:assert/strict';
import { adminUsers, adminSubscribers } from '../admin-users.mjs';

test('subscriber list includes reminder-only users, labels both modes and counts shared games once per person', () => {
  const config = { reminderPreferences: {
    a: { enabled: true, name: 'Other' }, b: { enabled: true, name: 'Player' },
    c: { enabled: false, name: 'Player' }, d: { enabled: true, name: 'Player' },
  }, bannedUsers: { d: {} }, lastNationsNames: { e: 'Old' } };
  const games = [{ id: '1', players: ['Player', 'Other'] }, { id: '2', players: ['Other'] }, { id: '3', players: ['Player'], finished: true }];
  const result = adminSubscribers(config, { Player: ['a', 'c'] }, games);
  assert.equal(result.length, 3);
  assert.deepEqual(result.find(user => user.userId === 'a'), { userId: 'a', username: 'Player', notifications: true, reminders: true, reminderName: 'Other', matches: 2 });
  assert.equal(result.find(user => user.userId === 'b').notifications, false);
  assert.equal(result.find(user => user.userId === 'b').username, 'Player');
  assert.equal(result.find(user => user.userId === 'c').reminders, false);
});

test('admin user status isolates shared subscribers, preferences, current games and delivery failures', () => {
  const config = { discord: { token: 'do-not-expose' }, lastNationsNames: { a: 'Player', b: 'Player', c: 'Old' },
    dmPreferences: { a: true }, userLocales: { a: 'sv-SE', b: 'en-GB' }, languagePreferences: { b: 'sv-SE' },
    bannedUsers: { c: { bannedAt: '2026-10-13T00:00:00Z' } } };
  const matches = [{ id: '1', title: 'Current', players: ['Player'], state: { player: 'Opponent' }, status: 'connected' },
    { id: '2', players: ['Player'], finished: true }, { id: '3', players: ['Other'] }];
  const users = adminUsers(config, { Player: ['a', 'b'] }, matches, [{ userId: 'a', matchId: '1', attempts: 3, blocked: true, nextAt: 123 }]);
  const [a, b, c] = users;
  assert.equal(a.dm, true); assert.equal(b.dm, true);
  assert.equal(a.language, 'sv-SE'); assert.equal(a.languageOverride, null);
  assert.equal(b.language, 'sv-SE'); assert.equal(b.languageOverride, 'sv-SE'); assert.equal(b.discordLocale, 'en-GB');
  assert.equal(a.matches.length, 1); assert.equal(a.matches[0].player, 'Opponent');
  assert.equal(a.pending[0].blocked, true); assert.equal(a.pending[0].attempts, 3);
  assert.equal(b.pending.length, 0);
  assert.equal(c.banned, true); assert.equal(c.username, null); assert.equal(c.previousName, 'Old');
  assert.equal(c.matches.length, 0); assert.equal(c.language, 'en-US');
  assert.equal(JSON.stringify(users).includes('do-not-expose'), false);
});

test('admin status follows preference changes and supplies defaults without altering configuration', () => {
  const config = { subscriptions: { Player: 'a' } };
  const original = JSON.stringify(config);
  const first = adminUsers(config, config.subscriptions, []);
  assert.equal(first[0].discordLocale, null); assert.equal(first[0].language, 'en-US');
  assert.equal(first[0].dm, true); assert.deepEqual(first[0].pending, []);
  assert.equal(JSON.stringify(config), original);
  config.dmPreferences = { a: true }; config.languagePreferences = { a: 'sv-SE' };
  const next = adminUsers(config, config.subscriptions, []);
  assert.equal(next[0].dm, true); assert.equal(next[0].language, 'sv-SE');
});
