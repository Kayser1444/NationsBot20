import { createReadStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import model from '../live-player/trained-weights.json' with { type: 'json' };
import { humanCandidates, rankHumanMoves } from '../live-player/human-policy.mjs';

const [directory, epochArg = '3'] = process.argv.slice(2);
const epochs = Number(epochArg);
if (!directory || !Number.isInteger(epochs) || epochs < 1 || epochs > 20) {
  throw new Error('Usage: node scripts/train-human-nations.mjs CORPUS_DIRECTORY [EPOCHS]');
}
const corpus = JSON.parse(await readFile(join(directory, 'corpus.json'), 'utf8'));
const weights = new Map();

async function* records(split) {
  const source = createReadStream(join(directory, `${split}.jsonl.gz`));
  const stream = createGunzip();
  source.on('error', error => stream.destroy(error));
  source.pipe(stream);
  for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) if (line) yield JSON.parse(line);
}

function logits(rows, get) {
  return rows.map(({ features }) => features.reduce((sum, [key, value]) => sum + get(key) * value, 0));
}

function probabilities(scores) {
  const best = Math.max(...scores);
  const exponents = scores.map(score => Math.exp(score - best));
  const total = exponents.reduce((a, b) => a + b, 0);
  return exponents.map(value => value / total);
}

function update(rows, label) {
  const probs = probabilities(logits(rows, key => weights.get(key)?.value ?? 0));
  const gradients = new Map();
  for (const [i, row] of rows.entries()) {
    const residual = Number(i === label) - probs[i];
    for (const [key, value] of row.features) gradients.set(key, (gradients.get(key) ?? 0) + residual * value);
  }
  for (const [key, gradient] of gradients) {
    let coordinate = weights.get(key);
    if (!coordinate) { coordinate = { value: 0, sumSquares: .1 }; weights.set(key, coordinate); }
    const step = gradient - .0003 * coordinate.value;
    coordinate.sumSquares += step * step;
    coordinate.value += .075 * step / Math.sqrt(coordinate.sumSquares);
  }
}

function countFor(counts, name) {
  if (!counts[name]) counts[name] = { count: 0, loss: 0, policyTop1: 0, policyTop3: 0, easyTop1: 0, easyTop3: 0, randomTop1: 0 };
  return counts[name];
}

async function evaluate(split, selectedWeights) {
  const counts = {};
  const games = new Set();
  for await (const row of records(split)) {
    games.add(row.match);
    const candidates = humanCandidates(row.state, model);
    const label = candidates.findIndex(move => move.move === row.chosen);
    if (label < 0) throw new Error(`No legal recorded move in match ${row.match}`);
    const scores = logits(candidates, key => selectedWeights[key] ?? 0);
    const probs = probabilities(scores);
    const legalOrder = new Map(row.state.next_move_options.map((move, index) => [move, index]));
    const order = scores.map((_, i) => i).sort((a, b) => scores[b] - scores[a] || legalOrder.get(candidates[a].move) - legalOrder.get(candidates[b].move));
    const predictedRank = order.indexOf(label);
    const size = Object.keys(row.state.players).length;
    const groups = ['all', `${size}p`, `${size}p/${row.phase}`, ...(row.rank === 1 ? [`${size}p/winner`] : [])];
    for (const group of groups) {
      const sum = countFor(counts, group);
      sum.count++;
      sum.loss -= Math.log(Math.max(1e-12, probs[label]));
      sum.policyTop1 += Number(predictedRank === 0);
      sum.policyTop3 += Number(predictedRank < 3);
      sum.easyTop1 += Number(label === 0);
      sum.easyTop3 += Number(label < 3);
      sum.randomTop1 += 1 / candidates.length;
    }
  }
  for (const sum of Object.values(counts)) for (const key of Object.keys(sum)) if (key !== 'count') sum[key] /= sum.count;
  return { games: games.size, groups: counts };
}

let best;
const validationEpochs = [];
for (let epoch = 1; epoch <= epochs; epoch++) {
  const started = performance.now();
  let count = 0;
  for await (const row of records('train')) {
    const candidates = humanCandidates(row.state, model);
    const label = candidates.findIndex(move => move.move === row.chosen);
    if (label < 0) throw new Error(`No legal recorded move in match ${row.match}`);
    update(candidates, label);
    count++;
  }
  const snapshot = Object.fromEntries([...weights].map(([key, state]) => [key, state.value]));
  const validation = await evaluate('validation', snapshot);
  const loss = validation.groups.all.loss;
  validationEpochs.push({ epoch, count, ...validation });
  console.log(JSON.stringify({ epoch, count, features: weights.size, validation: validation.groups.all,
    elapsedSeconds: Math.round((performance.now() - started) / 1000) }));
  if (!best || loss < best.loss) best = { epoch, loss, weights: snapshot };
}

const policy = { schemaVersion: 1, type: 'human-move-softmax', epoch: best.epoch, weights: best.weights };
const test = await evaluate('test', policy.weights);
const sample = JSON.parse(await readFile(new URL('../live-player/fixtures/match-3272-opening.json', import.meta.url)));
const opening = Object.entries(sample).map(([decision, state]) => ({ decision: Number(decision),
  easy: humanCandidates(state, model)[0]?.move, humanPolicy: rankHumanMoves(state, policy, model).slice(0, 5) }));
await writeFile(join(directory, 'policy.json'), JSON.stringify(policy));
await writeFile(join(directory, 'evaluation.json'), JSON.stringify({ corpus, selectedEpoch: best.epoch, validationEpochs, test, opening }, null, 2) + '\n');
console.log(JSON.stringify({ selectedEpoch: best.epoch, test, opening }));
