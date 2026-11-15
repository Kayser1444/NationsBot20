import assert from 'node:assert/strict';
import test from 'node:test';
import positions from './fixtures/match-3272-opening.json' with { type: 'json' };
import { militaryPlans, colonyRaces, readPositionPlans, growthFoodCoverage } from './position-reader.mjs';

const bot = 'NationsBot20';

test('the visible draft exposes Vikings colony access in two actions versus Poland in three', () => {
  const reading = readPositionPlans(positions[2], bot);
  const first = name => reading.draft.find(n => n.nation === name).colonies[0].routes[bot].plan;
  assert.deepEqual(first('Vikings').actions, ['Deploy to BM3', 'Buy P32']);
  assert.deepEqual(first('Poland').actions, ['Deploy to BM3', 'Deploy to BM3', 'Buy P32']);
  assert.equal(first('Vikings').workersLeft, 4);
  assert.equal(first('Poland').workersLeft, 3);
});

test('a second Axeman preserves the Nubia race while Forge lets Legionary arrive first', () => {
  const race = colonyRaces(positions[13], bot)[0];
  assert.equal(race.routes.Kayser.earliestAction, 3);
  const move = name => race.deployments.find(option => option.move === name);
  assert.equal(move('Deploy to BM3').earliestAction, 2);
  assert.equal(move('Deploy to BM3').beatsKnownRivalPlans, true);
  assert.equal(move('Deploy to BM2').earliestAction, 4);
  assert.equal(move('Deploy to BM2').beatsKnownRivalPlans, false);
});

test('personal deployment order has no colony deadline once the rival has passed', () => {
  const state = structuredClone(positions[13]); state.players.Kayser.passed = true;
  const race = colonyRaces(state, bot)[0];
  assert.equal(race.rivalDeadline, null);
  assert.equal(race.deployments.find(move => move.move === 'Deploy to BM2').beatsKnownRivalPlans, true);
});

test('routes cannot spend future production before resolution or deploy unavailable workers', () => {
  const state = structuredClone(positions[13]);
  state.players[bot].resources['[Gold]'] = 2;
  state.players[bot].production['[Gold]'] = 10;
  assert.deepEqual(militaryPlans(state, bot, 'P32').plans, []);
  state.players[bot].resources['[Gold]'] = 5;
  state.players[bot].workers = 0;
  assert.deepEqual(militaryPlans(state, bot, 'P32').plans, []);
  assert.equal(militaryPlans(positions[13], bot, 'P32', { maxNodes: 0 }).exhausted, true);
});

test('military purchase returns displaced workers and costs a turn before deployment', () => {
  const state = structuredClone(positions[13]);
  state.players[bot].workers = 0;
  state.progress_board.P11 = 'Lgn';
  const plan = militaryPlans(state, bot, 'P32').plans[0];
  assert.deepEqual(plan.actions, ['Buy P11; place BM3', 'Deploy to BM3', 'Buy P32']);
  assert.equal(plan.goldLeft, 1);
  assert.equal(plan.military, 3);
});

test('growth can fund the colony opening and Food production without knowing the next event', () => {
  const coverage = growthFoodCoverage(positions[6], bot);
  const gold = coverage.find(row => row.growth === '2 [Gold]');
  const food = coverage.find(row => row.growth === '2 [Food]');
  assert.deepEqual(gold.competitiveActions, ['Deploy to BM3', 'Deploy to BM3', 'Buy P32']);
  assert.equal(gold.foodBeforeFamine, 4);
  assert.equal(gold.goldAfterProduction, 6);
  assert.equal(food.foodBeforeFamine, 6);
  assert.equal(food.goldAfterProduction, 4);
  assert.equal(gold.knownFamine, null, 'The event had not been revealed at growth.');
});
