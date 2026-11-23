// Experiment-only adapter. Every imported player file belongs to the run's snapshot.
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const baselineDirectory = process.argv[2];
const load = name => import(pathToFileURL(resolve(baselineDirectory, name)));
const { rankBaselineMoves } = await load('baseline.mjs');
const { selectMove } = await load('scorer.mjs');
const { default: models } = await import(pathToFileURL(resolve(baselineDirectory, 'models.json')), { with: { type: 'json' } });
for await (const line of readline.createInterface({ input: process.stdin })) {
  try {
    const input = JSON.parse(line);
    const state = input.state ?? input;
    const rows = input.heuristic
      ? [{ move: selectMove(state, state.next_move_player, models['full-hour'].model) }]
      : rankBaselineMoves(state, state.next_move_player);
    process.stdout.write(JSON.stringify(rows) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: error.message }) + '\n');
  }
}
