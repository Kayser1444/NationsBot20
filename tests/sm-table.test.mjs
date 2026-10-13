import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SmTableCache, validateSeason } from '../sm-table.mjs';
const config = JSON.parse(readFileSync(new URL('../sm-season.json', import.meta.url), 'utf8'));
const fixture = { season: 11, divisions: { '1A': { players: ['A', 'B', 'C', 'D'], matches: [{ id: '1', title: 'S11-1A-P1', players: ['A', 'B', 'C', 'D'] }] } } };
const message = (over = false) => ({ replaying: false, state: { game_over: over, player_order: ['B', 'A', 'C', 'D'], players: {
  A: { score: 10, resource_remainder: 7 }, B: { score: 10, resource_remainder: 7 }, C: { score: 10, resource_remainder: 6 }, D: { score: 9, resource_remainder: 9 },
} } });
test('season lock contains exactly 21 unique verified matches; spoofed 2B candidates are excluded', () => {
  validateSeason(config);
  const cache = new SmTableCache(config);
  assert.equal(cache.matches.length, 21);
  assert.equal(cache.has('3030'), false); assert.equal(cache.has('3033'), false);
  const bad = structuredClone(config); bad.divisions['2B'].matches[0].id = config.divisions['1A'].matches[0].id;
  assert.throws(() => validateSeason(bad));
});
test('VP, resource remainder and current turn order award 5/3/2/1; unknown IDs and wrong participants cannot enter cache', () => {
  const cache = new SmTableCache(fixture);
  assert.equal(cache.update('99', message()), false);
  assert.match(cache.reply('1A'), /väntar/);
  cache.update('1', message());
  assert.deepEqual(cache.tables.get('1A').map(r => [r.name, r.points]), [['B', 5], ['A', 3], ['C', 2], ['D', 1]]);
  const bad = message(); bad.state.player_order = ['A', 'A', 'C', 'D'];
  assert.equal(cache.update('1', bad), false);
  assert.match(cache.reply('1A'), /saknar aktuell/);
  assert.equal(cache.update('1', { ...message(), replaying: true }), false);
});
test('auto division requires active subscription; cached data is stale after disconnect or age', () => {
  let now = 100000;
  const cache = new SmTableCache(fixture, { now: () => now });
  cache.update('1', message());
  assert.match(cache.reply(null, 'user', { A: 'user' }), /Division 1A/);
  assert.match(cache.reply(null, 'user', {}), /aktiv prenumeration/);
  assert.match(cache.reply(null, 'user', { Outsider: 'user' }), /inte i SM/);
  assert.doesNotMatch(cache.reply('1A'), /saknar aktuell/);
  now += 60001; assert.match(cache.reply('1A'), /saknar aktuell/);
  cache.update('1', message(true)); cache.connection('1', false);
  assert.doesNotMatch(cache.reply('1A'), /saknar aktuell/);
});
test('drafting snapshots are valid but do not award points before play starts', () => {
  const cache = new SmTableCache(fixture);
  const draft = message(); draft.state.round = 0; draft.state.phase = 'Drafting Phase';
  draft.state.players.A = { nation: null };
  assert.equal(cache.update('1', draft), true);
  assert.ok(cache.tables.get('1A').every(r => r.points === 0));
  assert.match(cache.reply('1A'), /Väntar på spelstart/);
  cache.update('1', message());
  assert.equal(cache.tables.get('1A')[0].points, 5);
  assert.doesNotMatch(cache.reply('1A'), /Väntar på spelstart/);
});
test('saved snapshots survive restart but ongoing games wait for fresh connection; season changes invalidate disk cache', t => {
  const dir = mkdtempSync(join(tmpdir(), 'sm-cache-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'cache.json');
  new SmTableCache(fixture, { path }).update('1', message());
  assert.match(new SmTableCache(fixture, { path }).reply('1A'), /saknar aktuell/);
  const changed = structuredClone(fixture); changed.divisions['1A'].matches[0].id = '2';
  assert.match(new SmTableCache(changed, { path }).reply('1A'), /väntar/);
});
test('verified 1A snapshot sorts Kayser above goonzo by head-to-head, LindenR above Dread by wins', () => {
  const data = JSON.parse(readFileSync(new URL('./fixtures/sm-1a-snapshot.json', import.meta.url), 'utf8'));
  const cache = new SmTableCache(config);
  for (const { value: m } of data.results) cache.update(m.id, { replaying: false, state: { game_over: m.over, player_order: m.playerOrder,
    players: Object.fromEntries(m.players.map(p => [p.name, { score: p.score, resource_remainder: p.remainder }])) } });
  const rows = cache.tables.get('1A');
  assert.deepEqual(rows.map(r => [r.name, r.points]), [['Kayser', 14], ['goonzo', 14], ['Tankare', 13], ['LindenR', 11], ['Dread', 11], ['gostubben', 9], ['Anderberg', 5]]);
  assert.equal(rows[0].tiebreak, 'Inbördes p: 8'); assert.equal(rows[1].tiebreak, 'Inbördes p: 6');
  assert.equal(rows[3].tiebreak, 'Vinster: 1');
  assert.ok(cache.reply('1A').length < 2000);
});

test('heartbeat-only replies keep a quiet game current without changing its last score update', () => {
  let now = 100000;
  const cache = new SmTableCache(fixture, { now: () => now });
  cache.update('1', message());
  const snapshotTime = cache.snapshots.get('1').updatedAt;
  for (let i = 0; i < 5; i++) { now += 20000; cache.update('1', { turns: 0 }); }
  assert.doesNotMatch(cache.reply('1A'), /saknar aktuell/);
  assert.equal(cache.snapshots.get('1').updatedAt, snapshotTime);
  cache.connection('1', false);
  cache.update('1', { turns: 0 });
  assert.match(cache.reply('1A'), /saknar aktuell/);
  cache.update('1', message());
  now += 60001;
  cache.update('1', { chat_log: [] });
  assert.match(cache.reply('1A'), /saknar aktuell/);
});

test('automatic division includes subscription explanation while explicit selection does not', () => {
  const cache = new SmTableCache(fixture); cache.update('1', message());
  assert.match(cache.reply(null, 'user', { A: 'user' }), /Division 1A \(Automatiskt vald utifrån din prenumeration\)/);
  assert.doesNotMatch(cache.reply('1A', 'user', { A: 'user' }), /Automatiskt vald/);
});
