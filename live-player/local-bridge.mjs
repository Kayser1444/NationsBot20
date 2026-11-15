import readline from 'node:readline';
import { readFile } from 'node:fs/promises';
import defaults from './default-weights.json' with { type: 'json' };
import { selectMove, rankMoves, validateModel } from './scorer.mjs';
import { chooseMove as legacyMove } from './baseline-v02.mjs';

let models = {};
let defaultModel = defaults;
if (process.env.NATIONS_PLAYER_WEIGHTS) {
  defaultModel = validateModel(JSON.parse(await readFile(process.env.NATIONS_PLAYER_WEIGHTS, 'utf8')));
}

for await (const line of readline.createInterface({ input: process.stdin })) {
  try {
    const message = JSON.parse(line);
    if (message.configure) {
      models = message.configure;
      for (const model of Object.values(models)) if (model !== 'v02') validateModel(model);
      process.stdout.write('{"ok":true}\n');
      continue;
    }
    const state = message.state ?? message;
    const username = state.next_move_player;
    const model = models[username] ?? defaultModel;
    let result;
    if (model === 'v02') {
      const rival = Object.keys(state.players).find(name => name !== username);
      result = legacyMove(state, username, rival);
    } else {
      result = message.explain ? rankMoves(state, username, model, true) : selectMove(state, username, model);
    }
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: error.message }) + '\n');
  }
}
