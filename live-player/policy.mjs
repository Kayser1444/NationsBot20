import defaults from './default-weights.json' with { type: 'json' };
import { rankMoves, selectMove } from './scorer.mjs';

export const explainMoves = (state, username, model = defaults) => rankMoves(state, username, model, true);

// Retain the worker caller signature and evaluate every visible opponent.
export const chooseMove = (state, username, _opponent, model = defaults) => selectMove(state, username, model);
