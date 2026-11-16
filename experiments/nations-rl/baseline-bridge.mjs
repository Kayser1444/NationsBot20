// Experiment-only adapter. Every imported player file belongs to the run's snapshot.
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const { rankBaselineMoves } = await import(pathToFileURL(resolve(process.argv[2], 'baseline.mjs')));
for await (const line of readline.createInterface({ input: process.stdin })) {
  try {
    const state = JSON.parse(line);
    process.stdout.write(JSON.stringify(rankBaselineMoves(state, state.next_move_player)) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: error.message }) + '\n');
  }
}
