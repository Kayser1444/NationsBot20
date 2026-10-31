import test from 'node:test';
import assert from 'node:assert/strict';
import { thinkingSummary, playerThinkingSummary } from '../thinking-summary.mjs';

const minute = 60000, hour = 60 * minute, day = 24 * hour;
test('player averages weight full turns across games and count distinct active monitored games from the roster', () => {
  const journal = { tracking: { '1': true }, records: [
    { matchId: '1', player: 'A', durationMs: minute, partial: false, reason: 'move' },
    { matchId: '2', player: 'A', durationMs: 3 * minute, partial: false, reason: 'move' },
    { matchId: '2', player: 'A', durationMs: 5 * minute, partial: false, reason: 'complete' },
    { matchId: '1', player: 'A', durationMs: day, partial: true, reason: 'move' },
    { matchId: '1', player: 'A', durationMs: day, partial: false, reason: 'disconnected' },
    { matchId: '1', player: 'A', durationMs: day, partial: false, reason: 'disabled' },
    { matchId: '1', player: 'A', durationMs: day, reason: 'move' },
    { matchId: '3', player: 'B', durationMs: 0, partial: false, reason: 'move' },
  ], turns: { '1': { player: 'A', trackedAt: 0, partial: false } } };
  const matches = [{ id: '1', players: ['A', 'A', 'C'] }, { id: '1', players: ['A', 'C'] },
    { id: '2', players: ['A', 'B'], over: true }, { id: '3', players: ['A', 'B'], connected: false }, { id: '4' }];
  const before = structuredClone({ journal, matches });
  assert.deepEqual(playerThinkingSummary(journal, matches), [
    { player: 'A', games: 2, turns: 3, averageMs: 3 * minute, average: '3 min' },
    { player: 'B', games: 1, turns: 1, averageMs: 0, average: '0 s' },
    { player: 'C', games: 1, turns: 0, averageMs: null, average: null },
  ]);
  assert.deepEqual({ journal, matches }, before);
});

test('historical players remain visible and averages round only after summing; invalid durations are excluded', () => {
  const record = durationMs => ({ matchId: '9', player: 'A', durationMs, partial: false, reason: 'move' });
  const journal = { records: [record(59500), record(62500), record(-1), record(NaN), record(Infinity), record('60000')] };
  assert.deepEqual(playerThinkingSummary(journal, []), [
    { player: 'A', games: 0, turns: 2, averageMs: 61000, average: '1 min 1 s' },
  ]);
  assert.deepEqual(playerThinkingSummary({ records: [] }, []), []);
  assert.equal(playerThinkingSummary({ records: [record(500)] }, [])[0].average, '<1 s');
});
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
