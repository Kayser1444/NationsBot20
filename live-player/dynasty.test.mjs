import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import fixture from './fixtures/match-3275-dynasties.json' with { type: 'json' };
import cards from './card-index.json' with { type: 'json' };
import learned from './human-baseline.json' with { type: 'json' };
import easy from './trained-weights.json' with { type: 'json' };
import { humanCandidates } from './human-policy.mjs';
import { rankBaselineMoves } from './baseline.mjs';
import { predictAction } from './medium.mjs';
import { abilities, activeDynasty, dynastyEffects, applyBenefit } from './dynasty-effects.mjs';

test('game 3275 chooses Sassanid during the first round and at the reported missed opportunity', () => {
  for (const state of [...fixture.persiaOpening.filter(s => s.next_move_choice === 'Which benefit?'), fixture.persiaSecondRound]) {
    assert.equal(rankBaselineMoves(state)[0].move, 'Play "Sassanid Empire"', `decision ${state.move_number}`);
  }
});

test('benefit policy distinguishes dynasty identities and the retained starting ability', () => {
  const state = fixture.persiaSecondRound;
  const choices = humanCandidates(state, easy);
  assert.equal(choices.length, 3);
  assert.ok(choices.find(c => c.move.includes('Sassanid')).features.some(([key]) => key === 'benefit/card/Ps_SE'));
  assert.ok(choices.find(c => c.move.includes('Achaemenid')).features.some(([key]) => key === 'benefit/card/Ps_AE'));
  assert.equal(rankBaselineMoves(fixture.romeKeepDefault)[0].move, '2 [Gold]');
  assert.equal(dynastyEffects(fixture.romeKeepDefault, fixture.romeKeepDefault.next_move_player, 'R_RE')['lost/Military'], 2);
  for (const [id, card] of Object.entries(cards)) if (card.type === 'dynasty') assert.ok(abilities[id]?.length, id);
});

test('Sassanid costs Stability to activate, but subsequent Gold turmoils keep Stability and consume round supply', () => {
  const state = structuredClone(fixture.persiaOpening.find(s => s.next_move_choice === 'Which benefit?'));
  const who = state.next_move_player, stability = state.players[who].resources['[Stability]'] ?? 0;
  const active = applyBenefit(state, who, 'Play "Sassanid Empire"');
  assert.equal(activeDynasty(active.players[who]), 'Ps_SE');
  assert.equal(active.players[who].resources['[Stability]'] ?? 0, stability);
  active.next_move_choice = 'Which action?';
  const gold = active.players[who].resources['[Gold]'];
  const projected = predictAction(active, who, 'Turmoil')[0].state;
  assert.equal(projected.players[who].resources['[Gold]'], gold + 2);
  assert.equal(projected.players[who].resources['[Stability]'] ?? 0, stability);
  assert.equal(projected.players[who].turmoil, active.players[who].turmoil);
  assert.equal(projected.turmoil, active.turmoil - 1);
  active.next_move_options = ['Turmoil', 'Pass'];
  assert.equal(rankBaselineMoves(active)[0].move, 'Turmoil');
  const choice = { ...active, next_move_choice: 'Which benefit?', next_move_options: ['2 [Gold]', 'Play "Achaemenid Empire"'] };
  assert.equal(rankBaselineMoves(choice)[0].move, '2 [Gold]');
});

test('the dynasty checkpoint retains the frozen action weights', () => {
  const frozen = Object.fromEntries(Object.entries(learned.weights).filter(([key]) => !key.startsWith('benefit/')).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  const hash = createHash('sha256').update(JSON.stringify(frozen)).digest('hex');
  assert.equal(learned.baseActionWeightsSha256, hash);
});

test('Sassanid is not activated after the last turmoil of the game', () => {
  const state = structuredClone(fixture.persiaSecondRound);
  state.round = 8; state.turmoil = 0;
  assert.notEqual(rankBaselineMoves(state)[0].move, 'Play "Sassanid Empire"');
});
