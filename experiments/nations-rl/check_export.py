"""Compare an exported player's logits and value against PyTorch on replay positions."""
import argparse
from collections import Counter
import gzip
import json
from pathlib import Path
import random
import subprocess

import torch

from encoding import Encoder, SUPPORTED
from model import collate, load_model

ROOT = Path(__file__).resolve().parents[2]
RUNNER = '''
import { readFileSync } from 'node:fs';
import { decodeExperimentalModel } from './live-player/rl-policy.mjs';
const model = decodeExperimentalModel(readFileSync(process.argv[1]));
const states = JSON.parse(readFileSync(0, 'utf8'));
const timings = [];
const predictions = states.map(state => {
  const start = performance.now();
  const result = model.rank(state);
  timings.push(performance.now() - start);
  return result;
});
timings.sort((a, b) => a - b);
console.log(JSON.stringify({ predictions, p95_ms: timings[Math.floor(.95 * timings.length)] }));
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('checkpoint', type=Path)
    parser.add_argument('export', type=Path)
    parser.add_argument('test_replays', type=Path, help='Gzipped JSONL replay positions.')
    args = parser.parse_args()
    torch.set_num_threads(1)
    model, _ = load_model(args.checkpoint)
    players = model.config.get('player_count', 2)
    encoder = Encoder(json.loads((ROOT / 'live-player/card-index.json').read_text(encoding='utf-8')), players)
    model.eval()
    samples = {prompt: [] for prompt in SUPPORTED}
    counts = Counter()
    rng = random.Random(711)
    with gzip.open(args.test_replays, 'rt', encoding='utf-8') as source:
        for line in source:
            state = json.loads(line)['state']
            prompt = state['next_move_choice']
            if len(state['players']) != players or prompt not in samples:
                continue
            counts[prompt] += 1
            group = samples[prompt]
            if len(group) < 100:
                group.append(state)
            else:
                index = rng.randrange(counts[prompt])
                if index < len(group):
                    group[index] = state
    states = [state for prompt in sorted(samples) for state in samples[prompt]]
    if not states:
        raise ValueError(f'No {players}-player positions')
    process = subprocess.run(['node', '--input-type=module', '-e', RUNNER, str(args.export.resolve())],
                             cwd=ROOT, input=json.dumps(states), encoding='utf-8', capture_output=True, check=True)
    result = json.loads(process.stdout)
    max_error, max_value_error = 0., 0.
    with torch.inference_mode():
        for state, actual in zip(states, result['predictions'], strict=True):
            features, moves = encoder.encode(state)
            logits, value = model(collate([features]))
            expected = dict(zip(moves, logits[0].tolist(), strict=True))
            scores = {row['move']: row['score'] for row in actual['moves']}
            if scores.keys() != expected.keys() or actual['moves'][0]['move'] != moves[logits[0].argmax().item()]:
                raise ValueError(f'Move mismatch at {state["next_move_choice"]}')
            max_error = max(max_error, max(abs(scores[move] - expected[move]) for move in moves))
            probability = value.sigmoid().item()
            expected_value = probability if players == 2 else 1 + 4 * probability
            key = 'winProbability' if players == 2 else 'expectedLeaguePoints'
            max_value_error = max(max_value_error, abs(actual[key] - expected_value))
    if max(max_error, max_value_error) > 1e-4:
        raise ValueError('Numerical mismatch between PyTorch and the player.')
    print(json.dumps({'positions': len(states), 'by_prompt': {p: len(g) for p, g in samples.items()},
                      'max_logit_error': max_error, 'max_value_error': max_value_error,
                      'node_p95_ms': result['p95_ms']}))


if __name__ == '__main__':
    main()
