import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import defaults from '../live-player/default-weights.json' with { type: 'json' };
import { rankMoves, validateModel } from '../live-player/scorer.mjs';

const { values } = parseArgs({
  options: {
    state: { type: 'string' }, weights: { type: 'string' },
    player: { type: 'string' }, decision: { type: 'string' },
  },
});
if (!values.state) {
  console.error('Usage: node scripts/explain-nations.mjs --state position.json [--weights model.json] [--player NationsBot20] [--decision 52]');
  process.exitCode = 1;
} else {
  const input = JSON.parse(await readFile(values.state, 'utf8'));
  const state = values.decision ? input[values.decision] : input.state ?? input;
  if (!state?.players) throw new Error('No game position at the requested decision.');
  const player = values.player ?? state.next_move_player;
  const model = values.weights ? validateModel(JSON.parse(await readFile(values.weights, 'utf8'))) : defaults;
  console.log(JSON.stringify({ model: model.name, player, round: state.round,
    decision: state.move_number, moves: rankMoves(state, player, model, true) }, null, 2));
}
