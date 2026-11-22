import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { PublicRoundSession, readPublicHistory } from './public-round.mjs';

const snapshot = number => ({
  state: { move_number: number, round: 2, round_starts: { 2: 10 }, phase: 'Action Phase',
    next_move_choice: 'Which action?', next_move_options: ['Buy', 'Pass'], growth_allowances: { A: 2, B: 2 } },
  log: 'Beginning of Round 2A!\n' + 'An action.\n'.repeat(number - 10),
});

test('public replay waits for the initial live position and restores contiguous positions', async () => {
  class Socket extends EventEmitter {
    constructor() { super(); queueMicrotask(() => this.emit('open')); }
    send(payload) {
      const request = JSON.parse(payload);
      if (!request) {
        this.emit('message', JSON.stringify({ visitor: 'connected' }));
        this.emit('message', JSON.stringify({ ...snapshot(12), move_number: 12, replaying: false }));
        return;
      }
      const position = request.replay.to;
      this.emit('message', JSON.stringify({ ...snapshot(position), move_number: 12, replay_position: position, replaying: true }));
    }
    terminate() { this.emit('close'); }
  }
  assert.deepEqual(await readPublicHistory('3310', 10, 12, { Socket }), [snapshot(10), snapshot(11)]);
  await assert.rejects(readPublicHistory('3310', 10, 13, { Socket }), /Match changed/);
});

test('cold reconnect and continuous observation supply the same state and history to the scorer', async () => {
  const warm = new PublicRoundSession(), cold = new PublicRoundSession(), incomplete = new PublicRoundSession();
  const root = snapshot(12);
  warm.observe(snapshot(10));
  warm.observe(snapshot(11));
  for (const session of [warm, cold, incomplete]) session.observe(root);
  const score = request => request;
  const recover = async () => [snapshot(10), snapshot(11)];
  assert.deepEqual(await cold.decide('3310', root.state, {}, { recover, score }),
    await warm.decide('3310', root.state, {}, { recover: () => assert.fail('Already observed'), score }));
  assert.equal((await incomplete.decide('3310', root.state, {},
    { recover: async () => [snapshot(11)], score: () => assert.fail('Unverified continuity') })).compared, false);
});
