import test from 'node:test';
import assert from 'node:assert/strict';
import { thinkingSummary } from '../thinking-summary.mjs';

const minute = 60000, hour = 60 * minute, day = 24 * hour;
test('thinking totals combine moves per player and game before rounding, sort longest first and include the current turn', () => {
  const now = 100 * day;
  const journal = { tracking: { '1': true, '3': true }, records: [
    { matchId: '1', player: 'A', durationMs: day + 2 * hour, partial: true },
    { matchId: '1', player: 'A', durationMs: 45000 },
    { matchId: '1', player: 'A', durationMs: 45000 },
    { matchId: '1', player: 'B', durationMs: 2 * day },
    { matchId: '2', player: 'A', durationMs: 35 * day + 5 * hour + 17 * minute },
  ], turns: { '1': { player: 'A', trackedAt: now - 3 * hour - 5 * minute, partial: false }, '2': { over: true } } };
  const original = structuredClone(journal);
  const games = thinkingSummary(journal, now);
  assert.deepEqual(games.find(g => g.matchId === '1').players, [
    { player: 'B', minutes: 2880, duration: '2 d 0 h 0 min', partial: false, ongoing: false },
    { player: 'A', minutes: 1746, duration: '1 d 5 h 6 min', partial: true, ongoing: true },
  ]);
  const finished = games.find(g => g.matchId === '2');
  assert.equal(finished.over, true); assert.equal(finished.tracking, false);
  assert.equal(finished.players[0].duration, '35 d 5 h 17 min');
  assert.deepEqual(games.find(g => g.matchId === '3').players, []);
  assert.deepEqual(journal, original, 'rendering must not change persisted timing records');
});

test('stopped, disconnected and completed turns cannot accrue time; saved totals remain available', () => {
  for (const [tracking, turn] of [[false, {}], [true, { suspended: true }], [true, { over: true }]]) {
    const journal = { tracking: tracking ? { '1': true } : {}, records: [{ matchId: '1', player: 'A', durationMs: hour + 2 * minute, partial: true }],
      turns: { '1': { player: 'A', trackedAt: 0, ...turn } } };
    const first = thinkingSummary(journal, day);
    assert.deepEqual(thinkingSummary(journal, 60 * day), first);
    assert.equal(first[0].players[0].duration, '1 h 2 min');
    assert.equal(first[0].players[0].ongoing, false);
    assert.equal(first[0].players[0].partial, true);
  }
});

test('sub-minute and backwards-clock durations display whole nonnegative minutes', () => {
  const journal = { tracking: { '1': true }, records: [{ matchId: '1', player: 'B', durationMs: 59000 }], turns: { '1': { player: 'A', trackedAt: minute } } };
  assert.deepEqual(thinkingSummary(journal, 0)[0].players.map(p => [p.player, p.minutes, p.duration]), [['A', 0, '0 min'], ['B', 0, '0 min']]);
});
