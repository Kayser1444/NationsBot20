import test from 'node:test';
import assert from 'node:assert/strict';
import { createDisplayNameCache, statusServiceWithNames } from '../status-turns.mjs';
import { handleSubscriptionCommand } from '../discord-commands.mjs';

test('status resolves only subscribed turn players, once each, and tolerates unavailable names', async () => {
  const calls = [], subscriptions = { Kayser: '1', Friend: '2', Unrelated: '3' };
  const service = { getSubscriptions: () => subscriptions, getStatus: () => ({ matchList: [
    { player: 'Friend' }, { player: 'Friend' }, { player: 'friend' }, { player: 'Other' }, { player: 'Kayser' },
  ] }) };
  const enriched = await statusServiceWithNames(service, '1', async id => { calls.push(id); if (id === '1') throw new Error('unavailable'); return 'Friend on Discord'; });
  assert.deepEqual(calls, ['2', '1']);
  assert.deepEqual(enriched.getStatus('Kayser', '1').matchList.map(match => match.discordName), ['Friend on Discord', 'Friend on Discord', null, null, null]);
  delete subscriptions.Friend;
  assert.equal(enriched.getStatus('Kayser', '1').matchList[0].discordName, null);
});

test('display-name cache deduplicates requests, expires, and retains a newer interaction name', async () => {
  let clock = 0, calls = 0, finish;
  const cache = createDisplayNameCache(() => { calls++; return new Promise(resolve => { finish = resolve; }); }, { now: () => clock, ttlMs: 100 });
  const first = cache.resolve('1'), second = cache.resolve('1');
  await Promise.resolve();
  assert.equal(calls, 1);
  cache.remember('1', 'Updated nickname');
  finish('Old nickname');
  assert.equal(await first, 'Updated nickname'); assert.equal(await second, 'Updated nickname');
  assert.equal(await cache.resolve('1'), 'Updated nickname');
  clock = 101;
  const refreshed = cache.resolve('1'); await Promise.resolve(); finish('Latest nickname');
  assert.equal(await refreshed, 'Latest nickname');
  assert.equal(calls, 2);
});
test('status resolves every shared follower and finds the caller within a recipient list', async () => {
  const service = { getSubscriptions: () => ({ Player: ['1', '2'] }), getStatus: name => {
    assert.equal(name, 'Player'); return { matchList: [{ player: 'Player' }] };
  } };
  const calls = [];
  const enriched = await statusServiceWithNames(service, '2', async id => { calls.push(id); return 'User ' + id; });
  assert.deepEqual(calls, ['1', '2']);
  assert.equal(enriched.getStatus('Player', '2').matchList[0].discordName, 'User 1, User 2');
});

test('failed name lookups fall back and back off without preventing status replies', async () => {
  let calls = 0;
  const cache = createDisplayNameCache(async () => { calls++; throw new Error('secret error'); });
  assert.equal(await cache.resolve('1'), null); assert.equal(await cache.resolve('1'), null);
  assert.equal(calls, 1);
});

test('status shows current, unknown and stale turns in both languages with plain subscriber names', () => {
  for (const locale of ['sv-SE', 'en-US']) {
    const content = handleSubscriptionCommand({ command: 'status', userId: '1' }, {
      getLocale: () => locale, getSubscriptions: () => ({ Kayser: '1', Friend: '2' }),
      getStatus: () => ({ matches: 4, discordEnabled: true, matchList: [
        { id: '1', title: 'Live', player: 'Friend', discordName: 'Friendly Discord name (Real name)', connected: true },
        { id: '2', title: 'Not subscribed', player: 'Stranger', discordName: 'Do not display', connected: true },
        { id: '3', title: 'Stale', player: 'Friend', discordName: '<@2> **name**\n@everyone', connected: false },
        { id: '4', title: 'Waiting', player: null, connected: false },
      ] }),
    });
    assert.ok(content.includes('Friend [Friendly Discord name (Real name)]'));
    assert.equal(content.includes('Do not display'), false);
    assert.equal(content.includes('<@'), false);
    assert.equal(content.includes('@everyone'), false);
    assert.match(content, locale === 'sv-SE' ? /Senast kända tur: Friend/ : /Last known turn: Friend/);
    assert.match(content, locale === 'sv-SE' ? /Tur: okänd/ : /Turn: unknown/);
  }
});
