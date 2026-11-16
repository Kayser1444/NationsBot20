import defaults from './default-weights.json' with { type: 'json' };
import { rankMoves, selectMove } from './scorer.mjs';
import { chooseBaselineMove, rankBaselineMoves } from './baseline.mjs';

const usesBaseline = (state, model) => /^human-baseline-v[12]$/.test(model?.playerPolicies?.[Object.keys(state.players ?? {}).length === 2 ? '2' : '4'] ?? '');

export const explainMoves = (state, username, model = defaults) => usesBaseline(state, model)
  ? rankBaselineMoves(state, username) : rankMoves(state, username, model, true);

// Retain the worker caller signature and evaluate every visible opponent.
export const chooseMove = (state, username, _opponent, model = defaults, context = {}) => usesBaseline(state, model)
  ? chooseBaselineMove(state, context) : selectMove(state, username, model);
