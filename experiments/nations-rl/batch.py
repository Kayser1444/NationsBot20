"""Train and benchmark a resumable policy batch using a frozen pilot environment."""
import argparse
import atexit
from collections import Counter
from concurrent.futures import ProcessPoolExecutor
from contextlib import contextmanager
from functools import lru_cache
import hashlib
import json
import os
from pathlib import Path
import random
import shutil
import sys
import time

import torch
import numpy as np

from encoding import Encoder
from model import PolicyValue, load_model, save_model
from train import (HERE, RULES, LEAGUE_POINTS, SAFETY_SOURCE, Baseline, board_seed, digest, emit, paired_improvement,
                   play_game, ppo_update, seed_all, summarize, verify_snapshot, write_json)


@contextmanager
def exclusive_run(output):
    # An OS lock is released even when the training process is killed.
    with (output / 'batch.lock').open('a+b') as lock:
        lock.seek(0, os.SEEK_END)
        if lock.tell() == 0:
            lock.write(b'\0')
            lock.flush()
        lock.seek(0)
        if os.name == 'nt':
            import msvcrt
            acquire = lambda: msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            acquire = lambda: fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            acquire()
        except OSError as error:
            raise RuntimeError(f'Another process holds the run lock for {output}') from error
        yield


def save_state(path, state):
    temporary = path.with_suffix('.pending')
    with temporary.open('wb') as stream:
        torch.save(state, stream)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)


def append_rows(path, offset, rows):
    """Append one update's journal rows and return the new byte offset."""
    with path.open('ab') as stream:
        if stream.tell() != offset:
            raise ValueError(f'Unexpected journal length for {path.name}')
        for row in rows:
            stream.write((json.dumps(row, separators=(',', ':'), allow_nan=False) + '\n').encode('utf-8'))
        stream.flush()
        os.fsync(stream.fileno())
        return stream.tell()


def restore_journal(path, offset):
    """Discard rows from a PPO update whose checkpoint was never committed."""
    with path.open('a+b') as stream:
        if stream.tell() < offset:
            raise ValueError(f'{path.name} is shorter than its committed checkpoint offset')
        stream.truncate(offset)


def snapshot_batch(args, output, parent):
    manifest = verify_snapshot(parent, runtime_sources=('model.py', 'encoding.py', 'baseline-bridge.mjs'))
    pretrained, _ = load_model(parent / 'pretrained.pt')
    learner, metadata = load_model(args.initial)
    if learner.config != pretrained.config:
        raise ValueError('Starting policy has different dimensions from the pretrained policy')
    snapshot = output / 'snapshot'
    for folder in ('baseline', 'engine'):
        shutil.copytree(parent / 'snapshot' / folder, snapshot / folder)
    (snapshot / 'experiment').mkdir()
    for name in ('batch.py', 'train.py', 'model.py', 'encoding.py', 'baseline-bridge.mjs', 'requirements.txt'):
        shutil.copy2(HERE / name, snapshot / 'experiment' / name)
    shutil.copy2(SAFETY_SOURCE, snapshot / 'experiment' / SAFETY_SOURCE.name)
    (output / 'checkpoints').mkdir()
    (output / 'evaluations').mkdir()
    (output / 'replays').mkdir()
    shutil.copy2(args.initial, output / 'start.pt')
    shutil.copy2(parent / 'pretrained.pt', output / 'pretrained.pt')
    config = {name: getattr(args, name) for name in ('games', 'games_per_update', 'monitor_every',
              'monitor_boards', 'final_boards', 'learning_rate', 'seed', 'game_seconds')}
    config['players'] = learner.config.get('player_count', 2)
    if args.patience is not None:
        if config['players'] != 4:
            raise ValueError('League-point patience requires a four-player checkpoint')
        config['patience'] = args.patience
    repository = Path(manifest['repository_root'])
    protected = {p.name: digest(p) for p in sorted((repository / 'live-player').glob('*.json'))}
    batch_manifest = {'config': config, 'rules': RULES, 'parent_run': str(parent),
                      'repository_root': str(repository), 'protected_models_before': protected,
                      'initial_checkpoint': str(args.initial.resolve()), 'initial_metadata': metadata,
                      'human_seed_hashes': sorted({seed for seeds in manifest.get('archive_audit', {}).get(
                          'seed_hashes', {}).values() for seed in seeds}),
                      'torch': str(torch.__version__), 'python': sys.version,
                      'source_sha256': {p.relative_to(output).as_posix(): digest(p)
                          for p in sorted(snapshot.rglob('*')) if p.is_file()} |
                          {name: digest(output / name) for name in ('start.pt', 'pretrained.pt')}}
    write_json(output / 'manifest.json', batch_manifest)
    seed_all(config['seed'], 2)
    optimizer = torch.optim.Adam(learner.parameters(), lr=config['learning_rate'])
    state = {'version': 1, 'manifest_sha256': digest(output / 'manifest.json'),
             'episode': 0, 'update': 0, 'model_config': learner.config,
             'model': learner.state_dict(), 'optimizer': optimizer.state_dict(),
             'rng': random.Random(config['seed']).getstate(), 'torch_rng': torch.get_rng_state(),
             'pool': ['start.pt', 'pretrained.pt'], 'checkpoints': ['start.pt'],
             'training_seconds': 0., 'all_samples': 0, 'complete_games': 0,
             'failures': {}, 'training.jsonl': 0, 'updates.jsonl': 0}
    save_state(output / 'resume.pt', state)
    return batch_manifest


def load_batch(output):
    manifest = json.loads((output / 'manifest.json').read_text(encoding='utf-8'))
    for path, expected in manifest['source_sha256'].items():
        if digest(output / path) != expected:
            raise ValueError(f'Run input changed: {path}')
        if path.startswith('snapshot/experiment/') and digest(HERE / Path(path).name) != expected:
            raise ValueError(f'Use the frozen entry point at {output / "snapshot/experiment/batch.py"}')
    return manifest


_worker = {}


def initialize_worker(output, player_count):
    seed_all(0, 1)
    sys.path.insert(0, str(output / 'snapshot/engine'))
    from nations import Match
    encoder = Encoder(json.loads((output / 'snapshot/baseline/card-index.json').read_text(encoding='utf-8')), player_count)
    baseline = Baseline(output)
    atexit.register(baseline.close)
    _worker.update(output=output, match=Match, encoder=encoder, baseline=baseline)


@lru_cache(maxsize=8)
def worker_policy(name):
    if name in (None, 'heuristic'):
        return name
    return load_model(_worker['output'] / name)[0].eval()


def play_chunk(task):
    mode, jobs, seconds = task
    output = _worker['output']
    learner = None
    if mode == 'train':
        # The parent waits for all games before replacing the shared checkpoint.
        state = torch.load(output / 'resume.pt', map_location='cpu', weights_only=True)
        learner = PolicyValue(**state['model_config'])
        learner.load_state_dict(state['model'])
        learner.eval()
    rows, samples = [], []
    for job in jobs:
        actor = job['actor']
        rival = job['rival']
        candidate = learner if mode == 'train' else worker_policy(job['candidate'])
        opponents = job.get('opponents') or {rival: job['opponent']}
        policies = {actor: candidate, **{seat: learner if name == 'current' else worker_policy(name)
                                         for seat, name in opponents.items()}}
        row, trajectory = play_game(
            _worker['match'], _worker['encoder'], _worker['baseline'], policies,
            job.get('learners', ()), job['seed'], output / 'replays' / job['replay'] if mode == 'eval' else None,
            mode == 'train', job['sampling_seed'], seconds=seconds,
            failure_output=output / 'replays' / job['replay'] if mode == 'train' else None)
        if mode == 'train':
            row.update(episode=job['episode'], opponent_kind=job['kind'],
                       opponent_checkpoint=job.get('opponents', job['opponent']), learner_seats=job['learners'])
        else:
            row.update(board=job['board'], candidate=actor, opponent=rival)
        rows.append(row)
        samples.extend(trajectory)
    return rows, samples


def run_games(executor, workers, mode, jobs, seconds):
    # Contiguous chunks preserve trajectory order regardless of worker count.
    chunk_size = (len(jobs) + workers - 1) // workers
    tasks = [(mode, jobs[start:start+chunk_size], seconds) for start in range(0, len(jobs), chunk_size)]
    rows, samples = [], []
    for game_rows, decisions in executor.map(play_chunk, tasks):
        rows.extend(game_rows)
        samples.extend(decisions)
    return rows, samples


def four_player_opponents(seat, lineup):
    return {f'Seat{(seat + distance) % 4}': policy for distance, policy in enumerate(lineup, 1)}


def make_training_jobs(config, state, end, rng, seeds):
    jobs = []
    for episode in range(state['episode'], end):
        count = config.get('players', 2)
        seat = (episode + episode // 4) % count
        actor, rival = f'Seat{seat}', f'Seat{(seat + 1) % count}'
        kind = ('self-play', 'baseline', 'self-play', 'history')[episode % 4]
        opponent = 'current' if kind == 'self-play' else None
        if kind == 'history':
            opponent = rng.choice(state['pool'])
        job = {'actor': actor, 'rival': rival, 'episode': episode + 1, 'kind': kind,
               'opponent': opponent, 'learners': [actor, rival] if kind == 'self-play' else [actor],
               'seed': seeds('batch-training', episode), 'sampling_seed': config['seed'] + episode,
               'replay': f'train-{episode + 1:06}.replay'}
        if count == 4:
            lineup = ([opponent] * 3 if kind == 'self-play' else [opponent, None, 'heuristic'])
            if kind != 'self-play':
                rng.shuffle(lineup)
            job['opponents'] = four_player_opponents(seat, lineup)
            job['learners'] = [actor, *job['opponents']] if kind == 'self-play' else [actor]
        jobs.append(job)
    return jobs


def make_seeds(manifest):
    known = set(manifest['human_seed_hashes'])
    def checked_seed(namespace, index):
        seed = board_seed(namespace, manifest['config']['seed'], index)
        if hashlib.sha256(bytes.fromhex(seed)).hexdigest() in known:
            raise ValueError('Generated board seed overlaps the human corpus')
        return seed
    return checked_seed


def four_points(rows):
    return {(row['seed'], row['candidate']): LEAGUE_POINTS[row['ranks'][row['candidate']] - 1] if not row['error'] else 1
            for row in rows}


def four_summary(rows):
    placements = Counter(row['ranks'][row['candidate']] for row in rows if not row['error'])
    return {'games': len(rows), 'failures': sum(bool(row['error']) for row in rows),
            'placements': [placements[rank] for rank in range(1, 5)],
            'mean_league_points': float(np.mean(list(four_points(rows).values())))}


def paired_points(reference, candidate):
    left, right = four_points(reference), four_points(candidate)
    if left.keys() != right.keys():
        raise ValueError('Four-player comparisons require identical boards and seats')
    boards = sorted({seed for seed, _ in left})
    differences = np.asarray([np.mean([right[(seed, f'Seat{seat}')] - left[(seed, f'Seat{seat}')]
                                      for seat in range(4)]) for seed in boards])
    rng = np.random.default_rng(32901)
    samples = rng.choice(differences, size=(5000, len(boards))).mean(axis=1)
    return {'boards': len(boards), 'mean_gain': float(differences.mean()),
            'interval_95': np.quantile(samples, [.025, .975]).tolist()}


def evaluate(executor, workers, output, config, seeds, label, namespace, boards, candidate, opponent=None, mixed=False):
    destination = output / 'evaluations' / f'{label}.json'
    if destination.exists():
        return json.loads(destination.read_text(encoding='utf-8'))
    count = config.get('players', 2)
    jobs = []
    for board in range(boards):
        for seat in range(count):
            job = {'actor': f'Seat{seat}', 'rival': f'Seat{(seat + 1) % count}', 'candidate': candidate,
                   'opponent': opponent, 'board': board, 'seed': seeds(namespace, board),
                   'sampling_seed': config['seed'], 'replay': f'{label}-{board:03}-{seat}.replay'}
            if count == 4:
                lineup = [opponent] * 3
                if mixed:
                    lineup[board % 3] = 'heuristic'
                job['opponents'] = four_player_opponents(seat, lineup)
            jobs.append(job)
    rows, _ = run_games(executor, workers, 'eval', jobs, config['game_seconds'])
    result = {'candidate': candidate, 'opponent': opponent or 'baseline', 'board_set': namespace,
              'summary': four_summary(rows) if count == 4 else summarize(rows), 'games': rows}
    write_json(destination, result)
    emit({'stage': 'evaluation', 'label': label, **result['summary']})
    return result


def benchmark(executor, workers, output, config, seeds, checkpoints):
    champion = None
    results = {}
    for checkpoint in checkpoints:
        label = 'monitor-' + Path(checkpoint).stem
        result = evaluate(executor, workers, output, config, seeds, label, 'batch-monitor',
                          config['monitor_boards'], checkpoint)
        summary = result['summary']
        results[label] = summary
        if champion is not None and config.get('players', 2) == 2:
            match = evaluate(executor, workers, output, config, seeds, label + '-vs-champion',
                             'batch-monitor-duel', config['monitor_boards'], checkpoint, champion[1])
            results[label + '-vs-champion'] = match['summary']
        rank = ((summary['mean_league_points'], 0 if config.get('patience') else -summary['failures']) if config.get('players') == 4 else
                (summary['wins'], summary['mean_vp_margin'] if summary['mean_vp_margin'] is not None else -float('inf')))
        if champion is None or rank > champion[0]:
            champion = (rank, checkpoint)
    return champion[1], results


def batches_without_improvement(checkpoints, monitoring):
    best, stalled = -float('inf'), 0
    for checkpoint in checkpoints:
        points = monitoring['monitor-' + Path(checkpoint).stem]['mean_league_points']
        if points > best:
            best, stalled = points, 0
        else:
            stalled += 1
    return stalled


def train_batch(output, manifest, workers, max_updates):
    config = manifest['config']
    seed_all(config['seed'], 2)
    state = torch.load(output / 'resume.pt', map_location='cpu', weights_only=True)
    if state['version'] != 1 or state['manifest_sha256'] != digest(output / 'manifest.json'):
        raise ValueError('Checkpoint does not match the batch manifest')
    for name in ('training.jsonl', 'updates.jsonl'):
        restore_journal(output / name, state[name])
    model = PolicyValue(**state['model_config'])
    model.load_state_dict(state['model'])
    optimizer = torch.optim.Adam(model.parameters(), lr=config['learning_rate'])
    optimizer.load_state_dict(state['optimizer'])
    rng = random.Random()
    rng.setstate(state['rng'])
    torch.set_rng_state(state['torch_rng'])
    anchor, _ = load_model(output / 'pretrained.pt')
    seeds = make_seeds(manifest)
    failures = Counter(state['failures'])
    updates_this_session = 0
    emit({'stage': 'start', 'games_committed': state['episode'], 'target_games': config['games'], 'workers': workers})
    four_player = config.get('players') == 4
    patience = config.get('patience')
    budget = config['games'] if patience is None else float('inf')
    with ProcessPoolExecutor(max_workers=workers, initializer=initialize_worker,
                             initargs=(output, config.get('players', 2))) as executor:
        champion, monitoring = benchmark(executor, workers, output, config, seeds, state['checkpoints'])
        stalled = batches_without_improvement(state['checkpoints'], monitoring) if patience else 0
        while state['episode'] < budget and (patience is None or stalled < patience):
            started = time.monotonic()
            episode = state['episode']
            next_monitor = (episode // config['monitor_every'] + 1) * config['monitor_every']
            end = min(budget, episode + config['games_per_update'], next_monitor)
            jobs = make_training_jobs(config, state, end, rng, seeds)
            rows, samples = run_games(executor, workers, 'train', jobs, config['game_seconds'])
            if not samples:
                raise RuntimeError(f'No completed trajectories in games {episode + 1} to {end}: {rows[0]["error"]}')
            metrics = ppo_update(model, anchor, samples, optimizer, rng)
            duration = time.monotonic() - started
            failures.update(r['error'] for r in rows if r['error'])
            update = state['update'] + 1
            event = {'stage': 'ppo-update', 'games': end, 'update': update, 'seconds': round(duration, 2),
                     'failures': sum(failures.values()), **metrics}
            if end == next_monitor or end == budget:
                checkpoint = f'checkpoints/games-{end:06}.pt'
                previous_games = manifest['initial_metadata'].get('games', 0) if four_player else 0
                save_model(output / checkpoint, model, {'kind': 'ppo-batch', 'games': previous_games + end,
                                                        'batch_games': end, 'update': update})
                state['checkpoints'].append(checkpoint)
                state['pool'] = ['start.pt', 'pretrained.pt', *state['checkpoints'][1:][-4:]]
            state.update(episode=end, update=update, model=model.state_dict(), optimizer=optimizer.state_dict(),
                         rng=rng.getstate(), torch_rng=torch.get_rng_state(), failures=dict(failures),
                         all_samples=state['all_samples'] + len(samples), complete_games=end - sum(failures.values()),
                         training_seconds=state['training_seconds'] + duration)
            state['training.jsonl'] = append_rows(output / 'training.jsonl', state['training.jsonl'], rows)
            state['updates.jsonl'] = append_rows(output / 'updates.jsonl', state['updates.jsonl'], [event])
            save_state(output / 'resume.pt', state)
            emit(event)
            if end == next_monitor or end == budget:
                champion, monitoring = benchmark(executor, workers, output, config, seeds, state['checkpoints'])
                if patience:
                    stalled = batches_without_improvement(state['checkpoints'], monitoring)
                    latest = 'monitor-' + Path(state['checkpoints'][-1]).stem
                    emit({'stage': 'patience-check', 'games': end, 'selected': champion,
                          'mean_league_points': monitoring[latest]['mean_league_points'],
                          'batches_without_improvement': stalled, 'patience': patience})
            updates_this_session += 1
            if (max_updates is not None and updates_this_session >= max_updates and end < budget
                    and (patience is None or stalled < patience)):
                emit({'stage': 'paused', 'games_committed': end, 'updates': update})
                return

        # Freeze selection before running any final-board games.
        final_checkpoint = state['checkpoints'][-1]
        criterion = 'monitoring wins vs baseline, then mean VP margin, then earliest checkpoint'
        if four_player:
            criterion = ('monitoring league points, then earliest checkpoint' if patience else
                         'monitoring league points, then fewer failures, then earliest checkpoint')
        write_json(output / 'selection.json', {'selected': champion, 'last': final_checkpoint, 'criterion': criterion})
        arms = {'start': 'start.pt', 'selected': champion, 'last': final_checkpoint}
        matches, by_checkpoint = {}, {}
        for arm, checkpoint in arms.items():
            if checkpoint not in by_checkpoint:
                by_checkpoint[checkpoint] = evaluate(executor, workers, output, config, seeds, 'final-' + arm,
                                                       'batch-final', config['final_boards'], checkpoint)
            matches[arm] = by_checkpoint[checkpoint]
        duel = None
        if champion != 'start.pt' and not four_player:
            duel = evaluate(executor, workers, output, config, seeds, 'final-selected-vs-start',
                            'batch-final-duel', config['final_boards'], champion, 'start.pt')
        repository = Path(manifest['repository_root'])
        protected = {p.name: digest(p) for p in sorted((repository / 'live-player').glob('*.json'))}
        report = {'complete': True, 'games': state['episode'], 'completed_games': state['complete_games'],
                  'failures': state['failures'], 'updates': state['update'], 'samples': state['all_samples'],
                  'training_seconds': round(state['training_seconds'], 2), 'monitoring': monitoring,
                  'selected_checkpoint': champion, 'selected_sha256': digest(output / champion),
                  'last_checkpoint': final_checkpoint, 'last_sha256': digest(output / final_checkpoint),
                  'held_out_vs_baseline': {key: value['summary'] for key, value in matches.items()},
                  'held_out_selected_vs_start': duel['summary'] if duel else None,
                  'paired_selected_minus_start_vs_baseline': (paired_points if four_player else paired_improvement)(
                      matches['start']['games'], matches['selected']['games']),
                  'protected_models_unchanged': protected == manifest['protected_models_before']}
        if patience:
            report.update(stop_reason='no new monitoring high', patience=patience, batches_without_improvement=stalled)
        if four_player:
            reference = evaluate(executor, workers, output, config, seeds, 'final-reference', 'batch-final',
                                 config['final_boards'], None)
            mixed_args = (executor, workers, output, config, seeds)
            mixed_reference = evaluate(*mixed_args, 'mixed-reference', 'batch-final-mixed',
                                       config['final_boards'], None, mixed=True)
            mixed_selected = evaluate(*mixed_args, 'mixed-selected', 'batch-final-mixed',
                                      config['final_boards'], champion, mixed=True)
            report.update(
                reference_vs_baseline=reference['summary'],
                paired_selected_minus_baseline=paired_points(reference['games'], matches['selected']['games']),
                mixed_reference=mixed_reference['summary'], mixed_selected=mixed_selected['summary'],
                paired_mixed_selected_minus_baseline=paired_points(mixed_reference['games'], mixed_selected['games']))
        write_json(output / 'results.json', report)
        emit({'stage': 'complete', **{k: v for k, v in report.items() if k != 'monitoring'}})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    start = sub.add_parser('start')
    resume = sub.add_parser('resume')
    for command in (start, resume):
        command.add_argument('--output', type=Path, required=True)
        command.add_argument('--workers', type=int, default=6)
        command.add_argument('--max-updates-this-session', type=int,
                             help='Pause after committing this many PPO updates.')
    start.add_argument('--run', type=Path, required=True, help='Parent replay pretraining run.')
    start.add_argument('--initial', type=Path, required=True, help='Policy/value checkpoint to continue from.')
    stop = start.add_mutually_exclusive_group()
    stop.add_argument('--games', type=int, help='Fixed number of training games (default 10000).')
    stop.add_argument('--patience', type=int, help='Stop after this many four-player checkpoints without a new high in league points.')
    start.add_argument('--games-per-update', type=int, default=40)
    start.add_argument('--monitor-every', type=int, default=2000)
    start.add_argument('--monitor-boards', type=int, default=64)
    start.add_argument('--final-boards', type=int, default=200)
    start.add_argument('--learning-rate', type=float, default=.0001)
    start.add_argument('--game-seconds', type=float, default=30)
    start.add_argument('--seed', type=int, default=161128)
    args = parser.parse_args()
    if args.workers < 1 or (args.max_updates_this_session is not None and args.max_updates_this_session < 1):
        parser.error('Worker and session budgets must be positive')
    if args.command == 'start':
        if args.games is None and args.patience is None:
            args.games = 10000
        budget = args.games if args.patience is None else args.patience
        if min(budget, args.games_per_update, args.monitor_every, args.monitor_boards,
               args.final_boards, args.learning_rate, args.game_seconds) <= 0:
            parser.error('Game, update and evaluation budgets must be positive')
    output = args.output.resolve()
    if args.command == 'start':
        output.mkdir(parents=True, exist_ok=False)
    with exclusive_run(output):
        if args.command == 'start':
            manifest = snapshot_batch(args, output, args.run.resolve())
        else:
            manifest = load_batch(output)
        if (output / 'results.json').is_file():
            emit({'stage': 'already-complete', 'results': str(output / 'results.json')})
            return
        train_batch(output, manifest, args.workers, args.max_updates_this_session)


if __name__ == '__main__':
    main()
