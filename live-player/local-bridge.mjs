import readline from 'node:readline';
import { readFile } from 'node:fs/promises';
import defaults from './default-weights.json' with { type: 'json' };
import { selectMove, rankMoves, validateModel } from './scorer.mjs';
import { chooseMove as legacyMove } from './baseline-v02.mjs';
import { readPositionPlans } from './position-reader.mjs';
import { predictMoves } from './medium.mjs';
import { rankHumanMoves } from './human-policy.mjs';
import { rankBaselineMoves } from './baseline.mjs';

let models = {};
let localHumanPolicy = null;
let localExperimental = null;
let defaultModel = defaults;
if (process.env.NATIONS_PLAYER_WEIGHTS) {
  defaultModel = validateModel(JSON.parse(await readFile(process.env.NATIONS_PLAYER_WEIGHTS, 'utf8')));
}

function validateHumanPolicy(candidate) {
  if (candidate?.type !== 'human-move-softmax' || candidate.schemaVersion !== 1 || !candidate.weights
      || typeof candidate.weights !== 'object' || Array.isArray(candidate.weights) || !Object.values(candidate.weights).every(Number.isFinite)) {
    throw new Error('Invalid human move policy');
  }
  return candidate;
}

function learnedMoves(state, policy) {
  const moves = rankHumanMoves(state, policy, defaultModel);
  return moves.length ? { moves, fallback: false }
    : { moves: rankMoves(state, state.next_move_player, defaultModel), fallback: true };
}

for await (const line of readline.createInterface({ input: process.stdin })) {
  try {
    const message = JSON.parse(line);
    if (message.loadHumanPolicy) {
      localHumanPolicy = validateHumanPolicy(message.loadHumanPolicy);
      process.stdout.write('{"ok":true}\n');
      continue;
    }
    if (message.loadExperimentalCheckpoint) {
      const { decodeExperimentalModel } = await import('./rl-policy.mjs');
      localExperimental = decodeExperimentalModel(await readFile(message.loadExperimentalCheckpoint));
      process.stdout.write(JSON.stringify({ id: localExperimental.id, label: localExperimental.label }) + '\n');
      continue;
    }
    if (message.configure) {
      for (const candidate of Object.values(message.configure)) {
        if (candidate === 'v02') continue;
        if (candidate?.type === 'human-move-softmax') validateHumanPolicy(candidate);
        else validateModel(candidate);
      }
      models = message.configure;
      process.stdout.write('{"ok":true}\n');
      continue;
    }
    const state = message.state ?? message;
    const username = state.next_move_player;
    const model = models[username] ?? defaultModel;
    let result;
    if (message.experimentalAnalysis === true) {
      if (!localExperimental) throw new Error('Experimental checkpoint is not installed');
      result = localExperimental.rank(state) ?? { moves: rankBaselineMoves(state, username), winProbability: null };
    } else if (message.humanPolicy === true) {
      if (!localHumanPolicy) throw new Error('Human policy is not installed');
      const prediction = { moves: rankBaselineMoves(state, username, localHumanPolicy), fallback: false };
      result = message.explain ? prediction : prediction.moves[0]?.move ?? null;
    } else if (model === 'v02') {
      const rival = Object.keys(state.players).find(name => name !== username);
      result = legacyMove(state, username, rival);
    } else if (model.type === 'human-move-softmax') {
      result = learnedMoves(state, model).moves[0]?.move ?? null;
    } else {
      result = message.medium ? predictMoves(state, username, model, message.search)
        : message.analyze ? { moves: rankMoves(state, username, model, true), reading: readPositionPlans(state, username), model: model.name }
        : message.explain ? rankMoves(state, username, model, true) : selectMove(state, username, model);
    }
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: error.message }) + '\n');
  }
}
