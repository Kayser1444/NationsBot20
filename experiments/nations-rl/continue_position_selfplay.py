"""Continue the structured scorer to a fixed self-play game count."""
import argparse
from contextlib import ExitStack
from hashlib import sha256
import json
from pathlib import Path
import random
import shutil
import subprocess
import sys
from time import perf_counter

import torch

from ability_encoding import REPLACEMENT_SCHEMA, ReplacementAbilityEncoder, SCHEMA as ABILITY_SCHEMA
from compare_position_encoding import (
    StaticFallback, card_catalog, expand, load_structured, position_encoder, summarize_by_difficulty,
)
from encoding import Encoder
from mixed_encoding import SCHEMA as MIXED_SCHEMA
from mixed_rules import RULE_MIX, rules_for_board
from model import collate, load_model
from position_encoding import SCHEMA
from train import ROOT, RULES, board_seed, digest, emit, ppo_update, seed_all, summarize, write_json
from train_position_selfplay import collect_games, collected_samples, read_json
from wonder_encoding import SCHEMA as WONDER_SCHEMA


def run_worker(batch, checkpoint, seed):
    seed_all(seed, 1)
    sys.path.insert(0, str(batch / 'snapshot/engine'))
    from nations import Match

    schema = read_checkpoint(checkpoint)['encoding_version']
    encoder = position_encoder(batch, schema)
    model = load_structured(checkpoint, schema)
    reference_logits = None
    if isinstance(encoder, ReplacementAbilityEncoder):
        benchmark = batch / read_json(batch / 'selection.json')['selected']
        reference_model = load_model(benchmark)[0].eval()
        reference_encoder = Encoder(card_catalog(batch))

        @torch.no_grad()
        def reference_logits(state, moves):
            if not reference_encoder.supports(state):
                return torch.zeros(len(moves)).numpy()
            features, reference_moves = reference_encoder.encode(state)
            logits, _ = reference_model(collate([features]))
            indexes = {move: index for index, move in enumerate(reference_moves)}
            return logits[0, [indexes[move] for move in moves]].numpy()

    fallback = StaticFallback(batch)
    try:
        for line in sys.stdin:
            task = json.loads(line)
            model.load_state_dict(read_checkpoint(checkpoint)['parameters'])
            file = Path(task['file'])
            collect_games(Match, encoder, model, fallback, task['episodes'], file, reference_logits)
            emit({'file': str(file)})
    finally:
        fallback.close()


def read_checkpoint(path):
    return torch.load(path, map_location='cpu', weights_only=True)


def close_worker(process):
    process.stdin.close()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.terminate()
        process.wait(timeout=10)
    finally:
        process.stdout.close()


def start_workers(args, checkpoint, stack):
    workers = []
    for index in range(args.workers):
        log_path = args.output / f'worker-{index:02}.log'
        with log_path.open('a', encoding='utf-8') as log:
            process = subprocess.Popen(
                [sys.executable, '-B', str(Path(__file__).resolve()), '--worker',
                 str(args.batch), str(checkpoint), str(args.seed)],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log,
                text=True, encoding='utf-8', bufsize=1,
            )
        stack.callback(close_worker, process)
        workers.append((process, log_path))
    return workers


def collect_batch(workers, directory, episodes, wave):
    width = min(len(workers), len(episodes))
    work = []
    for index, (process, log) in enumerate(workers[:width]):
        group = episodes[index * len(episodes) // width:(index + 1) * len(episodes) // width]
        path = directory / f'wave-{wave:02}-worker-{index:02}'
        process.stdin.write(json.dumps({'episodes': group, 'file': str(path)}) + '\n')
        process.stdin.flush()
        work.append((process, log, path, group))
    games, files = [], []
    for process, log, path, group in work:
        line = process.stdout.readline()
        if not line:
            raise RuntimeError(f'A self-play worker stopped; see {log}')
        if json.loads(line).get('file') != str(path):
            raise RuntimeError('A self-play worker replied for the wrong batch')
        rows = read_json(path.with_suffix('.games.json'))
        expected = [(seed, settings[0] if settings else None) for seed, _, *settings in group]
        if [(row['seed'], row.get('rules')) for row in rows] != expected:
            raise RuntimeError('A self-play worker returned the wrong games')
        games.extend(rows)
        if any(not row['error'] for row in rows):
            files.append(path.with_suffix('.npz'))
    return games, files


def save_checkpoint(path, model, metadata, *, schema, **extra):
    staged = path.with_suffix('.tmp')
    torch.save({'encoding_version': schema, 'config': model.config,
                'parameters': model.state_dict(), 'metadata': metadata, **extra}, staged)
    staged.replace(path)


class BatchMonitor:
    def __init__(self, args, initial_games):
        self.args = args
        self.initial_games = initial_games
        self.path = args.output / 'monitoring.json'
        if args.resume:
            self.history = read_json(self.path)
            if args.improve_either:
                for index, record in enumerate(self.history):
                    self.mark_improvement(record, self.history[:index])
                write_json(self.path, self.history)
        else:
            reference = self.result(args.reference_results, args.monitor_seed)
            self.history = [{'games': initial_games, 'result': reference, 'improved': True,
                             'stale_batches': 0, 'checkpoint': str(args.initial)}]
            write_json(self.path, self.history)

    def result(self, result_path, seed):
        report = read_json(result_path)
        if report.get('evaluation_opponent') != self.args.evaluation_opponent:
            raise ValueError(f'Evaluation opponent differs in {result_path}')
        matches = report['matches']
        mixed = self.args.schema == MIXED_SCHEMA
        expected = {(board_seed(SCHEMA, seed, index), f'Seat{seat}'):
                    rules_for_board(seed, index) if mixed else None
                    for index in range(self.args.monitor_boards) for seat in range(2)}
        actual = {(row['seed'], row['candidate']): row.get('rules') for row in matches}
        if (len(matches) != len(expected) or actual != expected or any(
                row['error'] or row['pair'] != 'structured-vs-benchmark' for row in matches)):
            raise ValueError(f'Incomplete or mismatched benchmark games in {result_path}')
        result = summarize(matches)
        if mixed:
            result['by_difficulty'] = summarize_by_difficulty(matches)
        return result

    @staticmethod
    def rank(record):
        result = record['result']
        return result['wins'], result['mean_vp_margin']

    @property
    def best(self):
        return max(self.history, key=self.rank)

    def mark_improvement(self, record, previous):
        improved = True
        if previous:
            wins, margin = self.rank(record)
            if self.args.improve_either:
                improved = (wins > max(row['result']['wins'] for row in previous)
                            or margin > max(row['result']['mean_vp_margin'] for row in previous))
            else:
                improved = (wins, margin) > max(map(self.rank, previous))
        record.update(improved=improved, stale_batches=0 if improved else previous[-1]['stale_batches'] + 1)

    def evaluate(self, label, checkpoint, seed):
        directory = self.args.output / 'benchmarks' / label
        directory.mkdir(parents=True, exist_ok=True)
        (directory / 'replays').mkdir(exist_ok=True)
        result = directory / 'results.json'
        if not result.exists():
            shutil.copyfile(checkpoint, directory / 'structured.pt')
            manifest = read_json(self.args.output / 'manifest.json')
            manifest['encoding'] = read_checkpoint(checkpoint)['encoding_version']
            write_json(directory / 'manifest.json', manifest)
            subprocess.run([sys.executable, '-B', str(Path(__file__).with_name('compare_position_encoding.py')),
                            '--batch', str(self.args.batch), '--output', str(directory), '--evaluate-only',
                            '--benchmark-only', '--boards', str(self.args.monitor_boards),
                            '--seed', str(seed), '--workers', str(self.args.evaluation_workers),
                            '--processes'], check=True)
        return self.result(result, seed), directory / 'structured.pt'

    def check(self, games, resume_path):
        if games == self.history[-1]['games']:
            return
        if games != self.history[-1]['games'] + self.args.monitor_every:
            raise ValueError('Evaluation would skip a training batch boundary')
        emit({'stage': 'monitor', 'games': games, 'previous_best_games': self.best['games']})
        result, checkpoint = self.evaluate(f'games-{games:06}', resume_path, self.args.monitor_seed)
        record = {'games': games, 'result': result, 'checkpoint': str(checkpoint)}
        self.mark_improvement(record, self.history)
        self.history.append(record)
        write_json(self.path, self.history)
        emit({'stage': 'monitored', **record, 'best_games': self.best['games']})

    def stalled(self, games):
        return (games - self.initial_games >= self.args.min_batches * self.args.monitor_every
                and self.history[-1]['stale_batches'] >= self.args.patience)

    def finish(self, games):
        checkpoint = Path(self.best['checkpoint'])
        selected = self.args.output / 'selected.pt'
        candidate = read_checkpoint(checkpoint)
        candidate = {key: candidate[key] for key in ('encoding_version', 'config', 'parameters', 'metadata')}
        staged = selected.with_suffix('.tmp')
        torch.save(candidate, staged)
        staged.replace(selected)
        emit({'stage': 'held-out', 'games': self.best['games']})
        holdout, _ = self.evaluate('held-out-selected', selected, self.args.holdout_seed)
        selection = {
            'stop_reason': f'{self.args.patience} consecutive batches without improvement'
            if self.stalled(games) else 'game budget reached',
            'training_games': games, 'selected_games': self.best['games'],
            'selected_sha256': digest(selected), 'monitor_result': self.best['result'], 'held_out_result': holdout,
        }
        if self.args.improve_either:
            best_margin = max(self.history, key=lambda record: self.rank(record)[::-1])
            margin_holdout = holdout
            if best_margin['games'] != self.best['games']:
                emit({'stage': 'held-out', 'games': best_margin['games'], 'criterion': 'VP margin'})
                margin_holdout, _ = self.evaluate('held-out-best-vp', Path(best_margin['checkpoint']),
                                                  self.args.holdout_seed)
            selection['best_vp'] = {**best_margin, 'held_out_result': margin_holdout}
        write_json(self.args.output / 'selection.json', selection)
        emit({'stage': 'selection', **selection})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--batch', type=Path, default=ROOT / '.data/nations-rl/batch-10000-v1')
    parser.add_argument('--initial', type=Path,
                        default=ROOT / '.data/nations-rl/current-position-selfplay-v1/structured.pt')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--games', type=int, default=2000, help='Total completed games including the starting checkpoint.')
    parser.add_argument('--games-per-update', type=int, default=48)
    parser.add_argument('--workers', type=int, default=6)
    parser.add_argument('--seed', type=int, default=181135)
    parser.add_argument('--learning-rate', type=float, default=.0001)
    parser.add_argument('--resume', action='store_true')
    encodings = parser.add_mutually_exclusive_group()
    encodings.add_argument('--abilities', dest='schema', action='store_const', const=ABILITY_SCHEMA,
                           help='Append publicly visible special-ability inputs to the direct policy.')
    encodings.add_argument('--replace-card-ids', dest='schema', action='store_const', const=REPLACEMENT_SCHEMA,
                           help='Replace existing identities for special cards with ability features.')
    encodings.add_argument('--normalize-wonder-slots', dest='schema', action='store_const', const=WONDER_SCHEMA,
                           help='Normalize wonder slots when continuing a replacement-ability checkpoint.')
    encodings.add_argument('--mixed-settings', dest='schema', action='store_const', const=MIXED_SCHEMA,
                           help='Continue a normalized wonder-slot policy on mixed two-player rules.')
    parser.set_defaults(schema=SCHEMA)
    parser.add_argument('--monitor-every', type=int, help='Run a fixed-board evaluation after this many additional games.')
    parser.add_argument('--reference-results', type=Path, help='Existing result on the fixed boards for the starting checkpoint.')
    parser.add_argument('--patience', type=int, default=2)
    parser.add_argument('--min-batches', type=int, default=0,
                        help='Complete at least this many monitoring batches before applying patience.')
    parser.add_argument('--evaluation-opponent', type=Path,
                        help='Use this fixed policy checkpoint for monitoring and holdout.')
    parser.add_argument('--improve-either', action='store_true',
                        help='Reset patience on a new high in wins or mean VP margin.')
    parser.add_argument('--monitor-boards', type=int, default=64)
    parser.add_argument('--monitor-seed', type=int, default=181136)
    parser.add_argument('--holdout-seed', type=int, default=181139)
    parser.add_argument('--evaluation-workers', type=int, default=4)
    args = parser.parse_args()
    if min(args.games, args.games_per_update, args.workers) < 1:
        parser.error('Games and worker count must be positive')
    if (args.improve_either or args.min_batches or args.evaluation_opponent) and args.monitor_every is None:
        parser.error('Improvement settings and an evaluation opponent require --monitor-every')
    if args.min_batches < 0:
        parser.error('--min-batches must be nonnegative')
    args.batch, args.initial, args.output = (path.resolve() for path in (args.batch, args.initial, args.output))
    checkpoint = args.batch / read_json(args.batch / 'selection.json')['selected']
    benchmark_hash = digest(checkpoint)
    frozen = read_json(args.batch / 'manifest.json')
    if frozen['rules'] != RULES:
        raise ValueError('Training rules differ from the frozen benchmark')
    seed_all(args.seed, min(args.workers, 4))
    initial = read_checkpoint(args.initial)
    initial_games = initial['metadata']['games_per_arm']
    if initial['metadata']['benchmark'] != benchmark_hash or initial_games >= args.games:
        raise ValueError('Expected a compatible starting checkpoint below the target game count')
    if args.monitor_every is not None:
        if (min(args.monitor_every, args.patience, args.monitor_boards, args.evaluation_workers) < 1
                or not args.reference_results or args.monitor_seed == args.holdout_seed
                or (args.games - initial_games) % args.monitor_every
                or args.min_batches * args.monitor_every > args.games - initial_games):
            parser.error('Monitoring needs positive sizes, a reference result, distinct board seeds and full batches')
    schema = args.schema
    initial_schema = initial['encoding_version']
    warm_start_schema = {ABILITY_SCHEMA: SCHEMA, REPLACEMENT_SCHEMA: SCHEMA, WONDER_SCHEMA: REPLACEMENT_SCHEMA,
                         MIXED_SCHEMA: WONDER_SCHEMA}
    widen = initial_schema == warm_start_schema.get(schema)
    if initial_schema != schema and not widen:
        raise ValueError('Starting checkpoint uses a different encoding')
    resume_path = args.output / 'resume.pt'
    model = load_structured(resume_path if args.resume else args.initial, schema if args.resume else initial_schema)
    ability_ids = None
    if schema != SCHEMA:
        encoder = position_encoder(args.batch, schema)
        ability_ids = list(encoder.ability_ids)
        if initial_schema != SCHEMA and initial['metadata'].get('ability_ids') != ability_ids:
            raise ValueError('Starting checkpoint uses a different ability catalog')
        if widen and not args.resume:
            if schema == MIXED_SCHEMA:
                added_state, added_actions = encoder.extra_mixed_state_size, encoder.extra_mixed_action_size
            elif schema == WONDER_SCHEMA:
                added_state, added_actions = encoder.capacity_size, 0
            else:
                added_state, added_actions = encoder.extra_state_size, len(ability_ids)
            model = expand(model, {'sn': torch.empty(model.config['state_size'] + added_state),
                                   'an': torch.empty(1, model.config['action_size'] + added_actions)})
    old = load_model(checkpoint)[0]
    example = {'sn': torch.empty(model.config['state_size']),
               'an': torch.empty(1, model.config['action_size'])}
    anchor = expand(old, example).eval()
    optimizer = torch.optim.Adam(model.parameters(), lr=args.learning_rate)
    setup = {'batch': str(args.batch), 'initial_sha256': digest(args.initial),
             'benchmark_sha256': benchmark_hash, 'encoding': schema, 'rules': RULES,
             'target_games': args.games, 'games_per_update': args.games_per_update,
             'training_seed': args.seed, 'learning_rate': args.learning_rate}
    if args.evaluation_opponent is not None:
        opponent = args.evaluation_opponent.resolve()
        args.evaluation_opponent = {'path': str(opponent), 'sha256': digest(opponent),
                                    'encoding': read_checkpoint(opponent)['encoding_version']}
        setup['evaluation_opponent'] = args.evaluation_opponent
    if schema == MIXED_SCHEMA:
        setup['rule_mix'] = RULE_MIX
    if args.monitor_every:
        setup['monitoring'] = {
            'every': args.monitor_every, 'patience': args.patience, 'boards': args.monitor_boards,
            'seed': args.monitor_seed, 'holdout_seed': args.holdout_seed,
            'reference_sha256': digest(args.reference_results),
        }
        if args.improve_either:
            setup['monitoring']['improve_either'] = True
        if args.min_batches:
            setup['monitoring']['min_batches'] = args.min_batches
    metadata = {'kind': 'structured-self-play-continuation', 'benchmark': benchmark_hash,
                'games_per_arm': initial_games}
    if schema != SCHEMA:
        setup['ability_ids'] = ability_ids
        metadata['ability_ids'] = ability_ids
    history = []
    if args.resume:
        manifest = read_json(args.output / 'manifest.json')
        if any(manifest.get(key) != value for key, value in setup.items()):
            raise ValueError('Continuation settings differ from the saved run')
        saved = read_checkpoint(resume_path)
        metadata, history = saved['metadata'], saved['history']
        optimizer.load_state_dict(saved['optimizer'])
    else:
        args.output.mkdir(parents=True)
        (args.output / 'replays').mkdir()
        write_json(args.output / 'manifest.json', {
            **setup, 'initial_games': initial_games,
            'source_sha256': {name: digest(Path(__file__).with_name(name)) for name in (
                'continue_position_selfplay.py', 'train_position_selfplay.py', 'compare_position_encoding.py',
                'ability_encoding.py', 'wonder_encoding.py', 'mixed_encoding.py', 'mixed_rules.py',
                'position_encoding.py', 'encoding.py', 'model.py', 'train.py')},
        })
        if 'optimizer' in initial and not widen:
            optimizer.load_state_dict(initial['optimizer'])
            for group in optimizer.param_groups:
                group['lr'] = args.learning_rate
        save_checkpoint(resume_path, model, metadata, schema=schema,
                        history=history, optimizer=optimizer.state_dict())
    monitor = BatchMonitor(args, initial_games) if args.monitor_every else None
    human_seeds = set(frozen['human_seed_hashes'])
    games = metadata['games_per_arm']
    attempted = history[-1]['attempted'] if history else 0
    started = perf_counter()
    with ExitStack() as stack:
        workers = start_workers(args, resume_path, stack) if games < args.games else []
        while True:
            if monitor and (games - initial_games) % args.monitor_every == 0:
                monitor.check(games, resume_path)
                if monitor.stalled(games):
                    break
            if games >= args.games:
                break
            update = len(history) + 1
            count = min(args.games_per_update, args.games - games)
            if monitor:
                count = min(count, args.monitor_every - (games - initial_games) % args.monitor_every)
            directory = args.output / f'update-{update:03}'
            directory.mkdir(exist_ok=True)
            remaining, wave, files, failed = count, 0, [], []
            collection_start = perf_counter()
            while remaining:
                indexes = range(attempted, attempted + remaining)
                episodes = [(board_seed('structured-2000-self-play', args.seed, i), args.seed + i) for i in indexes]
                if schema == MIXED_SCHEMA:
                    episodes = [(*episode, rules_for_board(args.seed, i)) for i, episode in zip(indexes, episodes)]
                if any(sha256(bytes.fromhex(seed)).hexdigest() in human_seeds for seed, *_ in episodes):
                    raise ValueError('Generated self-play board overlaps the human corpus')
                outcomes, samples = collect_batch(workers, directory, episodes, wave)
                failures = [row for row in outcomes if row['error']]
                if len(failures) == remaining:
                    raise RuntimeError(f'All games in the collection batch failed; see {directory}')
                failed.extend(failures)
                files.extend(samples)
                attempted += remaining
                remaining = len(failures)
                wave += 1
            collection_seconds = perf_counter() - collection_start
            rows = [row for file in files for row in collected_samples(file)]
            model.train()
            metrics = ppo_update(model, anchor, rows, optimizer, random.Random(args.seed + update))
            del rows
            games += count
            record = {'update': update, 'games': games, 'attempted': attempted,
                      'failures': len(failed), 'collect_seconds': round(collection_seconds, 2),
                      'elapsed_this_session': round(perf_counter() - started, 2), 'ppo': metrics}
            history.append(record)
            metadata = {**metadata, 'games_per_arm': games}
            save_checkpoint(resume_path, model, metadata, schema=schema,
                            history=history, optimizer=optimizer.state_dict())
            write_json(args.output / 'training.json', history)
            for file in files:
                file.unlink()
            emit({'stage': 'updated', **record})
    save_checkpoint(args.output / 'structured.pt', model, metadata, schema=schema)
    emit({'stage': 'trained', 'games': games, 'attempted': attempted,
          'elapsed_this_session': round(perf_counter() - started, 2)})
    if monitor:
        monitor.finish(games)


if __name__ == '__main__':
    if len(sys.argv) == 5 and sys.argv[1] == '--worker':
        run_worker(Path(sys.argv[2]), Path(sys.argv[3]), int(sys.argv[4]))
    else:
        main()
