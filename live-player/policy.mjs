import defaults from './default-weights.json' with { type: 'json' };
import { rankMoves, selectMove } from './scorer.mjs';
import { chooseBaselineMove, rankBaselineMoves } from './baseline.mjs';
import { isExperimentalModel } from './rl-policy.mjs';

const usesBaseline = (state, model) => /^human-baseline-v[12]$/.test(model?.playerPolicies?.[Object.keys(state.players ?? {}).length === 2 ? '2' : '4'] ?? '');

const usesExperiment = (state, model) => Object.keys(state.players ?? {}).length === 2 && isExperimentalModel(model?.playerPolicies?.['2']);

export const explainMoves = (state, username, model = defaults) => usesExperiment(state, model)
  ? model.experimental?.rank(state)?.moves ?? rankBaselineMoves(state, username)
  : usesBaseline(state, model) ? rankBaselineMoves(state, username) : rankMoves(state, username, model, true);

// Retain the worker caller signature and evaluate every visible opponent.
export function chooseMove(state, username, _opponent, model = defaults, context = {}) {
  if (usesExperiment(state, model)) {
    if (!model.experimental) throw new Error('This match’s experimental checkpoint is unavailable.');
    const prediction = model.experimental.rank(state);
    if (prediction) return prediction.moves[0].move;
    return chooseBaselineMove(state, context);
  }
  return usesBaseline(state, model) ? chooseBaselineMove(state, context) : selectMove(state, username, model);
}
