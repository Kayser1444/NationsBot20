import { createReadStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { rankHumanMoves } from '../live-player/human-policy.mjs';
import { rankMoves } from '../live-player/scorer.mjs';
import { dynastyId } from '../live-player/dynasty-effects.mjs';
import easy from '../live-player/trained-weights.json' with { type: 'json' };

const [directory, modelPath = 'live-player/human-baseline.json'] = process.argv.slice(2);
if (!directory) throw new Error('Usage: node scripts/evaluate-dynasty-nations.mjs CORPUS_DIRECTORY [POLICY]');
const bytes = await readFile(modelPath), model = JSON.parse(bytes);
const groups = {};
const stream = createReadStream(join(directory, 'test.jsonl.gz')).pipe(createGunzip());
for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
  const row = JSON.parse(line);
  if (!['benefit', 'dynasty'].includes(row.phase)) continue;
  const state = row.state, player = state.players[state.next_move_player];
  const id = dynastyId(player, row.chosen);
  const predicted = rankHumanMoves(state, model, easy)[0]?.move;
  const old = rankMoves(state, state.next_move_player, easy)[0]?.move;
  for (const key of ['all', row.phase === 'dynasty' ? 'forced' : id ? 'plays-dynasty' : 'takes-gold',
    `nation/${player.nation}`, ...(id ? [`chosen/${id}`] : [])]) {
    const sum = groups[key] ??= { count: 0, policyCorrect: 0, easyCorrect: 0 };
    sum.count++; sum.policyCorrect += Number(predicted === row.chosen); sum.easyCorrect += Number(old === row.chosen);
  }
}
for (const row of Object.values(groups)) { row.policyAccuracy = row.policyCorrect / row.count; row.easyAccuracy = row.easyCorrect / row.count; }
const report = { policySha256: createHash('sha256').update(bytes).digest('hex'), groups };
await writeFile(join(directory, 'dynasty-evaluation.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
