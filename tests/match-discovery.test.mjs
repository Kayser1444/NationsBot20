import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverMatches, discoverPublicMatches, parseMatchListing, addDiscoveredMatches } from '../match-discovery.mjs';
import { PlayerCache } from '../player-cache.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const card = (id, players, title = 'Summer &amp; winter') => `<div class="card my-2"><div>Title: <span>${title}</span></div><div>Players: ${players.map(name => `<span>${name}</span>`).join(', ')}</div><a href="/nations/${id}/"></a></div>`;
const listing = (archive, cards = []) => `<h1>${archive ? 'Archived Ongoing Nations Matches' : 'Ongoing Nations Matches'}</h1>${cards.join('') || '<ul><li>None.</li></ul>'}`;
const fakePages = (recent, archive) => async url => new Response(url.endsWith('/archive/ongoing/') ? archive : recent);

test('public discovery caches all players, survives restart/failure, and replaces stale names', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'nations-players-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'players.json');
  const cache = new PlayerCache(path);
  const matches = await discoverPublicMatches({ fetcher: fakePages(
    listing(false, [card('1', ['Kayser', 'Unsubscribed'])]),
    listing(true, [card('2', ['Kayser', 'A&amp;B'])]),
  ) });
  cache.update(matches);
  assert.deepEqual(cache.names, ['A&B', 'Kayser', 'Unsubscribed']);
  const loaded = new PlayerCache(path);
  assert.deepEqual(loaded.names, cache.names); assert.ok(loaded.updatedAt);
  await assert.rejects(async () => loaded.update(await discoverPublicMatches({ fetcher: fakePages(listing(false), '<html>Unavailable</html>') })));
  assert.deepEqual(loaded.names, cache.names);
  loaded.update([{ players: ['Kayser'] }]);
  assert.deepEqual(new PlayerCache(path).names, ['Kayser']);
  loaded.update([]); assert.deepEqual(new PlayerCache(path).names, []);
});

test('both lists, exact usernames, decoded entities and shared-game deduplication', async () => {
  const result = await discoverMatches(['Kayser', 'Suddoman'], { fetcher: fakePages(
    listing(false, [card('9', ['Ka&#x79;ser', 'Suddoman']), card('10', ['Kayser2', 'Other'])]),
    listing(true, [card('9', ['Kayser', 'Suddoman']), card('2', ['Suddoman', 'Other'])]),
  ) });
  assert.deepEqual(result.map(m => m.id), ['2', '9']);
  assert.equal(result[1].title, 'Summer & winter');
});

test('no relevant games and empty lists are valid', async () => {
  assert.deepEqual(await discoverMatches(['Kayser'], { fetcher: fakePages(listing(false, [card('1', ['Other'])]), listing(true)) }), []);
  assert.deepEqual(parseMatchListing(listing(false), 'Ongoing Nations Matches'), []);
});

test('unexpected pages and broken cards fail safely', () => {
  assert.throws(() => parseMatchListing('<html>Sign in</html>', 'Ongoing Nations Matches'));
  assert.throws(() => parseMatchListing('<h1>Ongoing Nations Matches</h1>', 'Ongoing Nations Matches'));
  assert.throws(() => parseMatchListing(listing(false, [card('1', [])]), 'Ongoing Nations Matches'));
});

test('a partial listing failure preserves observers without adding partial results', async () => {
  const existing = [{ id: '9', state: { player: 'Kayser' } }];
  const fetcher = async url => url.endsWith('/archive/ongoing/') ? new Response('Unavailable', { status: 503 }) : new Response(listing(false, [card('2', ['Kayser'])]));
  await assert.rejects(async () => addDiscoveredMatches(existing, await discoverMatches(['Kayser'], { fetcher })), /503/);
  assert.deepEqual(existing, [{ id: '9', state: { player: 'Kayser' } }]);
});

test('refreshing adds once, preserves socket and turn state, and retains missing games', () => {
  const state = { player: 'Kayser', move: 23 }, socket = {};
  const original = { id: '9', state, socket, title: 'Old' };
  const existing = [original];
  const discovered = [{ id: '9', title: 'New', players: ['Kayser'] }, { id: '10', title: 'New game', players: ['Kayser'] }];
  assert.equal(addDiscoveredMatches(existing, discovered).length, 1);
  assert.deepEqual(addDiscoveredMatches(existing, discovered), []);
  assert.strictEqual(existing[0], original);
  assert.strictEqual(original.state, state);
  assert.strictEqual(original.socket, socket);
  assert.equal(original.title, 'New');
  addDiscoveredMatches(existing, []);
  assert.equal(existing.length, 2);
});
