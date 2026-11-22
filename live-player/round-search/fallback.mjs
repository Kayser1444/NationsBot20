import { createInterface } from 'node:readline';
import { rankMoves } from './scorer.mjs';

for await (const line of createInterface({ input: process.stdin })) {
  const state = JSON.parse(line);
  console.log(JSON.stringify(rankMoves(state, state.next_move_player).map(row => row.move)));
}
