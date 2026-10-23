import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SmTableCache, validateSeason } from '../sm-table.mjs';
import { translations } from '../language.mjs';
const config = JSON.parse(readFileSync(new URL('../sm-season.json', import.meta.url), 'utf8'));
const fixture = { season: 11, divisions: { '1A': { players: ['A', 'B', 'C', 'D'], matches: [{ id: '1', title: 'S11-1A-P1', players: ['A', 'B', 'C', 'D'] }] } } };
const message = (over = false) => ({ replaying: false, state: { game_over: over, player_order: ['B', 'A', 'C', 'D'], players: {
  A: { score: 10, resource_remainder: 7 }, B: { score: 10, resource_remainder: 7 }, C: { score: 10, resource_remainder: 6 }, D: { score: 9, resource_remainder: 9 },
} } });
for (const disconnected of [false, true]) test(`SM warning waits more than five minutes after last contact (${disconnected ? 'disconnected' : 'connected'})`, () => {
  let now = 100000;
  const cache = new SmTableCache(fixture, { now: () => now });
  cache.update('1', message());
  now += 60001;
  assert.doesNotMatch(cache.reply('1A'), /⚠️/);
  cache.update('1', { turns: 0 });
  if (disconnected) cache.connection('1', false);
  assert.doesNotMatch(cache.reply('1A'), /⚠️/);
  now += 300000;
  assert.doesNotMatch(cache.reply('1A'), /⚠️/, 'exactly five minutes is still current');
  now += 1;
  assert.match(cache.reply('1A'), /⚠️/);
  cache.connection('1', true);
  assert.match(cache.reply('1A'), /⚠️/, 'opening a connection alone does not confirm standings');
  cache.update('1', { turns: 0 });
  assert.doesNotMatch(cache.reply('1A'), /⚠️/);
});
test('season lock contains exactly 21 unique verified matches; spoofed 2B candidates are excluded', () => {
  validateSeason(config);
  const cache = new SmTableCache(config);
  assert.equal(cache.matches.length, 21);
  assert.equal(cache.has('3030'), false); assert.equal(cache.has('3033'), false);
  const bad = structuredClone(config); bad.divisions['2B'].matches[0].id = config.divisions['1A'].matches[0].id;
  assert.throws(() => validateSeason(bad));
});

test('season 11 gives every player four games and every pair two meetings', () => {
  for (const [division, group] of Object.entries(config.divisions)) {
    assert.equal(group.matches.length, 7, division);
    for (const [index, name] of group.players.entries()) {
      assert.equal(group.matches.filter(match => match.players.includes(name)).length, 4, division + ': ' + name);
      for (const opponent of group.players.slice(index + 1)) {
        assert.equal(group.matches.filter(match => match.players.includes(name) && match.players.includes(opponent)).length, 2, division + ': ' + name + ' / ' + opponent);
      }
    }
  }
});

test('2B P5 accepts the restarted game and excludes the abandoned duplicate of P1', () => {
  const cache = new SmTableCache(config);
  const names = ['Whippis', 'Ergus8', 'swedviking', 'Suddoman'];
  const snapshot = { replaying: false, state: { game_over: false, round: 1, phase: 'Action Phase', player_order: names,
    players: Object.fromEntries(names.map(name => [name, { score: 10, resource_remainder: 0 }])) } };
  assert.equal(cache.has('3062'), false);
  assert.equal(cache.update('3062', snapshot), false);
  assert.equal(cache.update('3101', snapshot), true);
});

test('VP, resource remainder and current turn order award 5/3/2/1; unknown IDs and wrong participants cannot enter cache', () => {
  const cache = new SmTableCache(fixture);
  assert.equal(cache.update('99', message()), false);
  assert.match(cache.reply('1A'), /väntar/);
  cache.update('1', message());
  assert.deepEqual(cache.tables.get('1A').map(r => [r.name, r.points]), [['B', 5], ['A', 3], ['C', 2], ['D', 1]]);
  const bad = message(); bad.state.player_order = ['A', 'A', 'C', 'D'];
  assert.equal(cache.update('1', bad), false);
  assert.doesNotMatch(cache.reply('1A'), /⚠️/);
  assert.equal(cache.update('1', { ...message(), replaying: true }), false);
});
test('auto division requires active subscription; ongoing data expires after five minutes; final results stay current', () => {
  let now = 100000;
  const cache = new SmTableCache(fixture, { now: () => now });
  cache.update('1', message());
  assert.match(cache.reply(null, 'user', { A: 'user' }), /Division 1A/);
  assert.match(cache.reply(null, 'user', {}), /aktiv prenumeration/);
  assert.match(cache.reply(null, 'user', { Outsider: 'user' }), /inte i SM/);
  assert.doesNotMatch(cache.reply('1A'), /⚠️/);
  now += 300001; assert.match(cache.reply('1A'), /⚠️/);
  cache.update('1', message(true)); cache.connection('1', false);
  now += 300001;
  assert.doesNotMatch(cache.reply('1A'), /⚠️/);
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
test('saved snapshots retain the five-minute grace period after restart; season changes invalidate disk cache', t => {
  const dir = mkdtempSync(join(tmpdir(), 'sm-cache-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'cache.json');
  let now = 100000;
  new SmTableCache(fixture, { path, now: () => now }).update('1', message());
  now += 300000;
  const restarted = new SmTableCache(fixture, { path, now: () => now });
  assert.doesNotMatch(restarted.reply('1A'), /⚠️/);
  now += 1;
  assert.match(restarted.reply('1A'), /⚠️/);
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
  assert.doesNotMatch(cache.reply('1A'), /⚠️/);
  assert.equal(cache.snapshots.get('1').updatedAt, snapshotTime);
  cache.connection('1', false);
  now += 300001;
  cache.update('1', { turns: 0 });
  assert.match(cache.reply('1A'), /⚠️/);
  cache.update('1', message());
  assert.doesNotMatch(cache.reply('1A'), /⚠️/);
  now += 300001;
  cache.update('1', { chat_log: [] });
  assert.match(cache.reply('1A'), /⚠️/);
});

test('automatic division includes subscription explanation while explicit selection does not', () => {
  const cache = new SmTableCache(fixture); cache.update('1', message());
  assert.match(cache.reply(null, 'user', { A: 'user' }), /Division 1A \(Automatiskt vald utifrån din prenumeration\)/);
  assert.doesNotMatch(cache.reply('1A', 'user', { A: 'user' }), /Automatiskt vald/);
});

test('game status shows linked IDs, missing data, rounds, drafting, completion and stale snapshots', () => {
  let now = 100000;
  const cache = new SmTableCache(fixture, { now: () => now });
  assert.match(cache.reply('1A'), /> \[P1 · ID 1\]\(<https:\/\/games.tabony.net\/nations\/1\/>\) — Väntar på speldata/);
  const live = message(); live.state.round = 3; live.state.phase = 'Action Phase';
  cache.update('1', live);
  assert.match(cache.reply('1A'), /— Runda 3\/8/);
  cache.connection('1', false);
  now += 300000;
  assert.doesNotMatch(cache.reply('1A'), /Äldre speldata/);
  now++;
  assert.match(cache.reply('1A'), /Runda 3\/8 · ⚠️ Äldre speldata/);
  const done = structuredClone(live); done.state.game_over = true;
  cache.update('1', done); now += 300001;
  assert.match(cache.reply('1A'), /— Avslutat/);
  assert.doesNotMatch(cache.reply('1A'), /Äldre speldata/);
  const draft = structuredClone(live); draft.state.round = 0; draft.state.phase = 'Drafting Phase';
  cache.update('1', draft);
  assert.match(cache.reply('1A'), /— Draft pågår/);
  delete live.state.round;
  cache.update('1', live);
  assert.match(cache.reply('1A'), /— Pågår/);
  assert.doesNotMatch(cache.reply('1A'), /Runda undefined/);
});

test('saved game progress survives cache reload for the status box', t => {
  const dir = mkdtempSync(join(tmpdir(), 'sm-progress-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'cache.json');
  const cache = new SmTableCache(fixture, { path });
  const live = message(); live.state.round = 6; live.state.phase = 'Action Phase';
  cache.update('1', live);
  assert.match(new SmTableCache(fixture, { path }).reply('1A', null, {}, 'en-US'), /Round 6\/8/);
});

test('seven linked game statuses fit Discord replies for every division and language', () => {
  for (const language of Object.keys(translations)) for (const [division, group] of Object.entries(config.divisions)) {
    for (const status of ['missing', 'ongoing', 'draft', 'finished', 'stale']) {
      let now = 100000;
      const cache = new SmTableCache(config, { now: () => now });
      if (status !== 'missing') for (const match of group.matches) cache.update(match.id, { replaying: false, state: {
        game_over: status === 'finished', round: status === 'draft' ? 0 : 8, phase: status === 'draft' ? 'Drafting Phase' : 'Action Phase',
        player_order: match.players, players: Object.fromEntries(match.players.map(name => [name, { score: 10, resource_remainder: 0 }])) } });
      if (status === 'stale') now += 300001;
      const reply = cache.reply(null, 'u', { [group.players[0]]: 'u' }, language);
      assert.equal((reply.match(/https:\/\/games.tabony.net\/nations\//g) ?? []).length, 7);
      assert.ok(reply.length <= 2000, `${division} ${language} ${status}: ${reply.length}`);
      assert.doesNotMatch(reply, /undefined|\{round\}/);
    }
  }
});

test('English SM rendering covers titles, auto selection, tiebreakers, unavailable games and stale connections without changing rankings', () => {
  let now = 100000;
  const cache = new SmTableCache(config, { now: () => now });
  assert.match(cache.reply(null, 'u', {}, 'en-US'), /active subscription/);
  assert.match(cache.reply(null, 'u', { Outside: 'u' }, 'en-US'), /not in SM/);
  assert.match(cache.reply('9Z', 'u', {}, 'en-US'), /Unknown SM group/);
  assert.match(cache.reply('1A', 'u', {}, 'en-US'), /waiting for 7 of 7 games/);
  const data = JSON.parse(readFileSync(new URL('./fixtures/sm-1a-snapshot.json', import.meta.url), 'utf8'));
  for (const { value: m } of data.results) cache.update(m.id, { replaying: false, state: { game_over: m.over, player_order: m.playerOrder,
    players: Object.fromEntries(m.players.map(p => [p.name, { score: p.score, resource_remainder: p.remainder }])) } });
  const ranking = cache.tables.get('1A').map(r => [r.name, r.points]);
  const english = cache.reply(null, 'u', { Kayser: 'u' }, 'en-US');
  assert.match(english, /Swedish Championship/); assert.match(english, /Automatically selected from your subscription/);
  assert.match(english, /H2H points: 8/); assert.match(english, /Wins: 1/); assert.match(english, /Tiebreaker/);
  assert.doesNotMatch(english, /Svenska|Inbördes|Vinster|Skiljekriterium|Bevakning kontrollerad/);
  assert.ok(english.length < 2000); assert.match(english, /─/);
  assert.match(cache.reply('1A', 'u', {}, 'sv-SE'), /Svenska mästerskapet/);
  assert.deepEqual(cache.tables.get('1A').map(r => [r.name, r.points]), ranking);
  cache.connection('3032', false);
  now += 300001;
  assert.match(cache.reply('1A', 'u', {}, 'en-US'), /Last known standings/);
  const draftCache = new SmTableCache(fixture);
  const draft = message(); draft.state.round = 0; draft.state.phase = 'Drafting Phase'; draftCache.update('1', draft);
  assert.match(draftCache.reply('1A', 'u', {}, 'en-US'), /Waiting for play to start/);
  assert.match(draftCache.reply('1A', 'u', {}, 'en-US'), /Tied/);
});
