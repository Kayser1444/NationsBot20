"""Compare structured checkpoints on the same fresh two-seat benchmark boards."""
import argparse
from itertools import combinations
import json
from pathlib import Path
import random
from statistics import mean
import subprocess
import sys
from time import perf_counter

import torch

from ability_encoding import ReplacementAbilityEncoder
from compare_position_encoding import (LegacyInput, StaticFallback, card_catalog, load_structured,
                                       play_direct_game, position_encoder, summarize_by_difficulty)
from encoding import Encoder
from mixed_encoding import SCHEMA as MIXED_SCHEMA
from mixed_rules import RULE_MIX, rules_for_board
from model import load_model
from position_encoding import SCHEMA
from train import ROOT, RULES, board_seed, digest, emit, seed_all, summarize, write_json


CHECKPOINTS = (2000, 4000, 6000)


def read(path):
    return json.loads(path.read_text(encoding='utf-8'))


def matchups(checkpoints, round_robin):
    labels = tuple(map(str, checkpoints))
    return tuple(combinations(labels, 2)) if round_robin else tuple((label, 'benchmark') for label in labels)


def worker(manifest_path, jobs_path):
    manifest = read(manifest_path)
    batch = Path(manifest['batch'])
    output = manifest_path.parent
    seed_all(manifest['seed'], 1)
    sys.path.insert(0, str(batch / 'snapshot/engine'))
    from nations import Match

    schema = manifest.get('encoding', SCHEMA)
    encoder = position_encoder(batch, schema)
    if schema != SCHEMA and list(encoder.ability_ids) != manifest['ability_ids']:
        raise ValueError('Benchmark catalog differs from the training catalog')
    round_robin = manifest.get('round_robin', False)
    mixed = manifest.get('rule_mix') == RULE_MIX
    pairs = matchups(manifest['checkpoints'], round_robin)
    encoders = {schema: encoder}
    models, policy_encoders = {}, {}
    for label, info in manifest['checkpoints'].items():
        checkpoint_schema = info.get('encoding', schema)
        if checkpoint_schema not in encoders:
            encoders[checkpoint_schema] = position_encoder(batch, checkpoint_schema)
        policy_encoders[label] = encoders[checkpoint_schema]
        models[label] = load_structured(Path(info['path']), checkpoint_schema)
    if not round_robin:
        policy_encoders['benchmark'] = (Encoder(card_catalog(batch))
                                        if isinstance(encoder, ReplacementAbilityEncoder) else encoder)
        models['benchmark'] = LegacyInput(load_model(Path(manifest['benchmark']['path']))[0].eval())
    fallback = StaticFallback(batch)
    try:
        for index in read(jobs_path):
            seed = board_seed(SCHEMA, manifest['seed'], index)
            rules = rules_for_board(manifest['seed'], index) if mixed else None
            rows = [play_direct_game(Match, policy_encoders[left], fallback, models, output, left, right, seed, seat,
                                     rules, opponent_encoder=policy_encoders[right])
                    for left, right in pairs for seat in range(2)]
            write_json(output / 'boards' / f'{index:04}.json', {'index': index, 'seed': seed, 'games': rows})
    finally:
        fallback.close()


def verify_board(board, output, seed, checkpoints=CHECKPOINTS, round_robin=False, mixed=False):
    if board['seed'] != board_seed(SCHEMA, seed, board['index']):
        raise ValueError('Unexpected seed in saved board')
    pairs = {(r['pair'], r['candidate']) for r in board['games']}
    expected = {(f'{left}-vs-{right}', f'Seat{seat}')
                for left, right in matchups(checkpoints, round_robin) for seat in range(2)}
    if len(board['games']) != len(expected) or pairs != expected:
        raise ValueError('Saved board is missing a checkpoint or seat')
    rules = rules_for_board(seed, board['index']) if mixed else None
    if any(r['seed'] != board['seed'] or r.get('rules') != rules
           or not (output / 'replays' / r['replay']).is_file() for r in board['games']):
        raise ValueError('Saved board has inconsistent game or replay information')
    return all(not r['error'] and r['round'] == 8 for r in board['games'])


def run_wave(manifest_path, indexes, workers, wave, worker_script=__file__):
    output = manifest_path.parent
    runners = []
    for worker_id in range(min(workers, len(indexes))):
        job = output / f'wave-{wave:02}-worker-{worker_id:02}.json'
        write_json(job, indexes[worker_id::workers])
        with job.with_suffix('.log').open('a', encoding='utf-8') as log:
            process = subprocess.Popen([sys.executable, '-B', str(Path(worker_script).resolve()),
                                        '--worker', str(manifest_path), str(job)],
                                       stdout=log, stderr=subprocess.STDOUT)
        runners.append((process, job))
    failures = [job.with_suffix('.log').name for process, job in runners if process.wait()]
    if failures:
        raise RuntimeError(f'Benchmark workers failed; see {", ".join(failures)}. Use --resume to finish.')


def paired_intervals(boards, checkpoints=CHECKPOINTS):
    def measures(board, checkpoint):
        games = [r for r in board['games'] if r['pair'] == f'{checkpoint}-vs-benchmark']
        return (mean(r['rewards'][r['candidate']] for r in games),
                mean(r['scores'][r['candidate']] - r['scores'][r['opponent']] for r in games))

    by_checkpoint = {checkpoint: [measures(board, checkpoint) for board in boards] for checkpoint in checkpoints}
    report = {}
    for earlier, later in combinations(checkpoints, 2):
        deltas = [(b[0] - a[0], b[1] - a[1])
                  for a, b in zip(by_checkpoint[earlier], by_checkpoint[later])]
        rng = random.Random(197)
        samples = [[], []]
        for _ in range(4000):
            sample = rng.choices(deltas, k=len(deltas))
            for i in range(2):
                samples[i].append(mean(pair[i] for pair in sample))
        for series in samples:
            series.sort()
        report[f'{later}-minus-{earlier}'] = {
            'win_rate_difference': mean(p[0] for p in deltas),
            'win_rate_difference_95': [samples[0][100], samples[0][3899]],
            'mean_vp_margin_difference': mean(p[1] for p in deltas),
            'mean_vp_margin_difference_95': [samples[1][100], samples[1][3899]],
        }
    return report


def summarize_round_robin(boards, checkpoints):
    matches = {}
    standings = {str(label): {'wins': 0, 'games': 0, 'vp_margin': 0.0} for label in checkpoints}
    for left, right in matchups(checkpoints, True):
        pair = f'{left}-vs-{right}'
        result = summarize([game for board in boards for game in board['games'] if game['pair'] == pair])
        matches[pair] = result
        games, wins, margin = result['completed'], int(result['wins']), result['mean_vp_margin']
        for label, won, vp in ((left, wins, margin), (right, games - wins, -margin)):
            standings[label]['wins'] += won
            standings[label]['games'] += games
            standings[label]['vp_margin'] += vp * games
    for row in standings.values():
        row['win_rate'] = row['wins'] / row['games']
        row['mean_vp_margin'] = row.pop('vp_margin') / row['games']
    rankings = sorted(standings, key=lambda label: (standings[label]['wins'], standings[label]['mean_vp_margin']),
                      reverse=True)
    return {'matchups': matches, 'standings': standings, 'ranking': rankings}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--scale-run', type=Path, default=ROOT / '.data/nations-rl/current-position-scale-v1')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--boards', type=int, default=256)
    parser.add_argument('--workers', type=int, default=6)
    parser.add_argument('--seed', type=int, default=181142)
    parser.add_argument('--checkpoints', type=int, nargs='+', default=CHECKPOINTS,
                        help='Training-game counts to compare.')
    parser.add_argument('--round-robin', action='store_true', help='Play the checkpoints against each other.')
    parser.add_argument('--mixed-settings', action='store_true',
                        help='Use the shared mixed board schedule, including for older checkpoints.')
    parser.add_argument('--resume', action='store_true')
    args = parser.parse_args()
    if min(args.boards, args.workers) < 1:
        parser.error('Boards and workers must be positive')
    if len(set(args.checkpoints)) < 2 or len(set(args.checkpoints)) != len(args.checkpoints):
        parser.error('Provide at least two distinct checkpoints')
    output, scale = args.output.resolve(), args.scale_run.resolve()
    original = read(scale / 'manifest.json')
    batch = Path(original['batch'])
    frozen = batch / read(batch / 'selection.json')['selected']
    if digest(frozen) != original['benchmark_sha256'] or original['rules'] != RULES:
        raise ValueError('Benchmark or rules differ from the original scaling run')
    monitors = {record['games']: Path(record['checkpoint']) for record in read(scale / 'monitoring.json')}
    if not set(args.checkpoints) <= monitors.keys():
        parser.error('The requested checkpoints must have completed monitoring')
    config = {'batch': str(batch), 'seed': args.seed, 'boards': args.boards, 'rules': RULES,
              'benchmark': {'path': str(frozen), 'sha256': digest(frozen)},
              'checkpoints': {str(games): {'path': str(monitors[games]), 'sha256': digest(monitors[games])}
                              for games in args.checkpoints}}
    schema = original.get('encoding', SCHEMA)
    if original.get('rule_mix', RULE_MIX) != RULE_MIX:
        raise ValueError('Unsupported mixed settings schedule')
    mixed = args.mixed_settings or 'rule_mix' in original or schema == MIXED_SCHEMA
    if schema != SCHEMA:
        config.update(encoding=schema, ability_ids=original['ability_ids'])
    if mixed:
        config['rule_mix'] = RULE_MIX
        for info in config['checkpoints'].values():
            checkpoint = torch.load(info['path'], map_location='cpu', weights_only=True)
            info['encoding'] = checkpoint['encoding_version']
    if args.round_robin:
        config['round_robin'] = True
    manifest = output / 'manifest.json'
    if args.resume:
        if read(manifest) != config or (output / 'results.json').exists():
            raise ValueError('Resume requires an unfinished run with the same inputs')
    else:
        output.mkdir(parents=True)
        (output / 'boards').mkdir()
        (output / 'replays').mkdir()
        write_json(manifest, config)
    started = perf_counter()
    wave = len(list(output.glob('wave-*-worker-00.json')))
    files = sorted((output / 'boards').glob('*.json'))
    completed = {board['index']: board for path in files
                 if verify_board(board := read(path), output, args.seed, args.checkpoints, args.round_robin, mixed)}
    attempted = {int(path.stem) for path in files}
    while len(completed) < args.boards:
        needed = args.boards - len(completed)
        indexes = []
        index = 0
        while len(indexes) < needed:
            if index not in attempted:
                indexes.append(index)
            index += 1
        emit({'stage': 'boards', 'completed': len(completed), 'scheduled': needed})
        run_wave(manifest, indexes, args.workers, wave)
        previous = len(completed)
        for index in indexes:
            board = read(output / 'boards' / f'{index:04}.json')
            if verify_board(board, output, args.seed, args.checkpoints, args.round_robin, mixed):
                completed[index] = board
        if len(completed) == previous:
            raise RuntimeError('No games passed the fixed-board comparison; review the saved replays')
        attempted.update(indexes)
        wave += 1
    boards = [completed[index] for index in sorted(completed)]
    report = {'boards': len(boards), 'games': sum(len(board['games']) for board in boards),
              'excluded_boards': sorted(attempted - completed.keys()),
              'seconds': round(perf_counter() - started, 2)}
    if args.round_robin:
        report.update(summarize_round_robin(boards, args.checkpoints))
    else:
        report['results'] = {str(games): summarize([r for board in boards for r in board['games']
                                                   if r['pair'] == f'{games}-vs-benchmark'])
                             for games in args.checkpoints}
        report['paired_differences'] = paired_intervals(boards, args.checkpoints)
    if mixed:
        report['rule_mix'] = RULE_MIX
        report['by_difficulty'] = {}
        for left, right in matchups(args.checkpoints, args.round_robin):
            pair = f'{left}-vs-{right}'
            rows = [row for board in boards for row in board['games'] if row['pair'] == pair]
            report['by_difficulty'][pair] = summarize_by_difficulty(rows)
    write_json(output / 'results.json', report)
    emit({'stage': 'complete', **report})


if __name__ == '__main__':
    if len(sys.argv) == 4 and sys.argv[1] == '--worker':
        worker(Path(sys.argv[2]), Path(sys.argv[3]))
    else:
        main()
