"""Train two warm-started encodings and compare them in direct two-player play."""
import argparse
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor
from copy import deepcopy
import json
from pathlib import Path
import random
import shutil
import subprocess
import sys
from time import perf_counter

import torch
from torch import nn

from ability_encoding import (
    AbilityEncoder, REPLACEMENT_SCHEMA, ReplacementAbilityEncoder, SCHEMA as ABILITY_SCHEMA,
)
from encoding import Encoder
from mixed_encoding import MixedSettingsEncoder, SCHEMA as MIXED_SCHEMA
from mixed_rules import DIFFICULTIES, RULE_MIX, rules_for_board
from model import PolicyValue, collate, load_model, save_model
from position_encoding import PositionEncoder, SCHEMA
from train import (ROOT, RULES, board_seed, digest, emit, evaluate_predictions,
                   play_game, read_corpus, seed_all, summarize, write_json)
from wonder_encoding import SCHEMA as WONDER_SCHEMA, WonderSlotEncoder


PAIRS = (('structured', 'benchmark'), ('control', 'benchmark'), ('structured', 'control'))
LEGACY_SIZE = (60, 67)
POSITION_ENCODERS = {
    SCHEMA: PositionEncoder, ABILITY_SCHEMA: AbilityEncoder,
    REPLACEMENT_SCHEMA: ReplacementAbilityEncoder,
    WONDER_SCHEMA: WonderSlotEncoder,
    MIXED_SCHEMA: MixedSettingsEncoder,
}


class LegacyInput(nn.Module):
    def __init__(self, model):
        super().__init__()
        self.model = model
        self.config = model.config

    def forward(self, batch):
        state_size, action_size = LEGACY_SIZE
        return self.model({**batch, 'sn': batch['sn'][..., :state_size],
                           'an': batch['an'][..., :action_size]})


@torch.no_grad()
def expand(source, example):
    model = PolicyValue(len(example['sn']), example['an'].shape[-1])
    for name in ('state_embedding', 'action_embedding', 'policy', 'value'):
        getattr(model, name).load_state_dict(getattr(source, name).state_dict())
    for name, key in (('context', 'state_size'), ('action', 'action_size')):
        size = source.config[key]
        old, new = getattr(source, name)[0], getattr(model, name)[0]
        new.weight.zero_()
        new.weight[:, :size] = old.weight[:, :size]
        new.weight[:, model.config[key]:] = old.weight[:, size:]
        new.bias.copy_(old.bias)
    return model


def card_catalog(batch):
    return json.loads((batch / 'snapshot/baseline/card-index.json').read_text(encoding='utf-8'))


def position_encoder(batch, schema):
    return POSITION_ENCODERS[schema](card_catalog(batch))


class StaticFallback:
    """Shared feature scorer for menus outside the trained prompt families."""
    def __init__(self, batch):
        url = (batch / 'snapshot/baseline/scorer.mjs').as_uri()
        adapter = f"""
import {{ rankMoves }} from {json.dumps(url)};
import {{ createInterface }} from 'node:readline';
for await (const line of createInterface({{ input: process.stdin }})) {{
  const input = JSON.parse(line);
  const state = input.state ?? input;
  const moves = rankMoves(state, state.next_move_player);
  process.stdout.write(JSON.stringify(input.state ? moves : moves[0]?.move) + '\\n');
}}
"""
        self.process = subprocess.Popen([shutil.which('node') or 'node', '--input-type=module', '-e', adapter],
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
                                        encoding='utf-8')
        self.plans = {}

    def choose(self, state, heuristic=False):
        return self.request(state)

    def rank(self, state):
        return self.request({'state': state})

    def request(self, payload):
        self.process.stdin.write(json.dumps(payload) + '\n')
        self.process.stdin.flush()
        line = self.process.stdout.readline()
        if not line:
            raise RuntimeError('Shared static scorer stopped')
        return json.loads(line)

    def close(self):
        self.process.stdin.close()
        self.process.wait(timeout=10)
        self.process.stdout.close()


def load_structured(path, schema=SCHEMA):
    saved = torch.load(path, map_location='cpu', weights_only=True)
    if saved['encoding_version'] != schema:
        raise ValueError('Unexpected current-position encoding version')
    model = PolicyValue(**saved['config'])
    model.load_state_dict(saved['parameters'])
    return model.eval()


def play_direct_game(match_type, encoder, fallback, models, output, candidate, opponent, seed, seat, rules=None,
                     *, opponent_encoder=None):
    own, rival = f'Seat{seat}', f'Seat{1 - seat}'
    replay = output / 'replays' / f'{candidate}-vs-{opponent}-{seed[:16]}-{seat}.replay'
    policy_encoders = {rival: opponent_encoder} if opponent_encoder is not None else None
    row, _ = play_game(match_type, encoder, fallback, {own: models[candidate], rival: models[opponent]},
                       (), seed, replay, sample=False, sampling_seed=0, seconds=90,
                       policy_encoders=policy_encoders, rules=rules)
    return row | {'candidate': own, 'opponent': rival, 'pair': f'{candidate}-vs-{opponent}'}


def play_chunk(batch, output, checkpoint, jobs, schema=SCHEMA, opponent_schema=None):
    from nations import Match

    torch.set_num_threads(1)
    encoder = position_encoder(batch, schema)
    if opponent_schema is None:
        opponent_encoder = Encoder(card_catalog(batch)) if isinstance(encoder, ReplacementAbilityEncoder) else None
        opponent = LegacyInput(load_model(checkpoint)[0].eval())
    else:
        opponent_encoder = position_encoder(batch, opponent_schema)
        opponent = load_structured(checkpoint, opponent_schema)
    models = {'benchmark': opponent, 'structured': load_structured(output / 'structured.pt', schema)}
    if any('control' in job[:2] for job in jobs):
        models['control'] = LegacyInput(load_model(output / 'control.pt')[0].eval())
    fallback = StaticFallback(batch)
    try:
        return [play_direct_game(Match, encoder, fallback, models, output, *job,
                                 opponent_encoder=opponent_encoder) for job in jobs]
    finally:
        fallback.close()


def train_pair(args, checkpoint):
    encoder = PositionEncoder(card_catalog(args.batch))
    datasets = {}
    game_ids = {}
    for split, limit in (('train', args.train_rows), ('validation', args.eval_rows), ('test', args.eval_rows)):
        rows, ids, stats = read_corpus(args.corpus / f'{split}.jsonl.gz', encoder, limit,
                                      random.Random(args.seed + len(datasets)))
        if any(ids & other for other in game_ids.values()):
            raise ValueError('A match appears in multiple replay splits')
        datasets[split], game_ids[split] = rows, ids
        emit({'stage': 'replays', 'split': split, **stats})

    baseline, _ = load_model(checkpoint)
    if baseline.config != dict(zip(('state_size', 'action_size'), LEGACY_SIZE)):
        raise ValueError('Expected the original two-player checkpoint')
    structured = expand(baseline, datasets['train'][0])
    control = LegacyInput(deepcopy(baseline))
    parity_rows = collate(datasets['validation'][:64])
    with torch.no_grad():
        for new, old in zip(structured(parity_rows), control(parity_rows)):
            torch.testing.assert_close(new, old, atol=1.e-5, rtol=1.e-5)
    models = {'structured': structured, 'control': control}
    optimizers = {name: torch.optim.Adam(model.parameters(), lr=args.learning_rate)
                  for name, model in models.items()}
    history = []
    rng = random.Random(args.seed)
    train = datasets['train']
    for epoch in range(1, args.epochs + 1):
        order = list(range(len(train)))
        rng.shuffle(order)
        for model in models.values():
            model.train()
        for offset in range(0, len(order), args.batch_size):
            rows = [train[index] for index in order[offset:offset + args.batch_size]]
            features = collate(rows)
            labels = torch.tensor([row['label'] for row in rows])
            targets = torch.tensor([row['target'] for row in rows])
            for name, model in models.items():
                optimizer = optimizers[name]
                optimizer.zero_grad()
                policy, value = model(features)
                loss = nn.functional.cross_entropy(policy, labels) + .5 * nn.functional.binary_cross_entropy_with_logits(value, targets)
                loss.backward()
                nn.utils.clip_grad_norm_(model.parameters(), 1.)
                optimizer.step()
        record = {'epoch': epoch, 'validation': {name: evaluate_predictions(model, datasets['validation'])
                                                for name, model in models.items()}}
        history.append(record)
        write_json(args.output / 'training.json', history)
        emit({'stage': 'epoch', **record})
    metadata = {'kind': 'matched-human-fine-tune', 'epochs': args.epochs, 'benchmark': digest(checkpoint)}
    torch.save({'encoding_version': SCHEMA, 'config': structured.config,
                'parameters': structured.state_dict(), 'metadata': metadata}, args.output / 'structured.pt')
    save_model(args.output / 'control.pt', control.model, metadata)
    return {'epochs': history, 'start_parity_rows': 64,
            'parameters': {name: sum(p.numel() for p in model.parameters()) for name, model in models.items()},
            'test': {name: evaluate_predictions(model, datasets['test']) for name, model in
                     (models | {'benchmark': LegacyInput(baseline)}).items()}}


def summarize_by_difficulty(rows):
    groups = {i: [] for i in range(1, 5)}
    for row in rows:
        groups[row['rules']['growth_resources']].append(row)
    return {DIFFICULTIES[i - 1]: summarize(games) for i, games in groups.items() if games}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--batch', type=Path, default=ROOT / '.data/nations-rl/batch-10000-v1')
    parser.add_argument('--corpus', type=Path, default=ROOT / '.data/human-policy/dynasty-v2')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--train-rows', type=int, default=12000)
    parser.add_argument('--eval-rows', type=int, default=2400)
    parser.add_argument('--epochs', type=int, default=2)
    parser.add_argument('--batch-size', type=int, default=128)
    parser.add_argument('--learning-rate', type=float, default=.0001)
    parser.add_argument('--boards', type=int, default=16)
    parser.add_argument('--workers', type=int, default=4)
    parser.add_argument('--processes', action='store_true', help='Use separate CPU processes for benchmark games.')
    parser.add_argument('--seed', type=int, default=181126)
    parser.add_argument('--evaluate-only', action='store_true', help='Evaluate a completed training run.')
    parser.add_argument('--benchmark-only', action='store_true', help='Evaluate only the structured model against the benchmark.')
    parser.add_argument('--mixed-settings', action='store_true',
                        help='Use the shared mixed board schedule, including for older checkpoints.')
    args = parser.parse_args()
    if min(args.train_rows, args.eval_rows, args.epochs, args.batch_size, args.boards, args.workers) < 1:
        parser.error('Training sizes, boards and worker counts must be positive')
    if args.mixed_settings and not args.evaluate_only:
        parser.error('--mixed-settings evaluates a saved checkpoint')
    args.batch, args.corpus, args.output = (p.resolve() for p in (args.batch, args.corpus, args.output))
    selected = json.loads((args.batch / 'selection.json').read_text(encoding='utf-8'))['selected']
    checkpoint = args.batch / selected
    manifest = json.loads((args.batch / 'manifest.json').read_text(encoding='utf-8'))
    if manifest['rules'] != RULES:
        raise ValueError('Training runner and frozen benchmark rules differ')
    started = perf_counter()
    seed_all(args.seed, min(args.workers, 4))
    checkpoint_hash = digest(checkpoint)
    schema = SCHEMA
    mixed = args.mixed_settings
    evaluation_opponent = None
    if args.evaluate_only:
        experiment = json.loads((args.output / 'manifest.json').read_text(encoding='utf-8'))
        schema = experiment['encoding']
        if experiment.get('rule_mix', RULE_MIX) != RULE_MIX:
            raise ValueError('Unsupported mixed settings schedule')
        mixed = mixed or 'rule_mix' in experiment or schema == MIXED_SCHEMA
        if experiment['benchmark_sha256'] != checkpoint_hash or schema not in POSITION_ENCODERS:
            raise ValueError('Saved run expects a different benchmark or input schema')
        evaluation_opponent = experiment.get('evaluation_opponent')
        if evaluation_opponent is not None:
            checkpoint = Path(evaluation_opponent['path'])
            if (not args.benchmark_only or evaluation_opponent['encoding'] not in POSITION_ENCODERS
                    or digest(checkpoint) != evaluation_opponent['sha256']):
                raise ValueError('Saved run expects a different evaluation opponent')
        if schema != SCHEMA and (
                not args.benchmark_only or experiment['ability_ids'] != list(position_encoder(args.batch, schema).ability_ids)):
            raise ValueError('Ability evaluation needs the frozen ability catalog and --benchmark-only')
        if (args.output / 'results.json').exists():
            raise ValueError('This run already has game results')
    else:
        args.output.mkdir(parents=True)
        (args.output / 'replays').mkdir()
        write_json(args.output / 'manifest.json', {
            'arguments': {k: str(v) if isinstance(v, Path) else v for k, v in vars(args).items()},
            'rules': RULES, 'benchmark_sha256': checkpoint_hash, 'encoding': SCHEMA,
            'source_sha256': {name: digest(Path(__file__).with_name(name)) for name in (
                'compare_position_encoding.py', 'position_encoding.py', 'train.py', 'model.py', 'encoding.py')},
        })
        training = train_pair(args, checkpoint)
        write_json(args.output / 'training.json', training)
    sys.path.insert(0, str(args.batch / 'snapshot/engine'))
    torch.set_num_threads(1)
    boards = [(board_seed(SCHEMA, args.seed, index), rules_for_board(args.seed, index) if mixed else None)
              for index in range(args.boards)]
    pairs = PAIRS[:1] if args.benchmark_only else PAIRS
    jobs = [(name, rival, seed, seat, rules) for seed, rules in boards
            for name, rival in pairs for seat in range(2)]
    chunks = [jobs[index::args.workers] for index in range(args.workers)]
    emit({'stage': 'direct-play', 'games': len(jobs)})
    executor = ProcessPoolExecutor if args.processes else ThreadPoolExecutor
    opponent_schema = evaluation_opponent['encoding'] if evaluation_opponent is not None else None
    with executor(max_workers=args.workers) as pool:
        pending = [pool.submit(play_chunk, args.batch, args.output, checkpoint, chunk, schema, opponent_schema)
                   for chunk in chunks if chunk]
        results = [row for future in pending for row in future.result()]
    comparisons = {}
    by_difficulty = {}
    for a, b in pairs:
        pair = f'{a}-vs-{b}'
        rows = [row for row in results if row['pair'] == pair]
        comparisons[pair] = summarize(rows)
        if mixed:
            by_difficulty[pair] = summarize_by_difficulty(rows)
    report = {'comparisons': comparisons, 'matches': results, 'seconds': round(perf_counter() - started, 2)}
    if mixed:
        report.update(rule_mix=RULE_MIX, by_difficulty=by_difficulty)
    if evaluation_opponent is not None:
        report['evaluation_opponent'] = evaluation_opponent
    write_json(args.output / 'results.json', report)
    emit({'stage': 'complete', 'seconds': report['seconds'], 'comparisons': comparisons})
    if any(row['error'] for row in results):
        raise SystemExit('One or more direct-play games failed; see results.json')


if __name__ == '__main__':
    main()
