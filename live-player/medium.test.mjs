import assert from 'node:assert/strict';
import test from 'node:test';
import positions from './fixtures/match-3272-opening.json' with { type: 'json' };
import trained from './trained-weights.json' with { type: 'json' };
import { predictMoves } from './medium.mjs';

const bot = 'NationsBot20';
const predict = state => predictMoves(state, bot, trained, { maxNodes: 3000, timeMs: 5000 });

test('draft alternatives receive equal-depth public-only lookahead', () => {
  const result = predict(positions[2]);
  assert.equal(result.completedDepth,3);
  assert.deepEqual(result.moves.map(row=>row.move).sort(),['Poland','Vikings']);
  assert.ok(result.moves.every(row=>row.searchedDepth===3 && row.plan.length>1));
  // Human preference is measured in compare-nations.mjs. It remains a known
  // disagreement, not a hard-coded nation preference or a claimed fix.
});

test('Medium values the contested Nubia route above private Forge deployment', () => {
  const result = predict(positions[13]);
  const score = move => result.moves.find(row => row.move === move).score;
  assert.ok(score('Deploy to BM3') > score('Deploy to BM2'));
  assert.notEqual(result.moves[0].move, 'Deploy to BM2');
  const restricted = structuredClone(positions[13]);
  restricted.next_move_options = ['Deploy to BM2', 'Deploy to BM3'];
  assert.equal(predict(restricted).moves[0].move, 'Deploy to BM3');
});

test('Medium can fund Food later instead of treating growth Food as compulsory', () => {
  assert.notEqual(predict(positions[6]).moves[0].move, '2 [Food]');
});
