import test from 'node:test';
import assert from 'node:assert/strict';
import { startDashboard } from '../dashboard.mjs';
import { TurnJournal } from '../turn-journal.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('thinking API averages journal-completed turns, excludes interrupted turns and counts whole rosters', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'thinking-dashboard-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let clock = 0;
  const journal = new TurnJournal(join(dir, 'journal.json'), () => clock);
  journal.track('1', true);
  journal.observe('1', { player: 'A', move: 1, over: false });
  clock += 1000; journal.observe('1', { player: 'A', move: 2, over: false }); // initial partial
  clock += 61000; journal.observe('1', { player: 'A', move: 3, over: false }); // full
  clock += 62000; journal.suspend('1', clock); // interrupted
  clock += 100000; journal.observe('1', { player: 'B', move: 4, over: false });
  clock += 3000; journal.observe('1', { player: 'A', move: 5, over: false }); // partial after reconnect
  clock += 63000; journal.track('1', false); // interrupted by disabling
  const dashboard = await startDashboard({ port: 0, snapshot: () => ({ matches: [
    { id: '1', players: ['A', 'B'], over: false }, { id: '2', players: ['A', 'C'], over: true },
  ] }), thinkingSnapshot: () => journal.data });
  t.after(() => dashboard.close());
  const response = await fetch(dashboard.url + '/api/thinking');
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result.players, [
    { player: 'A', games: 1, turns: 1, averageMs: 61000, average: '1 min 1 s' },
    { player: 'B', games: 1, turns: 0, averageMs: null, average: null },
  ]);
  assert.equal(result.games[0].tracking, false, 'existing per-game totals still available');
  assert.equal(result.games[0].players[0].partial, true);
});
