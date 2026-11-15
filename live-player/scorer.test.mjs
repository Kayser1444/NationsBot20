import assert from 'node:assert/strict';
import test from 'node:test';
import defaults from './default-weights.json' with { type: 'json' };
import deployed from './trained-weights.json' with { type: 'json' };
import positions from './fixtures/match-3270-opening.json' with { type: 'json' };
import { rankMoves, selectMove, validateModel, weightsFor } from './scorer.mjs';
import { mostLeast } from './ranking.mjs';

test('deployment selects the approved two-player and multiplayer profiles', () => {
  validateModel(deployed);
  assert.notDeepEqual(deployed.profiles['2'], deployed.profiles['4']);
  assert.deepEqual(weightsFor(deployed, 2), { ...deployed.weights, ...deployed.profiles['2'] });
  for (const count of [3, 4, 5]) {
    assert.deepEqual(deployed.profiles[String(count)], deployed.profiles['4']);
    assert.deepEqual(weightsFor(deployed, count), { ...deployed.weights, ...deployed.profiles['4'] });
  }
});

test('score explanations add to the score and edited weights change decisions', () => {
  const state = positions[20];
  const model = structuredClone(defaults);
  model.profiles['2'] = { books: 20, stone: 0.01, futureProduction: 0.01 };
  assert.equal(selectMove(state, 'NationsBot20'), '3 [Stone]');
  assert.equal(selectMove(state, 'NationsBot20', model), '3 [Books]');
  for (const row of rankMoves(state, 'NationsBot20', model, true)) {
    assert.ok(Math.abs(Object.values(row.contributions).reduce((a, b) => a + b, 0) - row.score) < 1e-10);
  }
  assert.throws(() => validateModel({ ...model, weights: { ...model.weights, stone: NaN } }));
});

test('four-player threats include every rival, including a later dictionary entry', () => {
  const state = structuredClone(positions[15]);
  state.players.Kayser.passed = true;
  state.players.Rival2 = { resources: { '[Gold]': 3, '[Military]': 3 }, production: {}, passed: false };
  state.players.Rival3 = { resources: {}, production: {}, passed: true };
  const row = rankMoves(state, 'NationsBot20', defaults, true).find(row => row.move === 'Buy P32');
  assert.equal(row.features.urgency, 1);
  assert.equal(weightsFor(defaults, 3).stone, defaults.weights.stone);
});

test('five-player most membership excludes a tie across second and third', () => {
  assert.deepEqual(mostLeast([9, 7, 7, 2, 1]), {
    most: [true, false, false, false, false], least: [false, false, false, true, true],
  });
  assert.deepEqual(mostLeast([9, 8, 4, 4, 1]).least, [false, false, true, true, true]);
  assert.deepEqual(mostLeast([9, 9, 4, 2, 1]).most, [true, true, false, false, false]);
  assert.deepEqual(mostLeast([0, 0, 0, 0, 0]), {
    most: [false, false, false, false, false], least: [true, true, true, true, true],
  });
});

test('five-player first-to-pass remains available after one rival has passed', () => {
  const state = structuredClone(positions[45]);
  for (let i = 2; i <= 4; i++) state.players['Rival' + i] = { resources: {}, production: {}, passed: false };
  state.players.Kayser.passed = true;
  const pass = rankMoves(state, 'NationsBot20', defaults, true).find(row => row.move === 'Pass');
  assert.equal(pass.features.earlyPass, 1);
});

test('buying a golden-age point counts one VP and the resource payment', () => {
  const state = structuredClone(positions[20]);
  state.next_move_choice = 'Take which benefit?';
  state.next_move_options = ['Buy 1 [Point]', '2 [Stone]'];
  const point = rankMoves(state, 'NationsBot20', defaults, true).find(row => row.move === 'Buy 1 [Point]');
  assert.equal(point.features.victoryPoints, 1);
  assert.equal(point.features.purchaseCost, -1);
});

test('free architects cannot complete a wonder into occupied natural-wonder spaces', () => {
  const state = structuredClone(positions[20]);
  state.next_move_choice = 'Hire [Architect] for free?';
  state.next_move_options = ['Yes', 'No'];
  Object.assign(state.players.NationsBot20.slots, {
    W1: 'Sbr', W2: 'Sbr2', W3: 'SwOs', W4: 'GrBk', W5: 'CGH',
  });
  assert.equal(selectMove(state, 'NationsBot20'), 'No');
  state.next_move_choice = 'Hire 1 [Architect] for free?';
  assert.equal(selectMove(state, 'NationsBot20'), 'No');
  delete state.players.NationsBot20.slots.W3;
  assert.equal(selectMove(state, 'NationsBot20'), 'Yes');
});
