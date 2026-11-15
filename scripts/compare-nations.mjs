import { performance } from 'node:perf_hooks';
import positions from '../live-player/fixtures/match-3272-opening.json' with { type: 'json' };
import model from '../live-player/trained-weights.json' with { type: 'json' };
import { predictMoves } from '../live-player/medium.mjs';
import { readPositionPlans } from '../live-player/position-reader.mjs';
import { rankMoves } from '../live-player/scorer.mjs';

for (const [decision, state] of Object.entries(positions)) {
  const player = state.next_move_player;
  const started = performance.now();
  const easy = rankMoves(state, player, model);
  const easyMs = performance.now() - started;
  const medium = predictMoves(state, player, model);
  const reading = readPositionPlans(state, player);
  const ranks = Object.fromEntries(['Deploy to BM2', 'Deploy to BM3'].map(move => [move, {
    easy: easy.findIndex(row => row.move === move) + 1,
    medium: medium.moves.findIndex(row => row.move === move) + 1,
    mediumPlan: medium.moves.find(row => row.move === move)?.plan,
  }]));
  console.log(JSON.stringify({ decision: Number(decision), choice: state.next_move_choice,
    easy: easy[0]?.move, easyMs, medium: medium.moves[0]?.move, mediumMs: medium.duration_ms,
    depth: medium.completedDepth, plan: medium.moves[0]?.plan, ...(decision === '13' ? { ranks } : {}),
    ...(reading.draft ? { draft: reading.draft.map(row => ({ nation: row.nation,
      routes: row.colonies.map(race => ({ colony: race.name, turns: race.routes[player]?.plan?.turns })) })) } : {}),
  }));
}
