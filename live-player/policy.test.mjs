import assert from 'node:assert/strict';
import test from 'node:test';
import opening from './fixtures/match-3270-opening.json' with { type: 'json' };
import { chooseMove } from './policy.mjs';

const pick = state => chooseMove(state, 'NationsBot20', 'Kayser');

test('the colony opening, purchase, and raid remain viable in match 3270', () => {
  assert.equal(pick(opening[11]), 'Deploy to BM3'); // Trireme, opening Nubia
  assert.equal(pick(opening[15]), 'Buy P32'); // Nubia
  assert.equal(pick(opening[19]), 'Buy P22'); // Battle of Thermopylae
});

test('the opening economy prioritizes deployment Stone and staffs the Quarry', () => {
  assert.equal(pick(opening[20]), '3 [Stone]');
  assert.equal(pick(opening[28]), 'Deploy to BM2'); // Quarry, for both Stone and Gold
});

test('Venice declines two Gold when Turmoil would cause a revolt', () => {
  assert.equal(pick(opening[45]), 'Pass');
  const stable = structuredClone(opening[45]);
  stable.players.NationsBot20.resources['[Stability]'] = 2;
  assert.equal(pick(stable), 'Turmoil');
});

test('Venice declines an unneeded military purchase and protects staffed slots', () => {
  assert.equal(pick(opening[51]), 'Pass');
  assert.equal(pick(opening[52]), 'BM4'); // Farm, unstaffed and cheaper to lose than the Quarry
  const empty = structuredClone(opening[52]);
  delete empty.players.NationsBot20.slots.BM2;
  assert.equal(pick(empty), 'BM2');
});
